"""
PedusCode: endpoints del agente de código (solo Plan MAX).

POST /code/run    → ejecuta el organizador + agentes y emite el progreso por SSE.
GET  /code/usage  → ejecuciones usadas hoy.

El backend NUNCA escribe en el ordenador del usuario: solo devuelve el
contenido de los archivos. El navegador los guarda tras la confirmación.
"""
import asyncio
import logging
import time

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config import settings
from middleware.auth_middleware import CurrentUser, code_usage, get_current_user
from middleware.rate_limiter import check_limit, code_limiter, consume_code_run, refund_code_run
from services.groq_service import GroqError
from services.peduscode_service import (
    PLANNER_PROMPT,
    AgentPlan,
    Plan,
    build_key_files_text,
    build_tree_text,
    build_worker_messages,
    call_with_scheduler,
    estimate_tokens,
    parse_plan,
    parse_worker_output,
    safe_path,
)
from utils.helpers import APIError, clean_text, next_reset_iso, sse

logger = logging.getLogger("pedusia.code")
router = APIRouter(tags=["peduscode"])

MAX_TASK_CHARS = 4000
MAX_TOTAL_CHARS = 600_000      # contenido total de archivos que se puede enviar
MAX_FILE_CHARS = 120_000
RUN_TIMEOUT = 8 * 60           # una ejecución nunca dura más de 8 minutos
KEEPALIVE_SECONDS = 10


class CodeFile(BaseModel):
    path: str = Field(..., max_length=400)
    content: str = Field("", max_length=MAX_FILE_CHARS)


class TreeEntry(BaseModel):
    path: str = Field(..., max_length=400)
    size: int = 0


class CodeRunRequest(BaseModel):
    task: str = Field(..., min_length=1, max_length=MAX_TASK_CHARS + 500)
    folder_name: str = Field("", max_length=200)
    tree: list[TreeEntry] = Field(default_factory=list, max_length=3000)
    files: list[CodeFile] = Field(default_factory=list, max_length=600)


@router.get("/code/usage")
async def get_code_usage(user: CurrentUser = Depends(get_current_user)):
    return {**code_usage(user.profile), "resets_at": next_reset_iso()}


