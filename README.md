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

PedusGPT usa dos proveedores gratuitos en **modo mixto**: **Groq** (muy rápido) y **Mistral** (opcional). Cada modelo de la app tiene una **cadena de respaldo**: si el primero falla (no existe, está saturado o el proveedor no responde) se pasa automáticamente al siguiente.

| En la app | Cadena (de primero a último) | Quién puede usarlo |
|---|---|---|
| ⚡ PedusGPT 2 | `openai/gpt-oss-20b` → `qwen/qwen3.8-27b` → `mistral:mistral-small-latest` | Todos, sin límite |
| 🚀 PedusGPT 2 PRO | `openai/gpt-oss-120b` → `mistral:mistral-medium-latest` → `qwen/qwen3.8-27b` | Todos, sin límite |
| 👑 PedusGPT 2 PRO ULTRA | `mistral:mistral-large-4` → `mistral:mistral-medium-latest` → `openai/gpt-oss-120b` → `qwen/qwen3.8-27b` | MAX y Admin (30/día), Owner ilimitado |

| Uso interno | Cadena |
|---|---|
| Títulos | `openai/gpt-oss-20b` → `mistral:ministral-8b-latest` → `qwen/qwen3.8-27b` |
| Selector de skills y de búsqueda web | `openai/gpt-oss-20b` → `mistral:ministral-8b-latest` → `qwen/qwen3.8-27b` |
| Esfuerzo Ultra / UltraMAX (`DEEP`) | `mistral:mistral-large-4` → `openai/gpt-oss-120b` → `mistral:mistral-medium-latest` → `qwen/qwen3.8-27b` |
| Revisor de UltraMAX (`REVIEW`) | `mistral:mistral-medium-latest` → `qwen/qwen3.8-27b` → `openai/gpt-oss-20b` |
| PedusCode (organizador / agentes) | Groq primero (`gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b`) y `mistral-medium-latest` de respaldo |
| Imágenes adjuntas | `GROQ_VISION_MODEL` (`qwen/qwen3.8-27b`, con visión) |

> - **Formato:** `modelo` o `groq:modelo` = Groq · `mistral:modelo` = Mistral. Puedes cambiar las cadenas con las variables `GROQ_MODEL_*` / `PEDUSCODE_*_MODELS` sin tocar código (normalmente no hace falta).
> - **Sin `MISTRAL_API_KEY`** los modelos de Mistral se saltan solos y todo funciona solo con Groq.
> - **Modelos retirados:** Groq apagó `llama-3.1-8b-instant` y `llama-3.3-70b-versatile` el 16/08/2026. Si alguna variable antigua los contiene, PedusGPT los sustituye automáticamente; y si una variable conserva **exactamente** el valor por defecto de una versión anterior (el que puso el Blueprint de Render), se usa la nueva cadena mixta.
> - **Modo pensar en Mistral:** `mistral-large-4`, `mistral-medium-latest` y `mistral-small-latest` razonan con `reasoning_effort: "high"` cuando el modo pensar está activado (o con esfuerzo Alto/Ultra/UltraMAX); su razonamiento aparece igual en el bloque «Pensando…».
> - El plan gratuito de Mistral (*Experiment*) permite ~1 petición/segundo y ~20.000 tokens/minuto por modelo, y puede usar las conversaciones para entrenar sus modelos. Valóralo antes de activarlo.

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
| `GROQ_MODEL_BASIC / PRO / ULTRA / TITLE` | — | Cadenas de modelos separadas por comas (`mistral:` para Mistral). Mejor sin definir |
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
| `GROQ_MODEL_DEEP` / `GROQ_MODEL_REVIEW` / `GROQ_MODEL_ROUTER` | — | Modelos de Ultra/UltraMAX, del revisor de UltraMAX y del selector de skills |
| `ULTRAMAX_DAILY_LIMIT` | — | Respuestas UltraMAX diarias para MAX/Admin (10) |
| `GROQ_MAX_WAIT` | — | Segundos que se espera a un modelo saturado antes de cambiar (40) |
| `SKILLS_MAX_PER_USER` / `SKILLS_MAX_OWNER` | — | Skills máximas por usuario (20 / 100) |
| `SKILL_CONTEXT_CHARS` | — | Caracteres de skills por respuesta (12000) |
| `GITHUB_TOKEN` | — | Opcional: más peticiones al importar skills de GitHub |
| `MISTRAL_API_KEY` | — | Clave de Mistral (respaldo + PRO ULTRA). Vacía = solo Groq |
| `MISTRAL_TPM_LIMIT` | — | Tokens por minuto por modelo de Mistral (20000) |
| `MISTRAL_BASE_URL` | — | Endpoint de Mistral (`https://api.mistral.ai/v1`) |
| `TAVILY_API_KEY` | — | Búsqueda web principal (`tvly-...`, 1.000 búsquedas/mes gratis) |
| `EXA_API_KEY` | — | Búsqueda web de respaldo |
| `WEB_SEARCH_ENABLED` | — | Activa la búsqueda web automática (true; requiere Tavily o Exa) |
| `WEB_SEARCH_DAILY_LIMIT` | — | Respuestas con búsqueda al día para user/max/admin (30; owner ilimitado) |
| `WEB_SEARCH_MAX_QUERIES` / `WEB_SEARCH_RESULTS` | — | Consultas por mensaje (2) y resultados por consulta (5) |
| `WEB_SEARCH_CONTEXT_CHARS` | — | Caracteres de resultados que se pasan a la IA (6000) |

