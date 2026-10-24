"""
Limitadores de uso:
1. Limitador general en memoria (ventana deslizante) contra abusos.
2. Límite diario del modelo PedusGPT 2 PRO ULTRA (persistido en Supabase,
   con incremento atómico mediante una función SQL).
"""
import time
from collections import defaultdict, deque

from config import settings
from middleware.auth_middleware import CurrentUser
from services.supabase_service import SupabaseError, supabase
from utils.helpers import APIError, next_reset_iso


class SlidingWindowLimiter:
    """Permite `limit` peticiones cada `window` segundos por clave."""

    def __init__(self, limit: int, window: float) -> None:
        self.limit = limit
        self.window = window
        self.hits: dict[str, deque] = defaultdict(deque)
        self._last_cleanup = time.time()

    def allow(self, key: str) -> bool:
        now = time.time()
        bucket = self.hits[key]
        while bucket and bucket[0] <= now - self.window:
            bucket.popleft()
        if len(bucket) >= self.limit:
            return False
        bucket.append(now)
        self._cleanup(now)
        return True

    def _cleanup(self, now: float) -> None:
        # Limpieza periódica para que la memoria no crezca indefinidamente
        if now - self._last_cleanup < 300:
            return
        self._last_cleanup = now
        for key in [k for k, v in self.hits.items() if not v or v[-1] <= now - self.window]:
            del self.hits[key]


# Límites generales
ip_limiter = SlidingWindowLimiter(limit=240, window=60)       # todas las peticiones /api por IP
chat_limiter = SlidingWindowLimiter(limit=20, window=60)      # mensajes de chat por usuario
upload_limiter = SlidingWindowLimiter(limit=15, window=60)    # subidas por usuario
title_limiter = SlidingWindowLimiter(limit=20, window=60)


def check_limit(limiter: SlidingWindowLimiter, key: str) -> None:
    if not limiter.allow(key):
        raise APIError(429, "too_many_requests", "Vas demasiado rápido. Espera un momento.")


async def consume_ultra_request(user: CurrentUser) -> dict:
    """
    Aplica las reglas del modelo ULTRA:
    - user  -> 403 (necesita Plan MAX)
    - owner -> sin límite
    - max/admin -> máximo ULTRA_DAILY_LIMIT al día (reinicio 00:00 UTC)
    Devuelve el uso actualizado.
    """
    limit = settings.ULTRA_DAILY_LIMIT
    if not user.has_ultra:
        raise APIError(403, "needs_max", "Necesitas el Plan MAX para usar PedusGPT 2 PRO ULTRA.")
    if user.is_owner:
        return {"unlimited": True, "used": 0, "limit": limit, "remaining": None}

    try:
        new_count = await supabase.rpc("consume_405b_request", {"p_user_id": user.id, "p_limit": limit})
    except SupabaseError as error:
        raise APIError(503, "db_unavailable", "Error al cargar datos. Recarga la página.") from error

    if new_count is None or int(new_count) < 0:
        raise APIError(
            429,
            "rate_limit",
            f"Has alcanzado tu límite de {limit} mensajes diarios con PedusGPT 2 PRO ULTRA. Se restablecerá mañana.",
            remaining=0,
            resets_at=next_reset_iso(),
        )
    used = int(new_count)
    return {"unlimited": False, "used": used, "limit": limit, "remaining": max(0, limit - used)}


async def refund_ultra_request(user: CurrentUser) -> None:
    """Devuelve una petición ULTRA si Groq falló antes de generar nada."""
    if user.is_owner or not user.has_ultra:
        return
    try:
        await supabase.rpc("refund_405b_request", {"p_user_id": user.id})
    except SupabaseError:
        pass
