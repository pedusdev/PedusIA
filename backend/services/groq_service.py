"""
Comunicación con la API de Groq (compatible con OpenAI).

- Streaming de respuestas token a token.
- Cadenas de modelos de respaldo: si un modelo no existe o tu cuenta no tiene
  acceso, se prueba automáticamente el siguiente de la lista.
- Filtro de bloques <think>…</think> para modelos con razonamiento visible.
"""
import json
import logging
from typing import AsyncIterator

import httpx

from config import settings

logger = logging.getLogger("pedusia.groq")

# Catálogo público de modelos de PedusGPT
MODEL_CATALOG: dict[str, dict] = {
    "pedus-gpt-2": {
        "name": "PedusGPT 2",
        "tier": "basic",
        "chain": settings.MODEL_CHAIN_BASIC,
        "reasoning_effort": "low",
    },
    "pedus-gpt-2-pro": {
        "name": "PedusGPT 2 PRO",
        "tier": "pro",
        "chain": settings.MODEL_CHAIN_PRO,
        "reasoning_effort": "medium",
    },
    "pedus-gpt-2-pro-ultra": {
        "name": "PedusGPT 2 PRO ULTRA",
        "tier": "ultra",
        "chain": settings.MODEL_CHAIN_ULTRA,
        "reasoning_effort": "high",
    },
}
ULTRA_MODEL = "pedus-gpt-2-pro-ultra"


