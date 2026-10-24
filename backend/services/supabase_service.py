"""
Cliente asíncrono de Supabase (PostgREST + Storage + Auth) basado en httpx.

Se usa httpx directamente en lugar del SDK síncrono para NO bloquear el event
loop de FastAPI durante el streaming. Todas las llamadas usan la service key,
que SOLO vive en el backend.
"""
import logging
from typing import Any
from urllib.parse import quote

import httpx

from config import settings

logger = logging.getLogger("pedusia.supabase")


class SupabaseError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class SupabaseService:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    # ------------------------------------------------------------------ #
    # Ciclo de vida
    # ------------------------------------------------------------------ #
    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(20.0, connect=10.0),
                limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ------------------------------------------------------------------ #
    # Utilidades internas
    # ------------------------------------------------------------------ #
    @property
    def rest_url(self) -> str:
        return f"{settings.SUPABASE_URL}/rest/v1"

    @staticmethod
    def _service_auth() -> dict:
        """
        Cabeceras de autenticación con la clave de servicio.
        - Claves nuevas (sb_secret_...): NO son JWT, solo van en "apikey".
        - Claves antiguas (service_role, JWT "eyJ..."): en "apikey" y "Authorization".
        """
        key = settings.SUPABASE_SERVICE_KEY
        if key.startswith("sb_"):
            return {"apikey": key}
        return {"apikey": key, "Authorization": f"Bearer {key}"}

    def _headers(self, extra: dict | None = None) -> dict:
        headers = {**self._service_auth(), "Content-Type": "application/json"}
        if extra:
            headers.update(extra)
        return headers

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        if response.status_code >= 400:
            try:
                body = response.json()
                message = body.get("message") or body.get("error") or response.text
            except ValueError:
                message = response.text
            logger.warning("Supabase %s: %s", response.status_code, message)
            raise SupabaseError(response.status_code, str(message))

    @staticmethod
    def _parse_count(response: httpx.Response) -> int:
        # Formato: "0-9/123" o "*/0"
        content_range = response.headers.get("content-range", "")
        if "/" in content_range:
            total = content_range.split("/")[-1]
            if total.isdigit():
                return int(total)
        return 0

    # ------------------------------------------------------------------ #
    # PostgREST (tablas)
    # ------------------------------------------------------------------ #
    async def select(
        self,
        table: str,
        params: dict[str, Any] | list[tuple[str, Any]] | None = None,
        *,
        count: bool = False,
        range_from: int | None = None,
        range_to: int | None = None,
    ) -> tuple[list[dict], int]:
        """SELECT con filtros PostgREST (ej: {"id": "eq.123", "select": "*"})."""
        headers = self._headers()
        if count:
            headers["Prefer"] = "count=exact"
        if range_from is not None and range_to is not None:
            headers["Range-Unit"] = "items"
            headers["Range"] = f"{range_from}-{range_to}"
        response = await self.client.get(f"{self.rest_url}/{table}", params=params or {}, headers=headers)
        self._raise_for_status(response)
        return response.json(), (self._parse_count(response) if count else 0)

    async def select_one(self, table: str, params: dict[str, Any]) -> dict | None:
        rows, _ = await self.select(table, {**params, "limit": 1})
        return rows[0] if rows else None

    async def count(self, table: str, params: dict[str, Any] | None = None) -> int:
        """Cuenta filas sin descargarlas."""
        headers = self._headers({"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"})
        query = {"select": "id", **(params or {})}
        response = await self.client.get(f"{self.rest_url}/{table}", params=query, headers=headers)
        self._raise_for_status(response)
        return self._parse_count(response)

    async def insert(self, table: str, data: dict | list[dict], *, upsert: bool = False) -> list[dict]:
        prefer = "return=representation"
        if upsert:
            prefer += ",resolution=merge-duplicates"
        response = await self.client.post(
            f"{self.rest_url}/{table}", json=data, headers=self._headers({"Prefer": prefer})
        )
        self._raise_for_status(response)
        return response.json()

    async def update(self, table: str, filters: dict[str, Any], data: dict) -> list[dict]:
        if not filters:
            raise ValueError("update() requiere filtros para evitar actualizar toda la tabla")
        response = await self.client.patch(
            f"{self.rest_url}/{table}",
            params=filters,
            json=data,
            headers=self._headers({"Prefer": "return=representation"}),
        )
        self._raise_for_status(response)
        return response.json()

    async def delete(self, table: str, filters: dict[str, Any]) -> list[dict]:
        if not filters:
            raise ValueError("delete() requiere filtros para evitar borrar toda la tabla")
        response = await self.client.delete(
            f"{self.rest_url}/{table}",
            params=filters,
            headers=self._headers({"Prefer": "return=representation"}),
        )
        self._raise_for_status(response)
        return response.json()

    async def rpc(self, function: str, args: dict | None = None) -> Any:
        """Llama a una función de PostgreSQL expuesta por PostgREST."""
        response = await self.client.post(
            f"{self.rest_url}/rpc/{function}", json=args or {}, headers=self._headers()
        )
        self._raise_for_status(response)
        if not response.content:
            return None
        return response.json()

    # ------------------------------------------------------------------ #
    # Storage
    # ------------------------------------------------------------------ #
    def public_url(self, bucket: str, path: str) -> str:
        return f"{settings.SUPABASE_URL}/storage/v1/object/public/{bucket}/{quote(path)}"

    async def upload_file(self, bucket: str, path: str, content: bytes, content_type: str) -> str:
        """Sube un archivo al bucket y devuelve su URL pública."""
        response = await self.client.post(
            f"{settings.SUPABASE_URL}/storage/v1/object/{bucket}/{quote(path)}",
            content=content,
            headers={
                **self._service_auth(),
                "Content-Type": content_type,
                "x-upsert": "true",
                "cache-control": "3600",
            },
            timeout=60.0,
        )
        self._raise_for_status(response)
        return self.public_url(bucket, path)

    async def delete_files(self, bucket: str, paths: list[str]) -> None:
        if not paths:
            return
        response = await self.client.request(
            "DELETE",
            f"{settings.SUPABASE_URL}/storage/v1/object/{bucket}",
            json={"prefixes": paths},
            headers=self._headers(),
        )
        if response.status_code >= 400:
            logger.warning("No se pudieron borrar archivos de %s: %s", bucket, response.text)

    # ------------------------------------------------------------------ #
    # Auth
    # ------------------------------------------------------------------ #
    async def get_auth_user(self, access_token: str) -> dict | None:
        """Valida un JWT de usuario con Supabase Auth y devuelve el usuario."""
        response = await self.client.get(
            f"{settings.SUPABASE_URL}/auth/v1/user",
            headers={"apikey": settings.SUPABASE_ANON_KEY, "Authorization": f"Bearer {access_token}"},
        )
        if response.status_code == 200:
            return response.json()
        if response.status_code in (401, 403, 404):
            return None
        self._raise_for_status(response)
        return None


# Instancia única compartida
supabase = SupabaseService()
