"""
Servicios de voz.

La voz principal funciona 100% en el navegador con la Web Speech API (gratis):
- Speech-to-Text: SpeechRecognition (Chrome, Edge, Safari).
- Text-to-Speech: speechSynthesis (todos los navegadores modernos).

Este servicio añade:
1. Un RESPALDO de transcripción con Whisper en Groq para navegadores sin
   SpeechRecognition (por ejemplo Firefox). El navegador graba audio con
   MediaRecorder y lo envía a /api/v1/voice/transcribe.
2. Limpieza de Markdown para lectura en voz alta (usada también como
   referencia por el frontend).
"""
import re

import httpx

from config import settings
from services.groq_service import GroqError

ALLOWED_AUDIO_TYPES = {
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/m4a",
    "audio/x-m4a",
    "video/webm",  # algunos navegadores etiquetan así el audio de MediaRecorder
}
MAX_AUDIO_BYTES = 15 * 1024 * 1024


async def transcribe_audio(content: bytes, filename: str, content_type: str, language: str | None = None) -> str:
    """Transcribe audio con Whisper (Groq). Devuelve el texto reconocido."""
    if not settings.GROQ_API_KEY:
        raise GroqError(500, "missing_api_key", "GROQ_API_KEY no configurada")

    data = {"model": settings.GROQ_STT_MODEL, "response_format": "json", "temperature": "0"}
    if language and re.fullmatch(r"[a-z]{2}", language):
        data["language"] = language

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{settings.GROQ_BASE_URL}/audio/transcriptions",
                headers={"Authorization": f"Bearer {settings.GROQ_API_KEY}"},
                data=data,
                files={"file": (filename or "audio.webm", content, content_type or "audio/webm")},
            )
    except httpx.HTTPError as error:
        raise GroqError(502, "connection", str(error)) from error

    if response.status_code != 200:
        raise GroqError(response.status_code, "stt_error", response.text[:300])
    return str(response.json().get("text", "")).strip()


def clean_text_for_speech(markdown_text: str) -> str:
    """Convierte Markdown en texto natural para leer en voz alta."""
    text = re.sub(r"```[\s\S]*?```", " (bloque de código) ", markdown_text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*_~>|]", "", text)
    text = re.sub(r"^\s*[-+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{2,}", ". ", text)
    return re.sub(r"\s+", " ", text).strip()
