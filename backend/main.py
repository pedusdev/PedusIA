"""
PedusIA — Servidor principal (FastAPI).

Sirve la API REST en /api/v1 y el frontend estático desde ../frontend.
Arranque local:  uvicorn main:app --reload --port 8000
"""
import asyncio
import html
import logging
import os
import re
import time
from pathlib import Path
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException

from config import settings
from middleware.rate_limiter import ip_limiter
from routes import auth, chat, conversations, files, users
from services.groq_service import groq_service
from services.supabase_service import SupabaseError, supabase
from utils.helpers import APIError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("pedusia")
# Silenciar el detalle interno de las peticiones HTTP (ensucia la terminal)
for _noisy in ("httpx", "httpcore"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    missing = settings.missing_required()
    if missing:
        logger.warning("⚠️  Faltan variables de entorno: %s", ", ".join(missing))
    logger.info("PedusIA %s arrancando. Frontend: %s", settings.VERSION, settings.FRONTEND_DIR)
    yield
    await supabase.close()
    await groq_service.close()


app = FastAPI(
    title="PedusIA API",
    version=settings.VERSION,
    lifespan=lifespan,
    docs_url=None if settings.IS_PRODUCTION else "/docs",
    redoc_url=None,
    openapi_url=None if settings.IS_PRODUCTION else "/openapi.json",
)

# --------------------------------------------------------------------------
# CORS: solo los orígenes configurados (el frontend se sirve desde el mismo
# dominio, así que en producción normalmente no hace falta ninguno).
# --------------------------------------------------------------------------
if settings.ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )


def _content_security_policy() -> str:
    supabase_origin = ""
    supabase_ws = ""
    if settings.SUPABASE_URL:
        parsed = urlparse(settings.SUPABASE_URL)
        supabase_origin = f"{parsed.scheme}://{parsed.netloc}"
        supabase_ws = f"wss://{parsed.netloc}"
    return "; ".join(
        [
            "default-src 'self'",
            "script-src 'self' https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com data:",
            "img-src 'self' data: blob: https:",
            f"connect-src 'self' https://cdn.jsdelivr.net {supabase_origin} {supabase_ws}".strip(),
            "media-src 'self' blob: data:",
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            f"form-action 'self' {supabase_origin}".strip(),
        ]
    )


CSP_HEADER = _content_security_policy()


class SecurityMiddleware:
    """
    Middleware ASGI puro (compatible con streaming SSE):
    cabeceras de seguridad + limitador general por IP para /api.
    """

    def __init__(self, asgi_app):
        self.app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path.startswith("/api/") and not path.endswith("/health"):
            request = Request(scope)
            forwarded = request.headers.get("x-forwarded-for", "")
            client_ip = forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")
            if not ip_limiter.allow(client_ip):
                response = JSONResponse(
                    status_code=429,
                    content={"error": "too_many_requests", "message": "Vas demasiado rápido. Espera un momento."},
                )
                await response(scope, receive, send)
                return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
                headers.setdefault("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
                if settings.ENABLE_CSP and headers.get("content-type", "").startswith("text/html"):
                    headers.setdefault("Content-Security-Policy", CSP_HEADER)
                if path.startswith("/api/"):
                    headers.setdefault("Cache-Control", "no-store")
            await send(message)

        await self.app(scope, receive, send_with_headers)


app.add_middleware(SecurityMiddleware)


# --------------------------------------------------------------------------
# Manejadores de errores: SIEMPRE respuestas limpias, nunca trazas crudas.
# --------------------------------------------------------------------------
@app.exception_handler(APIError)
async def api_error_handler(_request: Request, exc: APIError):
    return JSONResponse(status_code=exc.status_code, content=exc.to_dict())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422, content={"error": "invalid_request", "message": "Los datos enviados no son válidos."}
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    # Rutas no-API desconocidas: devolver la SPA
    if exc.status_code == 404 and not request.url.path.startswith("/api/"):
        page = _render_index(request)
        if page is not None:
            return page
    messages = {404: "Recurso no encontrado.", 405: "Método no permitido."}
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": "http_error", "message": messages.get(exc.status_code, "Ups, algo salió mal.")},
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_request: Request, exc: Exception):
    logger.exception("Error no controlado: %s", exc)
    return JSONResponse(
        status_code=500, content={"error": "server_error", "message": "Ups, algo salió mal. Intenta de nuevo."}
    )


