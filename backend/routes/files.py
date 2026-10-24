"""
Subida de archivos (imágenes, PDF, texto) y transcripción de voz de respaldo.
"""
import io
import logging
import uuid

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool

from config import settings
from middleware.auth_middleware import CurrentUser, get_current_user
from middleware.rate_limiter import check_limit, upload_limiter
from services.groq_service import GroqError
from services.supabase_service import SupabaseError, supabase
from services.tts_stt_service import ALLOWED_AUDIO_TYPES, MAX_AUDIO_BYTES, transcribe_audio
from utils.helpers import EXTENSION_FOR_MIME, IMAGE_TYPES, APIError, decode_text, detect_mime, safe_filename

logger = logging.getLogger("pedusia.files")
router = APIRouter(tags=["files"])

MAX_EXTRACTED_CHARS = 60000
MAX_PDF_PAGES = 60


def _extract_pdf_text(content: bytes) -> str:
    """Extrae el texto de un PDF (se ejecuta en un hilo aparte)."""
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:  # noqa: BLE001
                return ""
        pages = []
        total = 0
        for page in reader.pages[:MAX_PDF_PAGES]:
            page_text = page.extract_text() or ""
            pages.append(page_text)
            total += len(page_text)
            if total > MAX_EXTRACTED_CHARS:
                break
        return "\n\n".join(pages).strip()[:MAX_EXTRACTED_CHARS]
    except Exception as error:  # noqa: BLE001 - PDF corrupto o no soportado
        logger.warning("No se pudo leer el PDF: %s", error)
        return ""


@router.post("/files/upload")
async def upload_file(file: UploadFile = File(...), user: CurrentUser = Depends(get_current_user)):
    check_limit(upload_limiter, user.id)

    content = await file.read(settings.MAX_UPLOAD_BYTES + 1)
    if len(content) > settings.MAX_UPLOAD_BYTES:
        raise APIError(413, "file_too_large", "El archivo supera los 10 MB.")
    if not content:
        raise APIError(400, "empty_file", "El archivo está vacío.")

    # Validar el tipo REAL por contenido
    mime = detect_mime(content, file.filename)
    if not mime:
        raise APIError(415, "invalid_file_type", "Tipo de archivo no permitido.")

    file_name = safe_filename(file.filename)
    path = f"{user.id}/{uuid.uuid4().hex}{EXTENSION_FOR_MIME[mime]}"

    # Extraer texto para incluirlo en el contexto del modelo
    extracted = ""
    if mime == "application/pdf":
        extracted = await run_in_threadpool(_extract_pdf_text, content)
    elif mime.startswith("text/"):
        extracted = decode_text(content)[:MAX_EXTRACTED_CHARS]

    try:
        url = await supabase.upload_file(settings.BUCKET_UPLOADS, path, content, mime)
        rows = await supabase.insert(
            "uploaded_files",
            {
                "user_id": user.id,
                "file_name": file_name,
                "file_url": url,
                "file_type": mime,
                "file_size": len(content),
                "extracted_text": extracted or None,
            },
        )
    except SupabaseError as error:
        logger.error("Error subiendo archivo: %s", error.message)
        raise APIError(503, "upload_failed", "No se pudo subir el archivo. Intenta de nuevo.") from error

    row = rows[0]
    return {
        "id": row["id"],
        "file_name": file_name,
        "file_url": url,
        "file_type": mime,
        "file_size": len(content),
        "is_image": mime in IMAGE_TYPES,
        "has_text": bool(extracted),
    }


@router.post("/voice/transcribe")
async def voice_transcribe(
    audio: UploadFile = File(...),
    language: str = Form(""),
    user: CurrentUser = Depends(get_current_user),
):
    """Respaldo de Speech-to-Text (Whisper) para navegadores sin Web Speech API."""
    check_limit(upload_limiter, user.id)
    content_type = (audio.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_AUDIO_TYPES:
        raise APIError(415, "invalid_file_type", "Formato de audio no soportado.")
    content = await audio.read(MAX_AUDIO_BYTES + 1)
    if len(content) > MAX_AUDIO_BYTES:
        raise APIError(413, "file_too_large", "El audio es demasiado largo.")
    if len(content) < 500:
        return {"text": ""}
    try:
        text = await transcribe_audio(content, audio.filename or "audio.webm", content_type, language[:2])
    except GroqError as error:
        logger.warning("Error de transcripción: %s", error.message)
        raise APIError(502, "stt_failed", "No se pudo transcribir el audio. Intenta de nuevo.") from error
    return {"text": text}
