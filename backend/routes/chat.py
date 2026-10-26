"""
Chat con streaming (Server-Sent Events) y generación automática de títulos.

Modo pensar: el razonamiento del modelo se envía en directo (eventos "reasoning")
separado de la respuesta (eventos "token"). Niveles de esfuerzo:
  low / medium / high  -> reasoning_effort de Groq
  ultra                -> modelo más potente + razonamiento a fondo (Plan MAX)
  ultramax             -> borrador + revisión crítica + respuesta final (Plan MAX, límite diario)
Skills: el usuario puede elegir hasta 3 a mano o dejar que un modelo rápido
elija las que encajan con el mensaje (eventos "skills").
Búsqueda web automática: si el mensaje necesita datos actuales, se busca en internet
(Tavily / Exa) y la respuesta cita las fuentes (eventos "search", "sources",
"search_limit" y "search_failed"). Límite diario para todos salvo el owner.
"""
import asyncio
import logging
import re
import time
from typing import AsyncIterator, Literal, Optional
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
    consume_search_request,
    consume_ultramax_run,
    refund_search_request,
    refund_ultra_request,
    refund_ultramax_run,
    title_limiter,
)
from routes.conversations import get_owned_conversation, touch_conversation
from services.groq_service import EFFORTS, MODEL_CATALOG, ULTRA_MODEL, GroqError, groq_service, reasoning_chain
from services.skills_service import (
    build_skills_block,
    bump_uses,
    load_active_skills_meta,
    load_skills_content,
    route_skills,
)
from services import search_service
from services.supabase_service import SupabaseError, supabase
from utils.helpers import IMAGE_TYPES, APIError, clean_text, sse, truncate_words
from utils.system_prompts import (
    TITLE_SYSTEM_PROMPT,
    ULTRA_ADDENDUM,
    ULTRAMAX_DRAFT,
    ULTRAMAX_FINAL,
    ULTRAMAX_REVIEW,
    build_system_prompt,
)

logger = logging.getLogger("pedusia.chat")
router = APIRouter(tags=["chat"])

HISTORY_FIELDS = "id,role,content,file_url,file_type,file_name,file_text,created_at"
MAX_SAVED_REASONING = 40000

EffortName = Literal["low", "medium", "high", "ultra", "ultramax"]


class ChatRequest(BaseModel):
    conversation_id: UUID
    message: str = Field("", max_length=settings.MAX_MESSAGE_CHARS)
    model: str = "pedus-gpt-2"
    files: list[UUID] = Field(default_factory=list, max_length=1)
    regenerate: bool = False
    # Modo pensar: mostrar el razonamiento y usar el nivel de esfuerzo elegido
    think: bool = False
    effort: Optional[EffortName] = None
    # Skills elegidas a mano (máx. 3) y selección automática
    skill_ids: list[UUID] = Field(default_factory=list, max_length=3)
    auto_skills: bool = True


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


def build_groq_messages(
    profile: dict, history: list[dict], model_key: str, with_image: bool, skills_block: str = "",
    search_block: str = "",
) -> list[dict]:
    """
    [system_prompt (+ skills), ...historial, (resultados de búsqueda)] con la imagen incluida
    solo en el último mensaje si procede.
    """
    is_new = not any(m["role"] == "assistant" for m in history)
    system = build_system_prompt(profile, MODEL_CATALOG[model_key]["name"], is_new)
    if skills_block:
        system += "\n\n" + skills_block
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
    if search_block:
        # Al final, junto a la pregunta, para que el modelo le preste más atención
        messages.append({"role": "system", "content": search_block})
    return messages


def recent_context(history: list[dict], limit: int = 4) -> str:
    """Resumen de los últimos mensajes (para el revisor de UltraMAX)."""
    lines = []
    for message in history[-(limit + 1):-1]:
        who = "Usuario" if message["role"] == "user" else "Asistente"
        lines.append(f"{who}: {clean_text(message.get('content'), 1500)}")
    return "\n".join(lines) or "(sin mensajes anteriores)"


# --------------------------------------------------------------------------
# Generadores de respuesta
# --------------------------------------------------------------------------