# --------------------------------------------------------------------------
# Rutas
# --------------------------------------------------------------------------
API_PREFIX = "/api/v1"


@app.api_route(f"{API_PREFIX}/health", methods=["GET", "HEAD"], tags=["health"])
@app.api_route("/health", methods=["GET", "HEAD"], include_in_schema=False)
async def health():
    """
    Usado por UptimeRobot para mantener Render despierto.
    Además, como mucho cada 6 horas hace una consulta mínima a Supabase en segundo
    plano para que el proyecto gratuito no se pause por inactividad.
    """
    global _last_db_ping
    now = time.monotonic()
    if not settings.missing_required() and now - _last_db_ping > DB_PING_INTERVAL:
        _last_db_ping = now
        task = asyncio.create_task(_ping_database())
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
    return {"status": "ok", "version": settings.VERSION}


DB_PING_INTERVAL = 6 * 60 * 60  # segundos
_last_db_ping = -DB_PING_INTERVAL
_background_tasks: set = set()


async def _ping_database() -> None:
    """Consulta ligera para registrar actividad en Supabase."""
    try:
        await supabase.count("profiles", {"limit": "1"})
    except Exception as error:  # noqa: BLE001 — nunca debe tumbar /health
        logger.warning("Ping a Supabase fallido: %s", error)


# --------------------------------------------------------------------------
# DIAGNÓSTICO (solo con ENVIRONMENT=development)
# Abre http://localhost:8000/api/v1/diagnostico para comprobar claves y servicios.
# Nunca muestra las claves, solo si funcionan.
# --------------------------------------------------------------------------
def _short(text: str, limit: int = 300) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text if len(text) <= limit else text[:limit] + "…"


async def _diag_supabase_rest() -> dict:
    try:
        total = await supabase.count("profiles")
        return {"ok": True, "detalle": f"Base de datos OK. Perfiles registrados: {total}"}
    except SupabaseError as error:
        hint = "Revisa SUPABASE_URL y SUPABASE_SERVICE_KEY (secret key)."
        if "permission denied" in error.message:
            hint = (
                "Faltan los permisos de la Data API (cambio de Supabase de 2026). "
                "Vuelve a ejecutar el supabase/schema.sql ACTUALIZADO en el SQL Editor."
            )
        elif "does not exist" in error.message or "PGRST205" in error.message or error.status_code == 404:
            hint = "La tabla 'profiles' no existe: ejecuta supabase/schema.sql en el SQL Editor."
        return {"ok": False, "status": error.status_code, "error": _short(error.message), "solucion": hint}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": _short(str(error)), "solucion": "Revisa SUPABASE_URL (¿está bien escrita?)."}


async def _diag_supabase_auth() -> dict:
    try:
        response = await supabase.client.get(
            f"{settings.SUPABASE_URL}/auth/v1/settings", headers={"apikey": settings.SUPABASE_ANON_KEY}
        )
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": _short(str(error)), "solucion": "Revisa SUPABASE_URL."}
    if response.status_code != 200:
        return {
            "ok": False,
            "status": response.status_code,
            "error": _short(response.text),
            "solucion": "Revisa SUPABASE_ANON_KEY (publishable key sb_publishable_... o anon).",
        }
    data = response.json()
    external = data.get("external", {}) or {}
    return {
        "ok": True,
        "detalle": "Auth OK (la publishable key funciona).",
        "registro_email_activado": bool(external.get("email")),
        "google_activado": bool(external.get("google")),
        "confirmacion_email_obligatoria": not data.get("mailer_autoconfirm", False),
        "registro_desactivado": bool(data.get("disable_signup")),
    }


async def _diag_storage() -> dict:
    result: dict = {"ok": True}
    for bucket in (settings.BUCKET_AVATARS, settings.BUCKET_UPLOADS):
        try:
            response = await supabase.client.get(
                f"{settings.SUPABASE_URL}/storage/v1/bucket/{bucket}", headers=supabase._service_auth()
            )
            exists = response.status_code == 200
        except Exception:  # noqa: BLE001
            exists = False
        result[bucket] = "OK" if exists else "NO EXISTE"
        if not exists:
            result["ok"] = False
            result["solucion"] = "Ejecuta supabase/schema.sql para crear los buckets."
    return result


