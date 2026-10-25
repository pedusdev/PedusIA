"""
Gestión de usuarios: perfil propio y panel de administración.
"""
import asyncio
import uuid
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Query, UploadFile
from pydantic import BaseModel, Field

from config import settings
from middleware.auth_middleware import CurrentUser, code_usage, get_current_user, require_admin, ultra_usage
from middleware.rate_limiter import check_limit, upload_limiter
from services.groq_service import MODEL_CATALOG
from services.supabase_service import SupabaseError, supabase
from utils.helpers import (
    EXTENSION_FOR_MIME,
    IMAGE_TYPES,
    APIError,
    clean_text,
    detect_mime,
    next_reset_iso,
    sanitize_search,
    today_utc,
)

router = APIRouter(tags=["users"])

SUPPORTED_LANGUAGES = {"es", "en", "fr", "de", "it", "pt", "ca", "ja", "zh", "ko", "ru", "ar"}
PUBLIC_PROFILE_FIELDS = (
    "id", "email", "display_name", "avatar_url", "bio", "interests", "favorite_animal", "role",
    "preferred_language", "preferred_theme", "default_model", "is_banned", "created_at",
)


def serialize_profile(profile: dict) -> dict:
    """Perfil listo para el frontend, con el uso de ULTRA calculado."""
    data = {key: profile.get(key) for key in PUBLIC_PROFILE_FIELDS}
    data["default_model"] = data.get("default_model") or "pedus-gpt-2"
    data["ultra"] = {**ultra_usage(profile), "resets_at": next_reset_iso()}
    data["code"] = {**code_usage(profile), "resets_at": next_reset_iso()}
    return data


def db_error(error: SupabaseError) -> APIError:
    return APIError(503, "db_unavailable", "Error al cargar datos. Recarga la página.")


# ==========================================================================
# PERFIL PROPIO
# ==========================================================================

class ProfileUpdate(BaseModel):
    display_name: Optional[str] = Field(None, max_length=60)
    bio: Optional[str] = Field(None, max_length=200)
    interests: Optional[str] = Field(None, max_length=200)
    favorite_animal: Optional[str] = Field(None, max_length=60)
    preferred_language: Optional[str] = None
    preferred_theme: Optional[Literal["light", "dark", "system"]] = None
    default_model: Optional[str] = None


@router.get("/profile")
async def get_profile(user: CurrentUser = Depends(get_current_user)):
    return serialize_profile(user.profile)


@router.patch("/profile")
async def update_profile(body: ProfileUpdate, user: CurrentUser = Depends(get_current_user)):
    changes: dict = {}
    if body.display_name is not None:
        name = clean_text(body.display_name, 60)
        if not name:
            raise APIError(400, "invalid_name", "El nombre no puede estar vacío.")
        changes["display_name"] = name
    if body.bio is not None:
        changes["bio"] = clean_text(body.bio, 200)
    if body.interests is not None:
        changes["interests"] = clean_text(body.interests, 200)
    if body.favorite_animal is not None:
        changes["favorite_animal"] = clean_text(body.favorite_animal, 60)
    if body.preferred_language is not None:
        if body.preferred_language not in SUPPORTED_LANGUAGES:
            raise APIError(400, "invalid_language", "Idioma no soportado.")
        changes["preferred_language"] = body.preferred_language
    if body.preferred_theme is not None:
        changes["preferred_theme"] = body.preferred_theme
    if body.default_model is not None:
        if body.default_model not in MODEL_CATALOG:
            raise APIError(400, "invalid_model", "Modelo no válido.")
        changes["default_model"] = body.default_model

    if not changes:
        return serialize_profile(user.profile)
    try:
        rows = await supabase.update("profiles", {"id": f"eq.{user.id}"}, changes)
    except SupabaseError as error:
        raise db_error(error) from error
    return serialize_profile(rows[0] if rows else {**user.profile, **changes})


