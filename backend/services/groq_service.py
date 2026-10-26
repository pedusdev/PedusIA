"""
Comunicación con los proveedores de IA: Groq (principal) y Mistral (respaldo y
modelo principal de PRO ULTRA). Ambos usan la API de chat compatible con OpenAI.

- Los modelos se escriben como "modelo" o "groq:modelo" (Groq) y "mistral:modelo"
  (Mistral). Si un proveedor no tiene clave configurada, sus modelos se saltan.

- Streaming de respuestas token a token, separando el RAZONAMIENTO (lo que el
  modelo "piensa") del CONTENIDO (la respuesta final) para el modo pensar.
- Niveles de esfuerzo: Bajo, Medio, Alto, Ultra y UltraMAX.
- Cadenas de modelos de respaldo: si un modelo no existe, tu cuenta no tiene
  acceso, está saturado o su proveedor falla, se prueba el siguiente de la lista
  (que puede ser de otro proveedor).
- Esperas cortas cuando Groq responde 429 (límite por minuto) usando retry-after.
- Ajuste automático de max_tokens al límite de tokens por minuto de la cuenta.
"""
import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import AsyncIterator

import httpx

from config import settings

logger = logging.getLogger("pedusia.groq")

# --------------------------------------------------------------------------
# Proveedores
# --------------------------------------------------------------------------
PROVIDER_PREFIXES = ("groq", "mistral")


@dataclass(frozen=True)
class Provider:
    """Datos de conexión de un proveedor (se leen de la configuración en cada uso)."""

    name: str
    label: str
    base_url: str
    api_key: str
    tpm: int

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}


def get_provider(name: str) -> Provider:
    """Proveedor por nombre ("groq" o "mistral")."""
    if name == "mistral":
        return Provider("mistral", "Mistral", settings.MISTRAL_BASE_URL, settings.MISTRAL_API_KEY,
                        settings.MISTRAL_TPM_LIMIT)
    return Provider("groq", "Groq", settings.GROQ_BASE_URL, settings.GROQ_API_KEY, settings.GROQ_TPM_LIMIT)


def split_model(model_ref: str) -> tuple[str, str]:
    """'mistral:mistral-large-4' -> ('mistral', 'mistral-large-4'); 'openai/gpt-oss-20b' -> ('groq', ...)."""
    prefix, sep, rest = model_ref.partition(":")
    if sep and rest and prefix.strip().lower() in PROVIDER_PREFIXES:
        return prefix.strip().lower(), rest.strip()
    return "groq", model_ref


def provider_of(model_ref: str) -> Provider:
    return get_provider(split_model(model_ref)[0])


def model_name(model_ref: str) -> str:
    """Nombre del modelo tal y como lo espera la API del proveedor (sin prefijo)."""
    return split_model(model_ref)[1]


def usable_chain(chain: list[str]) -> list[str]:
    """Quita los modelos cuyo proveedor no tiene clave configurada."""
    return [model for model in chain if provider_of(model).configured]


def _mistral_reasoning(name: str) -> bool:
    """Modelos de Mistral con razonamiento ajustable (reasoning_effort)."""
    return name.startswith((
        "mistral-small-latest", "mistral-small-2603", "mistral-small-4",
        "mistral-medium-latest", "mistral-medium-3-5", "mistral-medium-2604",
        "mistral-large-4", "magistral-",
    ))


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

# Modelo con razonamiento de respaldo por nivel (si la cadena elegida no tiene ninguno)
REASONING_FALLBACK = {
    "basic": "openai/gpt-oss-20b",
    "pro": "openai/gpt-oss-120b",
    "ultra": "openai/gpt-oss-120b",
}