def _describe_key(name: str, value: str, prefix: str, expected_length: int | None = None) -> dict:
    """Describe una clave SIN revelarla: inicio, final, longitud, origen y avisos."""
    import config as config_module

    # getattr: funciona aunque config.py sea una versión antigua
    env_file = getattr(config_module, "ENV_FILE", Path(__file__).resolve().parent / ".env")
    system_vars = getattr(config_module, "SYSTEM_ENV_VARS", None)
    config_outdated = system_vars is None

    info: dict = {
        "vista_previa": f"{value[:4]}…{value[-4:]}" if len(value) > 10 else "(demasiado corta)",
        "longitud": len(value),
        "leida_de": "archivo .env" if env_file.exists() else "variables del sistema (no hay .env)",
    }
    warnings = []
    if not value.startswith(prefix):
        warnings.append(f"No empieza por '{prefix}'. ¿Has pegado otra cosa?")
    if expected_length and len(value) != expected_length:
        warnings.append(f"Las claves de Groq suelen medir {expected_length} caracteres y esta mide {len(value)}: puede estar cortada o tener algo de más.")
    if any(ch.isspace() for ch in value):
        warnings.append("Contiene espacios o saltos de línea en medio.")
    if any(ord(ch) > 127 for ch in value):
        warnings.append("Contiene caracteres raros (no ASCII): vuelve a copiarla.")
    if "tu_clave" in value or "xxxx" in value:
        warnings.append("Parece el texto de ejemplo, no tu clave real.")
    if config_outdated:
        warnings.append(
            "Tu backend/config.py es una versión ANTIGUA: sustitúyelo por el nuevo. La versión antigua "
            "no limpia la clave y deja que una variable de Windows tape la del .env."
        )
    elif name in system_vars:
        warnings.append(
            f"Tu ordenador también tiene una variable de sistema {name}. Ahora el .env tiene prioridad, "
            "pero conviene borrarla para evitar líos."
        )
    if warnings:
        info["avisos"] = warnings
    return info


async def _diag_groq() -> dict:
    key_info = _describe_key("GROQ_API_KEY", settings.GROQ_API_KEY, "gsk_", 56)
    result = await _diag_groq_request()
    result["clave"] = key_info
    return result


async def _diag_groq_request() -> dict:
    try:
        response = await groq_service.client.get(f"{settings.GROQ_BASE_URL}/models", headers=groq_service.headers)
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": _short(str(error))}
    if response.status_code != 200:
        return {"ok": False, "status": response.status_code, "error": _short(response.text), "solucion": (
            "La clave de Groq no es válida. Crea una nueva en https://console.groq.com/keys, "
            "pégala en GROQ_API_KEY (sin comillas ni espacios, empieza por gsk_) y reinicia uvicorn."
        )}
    available = {m.get("id") for m in response.json().get("data", [])}
    chains = {
        "PedusGPT 2": settings.MODEL_CHAIN_BASIC,
        "PedusGPT 2 PRO": settings.MODEL_CHAIN_PRO,
        "PedusGPT 2 PRO ULTRA": settings.MODEL_CHAIN_ULTRA,
        "Títulos": settings.MODEL_CHAIN_TITLE,
    }
    models = {}
    for name, chain in chains.items():
        usable = next((m for m in chain if m in available), None)
        models[name] = f"usará {usable}" if usable else f"⚠️ ninguno disponible de {chain}"
    if settings.GROQ_VISION_MODEL:
        models["Visión"] = "OK" if settings.GROQ_VISION_MODEL in available else f"⚠️ {settings.GROQ_VISION_MODEL} no disponible"
    return {"ok": True, "detalle": "Groq OK (la API key funciona).", "modelos": models}


