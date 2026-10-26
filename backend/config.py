"""
Configuración central de PedusGPT.
Todas las variables sensibles se leen de variables de entorno (o del archivo .env en local).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

ENV_FILE = Path(__file__).resolve().parent / ".env"
SECRET_NAMES = (
    "GROQ_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY",
    "MISTRAL_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY",
)

# Variables que ya existían en el sistema ANTES de leer el .env (útil para el diagnóstico:
# una GROQ_API_KEY antigua guardada en Windows/macOS podía "tapar" la del .env).
SYSTEM_ENV_VARS = {name for name in SECRET_NAMES if os.environ.get(name)}

# Cargar .env si existe. override=True: en local el .env manda sobre las variables del sistema.
# (En Render no hay .env: las variables vienen del panel y esto no cambia nada.)
load_dotenv(ENV_FILE, override=True)

# Caracteres invisibles que a veces se cuelan al copiar y pegar
_INVISIBLE = "\u200b\u200c\u200d\u2060\ufeff\u00a0"


def _env(name: str, default: str = "") -> str:
    """Lee una variable de entorno y elimina espacios, comillas y caracteres invisibles."""
    value = os.getenv(name, default) or ""
    for char in _INVISIBLE:
        value = value.replace(char, "")
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return value


def _env_list(name: str, default: str) -> list[str]:
    """Lee una lista separada por comas (ej: cadenas de modelos de respaldo)."""
    raw = _env(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


# Modelos retirados (devuelven error y solo hacen perder tiempo) y su sustituto.
# Así, aunque en Render quede una variable GROQ_MODEL_* antigua, no se intenta usar.
RETIRED_MODELS = {
    "llama-3.1-8b-instant": "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
    "llama-3.1-405b-reasoning": "openai/gpt-oss-120b",
    "llama3-8b-8192": "openai/gpt-oss-20b",
    "llama3-70b-8192": "openai/gpt-oss-120b",
    "groq/compound": "openai/gpt-oss-120b",
    "groq/compound-mini": "openai/gpt-oss-20b",
    "qwen/qwen3-32b": "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b": "qwen/qwen3.8-27b",
    "meta-llama/llama-4-scout-17b-16e-instruct": "qwen/qwen3.8-27b",
    "moonshotai/kimi-k2-instruct": "openai/gpt-oss-120b",
    "mistral:magistral-medium-latest": "mistral:mistral-medium-latest",
    "mistral:magistral-small-latest": "mistral:mistral-small-latest",
}


# Valores por defecto de versiones anteriores (los copió render.yaml / .env.example).
# Si una variable conserva EXACTAMENTE ese valor antiguo, se usa el nuevo valor por defecto
# (con Mistral y sin modelos retirados) sin que tengas que tocar nada en Render.
LEGACY_CHAIN_DEFAULTS = {
    "GROQ_MODEL_BASIC": "llama-3.1-8b-instant,openai/gpt-oss-20b",
    "GROQ_MODEL_PRO": "llama-3.3-70b-versatile,openai/gpt-oss-120b",
    "GROQ_MODEL_ULTRA": "llama-3.1-405b-reasoning,openai/gpt-oss-120b",
    "GROQ_MODEL_TITLE": "llama-3.1-8b-instant,openai/gpt-oss-20b",
    "GROQ_MODEL_DEEP": "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b",
    "GROQ_MODEL_REVIEW": "qwen/qwen3.8-27b,openai/gpt-oss-20b,openai/gpt-oss-120b",
    "GROQ_MODEL_ROUTER": "openai/gpt-oss-20b,llama-3.1-8b-instant",
    "PEDUSCODE_PLANNER_MODELS": "openai/gpt-oss-120b,llama-3.3-70b-versatile,openai/gpt-oss-20b",
    "PEDUSCODE_WORKER_MODELS": "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,llama-3.3-70b-versatile",
}


def _env_chain(name: str, default: str) -> list[str]:
    """Cadena de modelos: sustituye los retirados y elimina duplicados manteniendo el orden."""
    current = ",".join(item.strip() for item in _env(name, default).split(",") if item.strip())
    if current == LEGACY_CHAIN_DEFAULTS.get(name):
        current = default
    chain: list[str] = []
    for model in [item.strip() for item in current.split(",") if item.strip()]:
        model = RETIRED_MODELS.get(model, model)
        if model not in chain:
            chain.append(model)
    return chain or _env_list(name, default)


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


class Settings:
    """Contenedor de configuración (solo lectura en tiempo de ejecución)."""

    APP_NAME = "PedusGPT"
    VERSION = "1.0.0"

    # --- Entorno ---
    ENVIRONMENT = _env("ENVIRONMENT", "production")
    IS_PRODUCTION = ENVIRONMENT == "production"

    # --- Groq ---
    GROQ_API_KEY = _env("GROQ_API_KEY")
    GROQ_BASE_URL = _env("GROQ_BASE_URL", "https://api.groq.com/openai/v1")

    # Cadenas de modelos por nivel. Se prueba el primero y, si no existe, no está
    # disponible para tu cuenta, está saturado o el proveedor falla, se pasa al siguiente.
    # Formato: "modelo" o "groq:modelo" = Groq · "mistral:modelo" = Mistral (respaldo / ULTRA).
    # Los modelos de Mistral se saltan solos si no hay MISTRAL_API_KEY.
    MODEL_CHAIN_BASIC = _env_chain(
        "GROQ_MODEL_BASIC", "openai/gpt-oss-20b,qwen/qwen3.8-27b,mistral:mistral-small-latest"
    )
    MODEL_CHAIN_PRO = _env_chain(
        "GROQ_MODEL_PRO", "openai/gpt-oss-120b,mistral:mistral-medium-latest,qwen/qwen3.8-27b"
    )
    # PRO ULTRA: Mistral Large 4 (el más potente gratis) con Groq de respaldo
    MODEL_CHAIN_ULTRA = _env_chain(
        "GROQ_MODEL_ULTRA",
        "mistral:mistral-large-4,mistral:mistral-medium-latest,openai/gpt-oss-120b,qwen/qwen3.8-27b",
    )
    MODEL_CHAIN_TITLE = _env_chain(
        "GROQ_MODEL_TITLE", "openai/gpt-oss-20b,mistral:ministral-8b-latest,qwen/qwen3.8-27b"
    )
    # Modelo con visión para analizar imágenes adjuntas (vacío = desactivado)
    _vision = _env("GROQ_VISION_MODEL", "qwen/qwen3.8-27b")
    GROQ_VISION_MODEL = RETIRED_MODELS.get(_vision, _vision)
    # Modelo de transcripción (respaldo de voz para navegadores sin Web Speech API)
    GROQ_STT_MODEL = _env("GROQ_STT_MODEL", "whisper-large-v3-turbo")

    # --- Modo pensar y niveles de esfuerzo ---
    # Modelos para los esfuerzos Ultra y UltraMAX (el primero disponible).
    # Si tu cuenta tiene acceso Enterprise puedes poner delante meta-models/muse-spark-open.
    MODEL_CHAIN_DEEP = _env_chain(
        "GROQ_MODEL_DEEP",
        "mistral:mistral-large-4,openai/gpt-oss-120b,mistral:mistral-medium-latest,qwen/qwen3.8-27b",
    )
    # Modelo revisor de UltraMAX (otro modelo reparte el límite de tokens por minuto)
    MODEL_CHAIN_REVIEW = _env_chain(
        "GROQ_MODEL_REVIEW", "mistral:mistral-medium-latest,qwen/qwen3.8-27b,openai/gpt-oss-20b"
    )
    # Modelo rápido que decide qué skills encajan y si hace falta buscar en internet
    MODEL_CHAIN_ROUTER = _env_chain(
        "GROQ_MODEL_ROUTER", "openai/gpt-oss-20b,mistral:ministral-8b-latest,qwen/qwen3.8-27b"
    )
    # Respuestas UltraMAX al día para MAX/admin (el owner no tiene límite)
    ULTRAMAX_DAILY_LIMIT = _env_int("ULTRAMAX_DAILY_LIMIT", 10)
    # Segundos máximos que se espera a Groq cuando responde 429 antes de probar otro modelo
    GROQ_MAX_WAIT = max(0, _env_int("GROQ_MAX_WAIT", 40))

    # --- Skills ---
    SKILLS_MAX_PER_USER = max(1, _env_int("SKILLS_MAX_PER_USER", 20))
    SKILLS_MAX_OWNER = max(1, _env_int("SKILLS_MAX_OWNER", 100))
    # Caracteres de skills que se añaden al contexto de cada respuesta (todas las activas juntas).
    # Con el plan gratuito de Groq (8.000 tokens/min) no conviene pasar de ~12.000.
    SKILL_CONTEXT_CHARS = max(2000, _env_int("SKILL_CONTEXT_CHARS", 12000))
    # Opcional: token de GitHub (sin permisos) para importar skills sin el límite de 60 peticiones/hora
    GITHUB_TOKEN = _env("GITHUB_TOKEN")

    # --- Mistral (proveedor de respaldo y modelo principal de PRO ULTRA) ---
    # Opcional: sin clave, los modelos "mistral:..." de las cadenas se saltan.
    MISTRAL_API_KEY = _env("MISTRAL_API_KEY")
    MISTRAL_BASE_URL = _env("MISTRAL_BASE_URL", "https://api.mistral.ai/v1").rstrip("/")
    # Tokens por minuto de cada modelo de Mistral en tu cuenta (modo gratis: ~20.000)
    MISTRAL_TPM_LIMIT = max(4000, _env_int("MISTRAL_TPM_LIMIT", 20000))

    # --- Búsqueda web automática (Tavily principal + Exa de respaldo) ---
    # Opcionales: sin ninguna clave, la búsqueda web queda desactivada.
    TAVILY_API_KEY = _env("TAVILY_API_KEY")
    EXA_API_KEY = _env("EXA_API_KEY")
    WEB_SEARCH_ENABLED = _env("WEB_SEARCH_ENABLED", "true").lower() != "false"
    # Respuestas con búsqueda al día para user/max/admin (el owner no tiene límite)
    WEB_SEARCH_DAILY_LIMIT = max(1, _env_int("WEB_SEARCH_DAILY_LIMIT", 30))
    # Consultas máximas por mensaje (cada una gasta 1 crédito de Tavily)
    WEB_SEARCH_MAX_QUERIES = max(1, min(3, _env_int("WEB_SEARCH_MAX_QUERIES", 2)))
    # Resultados por consulta y caracteres de resultados que se añaden al contexto
    WEB_SEARCH_RESULTS = max(2, min(8, _env_int("WEB_SEARCH_RESULTS", 5)))
    WEB_SEARCH_CONTEXT_CHARS = max(1500, _env_int("WEB_SEARCH_CONTEXT_CHARS", 6000))

    MAX_TOKENS = _env_int("GROQ_MAX_TOKENS", 4096)
    TEMPERATURE = float(_env("GROQ_TEMPERATURE", "0.7") or 0.7)

    # --- Supabase ---
    SUPABASE_URL = _env("SUPABASE_URL").rstrip("/")
    SUPABASE_SERVICE_KEY = _env("SUPABASE_SERVICE_KEY")
    SUPABASE_ANON_KEY = _env("SUPABASE_ANON_KEY")
    # Opcional: si lo defines (proyectos con JWT secret HS256) los tokens se
    # verifican localmente sin llamar a Supabase. Si no, se verifican vía API.
    SUPABASE_JWT_SECRET = _env("SUPABASE_JWT_SECRET")

    BUCKET_UPLOADS = _env("SUPABASE_BUCKET_UPLOADS", "uploads")
    BUCKET_AVATARS = _env("SUPABASE_BUCKET_AVATARS", "avatars")

    # --- Roles / negocio ---
    OWNER_EMAIL = _env("OWNER_EMAIL").lower()
    ULTRA_DAILY_LIMIT = _env_int("ULTRA_DAILY_LIMIT", 30)
    CONTACT_EMAIL = _env("CONTACT_EMAIL", "equipo@pedusia.com")

    # --- PedusCode (agente de código con varios agentes en paralelo) ---
    # Ejecuciones al día para MAX/admin (el owner no tiene límite)
    PEDUSCODE_DAILY_LIMIT = _env_int("PEDUSCODE_DAILY_LIMIT", 3)
    # Modelo(s) del organizador: el primero disponible
    PEDUSCODE_PLANNER_MODELS = _env_chain(
        "PEDUSCODE_PLANNER_MODELS", "openai/gpt-oss-120b,mistral:mistral-medium-latest,openai/gpt-oss-20b"
    )
    # Modelos de los agentes. Se reparten entre todos para sumar sus límites por minuto.
    PEDUSCODE_WORKER_MODELS = _env_chain(
        "PEDUSCODE_WORKER_MODELS",
        "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,mistral:mistral-medium-latest",
    )
    # Máximo de agentes trabajadores (organizador + 9 = 10 llamadas)
    PEDUSCODE_MAX_AGENTS = max(1, min(9, _env_int("PEDUSCODE_MAX_AGENTS", 9)))
    # Tokens por minuto que permite Groq a CADA modelo en tu cuenta
    # (plan gratuito: 8000). Si pagas el plan Developer, súbelo y irá más rápido.
    GROQ_TPM_LIMIT = max(2000, _env_int("GROQ_TPM_LIMIT", 8000))
    # Tokens máximos que puede escribir cada agente
    PEDUSCODE_WORKER_MAX_TOKENS = max(800, _env_int("PEDUSCODE_WORKER_MAX_TOKENS", 4000))

    # --- Límites ---
    MAX_UPLOAD_BYTES = _env_int("MAX_UPLOAD_MB", 10) * 1024 * 1024
    MAX_AVATAR_BYTES = 5 * 1024 * 1024
    MAX_MESSAGE_CHARS = _env_int("MAX_MESSAGE_CHARS", 16000)
    HISTORY_LIMIT = _env_int("HISTORY_LIMIT", 20)
    MAX_FILE_CONTEXT_CHARS = _env_int("MAX_FILE_CONTEXT_CHARS", 12000)

    # --- Seguridad ---
    ALLOWED_ORIGINS = _env_list("ALLOWED_ORIGINS", "")
    ENABLE_CSP = _env("ENABLE_CSP", "true").lower() == "true"

    # --- Rutas ---
    BASE_DIR = Path(__file__).resolve().parent
    FRONTEND_DIR = Path(_env("FRONTEND_DIR", str(BASE_DIR.parent / "frontend"))).resolve()

    def missing_required(self) -> list[str]:
        """Devuelve la lista de variables obligatorias que faltan."""
        required = {
            "GROQ_API_KEY": self.GROQ_API_KEY,
            "SUPABASE_URL": self.SUPABASE_URL,
            "SUPABASE_SERVICE_KEY": self.SUPABASE_SERVICE_KEY,
            "SUPABASE_ANON_KEY": self.SUPABASE_ANON_KEY,
        }
        return [name for name, value in required.items() if not value]


settings = Settings()