# Niveles de esfuerzo del modo pensar.
#   level  -> reasoning_effort que se envía a Groq
#   tokens -> máximo de tokens deseado (razonamiento + respuesta)
#   deep   -> usa la cadena de modelos más potente (GROQ_MODEL_DEEP)
#   multipass -> UltraMAX: borrador + revisión crítica + respuesta final
EFFORTS: dict[str, dict] = {
    "low": {"level": "low", "tokens": settings.MAX_TOKENS, "max_only": False, "deep": False, "multipass": False},
    "medium": {"level": "medium", "tokens": max(settings.MAX_TOKENS, 6144), "max_only": False, "deep": False, "multipass": False},
    "high": {"level": "high", "tokens": max(settings.MAX_TOKENS, 8192), "max_only": False, "deep": False, "multipass": False},
    "ultra": {"level": "high", "tokens": max(settings.MAX_TOKENS, 12288), "max_only": True, "deep": True, "multipass": False},
    "ultramax": {"level": "high", "tokens": max(settings.MAX_TOKENS, 12288), "max_only": True, "deep": True, "multipass": True},
}

# Parámetros opcionales que algunos modelos no aceptan (se quitan si Groq protesta)
EXTRA_KEYS = ("reasoning_effort", "include_reasoning", "reasoning_format")


def is_reasoning_model(model_ref: str) -> bool:
    """True si el modelo puede devolver su razonamiento."""
    provider, name = split_model(model_ref)
    if provider == "mistral":
        return _mistral_reasoning(name)
    return name.startswith(("openai/gpt-oss", "qwen/qwen3", "minimaxai/", "meta-models/muse"))


def reasoning_chain(chain: list[str], tier: str) -> list[str]:
    """Deja solo los modelos con razonamiento (manteniendo el orden) para el modo pensar."""
    models = [model for model in chain if is_reasoning_model(model)]
    return models or [REASONING_FALLBACK.get(tier, "openai/gpt-oss-120b")]


def _content_size(content) -> int:
    """Caracteres de un contenido (texto o lista multimodal). Las imágenes cuentan como ~1.000 tokens."""
    if isinstance(content, str):
        return len(content)
    total = 0
    for part in content or []:
        if part.get("type") == "text":
            total += len(part.get("text") or "")
        else:
            total += 3200
    return total


def estimate_tokens(messages: list[dict]) -> int:
    """Estimación prudente de los tokens de entrada (~3,2 caracteres por token)."""
    chars = sum(_content_size(m.get("content")) for m in messages)
    return int(chars / 3.2) + 8 * len(messages)


def fit_max_tokens(messages: list[dict], desired: int, tpm: int | None = None) -> int:
    """
    Groq rechaza (413) las peticiones cuya entrada + max_tokens supera el límite
    de tokens por minuto de la cuenta. Ajusta max_tokens para que siempre quepa.
    `tpm` permite usar el límite de otro proveedor (Mistral).
    """
    budget = (tpm or settings.GROQ_TPM_LIMIT) - estimate_tokens(messages) - 300
    return max(1024, min(desired, budget))


def _text_of(content) -> str:
    """Texto plano de un contenido (cadena o lista de partes)."""
    if isinstance(content, str):
        return content
    return "\n".join(part.get("text") or "" for part in content or [] if isinstance(part, dict) and part.get("type") == "text")


def mistral_messages(messages: list[dict]) -> list[dict]:
    """
    Mistral exige que el último mensaje sea del usuario y no admite instrucciones
    de sistema al final de la conversación: se unen todas en un único mensaje de
    sistema al principio (en el mismo orden).
    """
    systems = [_text_of(m.get("content")) for m in messages if m.get("role") == "system"]
    rest = [m for m in messages if m.get("role") != "system"]
    result = [{"role": "system", "content": "\n\n".join(part for part in systems if part)}] if systems else []
    result.extend(rest)
    if not rest or rest[-1].get("role") != "user":
        result.append({"role": "user", "content": "Continúa."})
    return result