@router.post("/code/run")
async def code_run(body: CodeRunRequest, user: CurrentUser = Depends(get_current_user)):
    check_limit(code_limiter, user.id)
    if not user.has_ultra:
        raise APIError(403, "needs_max", "Necesitas el Plan MAX para usar PedusCode.")
    if not settings.GROQ_API_KEY:
        raise APIError(503, "not_configured", "La IA no está configurada en el servidor.")

    task = clean_text(body.task, MAX_TASK_CHARS)
    if len(task) < 3:
        raise APIError(400, "empty_task", "Describe qué quieres que haga PedusCode.")

    # Archivos enviados por el navegador (solo rutas seguras, nunca secretos)
    files: dict[str, str] = {}
    total = 0
    for item in body.files:
        path = safe_path(item.path)
        if not path:
            continue
        content = item.content.replace("\x00", "")
        total += len(content)
        if total > MAX_TOTAL_CHARS:
            raise APIError(413, "project_too_large", "El proyecto es demasiado grande. Elige una carpeta más concreta.")
        files[path] = content
    tree: list[dict] = []
    seen: set[str] = set()
    for entry in body.tree:
        path = safe_path(entry.path)
        if path and path not in seen:
            seen.add(path)
            tree.append({"path": path, "size": max(0, int(entry.size))})
    for path, content in files.items():
        if path not in seen:
            seen.add(path)
            tree.append({"path": path, "size": len(content.encode("utf-8"))})
    folder = clean_text(body.folder_name, 120)

    usage = await consume_code_run(user)
    return StreamingResponse(
        _run_stream(user, task, folder, tree, files, usage),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# --------------------------------------------------------------------------
# Ejecución
# --------------------------------------------------------------------------
def _planner_messages(task: str, folder: str, tree: list[dict], files: dict[str, str], tree_limit: int, key_limit: int):
    system = PLANNER_PROMPT.format(max_agents=settings.PEDUSCODE_MAX_AGENTS)
    user_text = (
        f"TAREA DEL USUARIO:\n{task}\n\n"
        f"CARPETA: {folder or '(sin carpeta: proyecto nuevo, se descargará como ZIP)'}\n\n"
        f"ESTRUCTURA ({len(tree)} archivos):\n{build_tree_text(tree, tree_limit)}\n\n"
        f"ARCHIVOS CLAVE:\n{build_key_files_text(files, key_limit) if key_limit else '(omitidos)'}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user_text}]


async def _make_plan(task, folder, tree, files, emit) -> Plan:
    """Llamada 1: el organizador. Se adapta al límite de tokens por minuto."""
    tpm = settings.GROQ_TPM_LIMIT
    messages = None
    for tree_limit, key_limit in ((5000, 3000), (3000, 1500), (1500, 0)):
        messages = _planner_messages(task, folder, tree, files, tree_limit, key_limit)
        input_tokens = sum(estimate_tokens(m["content"]) for m in messages)
        if input_tokens + 2500 <= tpm - 200:
            break
    max_tokens = max(1500, min(4500, tpm - input_tokens - 200))
    existing = {entry["path"] for entry in tree}

    async def on_wait(seconds: float):
        await emit({"type": "planner", "status": "waiting", "seconds": round(seconds)})

    last_error: Exception | None = None
    for attempt in range(2):
        result, model = await call_with_scheduler(
            settings.PEDUSCODE_PLANNER_MODELS, messages, max_tokens,
            json_mode=True, effort="low", on_wait=on_wait,
        )
        try:
            return parse_plan(result.content, existing)
        except (ValueError, TypeError) as error:
            last_error = error
            logger.warning("Plan no válido de %s (intento %d): %s", model, attempt + 1, error)
            messages = messages + [
                {"role": "assistant", "content": result.content[:1500]},
                {
                    "role": "user",
                    "content": "Tu respuesta no era un JSON válido o estaba incompleta. Devuelve SOLO el JSON, "
                    "más breve (instrucciones de máximo 500 caracteres y como mucho 6 agentes).",
                },
            ]
    raise ValueError(str(last_error))


async def _run_agent(agent: AgentPlan, task: str, plan: Plan, files: dict[str, str], emit) -> dict:
    """Llamadas 2-10: un agente programador."""
    tpm = settings.GROQ_TPM_LIMIT
    input_budget = int(min(tpm * 0.5, tpm - 2500 - 300))
    messages = build_worker_messages(task, plan, agent, files, input_budget)
    input_tokens = sum(estimate_tokens(m["content"]) for m in messages)
    max_tokens = max(1200, min(settings.PEDUSCODE_WORKER_MAX_TOKENS, tpm - input_tokens - 300))

    last_progress = 0.0

    async def on_delta(chars: int):
        nonlocal last_progress
        now = time.monotonic()
        if now - last_progress >= 0.4:
            last_progress = now
            await emit({"type": "agent", "id": agent.id, "status": "working", "chars": chars})

    async def on_wait(seconds: float):
        await emit({"type": "agent", "id": agent.id, "status": "waiting", "seconds": round(seconds)})

    async def on_model(model: str):
        await emit({"type": "agent", "id": agent.id, "status": "working", "chars": 0, "model": model.split("/")[-1]})

    allowed = {f["path"]: f for f in agent.files}
    try:
        result, _model = await call_with_scheduler(
            settings.PEDUSCODE_WORKER_MODELS, messages, max_tokens,
            effort="low", on_delta=on_delta, on_wait=on_wait, on_model=on_model,
        )
        produced, notes = parse_worker_output(result.content, allowed)
        for item in produced:
            await emit({
                "type": "file",
                "agent_id": agent.id,
                "path": item["path"],
                "action": item["action"],
                "content": item["content"],
                "truncated": item["truncated"],
            })
        missing = [path for path in allowed if path not in {p["path"] for p in produced}]
        status = "done" if produced else "error"
        await emit({
            "type": "agent", "id": agent.id, "status": status, "notes": notes, "missing": missing,
            "message": "" if produced else "El agente no devolvió archivos válidos.",
        })
        return {"id": agent.id, "files": len(produced), "ok": bool(produced)}
    except GroqError as error:
        logger.warning("Agente %s falló: %s", agent.id, error.message)
        await emit({"type": "agent", "id": agent.id, "status": "error", "message": error.friendly})
        return {"id": agent.id, "files": 0, "ok": False}


async def _run_stream(user: CurrentUser, task: str, folder: str, tree: list[dict], files: dict[str, str], usage: dict):
    started = time.monotonic()
    queue: asyncio.Queue = asyncio.Queue()

    async def emit(event: dict):
        await queue.put(event)

    async def orchestrate():
        try:
            await emit({"type": "planner", "status": "working"})
            try:
                plan = await _make_plan(task, folder, tree, files, emit)
            except GroqError as error:
                await refund_code_run(user)
                await emit({"type": "error", "code": error.code, "message": error.friendly, "refunded": True})
                return
            except ValueError:
                await refund_code_run(user)
                await emit({
                    "type": "error", "code": "bad_plan", "refunded": True,
                    "message": "El organizador no ha podido preparar un plan. Prueba a describir la tarea de otra forma.",
                })
                return
            if plan.refuse:
                await refund_code_run(user)
                await emit({"type": "refused", "message": plan.message, "refunded": True})
                return

            await emit({
                "type": "plan",
                "summary": plan.summary,
                "agents": [
                    {"id": a.id, "name": a.name, "emoji": a.emoji, "role": a.role, "files": a.files}
                    for a in plan.agents
                ],
            })
            results = await asyncio.gather(
                *(_run_agent(agent, task, plan, files, emit) for agent in plan.agents)
            )
            produced = sum(r["files"] for r in results)
            if produced == 0:
                await refund_code_run(user)
            await emit({
                "type": "done",
                "summary": plan.summary,
                "files": produced,
                "failed": [r["id"] for r in results if not r["ok"]],
                "seconds": round(time.monotonic() - started, 1),
                "refunded": produced == 0,
            })
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - nunca dejar el stream colgado
            logger.exception("Error en PedusCode: %s", error)
            await emit({"type": "error", "code": "server_error", "message": "Ups, algo salió mal. Intenta de nuevo."})
        finally:
            await queue.put(None)

    task_handle = asyncio.create_task(orchestrate())
    yield sse({"type": "start", "usage": {**usage, "resets_at": next_reset_iso()}})
    try:
        while True:
            if time.monotonic() - started > RUN_TIMEOUT:
                task_handle.cancel()
                yield sse({"type": "error", "code": "timeout", "message": "PedusCode ha tardado demasiado. Prueba con una tarea más pequeña."})
                break
            try:
                event = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
            except asyncio.TimeoutError:
                yield ": ping\n\n"  # mantiene viva la conexión (Render corta a los 100 s sin datos)
                continue
            if event is None:
                break
            yield sse(event)
    finally:
        if not task_handle.done():
            task_handle.cancel()
            try:
                await task_handle
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
