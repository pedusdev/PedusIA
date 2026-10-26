"""
Endpoints de autenticación y configuración pública.

El login/registro (email + Google OAuth) lo gestiona Supabase Auth directamente
desde el navegador con la anon key. El backend:
- expone la configuración PÚBLICA necesaria (/config),
- valida la sesión y devuelve el perfil (/auth/me).
"""
from fastapi import APIRouter, Depends

from config import settings
from middleware.auth_middleware import CurrentUser, get_current_user
from routes.users import serialize_profile
from services.groq_service import EFFORTS, MODEL_CATALOG
from services.search_service import search_enabled

router = APIRouter(tags=["auth"])


@router.get("/config")
async def public_config():
    """Configuración pública para el frontend (nunca incluye claves secretas)."""
    return {
        "supabase_url": settings.SUPABASE_URL,
        "supabase_anon_key": settings.SUPABASE_ANON_KEY,
        "contact_email": settings.CONTACT_EMAIL,
        "ultra_daily_limit": settings.ULTRA_DAILY_LIMIT,
        "peduscode_daily_limit": settings.PEDUSCODE_DAILY_LIMIT,
        "peduscode_max_agents": settings.PEDUSCODE_MAX_AGENTS,
        "ultramax_daily_limit": settings.ULTRAMAX_DAILY_LIMIT,
        "efforts": [{"id": key, "max_only": info["max_only"]} for key, info in EFFORTS.items()],
        "skills_max": settings.SKILLS_MAX_PER_USER,
        "web_search": search_enabled(),
        "web_search_daily_limit": settings.WEB_SEARCH_DAILY_LIMIT,
        "max_upload_mb": settings.MAX_UPLOAD_BYTES // (1024 * 1024),
        "vision_enabled": bool(settings.GROQ_VISION_MODEL),
        "models": [
            {"id": key, "name": info["name"], "tier": info["tier"]} for key, info in MODEL_CATALOG.items()
        ],
        "configured": not settings.missing_required(),
    }


@router.get("/auth/me")
async def me(user: CurrentUser = Depends(get_current_user)):
    """Valida la sesión y devuelve el perfil (403 'banned' si está suspendido)."""
    return {"user": {"id": user.id, "email": user.email}, "profile": serialize_profile(user.profile)}
