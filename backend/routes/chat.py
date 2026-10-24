"""
Chat con streaming (Server-Sent Events) y generación automática de títulos.
"""
import asyncio
import logging
import re
import time
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config import settings
from middleware.auth_middleware import CurrentUser, get_current_user
from middleware.rate_limiter import (
    chat_limiter,
    check_limit,
    consume_ultra_request,
    refund_ultra_request,
    title_limiter,
)
from routes.conversations import get_owned_conversation, touch_conversation
from services.groq_service import MODEL_CATALOG, ULTRA_MODEL, GroqError, groq_service
from services.supabase_service import SupabaseError, supabase
from utils.helpers import IMAGE_TYPES, APIError, clean_text, sse, truncate_words
from utils.system_prompts import TITLE_SYSTEM_PROMPT, build_system_prompt

logger = logging.getLogger("pedusia.chat")
router = APIRouter(tags=["chat"])

HISTORY_FIELDS = "id,role,content,file_url,file_type,file_name,file_text,created_at"


class ChatRequest(BaseModel):
    conversation_id: UUID
    message: str = Field("", max_length=settings.MAX_MESSAGE_CHARS)
    model: str = "pedus-gpt-2"
    files: list[UUID] = Field(default_factory=list, max_length=1)
    regenerate: bool = False


class TitleRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    conversation_id: Optional[UUID] = None


# --------------------------------------------------------------------------
# Construcción del contexto
# --------------------------------------------------------------------------

async def load_history(conversation_id: str) -> list[dict]:
    """Últimos N mensajes de la conversación en orden cronológico."""
    rows, _ = await supabase.select(
        "messages",
        {
            "conversation_id": f"eq.{conversation_id}",
            "role": "neq.system",
            "select": HISTORY_FIELDS,
            "order": "created_at.desc",
            "limit": settings.HISTORY_LIMIT,
        },
    )
    return list(reversed(rows))


def message_to_model_content(message: dict, include_image: bool):
    """Convierte un mensaje guardado en el contenido que entiende el modelo."""
    text = message.get("content") or ""
    name = message.get("file_name")
    file_type = message.get("file_type") or ""
    if name:
        if message.get("file_text"):
            snippet = message["file_text"][: settings.MAX_FILE_CONTEXT_CHARS]
            text += f"\n\n[Archivo adjunto: {name}]\n<<<CONTENIDO DEL ARCHIVO\n{snippet}\nFIN DEL ARCHIVO>>>"
        elif file_type in IMAGE_TYPES and not include_image:
            text += f"\n\n[El usuario adjuntó una imagen llamada «{name}», pero no puedes verla en este contexto.]"
        elif file_type not in IMAGE_TYPES:
            text += f"\n\n[Archivo adjunto: {name} — no se pudo extraer texto.]"
    if not text.strip():
        text = "Echa un vistazo al archivo adjunto y dime qué ves."
    if include_image and message.get("file_url"):
        return [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": message["file_url"]}},
        ]
    return text


def build_groq_messages(profile: dict, history: list[dict], model_key: str, with_image: bool) -> list[dict]:
    """[system_prompt, ...historial] con la imagen incluida solo en el último mensaje si procede."""
    is_new = not any(m["role"] == "assistant" for m in history)
    system = build_system_prompt(profile, MODEL_CATALOG[model_key]["name"], is_new)
    messages = [{"role": "system", "content": system}]
    last_index = len(history) - 1
    for index, message in enumerate(history):
        include_image = (
            with_image
            and index == last_index
            and message["role"] == "user"
            and (message.get("file_type") or "") in IMAGE_TYPES
        )
        messages.append({"role": message["role"], "content": message_to_model_content(message, include_image)})
    return messages


# --------------------------------------------------------------------------
# Endpoint de streaming
# --------------------------------------------------------------------------