if not settings.IS_PRODUCTION:

    @app.get(f"{API_PREFIX}/diagnostico", include_in_schema=False)
    async def diagnostico():
        missing = settings.missing_required()
        if missing:
            return {"ok": False, "faltan_variables": missing, "solucion": "Rellena estas variables en backend/.env y reinicia uvicorn."}
        parts = await asyncio.gather(
            _diag_supabase_rest(), _diag_supabase_auth(), _diag_storage(), _diag_groq(),
            return_exceptions=True,
        )
        rest, auth_check, storage, groq = (
            part if isinstance(part, dict) else {"ok": False, "error": f"Fallo del diagnóstico: {part}"}
            for part in parts
        )
        return {
            "ok": all(part["ok"] for part in (rest, auth_check, storage, groq)),
            "owner_email": settings.OWNER_EMAIL or "⚠️ sin configurar",
            "jwt_secret": "configurado (verificación local)" if settings.SUPABASE_JWT_SECRET else "vacío (verificación con Supabase, correcto en proyectos nuevos)",
            "supabase_base_de_datos": rest,
            "supabase_auth": auth_check,
            "supabase_storage": storage,
            "groq": groq,
        }


for module in (auth, chat, conversations, users, files):
    app.include_router(module.router, prefix=API_PREFIX)


# --------------------------------------------------------------------------
# SEO: página principal con URLs absolutas, robots.txt y sitemap.xml
# --------------------------------------------------------------------------
_INDEX_CACHE: dict[str, str] = {}
_VERIFICATION_RE = re.compile(r"^[A-Za-z0-9_\-]{10,100}$")


def _clean_env(name: str) -> str:
    """Lee una variable de entorno quitando espacios y comillas."""
    return os.getenv(name, "").strip().strip('"').strip("'").strip()


def _site_url(request: Request) -> str:
    """URL pública de la web, sin barra final.

    Orden: PUBLIC_URL (si la defines) → RENDER_EXTERNAL_URL (Render la pone
    sola) → la dirección con la que ha llegado la petición.
    """
    for name in ("PUBLIC_URL", "RENDER_EXTERNAL_URL"):
        value = _clean_env(name)
        if value.startswith(("http://", "https://")):
            return value.rstrip("/")
    return str(request.base_url).rstrip("/")


def _render_index(request: Request):
    """Devuelve index.html con la URL pública y la verificación de Google."""
    index = settings.FRONTEND_DIR / "index.html"
    if not index.exists():
        return None
    site = _site_url(request)
    verification = _clean_env("GOOGLE_SITE_VERIFICATION")
    # Si pegan la etiqueta entera de Google, extraemos solo el código
    match = re.search(r'content="([^"]+)"', verification)
    if match:
        verification = match.group(1)
    cache_key = f"{site}|{verification}|{index.stat().st_mtime}"
    page = _INDEX_CACHE.get(cache_key)
    if page is None:
        page = index.read_text(encoding="utf-8").replace("__SITE_URL__", html.escape(site, quote=True))
        meta = ""
        if verification and _VERIFICATION_RE.match(verification):
            meta = f'<meta name="google-site-verification" content="{verification}" />'
        page = page.replace("<!--GOOGLE_SITE_VERIFICATION-->", meta)
        _INDEX_CACHE.clear()
        _INDEX_CACHE[cache_key] = page
    return HTMLResponse(page, headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
async def home(request: Request):
    page = _render_index(request)
    if page is None:
        return JSONResponse(status_code=404, content={"error": "http_error", "message": "Recurso no encontrado."})
    return page


@app.get("/robots.txt", include_in_schema=False)
async def robots_txt(request: Request):
    site = _site_url(request)
    body = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "\n"
        f"Sitemap: {site}/sitemap.xml\n"
    )
    return PlainTextResponse(body)


@app.get("/sitemap.xml", include_in_schema=False)
async def sitemap_xml(request: Request):
    site = html.escape(_site_url(request))
    lastmod = time.strftime("%Y-%m-%d", time.gmtime((settings.FRONTEND_DIR / "index.html").stat().st_mtime)) \
        if (settings.FRONTEND_DIR / "index.html").exists() else time.strftime("%Y-%m-%d", time.gmtime())
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"  <url><loc>{site}/</loc><lastmod>{lastmod}</lastmod>"
        "<changefreq>weekly</changefreq><priority>1.0</priority></url>\n"
        "</urlset>\n"
    )
    return Response(body, media_type="application/xml")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(settings.FRONTEND_DIR / "assets" / "logo.png", media_type="image/png")


# Frontend estático (debe ir al final para no tapar la API)
if settings.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=settings.FRONTEND_DIR, html=True), name="frontend")
else:
    logger.warning("No se encontró la carpeta del frontend en %s", settings.FRONTEND_DIR)