async def single_pass(
    text_messages: list[dict],
    vision_messages: list[dict] | None,
    model_key: str,
    effort_key: str | None,
) -> AsyncIterator[dict]:
    """Una sola llamada (con visión primero si hay imagen). Emite eventos de groq_service."""
    info = MODEL_CATALOG[model_key]
    cfg = EFFORTS.get(effort_key) if effort_key else None
    if cfg:
        chain = settings.MODEL_CHAIN_DEEP if cfg["deep"] else reasoning_chain(info["chain"], info["tier"])
        level, tokens, show, deep = cfg["level"], cfg["tokens"], True, cfg["deep"]
    else:
        chain, level, tokens, show, deep = info["chain"], info.get("reasoning_effort"), settings.MAX_TOKENS, False, False

    def with_addendum(messages: list[dict]) -> list[dict]:
        if effort_key == "ultra":
            return [*messages, {"role": "system", "content": ULTRA_ADDENDUM}]
        return messages

    if vision_messages:
        emitted = False
        try:
            async for event in groq_service.stream_events(
                with_addendum(vision_messages), [settings.GROQ_VISION_MODEL],
                effort=level if cfg else None, show_reasoning=show, max_tokens=tokens, deep=deep,
            ):
                if event["type"] in ("content", "reasoning"):
                    emitted = True
                yield event
            return
        except GroqError as error:
            if emitted:
                raise
            logger.warning("Visión no disponible (%s). Usando solo texto.", error.message)
    async for event in groq_service.stream_events(
        with_addendum(text_messages), chain, effort=level, show_reasoning=show, max_tokens=tokens, deep=deep
    ):
        yield event


async def ultramax_pass(
    text_messages: list[dict],
    vision_messages: list[dict] | None,
    history: list[dict],
) -> AsyncIterator[dict]:
    """
    UltraMAX en tres fases. El borrador y la revisión se muestran dentro del bloque
    de pensamiento (como razonamiento); solo la fase final es la respuesta.
    """
    cfg = EFFORTS["ultramax"]
    last_user = clean_text(history[-1].get("content") if history else "", 6000) or "(archivo adjunto)"

    # Fase 1: borrador (con la imagen si la hay)
    yield {"type": "phase", "phase": "draft"}
    draft_parts: list[str] = []

    async def draft_stream(messages: list[dict], chain: list[str]):
        async for event in groq_service.stream_events(
            [*messages, {"role": "system", "content": ULTRAMAX_DRAFT}], chain,
            effort=cfg["level"], show_reasoning=True, max_tokens=cfg["tokens"], deep=True,
        ):
            yield event

    sources = []
    if vision_messages:
        sources.append((vision_messages, [settings.GROQ_VISION_MODEL]))
    sources.append((text_messages, settings.MODEL_CHAIN_DEEP))
    for index, (messages, chain) in enumerate(sources):
        try:
            async for event in draft_stream(messages, chain):
                if event["type"] == "content":
                    draft_parts.append(event["text"])
                    yield {"type": "reasoning", "text": event["text"]}
                else:
                    yield event
            break
        except GroqError as error:
            if draft_parts or index == len(sources) - 1:
                raise
            logger.warning("Visión no disponible en UltraMAX (%s). Usando solo texto.", error.message)
    draft = "".join(draft_parts).strip()

    # Fase 2: revisión crítica con otro modelo (si falla, se sigue sin revisión)
    yield {"type": "phase", "phase": "review"}
    review_parts: list[str] = []
    review_messages = [
        {"role": "system", "content": ULTRAMAX_REVIEW},
        {"role": "user", "content": (
            f"CONVERSACIÓN RECIENTE:\n{recent_context(history)}\n\n"
            f"PETICIÓN DEL ESTUDIANTE:\n{last_user}\n\nBORRADOR:\n{draft[:14000] or '(vacío)'}"
        )},
    ]
    try:
        async for event in groq_service.stream_events(
            review_messages, settings.MODEL_CHAIN_REVIEW, effort="high", show_reasoning=True, max_tokens=4096,
        ):
            if event["type"] == "content":
                review_parts.append(event["text"])
                yield {"type": "reasoning", "text": event["text"]}
            elif event["type"] == "reasoning":
                continue  # el razonamiento del revisor no aporta: solo se muestra su revisión
            else:
                yield event
    except GroqError as error:
        logger.warning("Revisión de UltraMAX no disponible: %s", error.message)
    review = "".join(review_parts).strip() or "(sin revisión disponible: repasa tú mismo el borrador)"

    # Fase 3: respuesta final
    yield {"type": "phase", "phase": "final"}
    final_messages = [
        *text_messages,
        {"role": "system", "content": ULTRAMAX_FINAL.format(draft=draft[:12000] or "(vacío)", review=review[:6000])},
    ]
    async for event in groq_service.stream_events(
        final_messages, settings.MODEL_CHAIN_DEEP, effort="medium", show_reasoning=True, max_tokens=cfg["tokens"],
    ):
        yield event


