"""
Endpoints de skills (solo Plan MAX, admin y owner pueden crearlas y usarlas).

GET    /skills                   lista (sin el contenido) + límites
GET    /skills/{id}              skill completa (para editar o exportar)
POST   /skills                   crear
PATCH  /skills/{id}              editar / activar / automática
DELETE /skills/{id}              borrar
POST   /skills/github/preview    buscar SKILL.md en un enlace de GitHub
POST   /skills/github/import     importar las skills elegidas (actualiza las que ya existen)
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from middleware.auth_middleware import CurrentUser, get_current_user
from middleware.rate_limiter import SlidingWindowLimiter, check_limit
from services.skills_service import (
    MAX_IMPORT,
    SKILL_FULL_FIELDS,
    SKILL_LIST_FIELDS,
    SkillImportError,
    github_fetch,
    github_preview,
    is_schema_error,
    normalize_skill,
    skills_limit,
)
from services.supabase_service import SupabaseError, supabase
from utils.helpers import APIError

router = APIRouter(tags=["skills"])

skills_limiter = SlidingWindowLimiter(limit=30, window=60)
github_limiter = SlidingWindowLimiter(limit=8, window=60)


class ResourceIn(BaseModel):
    path: str = Field(..., max_length=160)
    content: str = Field(..., max_length=20000)


class SkillIn(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    title: str = Field(..., min_length=1, max_length=80)
    emoji: str = Field("🧩", max_length=16)
    description: str = Field("", max_length=800)
    instructions: str = Field(..., min_length=1, max_length=40000)
    resources: list[ResourceIn] = Field(default_factory=list, max_length=12)
    enabled: bool = True
    auto: bool = True


class SkillPatch(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    title: Optional[str] = Field(None, min_length=1, max_length=80)
    emoji: Optional[str] = Field(None, max_length=16)
    description: Optional[str] = Field(None, max_length=800)
    instructions: Optional[str] = Field(None, min_length=1, max_length=40000)
    resources: Optional[list[ResourceIn]] = Field(None, max_length=12)
    enabled: Optional[bool] = None
    auto: Optional[bool] = None


class GithubPreviewIn(BaseModel):
    url: str = Field(..., min_length=3, max_length=500)


class GithubImportIn(BaseModel):
    url: str = Field(..., min_length=3, max_length=500)
    paths: list[str] = Field(..., min_length=1, max_length=MAX_IMPORT)


# --------------------------------------------------------------------------
# Utilidades
# --------------------------------------------------------------------------

def require_access(user: CurrentUser) -> None:
    if not user.has_ultra:
        raise APIError(403, "needs_max", "Las skills son exclusivas del Plan MAX.")


def db_error(error: SupabaseError) -> APIError:
    if is_schema_error(error):
        return APIError(
            503, "schema_outdated",
            "Falta actualizar la base de datos: ejecuta de nuevo supabase/schema.sql en Supabase.",
        )
    if "23505" in error.message or "duplicate key" in error.message.lower():
        return APIError(409, "skill_exists", "Ya tienes una skill con ese identificador. Elige otro.")
    return APIError(503, "db_unavailable", "Error al cargar datos. Recarga la página.")


def import_error(error: SkillImportError) -> APIError:
    status = error.status_code if error.status_code in (400, 403, 404, 429, 502) else 400
    return APIError(status, "github_error", error.message)


async def count_skills(user_id: str) -> int:
    try:
        return await supabase.count("skills", {"user_id": f"eq.{user_id}"})
    except SupabaseError as error:
        raise db_error(error) from error


async def get_owned_skill(skill_id: UUID, user_id: str, fields: str = SKILL_FULL_FIELDS) -> dict:
    try:
        row = await supabase.select_one("skills", {"id": f"eq.{skill_id}", "user_id": f"eq.{user_id}", "select": fields})
    except SupabaseError as error:
        raise db_error(error) from error
    if not row:
        raise APIError(404, "skill_not_found", "No se encontró la skill.")
    return row


def serialize(row: dict) -> dict:
    data = dict(row)
    if "resources" in data:
        data["resources"] = data.get("resources") or []
    return data


# --------------------------------------------------------------------------
# CRUD
# --------------------------------------------------------------------------

@router.get("/skills")
async def list_skills(user: CurrentUser = Depends(get_current_user)):
    check_limit(skills_limiter, user.id)
    limit = skills_limit(user.role)
    try:
        rows, _ = await supabase.select(
            "skills", {"user_id": f"eq.{user.id}", "select": SKILL_LIST_FIELDS, "order": "created_at.asc"}
        )
    except SupabaseError as error:
        if is_schema_error(error):
            return {"has_access": user.has_ultra, "limit": limit, "count": 0, "skills": [], "schema_outdated": True}
        raise db_error(error) from error
    return {"has_access": user.has_ultra, "limit": limit, "count": len(rows), "skills": rows}


@router.get("/skills/{skill_id}")
async def get_skill(skill_id: UUID, user: CurrentUser = Depends(get_current_user)):
    check_limit(skills_limiter, user.id)
    return serialize(await get_owned_skill(skill_id, user.id))


@router.post("/skills", status_code=201)
async def create_skill(body: SkillIn, user: CurrentUser = Depends(get_current_user)):
    require_access(user)
    check_limit(skills_limiter, user.id)
    limit = skills_limit(user.role)
    if await count_skills(user.id) >= limit:
        raise APIError(400, "skills_limit", f"Puedes tener como máximo {limit} skills. Borra alguna para crear otra.")
    data = normalize_skill(body.model_dump())
    data["user_id"] = user.id
    try:
        rows = await supabase.insert("skills", data)
    except SupabaseError as error:
        raise db_error(error) from error
    return serialize(rows[0])


@router.patch("/skills/{skill_id}")
async def update_skill(skill_id: UUID, body: SkillPatch, user: CurrentUser = Depends(get_current_user)):
    require_access(user)
    check_limit(skills_limiter, user.id)
    await get_owned_skill(skill_id, user.id, "id")
    payload = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not payload:
        raise APIError(400, "nothing_to_update", "No hay cambios.")
    changes = normalize_skill(payload, partial=True)
    try:
        rows = await supabase.update("skills", {"id": f"eq.{skill_id}", "user_id": f"eq.{user.id}"}, changes)
    except SupabaseError as error:
        raise db_error(error) from error
    if not rows:
        raise APIError(404, "skill_not_found", "No se encontró la skill.")
    return serialize(rows[0])


@router.delete("/skills/{skill_id}")
async def delete_skill(skill_id: UUID, user: CurrentUser = Depends(get_current_user)):
    check_limit(skills_limiter, user.id)
    await get_owned_skill(skill_id, user.id, "id")
    try:
        await supabase.delete("skills", {"id": f"eq.{skill_id}", "user_id": f"eq.{user.id}"})
    except SupabaseError as error:
        raise db_error(error) from error
    return {"ok": True}


# --------------------------------------------------------------------------
# Importar desde GitHub
# --------------------------------------------------------------------------

async def existing_skills(user_id: str) -> dict[str, str]:
    """{name: id} de las skills del usuario."""
    try:
        rows, _ = await supabase.select("skills", {"user_id": f"eq.{user_id}", "select": "id,name"})
    except SupabaseError as error:
        raise db_error(error) from error
    return {row["name"]: row["id"] for row in rows}


@router.post("/skills/github/preview")
async def preview_github(body: GithubPreviewIn, user: CurrentUser = Depends(get_current_user)):
    require_access(user)
    check_limit(github_limiter, user.id)
    names = await existing_skills(user.id)
    try:
        return await github_preview(body.url, set(names))
    except SkillImportError as error:
        raise import_error(error) from error


@router.post("/skills/github/import")
async def import_github(body: GithubImportIn, user: CurrentUser = Depends(get_current_user)):
    require_access(user)
    check_limit(github_limiter, user.id)
    names = await existing_skills(user.id)
    limit = skills_limit(user.role)
    try:
        fetched, errors = await github_fetch(body.url, body.paths)
    except SkillImportError as error:
        raise import_error(error) from error

    created, updated = [], []
    total = len(names)
    for item in fetched:
        fields = item["fields"]
        try:
            data = normalize_skill(fields)
        except APIError as error:
            errors.append({"path": item["path"], "reason": error.message})
            continue
        data["source_url"] = fields.get("source_url")
        try:
            if data["name"] in names:
                # Volver a importar una skill existente la actualiza (sin tocar activa/automática)
                rows = await supabase.update(
                    "skills", {"id": f"eq.{names[data['name']]}", "user_id": f"eq.{user.id}"}, data
                )
                if rows:
                    updated.append(serialize({k: rows[0].get(k) for k in SKILL_LIST_FIELDS.split(",")}))
                continue
            if total >= limit:
                errors.append({"path": item["path"], "reason": f"Has llegado al máximo de {limit} skills"})
                continue
            rows = await supabase.insert("skills", {**data, "user_id": user.id})
            names[data["name"]] = rows[0]["id"]
            total += 1
            created.append(serialize({k: rows[0].get(k) for k in SKILL_LIST_FIELDS.split(",")}))
        except SupabaseError as error:
            api_error = db_error(error)
            if api_error.error == "schema_outdated":
                raise api_error from error
            errors.append({"path": item["path"], "reason": api_error.message})
    return {"created": created, "updated": updated, "errors": errors}