@router.post("/chat/stream")
async def chat_stream(body: ChatRequest, user: CurrentUser = Depends(get_current_user)):
    check_limit(chat_limiter, user.id)
    if body.model not in MODEL_CATALOG:
        raise APIError(400, "invalid_model", "Modelo no válido.")

    conversation_id = str(body.conversation_id)
    await get_owned_conversation(conversation_id, user.id)
    text = clean_text(body.message, settings.MAX_MESSAGE_CHARS)

    # Archivo adjunto (debe pertenecer al usuario)
    file_row = None
    if not body.regenerate:
        if body.files:
            try:
                file_row = await supabase.select_one(
                    "uploaded_files",
                    {"id": f"eq.{body.files[0]}", "user_id": f"eq.{user.id}", "select": "*"},
                )
            except SupabaseError as error:
                raise APIError(503, "db_unavailable", "Error al cargar datos. Recarga la página.") from error
            if not file_row:
                raise APIError(404, "file_not_found", "No se encontró el archivo adjunto.")
        if not text and not file_row:
            raise APIError(400, "empty_message", "Escribe un mensaje.")

    # 1-2. Permisos del modelo y límite diario de ULTRA
    ultra_info = await consume_ultra_request(user) if body.model == ULTRA_MODEL else None
    is_ultra = ultra_info is not None

    # 3-4. Guardar mensaje del usuario y cargar historial
    try:
        if body.regenerate:
            history = await load_history(conversation_id)
            trailing = []
            while history and history[-1]["role"] == "assistant":
                trailing.append(history.pop())
            if not history or history[-1]["role"] != "user":
                raise APIError(400, "nothing_to_regenerate", "No hay ningún mensaje para regenerar.")
            if trailing:
                ids = ",".join(m["id"] for m in trailing)
                await supabase.delete("messages", {"id": f"in.({ids})", "conversation_id": f"eq.{conversation_id}"})
            user_message_id = history[-1]["id"]
        else:
            new_message = {
                "conversation_id": conversation_id,
                "role": "user",
                "content": text,
            }
            if file_row:
                new_message.update(
                    {
                        "file_url": file_row["file_url"],
                        "file_type": file_row["file_type"],
                        "file_name": file_row["file_name"],
                        "file_text": file_row.get("extracted_text"),
                    }
                )
            saved = await supabase.insert("messages", new_message)
            user_message_id = saved[0]["id"]
            if file_row:
                await supabase.update("uploaded_files", {"id": f"eq.{file_row['id']}"}, {"message_id": user_message_id})
            history = await load_history(conversation_id)
    except APIError:
        if is_ultra:
            await refund_ultra_request(user)
        raise
    except SupabaseError as error:
        if is_ultra:
            await refund_ultra_request(user)
        raise APIError(503, "db_unavailable", "Error al cargar datos. Recarga la página.") from error

    # 5-6. System prompt personalizado + historial
    last = history[-1] if history else {}
    wants_vision = bool(settings.GROQ_VISION_MODEL) and (last.get("file_type") or "") in IMAGE_TYPES
    text_messages = build_groq_messages(user.profile, history, body.model, with_image=False)
    vision_messages = build_groq_messages(user.profile, history, body.model, with_image=True) if wants_vision else None

    async def generate():
        """Genera tokens; si hay imagen intenta primero con el modelo de visión."""
        if vision_messages:
            emitted = False
            try:
                async for chunk in groq_service.stream_chat(
                    vision_messages, body.model, model_chain=[settings.GROQ_VISION_MODEL]
                ):
                    emitted = True
                    yield chunk
                return
            except GroqError as error:
                if emitted:
                    raise
                logger.warning("Visión no disponible (%s). Usando solo texto.", error.message)
        async for chunk in groq_service.stream_chat(text_messages, body.model):
            yield chunk

    async def event_stream():
        parts: list[str] = []
        state = {"saved": False}

        async def save_assistant() -> str | None:
            if state["saved"]:
                return None
            state["saved"] = True
            content = "".join(parts).strip()
            if not content:
                return None
            try:
                rows = await supabase.insert(
                    "messages", {"conversation_id": conversation_id, "role": "assistant", "content": content}
                )
                await touch_conversation(conversation_id, {"model_used": body.model})
                return rows[0]["id"]
            except SupabaseError as error:
                logger.error("No se pudo guardar la respuesta: %s", error.message)
                return None

        yield sse({"type": "start", "user_message_id": user_message_id, "model": body.model, "ultra": ultra_info})
        last_ping = time.monotonic()
        try:
            # 7-8. Llamar a Groq y retransmitir
            async for chunk in generate():
                if not chunk:
                    # El modelo está razonando: mantener viva la conexión
                    if time.monotonic() - last_ping > 3:
                        last_ping = time.monotonic()
                        yield sse({"type": "thinking"})
                    continue
                parts.append(chunk)
                yield sse({"type": "token", "content": chunk})
            # 9. Guardar la respuesta completa
            message_id = await save_assistant()
            yield sse({"type": "done", "message_id": message_id})
        except (asyncio.CancelledError, GeneratorExit):
            # El usuario detuvo la generación o cerró la pestaña: guardar lo que haya
            if parts:
                asyncio.create_task(save_assistant())
            raise
        except GroqError as error:
            logger.warning("Groq error %s: %s", error.status_code, error.message)
            if not parts and is_ultra:
                await refund_ultra_request(user)
            message_id = await save_assistant() if parts else None
            yield sse({"type": "error", "code": "ai_error", "status": error.status_code,
                       "message": error.friendly, "message_id": message_id})
        except Exception:  # noqa: BLE001 - nunca enviar errores crudos al usuario
            logger.exception("Error inesperado en el streaming")
            if not parts and is_ultra:
                await refund_ultra_request(user)
            message_id = await save_assistant() if parts else None
            yield sse({"type": "error", "code": "ai_error", "status": 500,
                       "message": "Ups, algo salió mal. Intenta de nuevo.", "message_id": message_id})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# --------------------------------------------------------------------------
# Título automático
# --------------------------------------------------------------------------

def _fallback_title(message: str) -> str:
    title = truncate_words(re.sub(r"\s+", " ", message).strip(), 6)
    return (title[:60] or "Nueva conversación")


def _clean_title(raw: str, message: str) -> str:
    title = raw.strip().splitlines()[0] if raw.strip() else ""
    title = re.sub(r"^(t[íi]tulo|title)\s*:\s*", "", title, flags=re.IGNORECASE)
    title = title.strip(" \"'«»“”`*#.").strip()
    title = truncate_words(title, 6)[:60]
    return title or _fallback_title(message)


@router.post("/chat/title")
async def generate_title(body: TitleRequest, user: CurrentUser = Depends(get_current_user)):
    check_limit(title_limiter, user.id)
    if body.conversation_id:
        await get_owned_conversation(body.conversation_id, user.id)

    message = clean_text(body.message, 1500)
    try:
        raw = await groq_service.complete(
            [{"role": "system", "content": TITLE_SYSTEM_PROMPT}, {"role": "user", "content": message}],
            settings.MODEL_CHAIN_TITLE,
            max_tokens=24,
        )
        title = _clean_title(raw, message)
    except GroqError as error:
        logger.warning("No se pudo generar el título: %s", error.message)
        title = _fallback_title(message)

    if body.conversation_id:
        try:
            await supabase.update("conversations", {"id": f"eq.{body.conversation_id}"}, {"title": title})
        except SupabaseError:
            pass
    return {"title": title}