# --------------------------------------------------------------------------
# Guardado
# --------------------------------------------------------------------------

async def insert_assistant(row: dict, extra: dict) -> str | None:
    """Guarda la respuesta. Si la base de datos aún no tiene las columnas nuevas, guarda lo básico."""
    try:
        rows = await supabase.insert("messages", {**row, **extra})
        return rows[0]["id"]
    except SupabaseError as error:
        text = error.message.lower()
        if extra and any(
            key in text for key in ("reasoning", "thinking_ms", "effort", "skills", "sources", "pgrst204", "42703")
        ):
            # Primero sin las fuentes (columna más nueva) y, si aún falla, solo lo básico
            if "sources" in extra:
                try:
                    reduced = {k: v for k, v in extra.items() if k != "sources"}
                    rows = await supabase.insert("messages", {**row, **reduced})
                    return rows[0]["id"]
                except SupabaseError:
                    pass
            rows = await supabase.insert("messages", row)
            return rows[0]["id"]
        raise


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

    # Nivel de esfuerzo (solo con el modo pensar activado)
    effort_key = (body.effort or "medium") if body.think else None
    if effort_key and EFFORTS[effort_key]["max_only"] and not user.has_ultra:
        raise APIError(403, "needs_max", "Los esfuerzos Ultra y UltraMAX son exclusivos del Plan MAX.")
    multipass = bool(effort_key and EFFORTS[effort_key]["multipass"])

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

    # 1-2. Permisos del modelo, límite diario de ULTRA y de UltraMAX
    ultra_info = await consume_ultra_request(user) if body.model == ULTRA_MODEL else None
    ultramax_info = None
    if multipass:
        try:
            ultramax_info = await consume_ultramax_run(user)
        except APIError:
            if ultra_info is not None:
                await refund_ultra_request(user)
            raise

    async def refund_all() -> None:
        if ultra_info is not None:
            await refund_ultra_request(user)
        if ultramax_info is not None:
            await refund_ultramax_run(user)

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
        await refund_all()
        raise
    except SupabaseError as error:
        await refund_all()
        raise APIError(503, "db_unavailable", "Error al cargar datos. Recarga la página.") from error

    # Skills disponibles (solo Plan MAX)
    catalog = await load_active_skills_meta(user.id) if user.has_ultra else []
    catalog_ids = {skill["id"] for skill in catalog}
    manual_ids = [str(i) for i in body.skill_ids if str(i) in catalog_ids]

    last = history[-1] if history else {}
    wants_vision = bool(settings.GROQ_VISION_MODEL) and (last.get("file_type") or "") in IMAGE_TYPES

    async def event_stream():
        parts: list[str] = []
        reasoning_parts: list[str] = []
        used_skills: list[dict] = []
        used_sources: list[dict] = []
        state = {"saved": False, "think_ms": None}
        started_at = time.monotonic()

        def thinking_ms() -> int | None:
            if not effort_key:
                return None
            if state["think_ms"] is not None:
                return state["think_ms"]
            return int((time.monotonic() - started_at) * 1000)

        async def save_assistant() -> str | None:
            if state["saved"]:
                return None
            state["saved"] = True
            content = "".join(parts).strip()
            if not content:
                return None
            extra = {}
            reasoning = "".join(reasoning_parts).strip()
            if effort_key:
                extra = {"reasoning": reasoning[:MAX_SAVED_REASONING] or None, "thinking_ms": thinking_ms(),
                         "effort": effort_key}
            if used_skills:
                extra["skills"] = used_skills
            if used_sources:
                extra["sources"] = used_sources
            try:
                message_id = await insert_assistant(
                    {"conversation_id": conversation_id, "role": "assistant", "content": content}, extra
                )
                await touch_conversation(conversation_id, {"model_used": body.model})
                return message_id
            except SupabaseError as error:
                logger.error("No se pudo guardar la respuesta: %s", error.message)
                return None

        yield sse({
            "type": "start", "user_message_id": user_message_id, "model": body.model, "ultra": ultra_info,
            "ultramax": ultramax_info, "think": bool(effort_key), "effort": effort_key,
        })
        last_ping = time.monotonic()
        try:
            # Skills: las elegidas a mano o las que el selector considere útiles
            chosen_ids = manual_ids
            auto_chosen = False
            if not chosen_ids and body.auto_skills and any(s.get("auto") for s in catalog):
                yield sse({"type": "skills_routing"})
                names = await route_skills(last.get("content") or "", catalog)
                by_name = {s["name"]: s["id"] for s in catalog}
                chosen_ids = [by_name[n] for n in names if n in by_name]
                auto_chosen = bool(chosen_ids)
            skills = await load_skills_content(user.id, chosen_ids) if chosen_ids else []
            skills_block = build_skills_block(skills)
            if skills:
                used_skills.extend(
                    {"name": s["name"], "title": s.get("title") or s["name"], "emoji": s.get("emoji") or "🧩"}
                    for s in skills
                )
                yield sse({"type": "skills", "skills": used_skills, "auto": auto_chosen})
                asyncio.create_task(bump_uses(skills))

            # Búsqueda web automática (solo si el mensaje necesita datos actuales)
            search_block = ""
            last_text = last.get("content") or ""
            if search_service.search_enabled() and last_text.strip():
                decision = await search_service.decide(last_text, history)
                if decision.search:
                    quota = await consume_search_request(user)
                    if not quota.get("allowed"):
                        if quota.get("reason") == "limit":
                            yield sse({"type": "search_limit", "limit": settings.WEB_SEARCH_DAILY_LIMIT})
                    else:
                        quota = {k: v for k, v in quota.items() if k != "allowed"}
                        yield sse({"type": "search", "queries": decision.queries})
                        found = await search_service.search(decision)
                        if found:
                            search_block = search_service.build_search_block(found, decision.queries)
                            used_sources.extend(search_service.public_sources(found))
                            yield sse({"type": "sources", "sources": used_sources, "usage": quota})
                        else:
                            await refund_search_request(user)
                            yield sse({"type": "search_failed"})

            # 5-6. System prompt personalizado (+ skills) + historial (+ resultados de búsqueda)
            text_messages = build_groq_messages(
                user.profile, history, body.model, False, skills_block, search_block
            )
            vision_messages = (
                build_groq_messages(user.profile, history, body.model, True, skills_block, search_block)
                if wants_vision else None
            )
            started_at = time.monotonic()

            # 7-8. Llamar a Groq y retransmitir
            source = (
                ultramax_pass(text_messages, vision_messages, history)
                if multipass else single_pass(text_messages, vision_messages, body.model, effort_key)
            )
            final_phase = not multipass
            async for event in source:
                kind = event["type"]
                if kind == "content":
                    if not final_phase:
                        continue
                    if state["think_ms"] is None and effort_key:
                        state["think_ms"] = int((time.monotonic() - started_at) * 1000)
                    parts.append(event["text"])
                    yield sse({"type": "token", "content": event["text"]})
                elif kind == "reasoning":
                    if parts:
                        continue  # razonamiento tardío tras empezar la respuesta: no se muestra
                    reasoning_parts.append(event["text"])
                    yield sse({"type": "reasoning", "content": event["text"]})
                elif kind == "phase":
                    if event["phase"] == "final":
                        final_phase = True
                    reasoning_parts.append(f"\n\n⟦phase:{event['phase']}⟧\n")
                    yield sse({"type": "phase", "phase": event["phase"]})
                elif kind == "waiting":
                    yield sse({"type": "waiting", "seconds": event["seconds"]})
                elif kind == "alive":
                    # El modelo está razonando en silencio: mantener viva la conexión
                    if time.monotonic() - last_ping > 3:
                        last_ping = time.monotonic()
                        yield sse({"type": "thinking"})
            # 9. Guardar la respuesta completa
            message_id = await save_assistant()
            yield sse({"type": "done", "message_id": message_id, "thinking_ms": thinking_ms() if parts else None})
        except (asyncio.CancelledError, GeneratorExit):
            # El usuario detuvo la generación o cerró la pestaña: guardar lo que haya
            if parts:
                asyncio.create_task(save_assistant())
            raise
        except GroqError as error:
            logger.warning("Groq error %s: %s", error.status_code, error.message)
            if not parts:
                await refund_all()
            message_id = await save_assistant() if parts else None
            yield sse({"type": "error", "code": "ai_error", "status": error.status_code,
                       "message": error.friendly, "message_id": message_id})
        except Exception:  # noqa: BLE001 - nunca enviar errores crudos al usuario
            logger.exception("Error inesperado en el streaming")
            if not parts:
                await refund_all()
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
