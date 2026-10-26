"""
Autenticación: verifica el JWT de Supabase en CADA petición, carga el perfil
y bloquea a los usuarios baneados.
"""
import asyncio
import logging
import time
from dataclasses import dataclass

import jwt
from fastapi import Depends, Request

from config import settings
from services.supabase_service import SupabaseError, supabase
from utils.helpers import APIError, clean_text, today_utc, utc_now

logger = logging.getLogger("pedusia.auth")

ROLES = ("user", "max", "admin", "owner")
ULTRA_ROLES = ("max", "admin", "owner")
ADMIN_ROLES = ("admin", "owner")

# Caché corta token -> usuario para no consultar Supabase Auth en cada request
_TOKEN_CACHE: dict[str, tuple[float, dict]] = {}
_TOKEN_TTL = 60.0
_TOKEN_CACHE_MAX = 5000
_last_seen_updates: dict[str, float] = {}


@dataclass
class CurrentUser:
    id: str
    email: str
    profile: dict

    @property
    def role(self) -> str:
        return self.profile.get("role", "user")

    @property
    def is_admin(self) -> bool:
        return self.role in ADMIN_ROLES

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"

    @property
    def has_ultra(self) -> bool:
        return self.role in ULTRA_ROLES


def _extract_token(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise APIError(401, "unauthorized", "Necesitas iniciar sesión.")
    token = header[7:].strip()
    if not token or len(token) > 4096:
        raise APIError(401, "unauthorized", "Necesitas iniciar sesión.")
    return token


async def _verify_token(token: str) -> dict:
    """Devuelve {'id','email','meta'} si el token es válido."""
    now = time.time()
    cached = _TOKEN_CACHE.get(token)
    if cached and cached[0] > now:
        return cached[1]

    user: dict | None = None
    # 1) Verificación local (rápida) si hay JWT secret HS256 configurado
    if settings.SUPABASE_JWT_SECRET:
        try:
            claims = jwt.decode(
                token, settings.SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated"
            )
            user = {
                "id": claims["sub"],
                "email": claims.get("email", ""),
                "meta": claims.get("user_metadata", {}) or {},
            }
        except jwt.ExpiredSignatureError as error:
            raise APIError(401, "session_expired", "Tu sesión ha expirado.") from error
        except jwt.InvalidTokenError:
            user = None  # puede ser un token firmado con claves asimétricas: probar remoto

    # 2) Verificación remota con Supabase Auth (funciona con cualquier tipo de clave)
    if user is None:
        try:
            auth_user = await supabase.get_auth_user(token)
        except SupabaseError as error:
            raise APIError(503, "auth_unavailable", "No se pudo verificar tu sesión. Intenta de nuevo.") from error
        if not auth_user or not auth_user.get("id"):
            raise APIError(401, "unauthorized", "Tu sesión no es válida. Inicia sesión de nuevo.")
        user = {
            "id": auth_user["id"],
            "email": auth_user.get("email", ""),
            "meta": auth_user.get("user_metadata", {}) or {},
        }

    if len(_TOKEN_CACHE) > _TOKEN_CACHE_MAX:
        for key in [k for k, v in _TOKEN_CACHE.items() if v[0] <= now] or list(_TOKEN_CACHE)[:1000]:
            _TOKEN_CACHE.pop(key, None)
    _TOKEN_CACHE[token] = (now + _TOKEN_TTL, user)
    return user


async def _touch_last_seen(user_id: str) -> None:
    """Actualiza last_seen_at como mucho cada 5 minutos por usuario."""
    now = time.time()
    if now - _last_seen_updates.get(user_id, 0) < 300:
        return
    _last_seen_updates[user_id] = now
    try:
        await supabase.update("profiles", {"id": f"eq.{user_id}"}, {"last_seen_at": utc_now().isoformat()})
    except SupabaseError:
        pass


async def get_or_create_profile(user_id: str, email: str, meta: dict) -> dict:
    """Carga el perfil; si no existe (usuarios antiguos) lo crea. Sincroniza el owner."""
    try:
        profile = await supabase.select_one("profiles", {"id": f"eq.{user_id}", "select": "*"})
        if profile is None:
            display_name = clean_text(meta.get("full_name") or meta.get("name") or email.split("@")[0], 60)
            rows = await supabase.insert(
                "profiles",
                {
                    "id": user_id,
                    "email": email,
                    "display_name": display_name or "Usuario",
                    "avatar_url": meta.get("avatar_url") or meta.get("picture"),
                },
                upsert=True,
            )
            profile = rows[0]

        # El owner se define por OWNER_EMAIL (si está configurado)
        if settings.OWNER_EMAIL:
            is_owner_email = (profile.get("email") or email).lower() == settings.OWNER_EMAIL
            changes = {}
            if is_owner_email and (profile.get("role") != "owner" or profile.get("is_banned")):
                changes = {"role": "owner", "is_banned": False, "ban_reason": None}
            elif not is_owner_email and profile.get("role") == "owner":
                changes = {"role": "admin"}  # solo puede haber un owner
            if changes:
                rows = await supabase.update("profiles", {"id": f"eq.{user_id}"}, changes)
                if rows:
                    profile = rows[0]
        return profile
    except SupabaseError as error:
        logger.error("Error cargando perfil: %s", error.message)
        raise APIError(503, "db_unavailable", "Error al cargar datos. Recarga la página.") from error


async def get_current_user_allow_banned(request: Request) -> CurrentUser:
    """Igual que get_current_user pero NO bloquea a usuarios baneados."""
    token = _extract_token(request)
    auth = await _verify_token(token)
    profile = await get_or_create_profile(auth["id"], auth["email"], auth["meta"])
    asyncio.create_task(_touch_last_seen(auth["id"]))
    return CurrentUser(id=auth["id"], email=auth["email"] or profile.get("email", ""), profile=profile)


async def get_current_user(user: CurrentUser = Depends(get_current_user_allow_banned)) -> CurrentUser:
    """Dependencia principal: usuario autenticado y NO baneado."""
    if user.profile.get("is_banned") and user.role != "owner":
        raise APIError(
            403,
            "banned",
            "Tu cuenta ha sido suspendida.",
            reason=user.profile.get("ban_reason") or "",
        )
    return user


async def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_admin:
        raise APIError(403, "forbidden", "No tienes permiso para esta acción.")
    return user


def ultra_usage(profile: dict) -> dict:
    """Uso diario del modelo ULTRA a partir del perfil."""
    role = profile.get("role", "user")
    used = profile.get("daily_405b_requests") or 0
    if str(profile.get("last_405b_reset") or "") < today_utc():
        used = 0
    limit = settings.ULTRA_DAILY_LIMIT
    unlimited = role == "owner"
    return {
        "has_access": role in ULTRA_ROLES,
        "unlimited": unlimited,
        "used": used,
        "limit": limit,
        "remaining": None if unlimited else max(0, limit - used),
    }


def code_usage(profile: dict) -> dict:
    """Uso diario de PedusCode a partir del perfil."""
    role = profile.get("role", "user")
    used = profile.get("daily_code_runs") or 0
    if str(profile.get("last_code_reset") or "") < today_utc():
        used = 0
    limit = settings.PEDUSCODE_DAILY_LIMIT
    unlimited = role == "owner"
    return {
        "has_access": role in ULTRA_ROLES,
        "unlimited": unlimited,
        "used": used,
        "limit": limit,
        "remaining": None if unlimited else max(0, limit - used),
    }


def ultramax_usage(profile: dict) -> dict:
    """Uso diario del esfuerzo UltraMAX a partir del perfil."""
    role = profile.get("role", "user")
    used = profile.get("daily_ultramax_runs") or 0
    if str(profile.get("last_ultramax_reset") or "") < today_utc():
        used = 0
    limit = settings.ULTRAMAX_DAILY_LIMIT
    unlimited = role == "owner"
    return {
        "has_access": role in ULTRA_ROLES,
        "unlimited": unlimited,
        "used": used,
        "limit": limit,
        "remaining": None if unlimited else max(0, limit - used),
    }


def search_usage(profile: dict) -> dict:
    """Uso diario de la búsqueda web automática (todos los roles; el owner sin límite)."""
    role = profile.get("role", "user")
    used = profile.get("daily_search_requests") or 0
    if str(profile.get("last_search_reset") or "") < today_utc():
        used = 0
    limit = settings.WEB_SEARCH_DAILY_LIMIT
    unlimited = role == "owner"
    return {
        "has_access": True,
        "unlimited": unlimited,
        "used": used,
        "limit": limit,
        "remaining": None if unlimited else max(0, limit - used),
    }
