"""
Funciones auxiliares compartidas por todo el backend.
"""
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path


class APIError(Exception):
    """
    Error controlado de la API. Se convierte en una respuesta JSON limpia:
    { "error": "<codigo>", "message": "<mensaje amigable>", ...extra }
    """

    def __init__(self, status_code: int, error: str, message: str, **extra):
        super().__init__(message)
        self.status_code = status_code
        self.error = error
        self.message = message
        self.extra = extra

    def to_dict(self) -> dict:
        return {"error": self.error, "message": self.message, **self.extra}


# --------------------------------------------------------------------------
# Fechas
# --------------------------------------------------------------------------

def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def today_utc() -> str:
    """Fecha de hoy (UTC) en formato YYYY-MM-DD."""
    return utc_now().date().isoformat()


def next_reset_iso() -> str:
    """Momento del próximo reinicio del contador diario (00:00 UTC de mañana)."""
    tomorrow = utc_now().date() + timedelta(days=1)
    return datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


# --------------------------------------------------------------------------
# Texto
# --------------------------------------------------------------------------

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_text(value: str | None, max_length: int | None = None) -> str:
    """
    Normaliza texto de entrada: elimina caracteres de control, espacios
    sobrantes y recorta a la longitud máxima. El escapado HTML se hace en el
    frontend al renderizar (nunca se inserta HTML de usuario sin sanitizar).
    """
    if not value:
        return ""
    text = unicodedata.normalize("NFC", str(value))
    text = _CONTROL_CHARS.sub("", text).strip()
    if max_length is not None:
        text = text[:max_length]
    return text


def sanitize_search(value: str | None) -> str:
    """Limpia un término de búsqueda para usarlo en filtros de PostgREST."""
    text = clean_text(value, 80)
    # Quitar caracteres con significado especial en la sintaxis de PostgREST
    return re.sub(r"[,()*%\\:\"']", " ", text).strip()


def safe_filename(name: str | None, default: str = "archivo") -> str:
    """Nombre de archivo seguro para mostrar/guardar."""
    base = clean_text(name or default, 120)
    base = re.sub(r"[\\/<>:\"|?*]", "_", base)
    return base or default


def sse(data: dict) -> str:
    """Formatea un evento Server-Sent Event."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def truncate_words(text: str, max_words: int) -> str:
    words = text.split()
    return " ".join(words[:max_words])


# --------------------------------------------------------------------------
# Archivos: detección de tipo MIME REAL por "magic bytes"
# --------------------------------------------------------------------------

IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
TEXT_EXTENSIONS = {".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv"}
EXTENSION_FOR_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
}


def detect_mime(content: bytes, filename: str | None) -> str | None:
    """
    Detecta el tipo real del archivo mirando su contenido (no solo la extensión).
    Devuelve el MIME si está permitido, o None si no lo está.
    """
    if not content:
        return None
    head = content[:16]
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"%PDF-"):
        return "application/pdf"

    # Archivos de texto: deben tener extensión permitida y ser UTF-8 válido sin bytes nulos
    ext = Path(filename or "").suffix.lower()
    if ext in TEXT_EXTENSIONS:
        if b"\x00" in content[:4096]:
            return None
        try:
            content.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                content.decode("latin-1")
            except UnicodeDecodeError:
                return None
        return TEXT_EXTENSIONS[ext]
    return None


def decode_text(content: bytes) -> str:
    """Decodifica bytes de texto probando UTF-8 y luego Latin-1."""
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return content.decode("latin-1", errors="replace")