---

## 👥 Roles y permisos

| Rol | PRO ULTRA | Esfuerzo Ultra | UltraMAX | Skills | PedusCode | Panel admin | Puede asignar |
|---|---|---|---|---|---|---|---|
| `user` | ❌ (ve el Plan MAX) | ❌ | ❌ | ❌ | ❌ | ❌ | — |
| `max` | 30/día | ✅ | 10/día | 20 | 3/día | ❌ | — |
| `admin` | 30/día | ✅ | 10/día | 20 | 3/día | ✅ | `user`, `max` |
| `owner` | Ilimitado | ✅ | Ilimitado | 100 | Ilimitado | ✅ | `user`, `max`, `admin` |

Todos los usuarios pueden usar el **modo pensar** con los esfuerzos Bajo, Medio y Alto.

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
| POST | `/chat/stream` | Respuesta en streaming (SSE: `start`, `skills_routing`, `skills`, `phase`, `reasoning`, `waiting`, `thinking`, `token`, `done`, `error`). Cuerpo: `think`, `effort` (`low`·`medium`·`high`·`ultra`·`ultramax`), `skill_ids` (máx. 3), `auto_skills` |
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
| GET / POST | `/skills` | Listar / crear skills (Plan MAX) |
| GET / PATCH / DELETE | `/skills/{id}` | Ver / editar / borrar una skill |
| POST | `/skills/github/preview` · `/skills/github/import` | Buscar e importar `SKILL.md` de un repositorio público |
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
| `/` · `Tab` · `↑ ↓` | PedusCode: comandos, autocompletar e historial |
| `Esc` ×2 o `Ctrl + C` ×2 | PedusCode: cancelar la ejecución en curso |
| `Ctrl + L` | PedusCode: limpiar la terminal |

## 💻 PedusCode (agente de código, Plan MAX)

Sección propia en la barra lateral. El usuario elige una carpeta de su ordenador, describe la tarea y un equipo de hasta **10 llamadas a la IA** trabaja a la vez:

**Interfaz de terminal** (estilo agentes de programación de línea de comandos): ventana oscura con barra macOS, prompt `>` y salida en directo con viñetas `●` y líneas `⎿` para el organizador, cada agente y cada archivo. Las preguntas («¿Guardar 3 archivos en mi-web?») son menús que se manejan con `↑ ↓`, números y `Enter`.

| Comando | Alias | Qué hace |
|---|---|---|
| `/carpeta` | `/cd`, `/open` | Abrir una carpeta del ordenador (también se puede **arrastrar** a la terminal) |
| `/nuevo` | `/new` | Proyecto nuevo desde cero (se descarga en ZIP) |
| `/archivos` | `/ls`, `/tree` | Ver los archivos que leerá la IA |
| `/releer` | `/rescan` | Volver a leer la carpeta |
| `/cerrar` | `/close` | Cerrar la carpeta actual |
| `/guardar` | `/save` | Guardar los cambios marcados |
| `/deshacer` | `/undo` | Deshacer el último guardado |
| `/zip` | `/download` | Descargar los cambios en un ZIP |
| `/uso` | `/usage` | Ejecuciones que quedan hoy |
| `/limpiar` | `/clear` | Limpiar la pantalla (`Ctrl + L`) |
| `/ayuda` | `/help`, `?` | Lista de comandos y atajos |

Cualquier texto que no empiece por `/` es una **tarea** para el equipo de IAs.


1. **Organizador (1 llamada):** lee el árbol del proyecto y los archivos clave, decide cuántos agentes hacen falta (máx. 9), qué archivos crea o edita cada uno y escribe un *contrato* común (nombres de funciones, IDs, rutas) para que todo encaje.
2. **Agentes (hasta 9 llamadas en paralelo):** cada uno recibe un prompt personalizado con su papel, sus archivos y el contrato, y devuelve los archivos completos.
3. **Planificador de tokens:** reparte las llamadas entre varios modelos y respeta los tokens por minuto de cada uno (`GROQ_TPM_LIMIT`); si Groq responde 429, espera lo que indica `retry-after` y muestra *«Esperando turno»* en la interfaz.
4. **Revisión:** el usuario ve las diferencias línea a línea (con números de línea), marca qué guardar y PedusCode escribe **directamente en su carpeta** (File System Access API de Chrome/Edge). Se puede **deshacer**. En otros navegadores o en *Proyecto nuevo* se descarga un ZIP.

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