@router.post("/profile/avatar")
async def upload_avatar(file: UploadFile = File(...), user: CurrentUser = Depends(get_current_user)):
    check_limit(upload_limiter, user.id)
    content = await file.read(settings.MAX_AVATAR_BYTES + 1)
    if len(content) > settings.MAX_AVATAR_BYTES:
        raise APIError(413, "file_too_large", "La imagen supera los 5 MB.")
    mime = detect_mime(content, file.filename)
    if mime not in IMAGE_TYPES:
        raise APIError(415, "invalid_file_type", "La foto de perfil debe ser JPG, PNG, GIF o WEBP.")

    path = f"{user.id}/{uuid.uuid4().hex}{EXTENSION_FOR_MIME[mime]}"
    try:
        url = await supabase.upload_file(settings.BUCKET_AVATARS, path, content, mime)
        # Borrar el avatar anterior si estaba en nuestro bucket
        old = user.profile.get("avatar_url") or ""
        marker = f"/object/public/{settings.BUCKET_AVATARS}/"
        if marker in old:
            await supabase.delete_files(settings.BUCKET_AVATARS, [old.split(marker, 1)[1]])
        rows = await supabase.update("profiles", {"id": f"eq.{user.id}"}, {"avatar_url": url})
    except SupabaseError as error:
        raise db_error(error) from error
    return serialize_profile(rows[0] if rows else {**user.profile, "avatar_url": url})


# ==========================================================================
# PANEL DE ADMINISTRACIÓN
# ==========================================================================

class RoleUpdate(BaseModel):
    role: Literal["user", "max", "admin"]


class BanUpdate(BaseModel):
    is_banned: bool
    ban_reason: Optional[str] = Field("", max_length=300)


async def _get_target(user_id: UUID) -> dict:
    try:
        target = await supabase.select_one("profiles", {"id": f"eq.{user_id}", "select": "*"})
    except SupabaseError as error:
        raise db_error(error) from error
    if not target:
        raise APIError(404, "not_found", "Usuario no encontrado.")
    return target


def _assert_can_manage(actor: CurrentUser, target: dict) -> None:
    """Reglas de jerarquía: nadie toca al owner; un admin no toca a otros admins ni a sí mismo."""
    if target["id"] == actor.id:
        raise APIError(403, "forbidden", "No puedes modificar tu propia cuenta desde el panel.")
    if target.get("role") == "owner":
        raise APIError(403, "forbidden", "El owner no puede ser modificado.")
    if actor.role == "admin" and target.get("role") == "admin":
        raise APIError(403, "forbidden", "Un admin no puede modificar a otro admin.")


def _admin_user_row(profile: dict) -> dict:
    usage = ultra_usage(profile)
    return {
        "id": profile["id"],
        "email": profile.get("email"),
        "display_name": profile.get("display_name"),
        "avatar_url": profile.get("avatar_url"),
        "role": profile.get("role"),
        "is_banned": profile.get("is_banned", False),
        "ban_reason": profile.get("ban_reason"),
        "created_at": profile.get("created_at"),
        "last_seen_at": profile.get("last_seen_at"),
        "ultra_used_today": usage["used"],
    }


@router.get("/admin/users")
async def admin_list_users(
    search: str = "",
    role: str = "",
    status: str = "",
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    actor: CurrentUser = Depends(require_admin),
):
    params: list[tuple[str, str]] = [("select", "*"), ("order", "created_at.desc")]
    term = sanitize_search(search)
    if term:
        params.append(("or", f"(display_name.ilike.*{term}*,email.ilike.*{term}*)"))
    if role in ("user", "max", "admin", "owner"):
        params.append(("role", f"eq.{role}"))
    if status == "banned":
        params.append(("is_banned", "eq.true"))
    elif status == "active":
        params.append(("is_banned", "eq.false"))

    start = (page - 1) * limit
    try:
        rows, total = await supabase.select("profiles", params, count=True, range_from=start, range_to=start + limit - 1)
    except SupabaseError as error:
        if error.status_code == 416:  # página fuera de rango
            return {"users": [], "total": 0, "page": page, "limit": limit}
        raise db_error(error) from error
    return {"users": [_admin_user_row(r) for r in rows], "total": total, "page": page, "limit": limit}