def split_chunks(content) -> tuple[str, str]:
    """
    Separa (respuesta, razonamiento) de un contenido en formato de Mistral:
    una cadena o una lista de partes {"type": "text"} / {"type": "thinking", "thinking": [...]}.
    """
    if isinstance(content, str):
        return content, ""
    text, thinking = [], []
    for part in content or []:
        if isinstance(part, str):
            text.append(part)
            continue
        if not isinstance(part, dict):
            continue
        if part.get("type") == "thinking":
            for inner in part.get("thinking") or []:
                if isinstance(inner, str):
                    thinking.append(inner)
                elif isinstance(inner, dict) and inner.get("text"):
                    thinking.append(inner["text"])
        elif part.get("type") == "text" and part.get("text"):
            text.append(part["text"])
    return "".join(text), "".join(thinking)


class GroqError(Exception):
    """Error al hablar con Groq. `friendly` es seguro para mostrar al usuario."""

    def __init__(self, status_code: int, code: str, message: str, friendly: str | None = None,
                 retry_after: float | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.friendly = friendly or "Ups, algo salió mal. Intenta de nuevo."
        self.retry_after = retry_after

    @property
    def model_unavailable(self) -> bool:
        """True si el error indica que el modelo no existe o no está disponible."""
        text = f"{self.code} {self.message}".lower()
        if self.status_code in (403, 404):
            return True
        if self.status_code == 400 and any(
            key in text for key in (
                "model_not_found", "decommissioned", "does not exist", "not supported", "model_permission",
                "invalid model", "invalid_model", "unknown model", "no such model",
            )
        ):
            return True
        return False

    @property
    def bad_parameter(self) -> bool:
        text = f"{self.code} {self.message}".lower()
        return self.status_code in (400, 422) and any(
            key in text for key in ("reasoning", "property", "parameter", "extra_forbidden", "extra inputs")
        )

    @property
    def provider_failure(self) -> bool:
        """Fallo del proveedor (clave inválida, sin saldo, caído...): conviene probar otro."""
        return self.status_code in (401, 402, 408, 409) or self.status_code >= 500

    @property
    def rate_limited(self) -> bool:
        return self.status_code == 429

    @property
    def too_large(self) -> bool:
        return self.status_code == 413


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


class ThinkSplitter:
    """
    Separa en streaming el texto entre <think> y </think> (razonamiento) del resto
    (respuesta). Lo usan los modelos que devuelven el razonamiento dentro del contenido.
    """

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self.buffer = ""
        self.inside = False

    @staticmethod
    def _safe_cut(text: str, tag: str) -> int:
        """Posición hasta la que se puede emitir sin partir una etiqueta que llega a trozos."""
        for i in range(len(tag) - 1, 0, -1):
            if text.endswith(tag[:i]):
                return len(text) - i
        return len(text)

    def feed(self, chunk: str) -> tuple[str, str]:
        """Devuelve (respuesta, razonamiento) emitibles de este trozo."""
        self.buffer += chunk
        visible, hidden = [], []
        while self.buffer:
            tag = self.CLOSE if self.inside else self.OPEN
            index = self.buffer.find(tag)
            if index == -1:
                cut = self._safe_cut(self.buffer, tag)
                (hidden if self.inside else visible).append(self.buffer[:cut])
                self.buffer = self.buffer[cut:]
                break
            (hidden if self.inside else visible).append(self.buffer[:index])
            self.buffer = self.buffer[index + len(tag):]
            if self.inside:
                self.buffer = self.buffer.lstrip("\n")
            self.inside = not self.inside
        return "".join(visible), "".join(hidden)

    def flush(self) -> tuple[str, str]:
        rest = self.buffer
        self.buffer = ""
        return ("", rest) if self.inside else (rest, "")


def _friendly_from_status(status: int) -> str:
    if status == 429:
        return "PedusGPT está muy solicitado ahora mismo. Espera unos segundos y vuelve a intentarlo."
    if status == 413:
        return "El mensaje o el archivo es demasiado largo para este modelo. Prueba con algo más corto."
    return "Ups, algo salió mal. Intenta de nuevo."


def _parse_retry_after(value: str | None) -> float | None:
    """Convierte la cabecera retry-after ('7', '7.5', '1m30s', '850ms') en segundos."""
    if not value:
        return None
    value = value.strip().lower()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    total, found = 0.0, False
    for amount, unit in re.findall(r"([\d.]+)\s*(ms|h|m|s)", value):
        found = True
        number = float(amount)
        total += {"ms": number / 1000, "s": number, "m": number * 60, "h": number * 3600}[unit]
    return total if found else None


def _build_payload(
    model_ref: str,
    messages: list[dict],
    stream: bool,
    max_tokens: int,
    effort: str | None,
    *,
    show_reasoning: bool = False,
    deep: bool = False,
) -> dict:
    """
    Construye la petición. Cada familia de modelos usa sus propios parámetros de razonamiento:
    - gpt-oss: reasoning_effort (low/medium/high) + include_reasoning
    - qwen3: reasoning_effort (none/low/medium/high) + reasoning_format
    - muse-spark: reasoning_effort hasta xhigh + reasoning_format (temperatura por defecto)
    - Mistral (Small 4, Medium 3.5, Large 4): reasoning_effort "high" (piensa) o "none"
    """
    provider, model_id = split_model(model_ref)
    if provider == "mistral":
        payload = {
            "model": model_id,
            "messages": mistral_messages(messages),
            "stream": stream,
            "temperature": settings.TEMPERATURE,
            "max_tokens": max_tokens,
        }
        if _mistral_reasoning(model_id):
            thinks = show_reasoning or deep or effort == "high"
            payload["reasoning_effort"] = "high" if thinks else "none"
        return payload
    payload = {
        "model": model_id,
        "messages": messages,
        "stream": stream,
        "temperature": settings.TEMPERATURE,
        "max_tokens": max_tokens,
    }
    if model_id.startswith("openai/gpt-oss"):
        if effort in ("low", "medium", "high"):
            payload["reasoning_effort"] = effort
        payload["include_reasoning"] = bool(show_reasoning)
    elif model_id.startswith("qwen/qwen3"):
        if effort:
            payload["reasoning_effort"] = effort
        payload["reasoning_format"] = "parsed" if show_reasoning else "hidden"
    elif model_id.startswith("meta-models/muse"):
        payload.pop("temperature", None)
        if effort:
            payload["reasoning_effort"] = "xhigh" if deep else (effort if effort in ("low", "medium", "high") else "low")
        payload["reasoning_format"] = "parsed" if show_reasoning else "hidden"
    elif model_id.startswith("minimaxai/"):
        payload["reasoning_format"] = "parsed" if show_reasoning else "hidden"
    return payload


class GroqService:
    """Cliente de IA multiproveedor (el nombre se mantiene por compatibilidad)."""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0))
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    @property
    def headers(self) -> dict:
        """Cabeceras de Groq (compatibilidad con el diagnóstico y PedusCode)."""
        return get_provider("groq").headers

    @staticmethod
    async def _error_from_response(response: httpx.Response) -> GroqError:
        """Convierte una respuesta de error (formato de Groq o de Mistral) en GroqError."""
        try:
            body = json.loads(await response.aread())
            code, message = "groq_error", str(body)
            if isinstance(body, dict):
                err = body.get("error")
                if isinstance(err, dict):
                    code = str(err.get("code") or err.get("type") or "groq_error")
                    message = str(err.get("message") or body)
                elif isinstance(err, str):
                    message = err
                else:
                    # Formato de Mistral: {"object": "error", "message": ..., "type": ..., "code": ...}
                    code = str(body.get("code") or body.get("type") or "provider_error")
                    message = str(body.get("message") or body.get("detail") or body)
        except Exception:  # noqa: BLE001 - cuerpo no JSON
            code, message = "groq_error", f"HTTP {response.status_code}"
        return GroqError(
            response.status_code, code, message, _friendly_from_status(response.status_code),
            retry_after=_parse_retry_after(response.headers.get("retry-after")),
        )

    # ------------------------------------------------------------------ #
    # Streaming con razonamiento separado
    # ------------------------------------------------------------------ #
    async def _stream_single(self, payload: dict, provider: Provider | None = None) -> AsyncIterator[tuple[str, str]]:
        """Emite tuplas (tipo, texto) con tipo 'content' o 'reasoning'."""
        provider = provider or get_provider("groq")
        splitter = ThinkSplitter()
        async with self.client.stream(
            "POST", f"{provider.base_url}/chat/completions", headers=provider.headers, json=payload
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
                    err = chunk["error"] if isinstance(chunk["error"], dict) else {"message": str(chunk["error"])}
                    raise GroqError(500, str(err.get("code", "stream_error")), str(err.get("message", "")))
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                if reasoning:
                    yield "reasoning", reasoning
                content = delta.get("content")
                if not content:
                    continue
                if isinstance(content, list):
                    # Mistral: lista de partes "thinking" (razonamiento) y "text" (respuesta)
                    text, thinking = split_chunks(content)
                    if thinking:
                        yield "reasoning", thinking
                    if not text:
                        continue
                    content = text
                visible, hidden = splitter.feed(content)
                if hidden:
                    yield "reasoning", hidden
                if visible:
                    yield "content", visible
        visible, hidden = splitter.flush()
        if hidden:
            yield "reasoning", hidden
        if visible:
            yield "content", visible

    async def stream_events(
        self,
        messages: list[dict],
        chain: list[str],
        *,
        effort: str | None,
        show_reasoning: bool = False,
        max_tokens: int | None = None,
        deep: bool = False,
        max_wait: float | None = None,
    ) -> AsyncIterator[dict]:
        """
        Streaming probando la cadena de modelos. Emite diccionarios:
          {"type": "reasoning", "text": ...}   razonamiento (solo si show_reasoning)
          {"type": "content", "text": ...}     respuesta
          {"type": "alive"}                    el modelo piensa en silencio (mantener la conexión)
          {"type": "waiting", "seconds": n}    el proveedor pidió esperar (límite por minuto)
          {"type": "model", "id": ..., "provider": ...}  modelo que está respondiendo
        Solo cambia de modelo si aún no se ha emitido nada del intento actual.
        """
        chain = usable_chain(chain)
        if not chain:
            raise GroqError(500, "missing_api_key", "No hay ningún proveedor de IA configurado (GROQ_API_KEY)")
        wait_limit = settings.GROQ_MAX_WAIT if max_wait is None else max_wait
        last_error: GroqError | None = None

        for index, model_ref in enumerate(chain):
            is_last = index == len(chain) - 1
            provider = provider_of(model_ref)
            tokens = fit_max_tokens(messages, max_tokens or settings.MAX_TOKENS, provider.tpm)
            payload = _build_payload(
                model_ref, messages, True, tokens, effort, show_reasoning=show_reasoning, deep=deep
            )
            waited = False
            while True:
                started = False
                try:
                    yield {"type": "model", "id": model_ref, "provider": provider.name}
                    async for kind, text in self._stream_single(payload, provider):
                        started = True
                        if kind == "reasoning":
                            yield {"type": "reasoning", "text": text} if show_reasoning else {"type": "alive"}
                        else:
                            yield {"type": "content", "text": text}
                    return
                except GroqError as error:
                    if started:
                        raise
                    last_error = error
                    if error.bad_parameter and any(key in payload for key in EXTRA_KEYS):
                        for key in EXTRA_KEYS:
                            payload.pop(key, None)
                        continue  # reintentar el mismo modelo sin parámetros de razonamiento
                    if error.too_large and payload["max_tokens"] > 1024:
                        payload["max_tokens"] = max(1024, payload["max_tokens"] // 2)
                        continue  # pedir menos tokens de salida
                    if error.rate_limited:
                        if error.retry_after is None and not is_last:
                            # Sin indicación de espera (típico de Mistral): mejor probar el siguiente ya
                            logger.warning("Modelo %s saturado (429). Probando el siguiente.", model_ref)
                            break
                        seconds = error.retry_after if error.retry_after is not None else (
                            2.0 if provider.name == "mistral" else 8.0
                        )
                        # Esperar una vez si es poco tiempo (o si no queda otro modelo)
                        if not waited and (seconds <= wait_limit or (is_last and seconds <= wait_limit * 2)):
                            waited = True
                            yield {"type": "waiting", "seconds": round(seconds, 1)}
                            await asyncio.sleep(seconds + 0.3)
                            continue
                        if not is_last:
                            logger.warning("Modelo %s saturado (429). Probando el siguiente.", model_ref)
                            break
                        raise
                    if error.model_unavailable:
                        logger.warning("Modelo %s no disponible (%s). Probando el siguiente.", model_ref, error.message)
                        break
                    if error.provider_failure and not is_last:
                        logger.warning(
                            "%s falló con %s (%s). Probando el siguiente modelo.",
                            provider.label, model_ref, error.status_code,
                        )
                        break
                    raise
                except httpx.HTTPError as error:
                    if started:
                        raise GroqError(
                            502, "connection", str(error), "Se cortó la conexión con PedusGPT. Intenta de nuevo."
                        ) from error
                    last_error = GroqError(
                        502, "connection", str(error), "No se pudo conectar con PedusGPT. Intenta de nuevo."
                    )
                    break
        raise last_error or GroqError(500, "no_models", "Ningún modelo disponible")

    async def stream_chat(
        self,
        messages: list[dict],
        model_key: str,
        *,
        model_chain: list[str] | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[str]:
        """
        Compatibilidad: streaming solo de la respuesta (sin razonamiento visible).
        Emite "" mientras el modelo piensa, como señal de vida.
        """
        info = MODEL_CATALOG[model_key]
        async for event in self.stream_events(
            messages, model_chain or info["chain"], effort=info.get("reasoning_effort"), max_tokens=max_tokens
        ):
            if event["type"] == "content":
                yield event["text"]
            elif event["type"] in ("alive", "reasoning", "waiting"):
                yield ""

    # ------------------------------------------------------------------ #
    # Petición sin streaming (títulos, selector de skills)
    # ------------------------------------------------------------------ #
    async def complete(
        self, messages: list[dict], chain: list[str], max_tokens: int = 30, *, timeout: float = 30.0,
        json_mode: bool = False,
    ) -> str:
        last_error: GroqError | None = None
        chain = usable_chain(chain)
        if not chain:
            raise GroqError(500, "missing_api_key", "No hay ningún proveedor de IA configurado")
        for model_ref in chain:
            provider = provider_of(model_ref)
            # Los modelos de Groq con razonamiento gastan tokens "pensando": darles margen
            tokens = max(max_tokens, 400) if is_reasoning_model(model_ref) and provider.name == "groq" else max_tokens
            payload = _build_payload(model_ref, messages, False, tokens, "low")
            if json_mode:
                payload["response_format"] = {"type": "json_object"}
            try:
                for _attempt in range(3):
                    response = await self.client.post(
                        f"{provider.base_url}/chat/completions", headers=provider.headers, json=payload, timeout=timeout
                    )
                    if response.status_code == 200:
                        break
                    error = await self._error_from_response(response)
                    if error.bad_parameter and any(key in payload for key in (*EXTRA_KEYS, "response_format")):
                        for key in (*EXTRA_KEYS, "response_format"):
                            payload.pop(key, None)
                        continue
                    raise error
                else:
                    raise await self._error_from_response(response)
                text, _thinking = split_chunks(response.json()["choices"][0]["message"].get("content") or "")
                filt = ThinkFilter()
                return (filt.feed(text) + filt.flush()).strip()
            except GroqError as error:
                last_error = error
                if error.model_unavailable or error.rate_limited or error.provider_failure:
                    continue
                raise
            except (httpx.HTTPError, KeyError, IndexError, ValueError) as error:
                last_error = GroqError(502, "connection", str(error))
                continue
        raise last_error or GroqError(500, "no_models", "Ningún modelo disponible")


groq_service = GroqService()
