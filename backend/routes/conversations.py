"""
Historial: conversaciones y mensajes del usuario.
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from middleware.auth_middleware import CurrentUser, get_current_user
from services.groq_service import MODEL_CATALOG
from services.supabase_service import SupabaseError, supabase
from utils.helpers import APIError, clean_text, utc_now

router = APIRouter(tags=["conversations"])

MESSAGE_FIELDS = "id,conversation_id,role,content,file_url,file_type,file_name,liked,created_at"
# Columnas del modo pensar y skills (schema.sql actualizado)
MESSAGE_FIELDS_EXTRA = MESSAGE_FIELDS + ",reasoning,thinking_ms,effort,skills"
# Con las fuentes de la búsqueda web (columna añadida después)
MESSAGE_FIELDS_SOURCES = MESSAGE_FIELDS_EXTRA + ",sources"


def db_error() -> APIError:
    return APIError(503, "db_unavailable", "Error al cargar datos. Recarga la página.")


async def get_owned_conversation(conversation_id: UUID | str, user_id: str) -> dict:
    """Devuelve la conversación si pertenece al usuario; si no, 404."""
    try:
        conversation = await supabase.select_one(
            "conversations", {"id": f"eq.{conversation_id}", "user_id": f"eq.{user_id}", "select": "*"}
        )
    except SupabaseError as error:
        raise db_error() from error
    if not conversation:
        raise APIError(404, "not_found", "Conversación no encontrada.")
    return conversation


async def get_owned_message(message_id: UUID, user_id: str) -> dict:
    """Devuelve el mensaje si pertenece a una conversación del usuario."""
    try:
        message = await supabase.select_one(
            "messages",
            {"id": f"eq.{message_id}", "select": "id,conversation_id,role,created_at,conversations!inner(user_id)",
             "conversations.user_id": f"eq.{user_id}"},
        )
    except SupabaseError as error:
        raise db_error() from error
    if not message:
        raise APIError(404, "not_found", "Mensaje no encontrado.")
    return message


async def touch_conversation(conversation_id: str, extra: dict | None = None) -> None:
    try:
        await supabase.update(
            "conversations", {"id": f"eq.{conversation_id}"}, {"updated_at": utc_now().isoformat(), **(extra or {})}
        )
    except SupabaseError:
        pass


# --------------------------------------------------------------------------
# Conversaciones
# --------------------------------------------------------------------------

class ConversationCreate(BaseModel):
    title: Optional[str] = Field(None, max_length=120)
    model: Optional[str] = None


class ConversationUpdate(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)


@router.get("/conversations")
async def list_conversations(user: CurrentUser = Depends(get_current_user)):
    try:
        rows, _ = await supabase.select(
            "conversations",
            {
                "user_id": f"eq.{user.id}",
                "select": "id,title,model_used,created_at,updated_at",
                "order": "updated_at.desc",
                "limit": 500,
            },
        )
    except SupabaseError as error:
        raise db_error() from error
    return {"conversations": rows}


@router.post("/conversations", status_code=201)
async def create_conversation(body: ConversationCreate, user: CurrentUser = Depends(get_current_user)):
    model = body.model if body.model in MODEL_CATALOG else "pedus-gpt-2"
    data = {
        "user_id": user.id,
        "title": clean_text(body.title, 120) or "Nueva conversación",
        "model_used": model,
    }
    try:
        rows = await supabase.insert("conversations", data)
    except SupabaseError as error:
        raise db_error() from error
    return rows[0]


@router.patch("/conversations/{conversation_id}")
async def rename_conversation(
    conversation_id: UUID, body: ConversationUpdate, user: CurrentUser = Depends(get_current_user)
):
    await get_owned_conversation(conversation_id, user.id)
    title = clean_text(body.title, 120)
    if not title:
        raise APIError(400, "invalid_title", "El título no puede estar vacío.")
    try:
        rows = await supabase.update(
            "conversations", {"id": f"eq.{conversation_id}", "user_id": f"eq.{user.id}"}, {"title": title}
        )
    except SupabaseError as error:
        raise db_error() from error
    return rows[0]


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: UUID, user: CurrentUser = Depends(get_current_user)):
    await get_owned_conversation(conversation_id, user.id)
    try:
        # Los mensajes y archivos asociados se borran en cascada (ON DELETE CASCADE)
        await supabase.delete("conversations", {"id": f"eq.{conversation_id}", "user_id": f"eq.{user.id}"})
    except SupabaseError as error:
        raise db_error() from error
    return {"ok": True}


# --------------------------------------------------------------------------
# Mensajes
# --------------------------------------------------------------------------

@router.get("/conversations/{conversation_id}/messages")
async def list_messages(conversation_id: UUID, user: CurrentUser = Depends(get_current_user)):
    conversation = await get_owned_conversation(conversation_id, user.id)
    params = {
        "conversation_id": f"eq.{conversation_id}",
        "role": "neq.system",
        "order": "created_at.asc",
        "limit": 1000,
    }
    rows: list[dict] = []
    last_error: SupabaseError | None = None
    # Base de datos sin las columnas nuevas (schema.sql antiguo): probar con menos columnas
    for fields in (MESSAGE_FIELDS_SOURCES, MESSAGE_FIELDS_EXTRA, MESSAGE_FIELDS):
        try:
            rows, _ = await supabase.select("messages", {**params, "select": fields})
            last_error = None
            break
        except SupabaseError as error:
            last_error = error
            text = error.message.lower()
            if not any(key in text for key in ("42703", "pgrst204", "sources", "reasoning", "thinking_ms", "does not exist")):
                break
    if last_error is not None:
        raise db_error() from last_error
    return {"conversation": conversation, "messages": rows}


@router.delete("/conversations/{conversation_id}/messages")
async def truncate_messages(
    conversation_id: UUID,
    from_id: UUID = Query(..., description="Borra este mensaje y todos los posteriores"),
    user: CurrentUser = Depends(get_current_user),
):
    """Usado al EDITAR: elimina el mensaje indicado y todo lo que vino después."""
    await get_owned_conversation(conversation_id, user.id)
    message = await get_owned_message(from_id, user.id)
    if message["conversation_id"] != str(conversation_id):
        raise APIError(400, "invalid_message", "El mensaje no pertenece a esta conversación.")
    try:
        deleted = await supabase.delete(
            "messages",
            {"conversation_id": f"eq.{conversation_id}", "created_at": f"gte.{message['created_at']}"},
        )
    except SupabaseError as error:
        raise db_error() from error
    return {"ok": True, "deleted": len(deleted)}


@router.delete("/messages/{message_id}")
async def delete_message(message_id: UUID, user: CurrentUser = Depends(get_current_user)):
    await get_owned_message(message_id, user.id)
    try:
        await supabase.delete("messages", {"id": f"eq.{message_id}"})
    except SupabaseError as error:
        raise db_error() from error
    return {"ok": True}


class FeedbackUpdate(BaseModel):
    liked: Optional[bool] = None


@router.patch("/messages/{message_id}/feedback")
async def message_feedback(message_id: UUID, body: FeedbackUpdate, user: CurrentUser = Depends(get_current_user)):
    message = await get_owned_message(message_id, user.id)
    if message["role"] != "assistant":
        raise APIError(400, "invalid_message", "Solo se puede valorar respuestas de PedusGPT.")
    try:
        await supabase.update("messages", {"id": f"eq.{message_id}"}, {"liked": body.liked})
    except SupabaseError as error:
        raise db_error() from error
    return {"ok": True, "liked": body.liked}
