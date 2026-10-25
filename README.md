# 🐾 PedusGPT — Tu asistente de IA

Plataforma de chat con IA para estudiantes de 14 a 17 años. Interfaz estilo macOS, respuestas en streaming, 3 modelos, roles con Plan MAX, **PedusCode** (agente de programación con 10 IAs), panel de administración, 12 idiomas, voz, archivos y exportación. **Todo el stack es gratuito.**

| Capa | Tecnología | Coste |
|---|---|---|
| Backend | FastAPI (Python 3.12) | Gratis |
| Frontend | HTML + CSS + JavaScript sin frameworks (lo sirve FastAPI) | Gratis |
| Auth + Base de datos + Archivos | Supabase (email/contraseña + Google, Postgres, Storage) | Plan gratuito |
| IA | Groq API | Nivel gratuito |
| Hosting | Render Web Service | Plan gratuito |
| Mantener despierto | UptimeRobot (ping cada 5 min) | Gratis |

---

## 📁 Estructura

```
pedusia/
├── backend/
│   ├── main.py                 # App FastAPI, seguridad, errores, archivos estáticos
│   ├── config.py               # Variables de entorno centralizadas
│   ├── requirements.txt
│   ├── .env.example            # Plantilla de variables (copiar a .env)
│   ├── routes/                 # auth, users (perfil + admin), conversations, chat, files, code (PedusCode)
│   ├── services/               # groq_service, supabase_service, tts_stt_service, peduscode_service
│   ├── middleware/             # auth_middleware (JWT, roles, ban), rate_limiter
│   └── utils/                  # system_prompts, helpers
├── frontend/
│   ├── index.html
│   ├── css/                    # styles, themes, animations
│   ├── js/                     # app, auth, chat, sidebar, settings, themes, markdown,
│   │                           # files, export, voice, i18n, admin, icons, theme-boot, peduscode
│   └── assets/logo.png
├── supabase/schema.sql         # Tablas, RLS, triggers, funciones y buckets
├── render.yaml                 # Blueprint de despliegue en Render
└── README.md
```

---

## 🤖 Modelos

| En la app | Modelo de Groq (cadena de respaldo) | Quién puede usarlo |
|---|---|---|
| ⚡ PedusGPT 2 | `llama-3.1-8b-instant` → `openai/gpt-oss-20b` | Todos, sin límite |
| 🚀 PedusGPT 2 PRO | `llama-3.3-70b-versatile` → `openai/gpt-oss-120b` | Todos, sin límite |
| 👑 PedusGPT 2 PRO ULTRA | `llama-3.1-405b-reasoning` → `openai/gpt-oss-120b` | MAX y Admin (30/día), Owner ilimitado |

> **Importante:** Groq ya no ofrece Llama 3.1 405B, y en 2026 marca los modelos Llama como "Enterprise" en algunas cuentas. Por eso cada modelo tiene una **cadena de respaldo**: si el primero no está disponible para tu cuenta, se usa automáticamente el siguiente. Puedes cambiar las cadenas con las variables `GROQ_MODEL_*` sin tocar código.
>
> Las imágenes adjuntas se analizan con un modelo con visión (`GROQ_VISION_MODEL`, por defecto `qwen/qwen3.8-27b`). Si falla, la IA responde con la descripción del archivo.

---

## 🚀 Puesta en marcha (paso a paso)

### 1. Supabase