## 🧠 Modo pensar, niveles de esfuerzo y skills

**Modo pensar.** En el compositor, el botón **🧠 Pensar** activa o desactiva el razonamiento visible (clic) y la flecha abre el selector de esfuerzo. Mientras la IA piensa, su razonamiento aparece **en directo** en un bloque «Pensando… 4 s»; al empezar la respuesta se pliega solo y queda como **«Pensó durante X s»** (clic para desplegarlo). El razonamiento se guarda con el mensaje, pero **nunca** se vuelve a enviar a la IA en el historial (ahorra tokens).

| Esfuerzo | Qué hace | Quién |
|---|---|---|
| **Bajo** | `reasoning_effort: low`, respuestas rápidas | Todos |
| **Medio** | `medium` (por defecto) | Todos |
| **Alto** | `high`, más tokens para razonar | Todos |
| **Ultra** | Modelo más potente (`GROQ_MODEL_DEEP`) + instrucciones de verificación paso a paso | Plan MAX |
| **UltraMAX** | 3 fases: **borrador** → **revisión crítica** con otro modelo → **respuesta final** corregida. Las dos primeras se ven dentro del bloque de pensamiento | Plan MAX, 10/día |

Con el modo pensar desactivado la IA razona lo mínimo y solo se muestra la respuesta. Si un modelo está saturado (429), PedusGPT espera lo que indique Groq (máx. `GROQ_MAX_WAIT`) mostrando «Servidores ocupados, reintentando en X s» y luego prueba el siguiente modelo.

**Skills (Plan MAX).** Una skill es un conjunto de instrucciones especializadas (y, opcionalmente, archivos de referencia) que se añade al contexto cuando hace falta. Compatibles con el formato **Agent Skills** (`SKILL.md` con cabecera `name` / `description`).
- Botón **🧩** del compositor: elegir hasta 3 skills para la conversación o activar **«Elegir automáticamente»** (un modelo rápido lee las descripciones y elige como máximo 2).
- Escribe **`/`** en el cuadro de mensaje para buscar una skill por su identificador.
- **Gestionar skills**: crear, editar, activar/desactivar, marcar como automática, descargar `SKILL.md` o borrar.
- **Importar de GitHub**: pega `usuario/repo` o el enlace de una carpeta; PedusGPT busca los `SKILL.md`, enseña una vista previa y descarga los elegidos con sus archivos de texto. Volver a importar una skill existente la **actualiza**.
- Las skills nunca pueden saltarse las reglas de seguridad del system prompt.

---

## 🌐 Búsqueda web automática

La IA **decide sola** cuándo buscar en internet (noticias, resultados deportivos, precios, «hoy», «último»…):

1. Un filtro rápido descarta los mensajes que claramente no lo necesitan (saludos, matemáticas, código…).
2. Si hay duda, el modelo `ROUTER` decide y escribe hasta 2 consultas.
3. Se busca con **Tavily** (con *safe search*) y, si falla, con **Exa**. Los resultados se añaden al contexto y la IA cita las fuentes con `[1]`, `[2]`…
4. En el chat aparece «🌐 Buscando en la web…» con las consultas y, debajo de la respuesta, las **fuentes** como fichas clicables. Las citas `[n]` del texto se convierten en enlaces. Las fuentes se guardan con el mensaje y se incluyen al exportar.

**Límite:** 30 respuestas con búsqueda al día para user, MAX y admin (se reinicia a las 00:00 UTC); el owner no tiene límite. Si no hay resultados, la búsqueda **no** cuenta. Al llegar al límite, la IA responde igualmente sin buscar y lo avisa. El uso se ve en **Ajustes → Plan** y el admin puede reiniciarlo con «Reiniciar límites».

Sin `TAVILY_API_KEY` ni `EXA_API_KEY` la búsqueda queda desactivada y no aparece nada en la interfaz.

---

## 🧩 Notas técnicas

- El backend usa `httpx` asíncrono contra la API REST de Supabase en lugar de `supabase-py`, y `PyJWT` en lugar de `python-jose`: menos dependencias, arranque más rápido en Render y sin bloquear el *event loop*.
- El modelo de visión, el razonamiento de `gpt-oss`/`qwen` (`include_reasoning` / `reasoning_format`) y las etiquetas `<think>` se gestionan automáticamente: el razonamiento va al bloque «Pensando…» y nunca se mezcla con la respuesta. `max_tokens` se ajusta solo al límite de tokens por minuto del plan gratuito para evitar errores 413.
- La exportación a PDF usa jsPDF; para idiomas con alfabetos no latinos (japonés, chino, coreano, ruso, árabe) se abre el diálogo de impresión del navegador ("Guardar como PDF") para que el texto se vea perfecto.