@router.patch("/admin/users/{user_id}/role")
async def admin_change_role(user_id: UUID, body: RoleUpdate, actor: CurrentUser = Depends(require_admin)):
    target = await _get_target(user_id)
    _assert_can_manage(actor, target)
    if actor.role == "admin" and body.role == "admin":
        raise APIError(403, "forbidden", "Solo el owner puede nombrar administradores.")
    try:
        rows = await supabase.update("profiles", {"id": f"eq.{user_id}"}, {"role": body.role})
    except SupabaseError as error:
        raise db_error(error) from error
    return _admin_user_row(rows[0] if rows else {**target, "role": body.role})


@router.patch("/admin/users/{user_id}/ban")
async def admin_ban_user(user_id: UUID, body: BanUpdate, actor: CurrentUser = Depends(require_admin)):
    target = await _get_target(user_id)
    _assert_can_manage(actor, target)
    changes = {
        "is_banned": body.is_banned,
        "ban_reason": clean_text(body.ban_reason, 300) or None if body.is_banned else None,
    }
    try:
        rows = await supabase.update("profiles", {"id": f"eq.{user_id}"}, changes)
    except SupabaseError as error:
        raise db_error(error) from error
    return _admin_user_row(rows[0] if rows else {**target, **changes})


@router.patch("/admin/users/{user_id}/reset-limits")
async def admin_reset_limits(user_id: UUID, actor: CurrentUser = Depends(require_admin)):
    target = await _get_target(user_id)
    _assert_can_manage(actor, target)
    changes = {
        "daily_405b_requests": 0,
        "last_405b_reset": today_utc(),
        "daily_code_runs": 0,
        "last_code_reset": today_utc(),
    }
    try:
        rows = await supabase.update("profiles", {"id": f"eq.{user_id}"}, changes)
    except SupabaseError as error:
        # Base de datos sin las columnas de PedusCode (schema.sql antiguo): resetear solo ULTRA
        if "daily_code_runs" not in error.message and "last_code_reset" not in error.message:
            raise db_error(error) from error
        changes = {"daily_405b_requests": 0, "last_405b_reset": today_utc()}
        try:
            rows = await supabase.update("profiles", {"id": f"eq.{user_id}"}, changes)
        except SupabaseError as retry_error:
            raise db_error(retry_error) from retry_error
    return _admin_user_row(rows[0] if rows else {**target, **changes})


@router.get("/admin/users/{user_id}/conversations")
async def admin_user_conversations(user_id: UUID, actor: CurrentUser = Depends(require_admin)):
    """Solo títulos y metadatos: el contenido NO se expone por privacidad."""
    await _get_target(user_id)
    try:
        rows, total = await supabase.select(
            "conversations",
            {
                "user_id": f"eq.{user_id}",
                "select": "id,title,model_used,created_at,updated_at",
                "order": "updated_at.desc",
                "limit": 200,
            },
            count=True,
        )
    except SupabaseError as error:
        raise db_error(error) from error
    return {"conversations": rows, "total": total}


@router.get("/admin/stats")
async def admin_stats(actor: CurrentUser = Depends(require_admin)):
    today = today_utc()
    try:
        (total_users, active_today, total_conversations, total_messages, max_users, banned_users) = (
            await asyncio.gather(
                supabase.count("profiles"),
                supabase.count("profiles", {"last_seen_at": f"gte.{today}T00:00:00Z"}),
                supabase.count("conversations"),
                supabase.count("messages"),
                supabase.count("profiles", {"role": "eq.max"}),
                supabase.count("profiles", {"is_banned": "eq.true"}),
            )
        )
    except SupabaseError as error:
        raise db_error(error) from error
    return {
        "total_users": total_users,
        "active_today": active_today,
        "total_conversations": total_conversations,
        "total_messages": total_messages,
        "max_users": max_users,
        "banned_users": banned_users,
    }