1. Crea un proyecto gratis en [supabase.com](https://supabase.com).
2. Ve a **SQL Editor → New query**, pega el contenido de `supabase/schema.sql` y pulsa **Run**. Puedes ejecutarlo varias veces sin romper nada (es idempotente). Crea:
   - Tablas `profiles`, `conversations`, `messages`, `uploaded_files`
   - Row Level Security en todas las tablas
   - Trigger que crea el perfil al registrarse y protege las columnas sensibles (`role`, `is_banned`, contador de ULTRA) para que un usuario no pueda auto-ascenderse
   - Funciones atómicas para el contador diario de PRO ULTRA
   - Buckets de Storage `avatars` (5 MB) y `uploads` (10 MB)
3. En **Project Settings → API Keys** copia la **Publishable key** (`sb_publishable_...`) y la **Secret key** (`sb_secret_...`, ¡secreta!). Si tu proyecto es antiguo también valen las claves *legacy* `anon` y `service_role`.
4. `SUPABASE_JWT_SECRET` es opcional y solo sirve para proyectos con el *Legacy JWT secret*. En proyectos nuevos déjalo vacío.
5. En **Authentication → URL Configuration** pon como **Site URL** tu dominio de Render (p. ej. `https://pedusia.onrender.com`) y añádelo a **Redirect URLs**. Para desarrollo añade también `http://localhost:8000`.

### 2. Login con Google (opcional)

1. En [Google Cloud Console](https://console.cloud.google.com/) → **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth** (tipo *Aplicación web*).
2. En **URIs de redireccionamiento autorizados** añade: `https://TU-PROYECTO.supabase.co/auth/v1/callback`
3. Copia el *Client ID* y el *Client Secret* en Supabase → **Authentication → Providers → Google** y actívalo.

### 3. Groq

Crea una API key gratis en [console.groq.com/keys](https://console.groq.com/keys).

### 4. Ejecutar en local

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # y rellena las variables
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Abre <http://localhost:8000>. Regístrate con el email que pusiste en `OWNER_EMAIL` para obtener el rol **owner**.

### 5. Desplegar en Render (gratis)

1. Sube el proyecto a un repositorio de GitHub (el `.gitignore` ya excluye el `.env`).
2. En [render.com](https://render.com) → **New → Blueprint** → elige el repositorio. Render leerá `render.yaml`.
3. Rellena las variables marcadas como secretas: `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `OWNER_EMAIL`, `CONTACT_EMAIL`.
4. Espera al despliegue y comprueba `https://TU-APP.onrender.com/health` → `{"status":"ok",...}`.
5. Vuelve a Supabase y actualiza **Site URL / Redirect URLs** con la URL definitiva.

### 6. UptimeRobot (evitar que Render se duerma)

El plan gratuito de Render apaga el servicio tras 15 min sin tráfico. Para evitarlo:

1. Crea una cuenta en [uptimerobot.com](https://uptimerobot.com).
2. **Add New Monitor → HTTP(s)** con URL `https://TU-APP.onrender.com/health` e intervalo **5 minutos** (el del plan gratuito) (el endpoint también acepta `HEAD`).

---

## 🔐 Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `GROQ_API_KEY` | ✅ | Clave de Groq (solo backend) |
| `SUPABASE_URL` | ✅ | URL del proyecto |
| `SUPABASE_ANON_KEY` | ✅ | Publishable key `sb_publishable_...` (o anon). Se envía al navegador |
| `SUPABASE_SERVICE_KEY` | ✅ | Secret key `sb_secret_...` (o service_role). Solo backend |
| `SUPABASE_JWT_SECRET` | — | Solo proyectos con Legacy JWT secret; si no, vacío |
| `OWNER_EMAIL` | ✅ | Email que recibe el rol owner automáticamente |
| `CONTACT_EMAIL` | ✅ | Destino del botón "Solicitar acceso" del Plan MAX |
| `ULTRA_DAILY_LIMIT` | — | Mensajes diarios de PRO ULTRA para MAX/Admin (30) |
| `GROQ_MODEL_BASIC / PRO / ULTRA / TITLE` | — | Cadenas de modelos separadas por comas |
| `GROQ_VISION_MODEL` | — | Modelo con visión para imágenes (vacío = desactivado) |
| `GROQ_STT_MODEL` | — | Whisper para dictado en navegadores sin Web Speech API |
| `GROQ_MAX_TOKENS` | — | Máximo de tokens por respuesta (4096) |
| `ALLOWED_ORIGINS` | — | Solo si sirves el frontend desde otro dominio |
| `ENABLE_CSP` | — | Content-Security-Policy (true) |
| `ENVIRONMENT` | — | `production` o `development` |
| `PEDUSCODE_DAILY_LIMIT` | — | Ejecuciones diarias de PedusCode para MAX/Admin (3) |
| `PEDUSCODE_PLANNER_MODELS` / `PEDUSCODE_WORKER_MODELS` | — | Modelos del organizador y de los agentes |
| `PEDUSCODE_MAX_AGENTS` | — | Agentes además del organizador (9 → 10 llamadas) |
| `PEDUSCODE_WORKER_MAX_TOKENS` | — | Tokens máximos por agente (4000) |
| `GROQ_TPM_LIMIT` | — | Tokens por minuto de tu cuenta por modelo (8000 en el plan gratuito) |

---

## 👥 Roles y permisos

| Rol | PRO ULTRA | PedusCode | Panel admin | Puede asignar |
|---|---|---|---|---|
| `user` | ❌ (ve el Plan MAX) | ❌ | ❌ | — |
| `max` | 30/día | 3/día | ❌ | — |
| `admin` | 30/día | 3/día | ✅ | `user`, `max` |
| `owner` | Ilimitado | Ilimitado | ✅ | `user`, `max`, `admin` |

- El contador se reinicia cada día a las **00:00 UTC** (de forma perezosa al primer uso del día y con la función `reset_daily_405b_requests()` si quieres programarla con `pg_cron`).
- Un admin no puede modificar a otros admins ni al owner; nadie puede asignar el rol owner (se define por `OWNER_EMAIL`).
- Los usuarios baneados ven una pantalla de suspensión con el motivo y todas sus peticiones devuelven `403`.
- El panel solo muestra **títulos** de conversaciones, nunca su contenido.

---

## 🌐 API (`/api/v1`)

| Método | Ruta | Descripción |
|---|---|---|
| GET/HEAD | `/health` (y `/api/v1/health`) | Estado del servicio |
| GET | `/config` | Configuración pública del frontend |
| GET | `/auth/me` | Usuario + perfil |
| POST | `/chat/stream` | Respuesta en streaming (SSE) |
| POST | `/chat/title` | Título automático (≤ 6 palabras) |
| GET / POST | `/conversations` | Listar / crear |
| PATCH / DELETE | `/conversations/{id}` | Renombrar / eliminar |
| GET | `/conversations/{id}/messages` | Mensajes |
| DELETE | `/conversations/{id}/messages?from_id=` | Borrar desde un mensaje (editar) |
| DELETE | `/messages/{id}` | Borrar mensaje |
| PATCH | `/messages/{id}/feedback` | Me gusta / no me gusta |
| GET / PATCH | `/profile` | Ver / editar perfil |
| POST | `/profile/avatar` | Subir foto |
| POST | `/files/upload` | Subir archivo (10 MB, validación real del tipo) |
| POST | `/voice/transcribe` | Dictado de respaldo con Whisper |
| GET | `/admin/users` | Usuarios (búsqueda, filtros, paginación) |
| PATCH | `/admin/users/{id}/role` · `/ban` · `/reset-limits` | Gestión |
| GET | `/admin/users/{id}/conversations` | Solo títulos |
| GET | `/admin/stats` | Estadísticas |
| GET | `/code/usage` | Uso diario de PedusCode |
| POST | `/code/run` | Ejecuta PedusCode (SSE: `start`, `planner`, `plan`, `agent`, `file`, `done`, `error`, `refused`) |

Errores siempre en JSON plano, por ejemplo:

```json
{ "error": "rate_limit", "message": "Has alcanzado tu límite de 30 mensajes diarios con PedusGPT 2 PRO ULTRA. Se reinicia a las 00:00 UTC.", "remaining": 0, "resets_at": "2026-10-24T00:00:00+00:00" }
```

---

## 🛡️ Seguridad

- Las claves de Groq y `service_role` solo existen en el backend.
- JWT de Supabase verificado en **cada** petición + comprobación de baneo.
- RLS en todas las tablas y trigger que impide cambiar `role`/`is_banned` desde el cliente.
- Markdown sanitizado con DOMPurify; los mensajes del usuario se pintan como texto plano.
- Validación del tipo real de archivo por *magic bytes*, no solo por extensión.
- Rate limiting general por IP y por usuario, `max_tokens` 4096, cabeceras de seguridad y CSP.

## ⌨️ Atajos

| Atajo | Acción |
|---|---|
| `Ctrl/Cmd + Shift + N` | Nueva conversación |
| `Ctrl/Cmd + Shift + S` | Mostrar/ocultar barra lateral |
| `Ctrl/Cmd + /` | Ir al cuadro de mensaje |
| `Esc` | Cerrar modal / cancelar edición |
| `Enter` / `Shift + Enter` | Enviar / nueva línea |
| `Ctrl/Cmd + Enter` | Lanzar PedusCode (en el cuadro de la tarea) |

## 💻 PedusCode (agente de código, Plan MAX)

Sección propia en la barra lateral. El usuario elige una carpeta de su ordenador, describe la tarea y un equipo de hasta **10 llamadas a la IA** trabaja a la vez:

1. **Organizador (1 llamada):** lee el árbol del proyecto y los archivos clave, decide cuántos agentes hacen falta (máx. 9), qué archivos crea o edita cada uno y escribe un *contrato* común (nombres de funciones, IDs, rutas) para que todo encaje.
2. **Agentes (hasta 9 llamadas en paralelo):** cada uno recibe un prompt personalizado con su papel, sus archivos y el contrato, y devuelve los archivos completos.
3. **Planificador de tokens:** reparte las llamadas entre varios modelos y respeta los tokens por minuto de cada uno (`GROQ_TPM_LIMIT`); si Groq responde 429, espera lo que indica `retry-after` y muestra *«Esperando turno»* en la interfaz.
4. **Revisión:** el usuario ve las diferencias línea a línea, marca qué guardar y PedusCode escribe **directamente en su carpeta** (File System Access API de Chrome/Edge). Se puede **deshacer**. En otros navegadores o en *Proyecto nuevo* se descarga un ZIP.

**Seguridad de archivos (en el navegador y otra vez en el servidor):**

- Se rechazan carpetas del sistema, discos completos y la carpeta personal entera (`Windows`, `Program Files`, `Users`, `Library`, `/etc`…).
- Nunca se leen ni se escriben secretos (`.env`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`…), ni `node_modules`, `.git`, `.venv`, `.ssh`…
- Rutas siempre relativas: sin `..`, sin rutas absolutas, sin nombres reservados de Windows y sin ejecutables (`.exe`, `.dll`, `.msi`, `.vbs`…).
- Los archivos incompletos o mucho más cortos que el original quedan **desmarcados** por defecto; los scripts (`.sh`, `.bat`, `.ps1`) muestran un aviso.
- Antes de guardar se comprueba si el archivo cambió desde que se leyó y se pide confirmación.
- Límites por ejecución: 600 archivos, 120.000 caracteres por archivo y 600.000 en total.
- Si el organizador falla o rechaza la tarea, **no se gasta** la ejecución del día.

> En el plan gratuito de Groq cada modelo admite unos 8.000 tokens por minuto, así que una ejecución suele tardar **1–3 minutos**. Con el plan Developer sube `GROQ_TPM_LIMIT` y será mucho más rápido.

---

## 🧩 Notas técnicas

- El backend usa `httpx` asíncrono contra la API REST de Supabase en lugar de `supabase-py`, y `PyJWT` en lugar de `python-jose`: menos dependencias, arranque más rápido en Render y sin bloquear el *event loop*.
- El modelo de visión, el razonamiento de `gpt-oss` y las etiquetas `<think>` se gestionan automáticamente: el usuario solo ve la respuesta final.
- La exportación a PDF usa jsPDF; para idiomas con alfabetos no latinos (japonés, chino, coreano, ruso, árabe) se abre el diálogo de impresión del navegador ("Guardar como PDF") para que el texto se vea perfecto.