class GroqError(Exception):
    """Error al hablar con Groq. `friendly` es seguro para mostrar al usuario."""

    def __init__(self, status_code: int, code: str, message: str, friendly: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.friendly = friendly or "Ups, algo salió mal. Intenta de nuevo."

    @property
    def model_unavailable(self) -> bool:
        """True si el error indica que el modelo no existe o no está disponible."""
        text = f"{self.code} {self.message}".lower()
        if self.status_code in (403, 404):
            return True
        if self.status_code == 400 and any(
            key in text for key in ("model_not_found", "decommissioned", "does not exist", "not supported", "model_permission")
        ):
            return True
        return False

    @property
    def bad_parameter(self) -> bool:
        text = f"{self.code} {self.message}".lower()
        return self.status_code == 400 and ("reasoning" in text or "property" in text or "parameter" in text)


class ThinkFilter:
    """Elimina en streaming el contenido entre <think> y </think>."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self.buffer = ""
        self.inside = False

    def feed(self, chunk: str) -> str:
        self.buffer += chunk
        output = []
        while self.buffer:
            if self.inside:
                end = self.buffer.find(self.CLOSE)
                if end == -1:
                    # Conservar la cola por si la etiqueta llega partida
                    self.buffer = self.buffer[-len(self.CLOSE):]
                    break
                self.buffer = self.buffer[end + len(self.CLOSE):].lstrip("\n")
                self.inside = False
            else:
                start = self.buffer.find(self.OPEN)
                if start == -1:
                    # Emitir todo salvo un posible inicio de etiqueta al final
                    safe = len(self.buffer)
                    for i in range(1, len(self.OPEN)):
                        if self.buffer.endswith(self.OPEN[:i]):
                            safe = len(self.buffer) - i
                            break
                    output.append(self.buffer[:safe])
                    self.buffer = self.buffer[safe:]
                    break
                output.append(self.buffer[:start])
                self.buffer = self.buffer[start + len(self.OPEN):]
                self.inside = True
        return "".join(output)

    def flush(self) -> str:
        rest = "" if self.inside else self.buffer
        self.buffer = ""
        return rest


def _friendly_from_status(status: int) -> str:
    if status == 429:
        return "PedusGPT está muy solicitado ahora mismo. Espera unos segundos y vuelve a intentarlo."
    if status == 413:
        return "El mensaje o el archivo es demasiado largo para este modelo. Prueba con algo más corto."
    return "Ups, algo salió mal. Intenta de nuevo."


def _build_payload(model_id: str, messages: list[dict], stream: bool, max_tokens: int, effort: str | None) -> dict:
    payload = {
        "model": model_id,
        "messages": messages,
        "stream": stream,
        "temperature": settings.TEMPERATURE,
        "max_tokens": max_tokens,
    }
    # Los modelos gpt-oss aceptan nivel de razonamiento
    if effort and model_id.startswith("openai/gpt-oss"):
        payload["reasoning_effort"] = effort
    return payload


class GroqService:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {settings.GROQ_API_KEY}", "Content-Type": "application/json"}

    @staticmethod
    async def _error_from_response(response: httpx.Response) -> GroqError:
        try:
            body = json.loads(await response.aread())
            err = body.get("error", {}) if isinstance(body, dict) else {}
            code = str(err.get("code") or err.get("type") or "groq_error")
            message = str(err.get("message") or body)
        except Exception:  # noqa: BLE001 - cuerpo no JSON
            code, message = "groq_error", f"HTTP {response.status_code}"
        return GroqError(response.status_code, code, message, _friendly_from_status(response.status_code))

    # ------------------------------------------------------------------ #
    # Streaming
    # ------------------------------------------------------------------ #
    async def _stream_single(self, payload: dict) -> AsyncIterator[str]:
        think = ThinkFilter()
        async with self.client.stream(
            "POST", f"{settings.GROQ_BASE_URL}/chat/completions", headers=self.headers, json=payload
        ) as response:
            if response.status_code != 200:
                raise await self._error_from_response(response)
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if chunk.get("error"):
                    err = chunk["error"]
                    raise GroqError(500, str(err.get("code", "stream_error")), str(err.get("message", "")))
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                # Solo se reenvía el contenido final. El razonamiento interno
                # (delta.reasoning) no se muestra: se emite "" como señal de vida.
                delta_obj = choices[0].get("delta") or {}
                delta = delta_obj.get("content")
                if delta:
                    text = think.feed(delta)
                    yield text  # puede ser "" si está dentro de <think>
                elif delta_obj.get("reasoning"):
                    yield ""
        rest = think.flush()
        if rest:
            yield rest

    async def stream_chat(
        self,
        messages: list[dict],
        model_key: str,
        *,
        model_chain: list[str] | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[str]:
        """
        Hace streaming probando la cadena de modelos. Solo cambia de modelo si
        aún no se ha emitido ningún token.
        """
        if not settings.GROQ_API_KEY:
            raise GroqError(500, "missing_api_key", "GROQ_API_KEY no configurada")

        info = MODEL_CATALOG[model_key]
        chain = model_chain or info["chain"]
        last_error: GroqError | None = None

        for model_id in chain:
            attempts = [info.get("reasoning_effort"), None]  # 2º intento sin parámetros extra
            for effort in attempts:
                payload = _build_payload(model_id, messages, True, max_tokens or settings.MAX_TOKENS, effort)
                started = False
                try:
                    async for text in self._stream_single(payload):
                        started = True
                        yield text
                    return
                except GroqError as error:
                    if started:
                        raise
                    last_error = error
                    if error.bad_parameter and "reasoning_effort" in payload:
                        continue  # reintentar el mismo modelo sin reasoning_effort
                    if error.model_unavailable:
                        logger.warning("Modelo %s no disponible (%s). Probando el siguiente.", model_id, error.message)
                        break
                    raise
                except httpx.HTTPError as error:
                    raise GroqError(
                        502, "connection", str(error), "No se pudo conectar con PedusGPT. Intenta de nuevo."
                    ) from error
        raise last_error or GroqError(500, "no_models", "Ningún modelo disponible")

    # ------------------------------------------------------------------ #
    # Petición sin streaming (títulos)
    # ------------------------------------------------------------------ #
    async def complete(self, messages: list[dict], chain: list[str], max_tokens: int = 30) -> str:
        last_error: GroqError | None = None
        for model_id in chain:
            # Los modelos con razonamiento gastan tokens "pensando": darles margen
            tokens = max(max_tokens, 400) if model_id.startswith("openai/gpt-oss") else max_tokens
            payload = _build_payload(model_id, messages, False, tokens, "low")
            try:
                response = await self.client.post(
                    f"{settings.GROQ_BASE_URL}/chat/completions", headers=self.headers, json=payload, timeout=30.0
                )
                if response.status_code != 200:
                    error = await self._error_from_response(response)
                    if error.bad_parameter and "reasoning_effort" in payload:
                        payload.pop("reasoning_effort")
                        response = await self.client.post(
                            f"{settings.GROQ_BASE_URL}/chat/completions", headers=self.headers, json=payload, timeout=30.0
                        )
                        if response.status_code != 200:
                            error = await self._error_from_response(response)
                        else:
                            error = None
                    if error:
                        last_error = error
                        if error.model_unavailable:
                            continue
                        raise error
                content = response.json()["choices"][0]["message"].get("content") or ""
                filt = ThinkFilter()
                return (filt.feed(content) + filt.flush()).strip()
            except httpx.HTTPError as error:
                raise GroqError(502, "connection", str(error)) from error
        raise last_error or GroqError(500, "no_models", "Ningún modelo disponible")


groq_service = GroqService()
