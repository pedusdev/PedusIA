"""
Configuración central de PedusIA.
Todas las variables sensibles se leen de variables de entorno (o del archivo .env en local).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

ENV_FILE = Path(__file__).resolve().parent / ".env"
SECRET_NAMES = ("GROQ_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY")

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


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


class Settings:
    """Contenedor de configuración (solo lectura en tiempo de ejecución)."""

    APP_NAME = "PedusIA"
    VERSION = "1.0.0"

    # --- Entorno ---
    ENVIRONMENT = _env("ENVIRONMENT", "production")
    IS_PRODUCTION = ENVIRONMENT == "production"

    # --- Groq ---
    GROQ_API_KEY = _env("GROQ_API_KEY")
    GROQ_BASE_URL = _env("GROQ_BASE_URL", "https://api.groq.com/openai/v1")

    # Cadenas de modelos por nivel. Se prueba el primero y, si Groq dice que
    # no existe / no está disponible para tu cuenta, se pasa al siguiente.
    MODEL_CHAIN_BASIC = _env_list("GROQ_MODEL_BASIC", "llama-3.1-8b-instant,openai/gpt-oss-20b")
    MODEL_CHAIN_PRO = _env_list("GROQ_MODEL_PRO", "llama-3.3-70b-versatile,openai/gpt-oss-120b")
    MODEL_CHAIN_ULTRA = _env_list(
        "GROQ_MODEL_ULTRA", "llama-3.1-405b-reasoning,openai/gpt-oss-120b"
    )
    MODEL_CHAIN_TITLE = _env_list("GROQ_MODEL_TITLE", "llama-3.1-8b-instant,openai/gpt-oss-20b")
    # Modelo con visión para analizar imágenes adjuntas (vacío = desactivado)
    GROQ_VISION_MODEL = _env("GROQ_VISION_MODEL", "qwen/qwen3.8-27b")
    # Modelo de transcripción (respaldo de voz para navegadores sin Web Speech API)
    GROQ_STT_MODEL = _env("GROQ_STT_MODEL", "whisper-large-v3-turbo")

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
