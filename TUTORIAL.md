# 📘 Tutorial completo de PedusGPT

### De cero a tener tu propia IA en internet, gratis y paso a paso

> **Para quién es esta guía:** para cualquiera, aunque nunca hayas publicado una web. Cada paso explica **qué** hay que hacer, **dónde** hacer clic y **por qué**.
>
> **Tiempo estimado:** 1–2 horas la primera vez.
> **Coste:** 0 €. No hace falta tarjeta de crédito en ningún servicio.

---

## 📑 Índice

0. [Cómo funciona PedusGPT (en 2 minutos)](#0-cómo-funciona-pedusgpt-en-2-minutos)
1. [Lo que necesitas antes de empezar](#1-lo-que-necesitas-antes-de-empezar)
2. [Descargar el proyecto](#2-descargar-el-proyecto)
3. [Instalar las herramientas en tu ordenador](#3-instalar-las-herramientas-en-tu-ordenador)
4. [Groq: la clave de la IA](#4-groq-la-clave-de-la-ia)
    - [4 bis. Mistral y búsqueda web (opcional)](#4-bis-mistral-y-búsqueda-web-opcional)
5. [Supabase: usuarios, base de datos y archivos](#5-supabase-usuarios-base-de-datos-y-archivos)
6. [Login con Google (opcional)](#6-login-con-google-opcional)
7. [Probar PedusGPT en tu ordenador](#7-probar-pedusgpt-en-tu-ordenador)
8. [Subir el código a GitHub](#8-subir-el-código-a-github)
9. [Publicar en internet con Render](#9-publicar-en-internet-con-render)
10. [Conectar Supabase con tu web publicada](#10-conectar-supabase-con-tu-web-publicada)
11. [UptimeRobot: que tu web no se duerma](#11-uptimerobot-que-tu-web-no-se-duerma)
12. [Guía de uso para los usuarios](#12-guía-de-uso-para-los-usuarios)
    - [12 bis. PedusCode: el agente de programación](#12-bis-peduscode-el-agente-de-programación)
    - [12 ter. Modo pensar, esfuerzo y skills](#12-ter-modo-pensar-esfuerzo-y-skills)
    - [12 quater. Búsqueda web](#12-quater-búsqueda-web)
13. [Guía del administrador (roles, Plan MAX, baneos)](#13-guía-del-administrador)
14. [Personalizar PedusGPT](#14-personalizar-pedusgpt)
15. [Actualizar la web después de hacer cambios](#15-actualizar-la-web-después-de-hacer-cambios)
16. [Límites de los planes gratuitos](#16-límites-de-los-planes-gratuitos)
17. [Solución de problemas](#17-solución-de-problemas)
18. [Seguridad y buenas prácticas](#18-seguridad-y-buenas-prácticas)
19. [Glosario](#19-glosario)
20. [Lista de comprobación final](#20-lista-de-comprobación-final)

---

## 0. Cómo funciona PedusGPT (en 2 minutos)

Antes de tocar nada, conviene entender las piezas. PedusGPT usa **5 servicios gratuitos** que trabajan juntos:

```
   👤 Usuario (navegador)
          │
          ▼
 ┌─────────────────────┐        ┌──────────────────────┐
 │  RENDER (hosting)   │ ─────▶ │  GROQ (la IA)        │
 │  Tu servidor FastAPI│        │  Genera las respuestas│
 │  + la web (HTML/JS) │        └──────────────────────┘
 └─────────────────────┘
          │
          ▼
 ┌─────────────────────────────────────────────┐
 │  SUPABASE                                   │
 │  • Auth: registro, login, Google            │
 │  • Base de datos: perfiles, chats, mensajes │
 │  • Storage: fotos de perfil y archivos      │
 └─────────────────────────────────────────────┘

 ⏰ UPTIMEROBOT: visita tu web cada 5 min para que Render no la apague.
 🐙 GITHUB: guarda tu código; Render lo coge de ahí.
```

| Servicio | Qué hace en PedusGPT | Analogía |
|---|---|---|
| **Groq** | Es el "cerebro": la IA que responde | El profesor que contesta |
| **Supabase** | Guarda usuarios, chats y archivos | El archivador del instituto |
| **Render** | Mantiene tu web encendida en internet | El edificio donde está la clase |
| **GitHub** | Guarda tu código en la nube | La mochila con tus apuntes |
| **UptimeRobot** | Visita la web cada 5 min para que no se duerma | El despertador |

**Lo más importante de la seguridad:** las claves secretas (Groq y la *secret key* de Supabase) **solo** las conoce tu servidor. El navegador del usuario nunca las ve. Por eso PedusGPT tiene un backend en Python y no solo una página web.

---

## 1. Lo que necesitas antes de empezar

### Cuentas (todas gratuitas)

Te recomiendo usar **el mismo email** en todas para no liarte:

| Servicio | Enlace | ¿Obligatorio? |
|---|---|---|
| GitHub | <https://github.com/signup> | ✅ |
| Groq | <https://console.groq.com> | ✅ |
| Supabase | <https://supabase.com/dashboard> (puedes entrar con GitHub) | ✅ |
| Render | <https://render.com> (puedes entrar con GitHub) | ✅ |
| UptimeRobot | <https://uptimerobot.com> | ✅ (para que no se duerma) |
| Google Cloud | <https://console.cloud.google.com> | Solo si quieres "Continuar con Google" |

### Programas para tu ordenador

| Programa | Para qué |
|---|---|
| **Python 3.12** | Ejecutar el servidor en tu ordenador |
| **Git** | Subir el código a GitHub |
| **Visual Studio Code** (recomendado) | Editar archivos cómodamente |

> 💡 **¿Te saltas la prueba en local?** Se puede: si solo quieres publicar la web, puedes saltar los pasos 3 y 7 y subir los archivos a GitHub desde el navegador (te explico cómo en el paso 8, opción B). Aun así, probar en local te ayuda mucho a detectar errores.

---

## 2. Descargar el proyecto

1. En el panel de archivos de esta conversación, descarga **`pedusia.zip`**.
2. Descomprímelo en un sitio fácil de encontrar, por ejemplo:
   - Windows: `C:\Users\TuNombre\Documentos\pedusia`
   - Mac/Linux: `~/Documentos/pedusia`
3. Comprueba que dentro ves esto:

```
pedusia/
├── backend/        ← el servidor (Python)
├── frontend/       ← la web (HTML, CSS, JavaScript)
├── supabase/       ← schema.sql (la base de datos)
├── render.yaml     ← instrucciones para Render
├── README.md
└── TUTORIAL.md     ← este archivo
```

> ⚠️ El archivo `backend/.env` **no** viene en el zip a propósito: es donde irán tus claves secretas y lo crearás tú en el paso 7.

---

## 3. Instalar las herramientas en tu ordenador

### 3.1 Python 3.12

**Windows**
1. Ve a <https://www.python.org/downloads/> y descarga Python **3.12.x**.
2. Al abrir el instalador, **marca la casilla "Add python.exe to PATH"** (¡muy importante!) y pulsa *Install Now*.
3. Abre **PowerShell** (botón Inicio → escribe "PowerShell") y comprueba:
   ```powershell
   python --version
   ```
   Debe decir `Python 3.12.x`.

**Mac**
1. Descarga el instalador de macOS desde <https://www.python.org/downloads/> e instálalo.
2. Abre **Terminal** y comprueba:
   ```bash
   python3 --version
   ```

**Linux (Ubuntu/Debian)**
```bash
sudo apt update && sudo apt install python3 python3-venv python3-pip -y
python3 --version
```

> En Mac y Linux el comando es `python3`; en Windows suele ser `python`. En esta guía escribo `python`: cámbialo por `python3` si estás en Mac/Linux.

### 3.2 Git

- **Windows:** descarga desde <https://git-scm.com/download/win> e instala con las opciones por defecto.
- **Mac:** en Terminal escribe `git --version`; si no lo tienes, macOS te ofrecerá instalarlo.
- **Linux:** `sudo apt install git -y`

Configúralo una vez con tu nombre y email (los de GitHub):
```bash
git config --global user.name "Tu Nombre"
git config --global user.email "tu-email@ejemplo.com"
```

### 3.3 Visual Studio Code (opcional pero recomendado)

Descárgalo en <https://code.visualstudio.com>, ábrelo y ve a **File → Open Folder** → elige la carpeta `pedusia`. Con **Terminal → New Terminal** tendrás una terminal ya colocada en la carpeta del proyecto.

---

## 4. Groq: la clave de la IA

Groq es quien ejecuta los modelos de IA. Su nivel gratuito es muy generoso.

1. Entra en <https://console.groq.com> y regístrate (con Google o con email).
2. En el menú, ve a **API Keys** → **Create API Key**.
3. Ponle un nombre, por ejemplo `pedusia`, y pulsa *Submit*.
4. **Copia la clave** (empieza por `gsk_...`) y guárdala en un bloc de notas temporal.
   > ⚠️ Groq solo te la enseña **una vez**. Si la pierdes, borra esa clave y crea otra.

### ¿Qué modelos usa PedusGPT?

| En la app | Primero intenta… | Si falla, usa… |
|---|---|---|
| ⚡ PedusGPT 2 | `openai/gpt-oss-20b` (Groq) | `qwen/qwen3.8-27b` → `mistral-small-latest` |
| 🚀 PedusGPT 2 PRO | `openai/gpt-oss-120b` (Groq) | `mistral-medium-latest` → `qwen/qwen3.8-27b` |
| 👑 PedusGPT 2 PRO ULTRA | `mistral-large-4` (Mistral) | `mistral-medium-latest` → `openai/gpt-oss-120b` → `qwen/qwen3.8-27b` |
| 🖼️ Imágenes adjuntas | `qwen/qwen3.8-27b` (con visión) | Responde solo con el texto |

**Por qué hay "plan B":** si un modelo no existe, está saturado o su proveedor no responde, PedusGPT pasa al siguiente de la lista sin que el usuario note nada. Los modelos de Mistral solo se usan si añades la clave de Mistral (apartado 4 bis); si no, todo funciona solo con Groq.

> ℹ️ Groq apagó los modelos `llama-3.1-8b-instant` y `llama-3.3-70b-versatile` en agosto de 2026. Si los tenías en alguna variable de Render, PedusGPT los cambia solo por los nuevos.

Puedes ver los modelos disponibles para tu cuenta en <https://console.groq.com/docs/models> y tus límites en **Settings → Limits** dentro de la consola.

---

## 4 bis. Mistral y búsqueda web (opcional)

Las tres claves de este apartado son **opcionales y gratuitas**. Puedes hacerlo ahora o más tarde (solo hay que añadir la variable en Render).

### Mistral: segundo proveedor de IA

Hace de **respaldo** cuando Groq está saturado y es el modelo principal de **PRO ULTRA**.

1. Entra en <https://console.mistral.ai> y crea una cuenta.
2. Te pedirá elegir plan: escoge el gratuito **Experiment** (no pide tarjeta, sí verificar un número de teléfono).
3. Menú **API Keys** → **Create new key** → ponle un nombre (`pedusgpt`) → **Create**.
4. Copia la clave y guárdala: será la variable `MISTRAL_API_KEY`.

> ⚠️ En el plan gratuito Mistral puede usar las conversaciones para mejorar sus modelos y el límite es de ~1 petición por segundo. Como tus usuarios son menores, explícalo en tu política de privacidad.

### Tavily: buscador principal

1. Entra en <https://app.tavily.com> y regístrate (con Google o email).
2. En el panel (*Overview*) verás tu **API Key**, que empieza por `tvly-`. Cópiala: será `TAVILY_API_KEY`.
3. El plan gratuito incluye **1.000 búsquedas al mes** sin tarjeta.

### Exa: buscador de respaldo

1. Entra en <https://dashboard.exa.ai> y regístrate.
2. Menú **API Keys** → copia la clave (o crea una nueva): será `EXA_API_KEY`.
3. Exa regala crédito al registrarte y un pequeño crédito gratuito cada mes.

Con **al menos una** de las dos (Tavily o Exa) se activa la búsqueda web. Lo ideal es poner las dos: si Tavily falla o se le acaba el cupo, se usa Exa.

---

## 5. Supabase: usuarios, base de datos y archivos

### 5.1 Crear el proyecto

1. Entra en <https://supabase.com/dashboard> (puedes usar *Continue with GitHub*).
2. Pulsa **New project**.
3. Rellena:
   - **Name:** `pedusia`
   - **Database Password:** pulsa *Generate a password* y **guárdala** (no la usa la app, pero es tu llave maestra de la base de datos).
   - **Region:** elige la más cercana a tus usuarios. Desde España: **West EU (Paris)** o **Central EU (Frankfurt)**.
4. Pulsa **Create new project** y espera 1–2 minutos a que termine de prepararse.

### 5.2 Crear las tablas (ejecutar `schema.sql`)

Este paso crea toda la estructura de datos de golpe.

1. En el menú izquierdo, abre **SQL Editor** (icono `>_`).
2. Pulsa **New query** (o el `+`).
3. Abre en tu ordenador el archivo `pedusia/supabase/schema.sql` con VS Code o el Bloc de notas, **selecciona todo** (Ctrl+A / Cmd+A) y **cópialo**.
4. Pégalo en el editor de Supabase y pulsa **Run** (o Ctrl+Enter).
5. Abajo debe aparecer **"Success. No rows returned"**.

> 💡 Si Supabase te avisa de que la consulta contiene operaciones "destructivas" (por los `drop ... if exists`), es normal: confírmalo. El script es **idempotente**, es decir, puedes ejecutarlo todas las veces que quieras sin perder datos.

**Comprueba que ha funcionado:**
- **Table Editor:** deben aparecer las tablas `profiles`, `conversations`, `messages` y `uploaded_files`, todas con la etiqueta de RLS activado.
- **Storage:** deben aparecer los buckets `avatars` y `uploads`.

**¿Qué ha creado exactamente?**

| Elemento | Para qué sirve |
|---|---|
| `profiles` | Nombre, bio, intereses, animal favorito, rol, baneo, contador de PRO ULTRA |
| `conversations` | Cada chat, con su título y modelo |
| `messages` | Cada mensaje (tuyo o de la IA) |
| `uploaded_files` | Archivos subidos y su texto extraído |
| **RLS** (Row Level Security) | Cada usuario solo puede ver **sus** datos |
| Trigger `protect_profile_columns` | Impide que alguien se ponga a sí mismo "admin" o se quite un baneo desde el navegador |
| Trigger `handle_new_user` | Crea el perfil automáticamente al registrarse |
| Funciones `consume/refund_405b_request` | Cuentan los mensajes de PRO ULTRA sin trampas |
| Buckets `avatars` (5 MB) y `uploads` (10 MB) | Fotos de perfil y archivos del chat |

### 5.3 Copiar las claves (API Keys)

1. Ve a **Project Settings** (el engranaje ⚙️ de abajo a la izquierda).
2. En **Data API** (o en el botón **Connect** de arriba) copia la **Project URL**, algo como `https://abcdefghijk.supabase.co`.
3. En **API Keys** copia:
   - **Publishable key** → empieza por `sb_publishable_...` (esta es **pública**, puede ir al navegador).
   - **Secret key** → empieza por `sb_secret_...` (pulsa el ojo 👁️ para verla). **Es secretísima.**

> 🧓 **¿Tu proyecto es antiguo?** Si en vez de esas ves claves largas que empiezan por `eyJ...` (llamadas `anon` y `service_role`, en la pestaña *Legacy API Keys*), también funcionan. PedusGPT acepta los dos tipos. Aun así, Supabase va a retirar las antiguas a finales de 2026, así que mejor usa las nuevas si las tienes.

Apunta en tu bloc de notas:
```
SUPABASE_URL          = https://abcdefghijk.supabase.co
SUPABASE_ANON_KEY     = sb_publishable_...   (la publishable)
SUPABASE_SERVICE_KEY  = sb_secret_...        (la secret)
```

> El nombre de la variable sigue siendo `SUPABASE_ANON_KEY` por costumbre, pero ahí va la **publishable**.
>
> `SUPABASE_JWT_SECRET` es opcional y **en proyectos nuevos debe quedarse vacío**: PedusGPT verifica las sesiones preguntando directamente a Supabase.

### 5.4 Configurar el registro por email

Ve a **Authentication → Sign In / Providers** (en algunas versiones, *Providers → Email*):

- **Enable Email provider:** activado ✅
- **Confirm email:**
  - **Activado** (recomendado en producción): el usuario tiene que pulsar un enlace en su correo antes de poder entrar. PedusGPT le muestra el mensaje *"Revisa tu correo para confirmar tu cuenta"*.
  - **Desactivado** (cómodo para hacer pruebas): se entra al instante.

> ⚠️ **Muy importante:** el servidor de correo que trae Supabase de serie solo envía **muy pocos emails por hora** y está pensado para pruebas. Si vas a tener muchos usuarios, configura un SMTP propio gratuito en **Authentication → Emails → SMTP Settings** (por ejemplo con Brevo o Resend, que tienen plan gratis). Si no, los emails de confirmación y de "olvidé mi contraseña" dejarán de llegar.

**Opcional: traducir los emails.** En **Authentication → Emails → Templates** puedes cambiar el texto de los correos de confirmación y recuperación (vienen en inglés). Por ejemplo, en *Confirm signup*:

```html
<h2>¡Bienvenido/a a PedusGPT! 🐾</h2>
<p>Pulsa el botón para confirmar tu cuenta:</p>
<p><a href="{{ .ConfirmationURL }}">Confirmar mi cuenta</a></p>
```

### 5.5 URLs permitidas (de momento, local)

En **Authentication → URL Configuration**:
- **Site URL:** `http://localhost:8000` (de momento; en el paso 10 la cambiarás por la de Render).
- **Redirect URLs** → *Add URL*: `http://localhost:8000/**`

Esto le dice a Supabase a qué direcciones puede devolver al usuario después de confirmar el email o de entrar con Google.

---

## 6. Login con Google (opcional)

Si no quieres el botón "Continuar con Google", salta al paso 7. El botón seguirá apareciendo, pero dará un aviso hasta que lo configures.

### 6.1 Crear la pantalla de consentimiento

1. Entra en <https://console.cloud.google.com> y crea un proyecto nuevo (arriba, selector de proyectos → **New Project** → nombre `PedusGPT`).
2. Ve a **APIs & Services → OAuth consent screen** (en la interfaz nueva se llama **Google Auth Platform**) y pulsa **Get started**.
3. Rellena:
   - **App name:** `PedusGPT`
   - **User support email:** tu email
   - **Audience:** **External**
   - **Contact information:** tu email
4. Acepta las condiciones y crea.
5. En **Data Access** (o *Scopes*) añade los permisos básicos: `openid`, `.../auth/userinfo.email` y `.../auth/userinfo.profile`. No necesitas ninguno más.
6. En **Branding** puedes subir el logo (`frontend/assets/logo.png`) y añadir como dominio autorizado `supabase.co` y, más tarde, `onrender.com`.

### 6.2 Crear las credenciales

1. Ve a **Clients** (o *APIs & Services → Credentials*) → **Create client** → tipo **Web application**.
2. **Name:** `PedusGPT Web`.
3. **Authorized JavaScript origins:**
   - `http://localhost:8000`
   - (más tarde añadirás `https://tu-app.onrender.com`)
4. **Authorized redirect URIs**: añade **exactamente**
   ```
   https://TU-PROYECTO.supabase.co/auth/v1/callback
   ```
   (cambia `TU-PROYECTO` por el de tu Project URL. Supabase también te muestra esta URL en la pantalla del proveedor de Google, con un botón para copiarla).
5. Pulsa **Create** y copia el **Client ID** y el **Client Secret**.

### 6.3 Activarlo en Supabase

1. En Supabase: **Authentication → Sign In / Providers → Google**.
2. Actívalo, pega el **Client ID** y el **Client Secret** y pulsa **Save**.

### 6.4 Publicar la app de Google

Mientras la app esté en modo **Testing**, solo podrán entrar con Google los emails que añadas como *Test users*. Cuando todo funcione, ve a **Audience** y pulsa **Publish app**. Como solo pides email y perfil, normalmente no hace falta pasar la verificación de Google.

---

## 7. Probar PedusGPT en tu ordenador

### 7.1 Abrir una terminal en la carpeta `backend`

```bash
cd ruta/a/pedusia/backend
```
Ejemplo en Windows: `cd C:\Users\TuNombre\Documentos\pedusia\backend`

### 7.2 Crear un entorno virtual

Un entorno virtual es una "cajita" donde se instalan las librerías del proyecto sin ensuciar el resto de tu ordenador.

**Windows (PowerShell):**
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```
> Si PowerShell dice que la ejecución de scripts está deshabilitada, ejecuta una vez
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` y vuelve a intentarlo.

**Mac / Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

Sabrás que está activo porque al principio de la línea aparece `(.venv)`.

### 7.3 Instalar las dependencias

```bash
pip install -r requirements.txt
```

Instala FastAPI, Uvicorn, httpx, PyJWT, pypdf y algunas más. Tarda un minuto.

### 7.4 Crear el archivo `.env`

1. Copia `.env.example` y renombra la copia a `.env`:
   - Windows: `copy .env.example .env`
   - Mac/Linux: `cp .env.example .env`
2. Ábrelo con VS Code y rellena tus datos:

```env
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx

SUPABASE_URL=https://abcdefghijk.supabase.co
SUPABASE_ANON_KEY=sb_publishable_xxxxxxxx
SUPABASE_SERVICE_KEY=sb_secret_xxxxxxxx
SUPABASE_JWT_SECRET=

OWNER_EMAIL=tu-email@ejemplo.com
CONTACT_EMAIL=tu-email@ejemplo.com
ULTRA_DAILY_LIMIT=30

ENVIRONMENT=development
```

| Variable | Qué poner |
|---|---|
| `OWNER_EMAIL` | **Tu** email. Quien se registre con él será **owner** (el jefe supremo). |
| `CONTACT_EMAIL` | El email al que llegarán las solicitudes del Plan MAX. |
| `ENVIRONMENT` | `development` en tu ordenador (en Render ya viene `production`). |

El resto de variables (modelos, tokens…) puedes dejarlas como vienen.

> ⚠️ Sin espacios alrededor del `=` y sin comillas.

### 7.5 Arrancar el servidor

Con el entorno virtual activo y dentro de `backend`:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Si todo va bien verás:
```
INFO pedusia: PedusGPT 1.0.0 arrancando. Frontend: .../frontend
INFO:     Uvicorn running on http://0.0.0.0:8000
```

> Si aparece `⚠️ Faltan variables de entorno: ...`, revisa tu `.env`: falta alguna de las que nombra.

`--reload` hace que el servidor se reinicie solo cada vez que guardas un cambio en el código Python. Para pararlo: **Ctrl + C**.

### 7.6 Probar

1. Abre <http://localhost:8000> en el navegador.
2. Pulsa **Registrarse** y crea una cuenta **con el email de `OWNER_EMAIL`**.
3. Si tienes "Confirm email" activado, confirma desde tu correo y vuelve a entrar.
4. Comprueba que en la barra lateral, debajo de tu nombre, pone **Owner ⚡**.

**Prueba rápida (5 minutos):**

- [ ] Envía "Hola" y mira cómo la respuesta aparece palabra a palabra.
- [ ] Mira que la conversación aparece en la barra lateral con un título automático.
- [ ] Cambia el modelo a 👑 PRO ULTRA y envía algo.
- [ ] Adjunta una imagen (📎) y pregunta qué hay en ella.
- [ ] Adjunta un PDF y pide un resumen.
- [ ] Pulsa 🎤 y dicta un mensaje (en Chrome o Edge).
- [ ] Pulsa 🔊 en una respuesta para que la lea en voz alta.
- [ ] Exporta la conversación a PDF.
- [ ] Cambia a tema oscuro (🌙) y prueba otro idioma en Configuración.
- [ ] Abre el **Panel de administración** (escudo 🛡️).
- [ ] Haz la ventana pequeña (o ábrela en el móvil) y comprueba el menú lateral desplegable.

**Comprueba también:** <http://localhost:8000/health> debe mostrar `{"status":"ok","version":"1.0.0"}`.

### 🩺 Página de diagnóstico (si algo no va)
Con `ENVIRONMENT=development`, abre **<http://localhost:8000/api/v1/diagnostico>**. Comprueba una por una tus claves de Supabase y Groq, si existen las tablas y los buckets, si Google está activado y qué modelo usará cada opción. Si algo falla, te dice la solución. Nunca muestra tus claves, y en Render (producción) está desactivada.

> 📱 **Probar desde el móvil en tu misma wifi:** busca la IP local de tu ordenador (por ejemplo `192.168.1.40`) y abre `http://192.168.1.40:8000` en el móvil. El micrófono no funcionará así porque los navegadores exigen HTTPS; en Render sí funcionará.

---

## 8. Subir el código a GitHub

### Antes de nada: ¡que no se suba el `.env`!

El proyecto trae un `.gitignore` que ya excluye `.env`, `.venv` y `__pycache__`. No lo borres.

### Opción A — Con la terminal (recomendada)

1. En GitHub pulsa **+ → New repository**.
   - **Repository name:** `pedusia`
   - **Private** ✅ (recomendado)
   - **No** marques "Add a README" (ya tienes uno).
   - Pulsa **Create repository**.
2. En la terminal, en la carpeta **raíz** `pedusia` (no en `backend`):

```bash
cd ruta/a/pedusia
git init
git add .
git status
```

3. **Revisa la lista de `git status`:** NO debe aparecer `backend/.env`. Si aparece, para y revisa el `.gitignore`.
4. Continúa:

```bash
git commit -m "Primera versión de PedusGPT"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/pedusia.git
git push -u origin main
```

La primera vez, GitHub te pedirá iniciar sesión (se abrirá el navegador, o te pedirá un *Personal Access Token* en lugar de la contraseña).

### Opción B — Desde el navegador (sin instalar Git)

1. Crea el repositorio igual que antes.
2. En la página del repositorio vacío pulsa **uploading an existing file**.
3. Arrastra **el contenido** de la carpeta `pedusia` (las carpetas `backend`, `frontend`, `supabase` y los archivos `render.yaml`, `README.md`, `TUTORIAL.md` y `.gitignore`).
   - ⚠️ **No subas** `backend/.env` ni la carpeta `.venv`.
   - Los archivos que empiezan por punto pueden estar ocultos: en Windows actívalos en el Explorador con *Vista → Mostrar → Elementos ocultos*; en Mac, con **Cmd + Shift + .** en el Finder.
4. Pulsa **Commit changes**.

---

## 9. Publicar en internet con Render

### 9.1 Crear el servicio con el Blueprint

El archivo `render.yaml` ya le dice a Render todo lo que tiene que hacer.

1. Entra en <https://dashboard.render.com> (con *GitHub* es lo más fácil).
2. Pulsa **New + → Blueprint**.
3. Conecta tu cuenta de GitHub si te lo pide y da acceso al repositorio `pedusia`.
4. Elige el repositorio. Render detectará `render.yaml` y mostrará un servicio llamado **pedusia** (plan *Free*).
5. Te pedirá las variables marcadas como secretas. Rellénalas con tus datos:

| Variable | Valor |
|---|---|
| `GROQ_API_KEY` | `gsk_...` |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | `sb_publishable_...` |
| `SUPABASE_SERVICE_KEY` | `sb_secret_...` |
| `SUPABASE_JWT_SECRET` | **déjala vacía** (en proyectos nuevos) |
| `OWNER_EMAIL` | tu email |
| `CONTACT_EMAIL` | email para solicitudes del Plan MAX |

6. Pulsa **Apply** (o *Deploy Blueprint*).

> 💡 **¿El nombre `pedusia` está cogido?** Render te dará una URL tipo `pedusia-ab12.onrender.com`. Puedes cambiar `name: pedusia` en `render.yaml` antes de subirlo a GitHub.

### 9.2 Ver el despliegue

1. Entra en el servicio **pedusia** → pestaña **Logs** (o *Events*).
2. Verás cómo instala las dependencias (`pip install ...`) y después:
   ```
   INFO:     Uvicorn running on http://0.0.0.0:10000
   ==> Your service is live 🎉
   ```
3. Arriba aparece tu URL: `https://pedusia.onrender.com` (o parecida). **Cópiala.**
4. Abre `https://TU-APP.onrender.com/health` → debe responder `{"status":"ok",...}`.

### 9.3 Si prefieres hacerlo sin Blueprint (manual)

**New + → Web Service** → elige el repositorio y configura:

| Campo | Valor |
|---|---|
| Runtime | Python 3 |
| Build Command | `pip install -r backend/requirements.txt` |
| Start Command | `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Instance Type | Free |
| Health Check Path | `/health` |

En **Environment** añade todas las variables del `.env` **más** `PYTHON_VERSION=3.12.7` y `ENVIRONMENT=production`.

---

## 10. Conectar Supabase con tu web publicada

Ahora que tienes la URL de Render, hay que decírsela a Supabase y a Google. **Si te saltas esto, el login con Google y los enlaces de los emails te mandarán a `localhost`.**

### En Supabase
**Authentication → URL Configuration:**
- **Site URL:** `https://TU-APP.onrender.com`
- **Redirect URLs:** añade `https://TU-APP.onrender.com/**` y conserva `http://localhost:8000/**` para seguir probando en local.

### En Google Cloud (si usas Google)
En tu cliente OAuth, en **Authorized JavaScript origins**, añade `https://TU-APP.onrender.com`. La *redirect URI* de Supabase **no** cambia.

### Prueba final
Abre tu web publicada, entra con tu cuenta de owner y repite la prueba rápida del paso 7.6. 🎉

---

## 11. UptimeRobot: que tu web no se duerma

El plan gratuito de Render **apaga tu servicio tras 15 minutos sin visitas**. La siguiente visita tarda unos 50 segundos en despertarlo. Para evitarlo, UptimeRobot visitará tu web cada 5 minutos.

1. Regístrate en <https://uptimerobot.com>.
2. Pulsa **+ New monitor** (o *Add New Monitor*).
3. Configura:
   - **Monitor type:** HTTP(s)
   - **Friendly name:** `PedusGPT`
   - **URL:** `https://TU-APP.onrender.com/health`
   - **Monitoring interval:** **5 minutes** (es el único intervalo del plan gratuito y vale perfectamente: basta con que sea menor de 15 minutos)
4. Activa las alertas por email si quieres enterarte cuando la web se caiga.
5. Guarda (*Create monitor*).

**Bonus incluido:** cada vez que UptimeRobot visita `/health`, PedusGPT hace (como mucho cada 6 horas) una consulta mínima a Supabase. Así tu proyecto gratuito de Supabase **tampoco se pausa** por inactividad (Supabase pausa los proyectos gratuitos tras una semana sin actividad).

> 💡 **Horas gratis de Render:** el plan gratuito incluye 750 horas al mes, suficiente para tener **un** servicio encendido 24/7. No crees otro servicio gratuito encendido a la vez o te quedarás sin horas antes de fin de mes.

---

## 11 bis. Aparecer en Google

PedusGPT ya trae preparado lo técnico: descripción para Google, `robots.txt`, `sitemap.xml`, datos estructurados y vista previa al compartir el enlace.

1. Entra en <https://search.google.com/search-console> → **Añadir propiedad** → **Prefijo de la URL** → `https://TU-APP.onrender.com`.
2. Elige el método **Etiqueta HTML** y copia el código del `content="..."`.
3. En Render → tu servicio → **Environment** → añade `GOOGLE_SITE_VERIFICATION` con ese código → **Save Changes** (se vuelve a publicar sola).
4. Cuando termine, vuelve a Search Console y pulsa **Verificar**.
5. En **Sitemaps**, escribe `sitemap.xml` y pulsa **Enviar**.
6. En **Inspección de URLs**, pega tu URL y pulsa **Solicitar indexación**.

Google tarda entre unos días y unas semanas en mostrarla. Buscar "PedusGPT" es lo primero que funcionará; palabras genéricas como "IA para estudiar" necesitan visitas y enlaces desde otras webs.

---

## 12. Guía de uso para los usuarios

Puedes compartir esta sección con tus usuarios.

### Crear cuenta y entrar
- **Registrarse:** nombre, email y contraseña (mínimo 6 caracteres). Puede que tengas que confirmar el email.
- **Continuar con Google:** entra con un clic.
- **¿Olvidaste tu contraseña?** Escribe tu email y pulsa el enlace: recibirás un correo para crear una nueva.

### La pantalla principal
- **Barra lateral (izquierda):** botón *Nueva conversación*, buscador, tus chats agrupados por fecha (Hoy, Ayer, Últimos 7 días, Últimos 30 días, Más antiguas), selector de modelo, Plan MAX y tu perfil.
- **Zona de chat:** cuando está vacía te saluda por tu nombre y te propone 4 ideas (📚 💻 🌍 ✨). Pulsa una para usarla.

### Escribir y enviar
- **Enter** envía · **Shift + Enter** hace un salto de línea.
- El cuadro de texto crece hasta 5 líneas.
- Mientras la IA escribe, el botón de enviar se convierte en ⏹️ **Detener**.
- Si subes para leer algo anterior, la pantalla deja de bajar sola; pulsa la flecha ⬇️ para volver al final.

### Los tres modelos
| Modelo | Cuándo usarlo |
|---|---|
| ⚡ PedusGPT 2 | Preguntas rápidas, dudas sencillas |
| 🚀 PedusGPT 2 PRO | Deberes, explicaciones largas, código |
| 👑 PedusGPT 2 PRO ULTRA | Problemas difíciles y razonamiento profundo (Plan MAX) |

Si no tienes el Plan MAX, ULTRA aparece con un 🔒 y al pulsarlo se abre la información del plan.

### Acciones en los mensajes (pasa el ratón por encima)
- En las respuestas de la IA: 📋 copiar · 🔄 regenerar (solo la última) · 👍 / 👎 valorar · 🔊 escuchar.
- En tus mensajes: 📋 copiar · ✏️ **editar**. Al editar, se borra todo lo que venía después y la IA responde de nuevo.
- En los bloques de código: botón **Copiar código** y etiqueta con el lenguaje.

### Archivos
- Pulsa 📎, **arrastra** un archivo al chat o **pega** una imagen con Ctrl+V.
- Tipos permitidos: JPG, PNG, GIF, WEBP, PDF, TXT, MD y CSV. Máximo **10 MB**, un archivo por mensaje.
- La IA "ve" las imágenes y lee el texto de PDFs y documentos.

### Voz
- 🎤 **Dictar:** pulsa el micrófono, habla y vuelve a pulsarlo para parar. Funciona mejor en Chrome y Edge. En otros navegadores se graba el audio y se transcribe en el servidor.
- 🔊 **Escuchar:** lee la respuesta en voz alta; vuelve a pulsarlo para parar.

### Gestionar conversaciones
En los tres puntos (⋯) de cada chat de la barra lateral: **Renombrar**, **Exportar** (TXT, PDF o copiar) y **Eliminar**.

### Perfil y configuración
Pulsa tu nombre (abajo a la izquierda):
- **Perfil:** foto, nombre, bio (máx. 200 caracteres), intereses y animal favorito. **La IA usa estos datos para personalizar sus respuestas**: si pones que te gusta el fútbol, puede usar ejemplos de fútbol.
- **Preferencias:** idioma (12 disponibles), tema (Claro / Oscuro / Sistema) y modelo por defecto.
- **Tu plan:** tu plan actual y, si eres MAX, tu uso diario de ULTRA.

### Atajos de teclado
| Atajo | Acción |
|---|---|
| `Ctrl + Shift + N` | Nueva conversación |
| `Ctrl + Shift + S` | Mostrar/ocultar la barra lateral |
| `Ctrl + /` | Ir al cuadro de texto |
| `Esc` | Cerrar ventanas / cancelar edición |

(En Mac, `Cmd` en lugar de `Ctrl`.)

---

## 12 bis. PedusCode: el agente de programación

**PedusCode** es un equipo de hasta 10 IAs que programa por ti. Es exclusivo del **Plan MAX** (y de admin/owner): **3 ejecuciones al día** por persona (el owner no tiene límite). Se renuevan a las 00:00 UTC.

### Antes de usarlo por primera vez (solo el dueño de la web)

1. Vuelve a ejecutar **todo** `supabase/schema.sql` en Supabase → **SQL Editor** → *Run*. Es seguro repetirlo: añade las columnas `daily_code_runs` y `last_code_reset` y las funciones `consume_code_run` / `refund_code_run` sin borrar nada. Si no lo haces, PedusCode avisará con *«Falta actualizar la base de datos»*.
2. No hace falta ninguna variable nueva: los valores por defecto ya funcionan con el plan gratuito de Groq. Si quieres cambiar algo, mira el bloque **PedusCode** de `backend/.env.example` (por ejemplo `PEDUSCODE_DAILY_LIMIT`).

### Cómo se usa

PedusCode es una **terminal**: una ventana oscura donde escribes al lado del símbolo `>` y pulsas `Enter`. Lo que empieza por `/` es un **comando**; cualquier otra cosa es una **tarea** para las IAs.

1. En la barra lateral pulsa **💻 PedusCode**. Verás la bienvenida y tres botones rápidos: `/carpeta`, `/nuevo` y `/ayuda`.
2. **Abre tu carpeta:** escribe `/carpeta` (o pulsa el botón, o **arrastra la carpeta** desde el explorador de archivos hasta la terminal) y elige la carpeta de tu proyecto, por ejemplo `Documentos/mi-juego`. El navegador te pedirá permiso para **ver y editar** esa carpeta: acéptalo. Abajo a la derecha verás `📁 mi-juego · N archivos`. Si vas a empezar de cero, escribe `/nuevo`.
   - Solo funciona con **Chrome o Edge en un ordenador**. En móvil, Safari o Firefox recibirás los archivos en un ZIP.
   - Por seguridad, no se aceptan carpetas del sistema (`C:\Windows`, `Program Files`…), discos enteros ni tu carpeta de usuario completa.
   - Los archivos con contraseñas o claves (`.env`, `.pem`, `id_rsa`…) y carpetas como `node_modules` o `.git` **nunca** se envían a la IA. Con `/archivos` ves exactamente qué se va a leer.
3. **Escribe la tarea** (o pulsa el ejemplo de «Prueba:») y pulsa `Enter`. `Shift + Enter` hace un salto de línea. Si no habías abierto ninguna carpeta, PedusCode te preguntará dónde trabajar.
4. **El equipo trabaja:** aparece el plan del **organizador** y una línea por agente (🎨 diseño, 🧠 lógica, 📝 documentación…) con su estado: `○` en cola, `●` parpadeando mientras escribe, *Esperando turno* y `✓` listo, más los archivos que va entregando. Abajo verás *«Escribiendo código · 2/5 archivos (48 s · Esc para cancelar)»*. Con el plan gratuito de Groq suele tardar **1–3 minutos**. Para cancelar, pulsa `Esc` dos veces (o `Ctrl + C` dos veces).
5. **Revisa y guarda:** sale la lista de archivos con **Nuevo** o **Modificado** y las líneas `+`/`−`. Pulsa un archivo para ver los cambios en verde y rojo con números de línea, y `[x]` / `[ ]` para marcar o desmarcar. Después aparece la pregunta **«¿Guardar N archivo(s) en mi-juego?»**: muévete con `↑ ↓` (o pulsa `1`, `2`, `3`) y confirma con `Enter`.
   - **Sí, guardar en la carpeta:** se escriben directamente, sin descargar nada.
   - **Descargar ZIP:** te da los archivos marcados en un `.zip`.
   - **Ahora no:** podrás hacerlo luego con `/guardar` o `/zip`.
   - ⚠️ *Incompleto* o *Mucho más corto que el original*: vienen **desmarcados**; revísalos antes de guardarlos.
   - ⚠️ *Script*: revisa los `.sh`, `.bat` o `.ps1` antes de ejecutarlos.
   - Si mientras tanto has cambiado algún archivo, PedusCode te avisará antes de sobrescribirlo.
   - `/deshacer` devuelve los archivos a como estaban y borra los que creó PedusCode.

**Comandos y atajos:**

| Comando | Qué hace |
|---|---|
| `/carpeta` | Abrir una carpeta (o arrástrala) |
| `/nuevo` | Proyecto nuevo (ZIP) |
| `/archivos` | Ver los archivos que leerá la IA |
| `/releer` | Volver a leer la carpeta |
| `/cerrar` | Cerrar la carpeta |
| `/guardar` · `/zip` | Guardar en la carpeta · descargar ZIP |
| `/deshacer` | Deshacer el último guardado |
| `/uso` | Ver cuántas ejecuciones te quedan hoy |
| `/limpiar` | Limpiar la pantalla (`Ctrl + L`) |
| `/ayuda` | Ver todos los comandos |

Al escribir `/` aparece una lista de comandos: `↑ ↓` para elegir y `Tab` para completar. Con `↑ ↓` en el cuadro vacío recuperas lo que escribiste antes. Los comandos también aceptan nombres en inglés (`/open`, `/save`, `/undo`, `/help`…).

> 💡 **Consejos:** describe la tarea con detalle («un juego de la serpiente con récord guardado y botón de pausa»), elige la carpeta concreta del proyecto (no `Documentos` entero) y, si el resultado no te convence, escribe otra tarea pidiendo los ajustes: PedusCode vuelve a leer la carpeta antes de cada ejecución.

---

## 12 ter. Modo pensar, esfuerzo y skills

### Antes de usarlo por primera vez (solo el dueño de la web)

Vuelve a ejecutar **todo** `supabase/schema.sql` en Supabase → **SQL Editor** → *Run* (es seguro repetirlo, no borra nada). Añade la tabla `skills`, las columnas del razonamiento en `messages` y el contador diario de UltraMAX. Si no lo haces, el chat sigue funcionando pero las skills avisarán con *«Falta actualizar la base de datos»* y el razonamiento no se guardará.

### Modo pensar

Junto al micrófono verás el botón **🧠 Medio**:

- **Clic en el botón:** activa o desactiva el modo pensar. Desactivado pone **Pensar** y la IA contesta directamente.
- **Clic en la flecha ⌄:** abre el menú con el interruptor y los **5 niveles de esfuerzo**: **Bajo**, **Medio**, **Alto**, **Ultra** 👑 y **UltraMAX** 👑.

Cuando envías un mensaje con el modo pensar activado aparece un recuadro **«Pensando… 5 s»** donde ves en directo cómo razona la IA. Cuando empieza a escribir la respuesta, el recuadro se pliega y pone **«Pensó durante 12 s»**: pulsa encima para volver a verlo.

- **Ultra** usa el modelo más potente y le pide comprobar cada paso. Ideal para problemas de matemáticas, física o código.
- **UltraMAX** trabaja en tres fases que ves dentro del recuadro: 📝 **Borrador**, 🔍 **Revisión crítica** (otro modelo busca errores) y ✨ **Respuesta final** (la versión corregida). Tarda más (30 s – 2 min) y hay **10 al día** por persona con Plan MAX.

### Skills (Plan MAX)

Una **skill** es como darle a PedusGPT un «manual» para un tipo de tarea: por ejemplo *Profe de mates* («explica cada paso y propón un ejercicio al final») o *Corrector de redacción*.

1. Pulsa el botón **🧩** del cuadro de mensaje → **Gestionar skills** → **Nueva skill**.
2. Rellena el **nombre**, un **emoji**, **cuándo usarla** (la IA lee esto para decidir si la usa sola) y las **instrucciones**. Puedes añadir hasta 10 **archivos de referencia** de texto (apuntes, ejemplos…) o cargar un `SKILL.md` que ya tengas.
3. Guarda. A partir de ahí:
   - Con **«Elegir automáticamente»** activado (punto verde en 🧩), la IA usa las skills que encajan con cada mensaje.
   - También puedes elegirlas tú (hasta 3) en el menú 🧩 o escribiendo **`/`** y el nombre (por ejemplo `/profe-mates`) y pulsando `Enter`.
   - En la respuesta verás qué skills se han usado (🧩 📐 Profe de mates).

**Importar de GitHub:** en *Gestionar skills* → **Importar de GitHub**, pega `anthropics/skills` o el enlace de un repositorio o carpeta pública, pulsa **Buscar**, marca las que quieras e **Importar**. Si una ya existía, se actualiza. GitHub permite 60 búsquedas por hora sin token; si lo necesitas, crea un token sin permisos en GitHub → *Settings → Developer settings → Personal access tokens* y ponlo en la variable `GITHUB_TOKEN` de Render.

---

## 12 quater. Búsqueda web

### Antes de usarla por primera vez (solo el dueño de la web)

1. Vuelve a ejecutar **todo** `supabase/schema.sql` en Supabase → **SQL Editor** → *Run* (es seguro repetirlo). Añade el contador diario de búsquedas y la columna `sources` de los mensajes.
2. En Render → tu servicio → **Environment**, añade `TAVILY_API_KEY` y/o `EXA_API_KEY` (y `MISTRAL_API_KEY` si la tienes). Guarda: Render se redesplegará solo.
3. Si en **Environment** tienes variables `GROQ_MODEL_BASIC`, `GROQ_MODEL_PRO`, `GROQ_MODEL_ULTRA`, `GROQ_MODEL_TITLE` (o `GROQ_MODEL_DEEP` / `REVIEW` / `ROUTER`, `PEDUSCODE_*_MODELS`), **bórralas**: así se usan las nuevas cadenas con Mistral. (Si conservan el valor original del Blueprint, PedusGPT ya las ignora, pero es más limpio borrarlas.)
4. Abre `https://TU-APP.onrender.com/diagnostico`: los apartados de Mistral y de búsqueda web deben salir en verde.

### Cómo funciona para los usuarios

No hay que pulsar nada: cuando preguntas algo que necesita información actual (*«¿Quién ganó ayer el partido?»*, *«¿Qué tiempo hará el sábado en Barcelona?»*, *«Últimas noticias sobre…»*), PedusGPT busca solo.

- Verás **🌐 Buscando en la web…** con lo que está buscando.
- La respuesta incluye números como **¹ ²**: pulsa uno para abrir la fuente.
- Debajo aparecen las **Fuentes** (web y título). Se abren en una pestaña nueva.
- Cada persona tiene **30 respuestas con búsqueda al día** (se reinician a las 02:00 en verano / 01:00 en invierno, hora de España). El owner no tiene límite. Puedes ver cuántas te quedan en **Ajustes → Plan**.
- Si se acaban, PedusGPT responde igual con lo que sabe y te avisa de que la información puede no estar actualizada.

---

## 13. Guía del administrador

### Los roles

| Rol | PRO ULTRA | Panel admin | Puede asignar | Quién lo da |
|---|---|---|---|---|
| **Usuario** | ❌ | ❌ | — | Rol por defecto al registrarse |
| **MAX 👑** | 30/día | ❌ | — | Admin u Owner |
| **Admin 🛡️** | 30/día | ✅ | Usuario, MAX | Solo el Owner |
| **Owner ⚡** | Ilimitado | ✅ | Usuario, MAX, Admin | Automático por `OWNER_EMAIL` |

**Reglas de seguridad** (se comprueban en el servidor, no solo en la pantalla):
- Nadie puede modificar al Owner ni asignar el rol Owner.
- Un Admin no puede tocar a otros Admins.
- Nadie puede modificarse a sí mismo desde el panel.
- El contador de PRO ULTRA se reinicia cada día a las **00:00 UTC** (las 01:00 en España en invierno y las 02:00 en verano).

### El panel de administración
Pulsa el escudo 🛡️ de la barra lateral:

- **Estadísticas:** usuarios totales, activos hoy, conversaciones, mensajes, usuarios MAX y baneados.
- **Buscador y filtros:** por nombre o email, por rol y por estado.
- **Cambiar rol:** con el desplegable de la columna *Rol* (te pedirá confirmación).
- **Banear ⛔:** puedes escribir un motivo (opcional). El usuario verá una pantalla de *"Tu cuenta ha sido suspendida"* con ese motivo y no podrá usar nada.
- **Desbanear ✅:** le devuelve el acceso.
- **Resetear límite 🔄:** pone a 0 su contador de PRO ULTRA del día.
- **Ver conversaciones 🕘:** muestra **solo los títulos**. El contenido nunca se muestra, por privacidad.

### Dar el Plan MAX a alguien (flujo típico)
1. El usuario pulsa **Solicitar acceso** en la tarjeta del Plan MAX → se abre su programa de correo con un email ya escrito dirigido a tu `CONTACT_EMAIL`.
2. Tú lo lees y decides.
3. En el panel, busca su email y cambia su rol a **MAX**.
4. La próxima vez que abra la app verá *"Ya tienes el Plan MAX 🎉"* y su barra de uso.

### Gestionar desde Supabase (plan B)
Si algún día no puedes entrar al panel, en Supabase → **SQL Editor** puedes ejecutar:

```sql
-- Ver todos los usuarios
select email, display_name, role, is_banned, created_at from profiles order by created_at desc;

-- Dar Plan MAX
update profiles set role = 'max' where email = 'alumno@ejemplo.com';

-- Nombrar admin
update profiles set role = 'admin' where email = 'profe@ejemplo.com';

-- Banear con motivo
update profiles set is_banned = true, ban_reason = 'Uso inadecuado' where email = 'alguien@ejemplo.com';

-- Desbanear
update profiles set is_banned = false, ban_reason = null where email = 'alguien@ejemplo.com';

-- Reiniciar el contador de ULTRA de todos
select reset_daily_405b_requests();
```

(Desde el SQL Editor sí se pueden cambiar las columnas protegidas, porque ahí entras como administrador de la base de datos.)

---

## 14. Personalizar PedusGPT

Después de cada cambio: si estás en local con `--reload`, recarga el navegador; para publicarlo, mira el paso 15.

### 🎨 Logo
Sustituye `frontend/assets/logo.png` por tu imagen (cuadrada, PNG, 512×512 recomendado). También se usa como favicon.

### 🌈 Colores
Están en `frontend/css/themes.css`, en variables al principio del archivo:
```css
:root {            /* Tema claro */
  --bg-main: #F5F5F0;
  --accent: #2D2D2D;
  ...
}
[data-theme="dark"] {   /* Tema oscuro */
  --bg-main: #1A1A1A;
  ...
}
```
Cambia los códigos de color y listo.

### 🧠 Personalidad de la IA (system prompt)
Está en `backend/utils/system_prompts.py`, en la función `build_system_prompt`. Ahí se define cómo habla PedusGPT (cercano, sin "bro" ni "crack", responde en el idioma del usuario, etc.) y cómo usa el perfil del usuario. Edítalo con cuidado y conserva las reglas de seguridad para menores.

### 🔢 Límite diario de ULTRA
Cambia la variable `ULTRA_DAILY_LIMIT` en Render (**Environment**) y guarda: el servicio se reinicia solo. No hace falta tocar código.

### 🤖 Cambiar los modelos
Variables `GROQ_MODEL_BASIC`, `GROQ_MODEL_PRO`, `GROQ_MODEL_ULTRA` y `GROQ_MODEL_TITLE`: son listas separadas por comas, y se usa el primer modelo que funcione. Un nombre sin prefijo es de Groq; con `mistral:` delante, de Mistral. Ejemplo (PRO ULTRA solo con Groq):
```
GROQ_MODEL_ULTRA=openai/gpt-oss-120b,qwen/qwen3.8-27b
```
Si no defines estas variables se usan las cadenas recomendadas (mixtas Groq + Mistral).

### 🌐 Límite de búsquedas web
Cambia `WEB_SEARCH_DAILY_LIMIT` (30 por defecto). Para apagar la búsqueda web sin borrar las claves, pon `WEB_SEARCH_ENABLED=false`.
Para desactivar el análisis de imágenes, deja `GROQ_VISION_MODEL` vacío.

### 🌍 Textos e idiomas
Todos los textos de la interfaz están en `frontend/js/i18n.js`, agrupados por idioma (`es`, `en`, `fr`…). Si cambias un texto en español, cámbialo también en los demás idiomas.

### 💡 Las 4 sugerencias de la pantalla de inicio
Son las claves `sugg_*` en `i18n.js` (por ejemplo `sugg_explain_prompt`).

---

## 15. Actualizar la web después de hacer cambios

Con Git:
```bash
cd ruta/a/pedusia
git add .
git commit -m "Describe aquí tu cambio"
git push
```

Render detecta el `push` y **vuelve a desplegar solo** en 2–3 minutos (`autoDeploy: true` en `render.yaml`). Puedes seguirlo en la pestaña **Events** o **Logs**.

> 💡 Si cambias `supabase/schema.sql`, vuelve a ejecutarlo en el SQL Editor de Supabase: GitHub y Render no tocan la base de datos.

> 🧹 Si después de actualizar ves la versión vieja, fuerza la recarga con **Ctrl + F5** (Cmd + Shift + R en Mac).

---

## 16. Límites de los planes gratuitos

Son aproximados y pueden cambiar; consulta la web de cada servicio.

| Servicio | Límite gratuito | ¿Qué pasa si lo superas? |
|---|---|---|
| **Groq** | Límites por minuto y por día para cada modelo (míralos en *Settings → Limits*) | PedusGPT muestra *"Vas demasiado rápido"* y se recupera solo |
| **Supabase** | 500 MB de base de datos, 1 GB de archivos, 50.000 usuarios activos/mes, 2 proyectos | Te avisa; puedes borrar datos antiguos o pasar a pago |
| **Supabase** | Se pausa tras 7 días sin actividad | PedusGPT lo evita con el ping de `/health` |
| **Supabase (email)** | Muy pocos emails por hora con el servidor de serie | Configura un SMTP gratuito (Brevo, Resend…) |
| **Render** | 750 h/mes, 512 MB de RAM, se duerme a los 15 min | UptimeRobot lo mantiene despierto |
| **UptimeRobot** | 50 monitores, intervalo mínimo de 5 min | Te sobra |
| **Mistral (Experiment)** | ~1 petición/s y ~20.000 tokens/min por modelo | PedusGPT pasa al siguiente modelo de la cadena |
| **Tavily** | 1.000 búsquedas al mes | Se usa Exa; si tampoco, la IA responde sin buscar |
| **Exa** | Crédito gratuito al registrarte + crédito mensual | La IA responde sin buscar |
| **Groq (PedusCode)** | ~8.000 tokens por minuto y 200.000 por día en cada modelo | PedusCode espera su turno automáticamente (por eso tarda 1–3 min); si se agota el cupo diario, muestra un error y no gasta la ejecución si el organizador no llegó a trabajar |

**Para cuidar el espacio:** los archivos subidos ocupan Storage. Puedes revisarlos en Supabase → **Storage → uploads** y borrar los antiguos.

---

## 17. Solución de problemas

### En la pantalla de login

| Síntoma | Causa | Solución |
|---|---|---|
| *"El servidor aún no está configurado"* | Faltan variables de entorno | Revisa `.env` (local) o **Environment** (Render). Los logs dicen cuáles faltan. |
| *"Confirma tu email antes de iniciar sesión"* | No has pulsado el enlace del correo | Revisa la bandeja de spam, o desactiva *Confirm email* para probar |
| No llegan los emails | Límite del correo de serie de Supabase | Espera una hora o configura un SMTP propio (paso 5.4) |
| Google te devuelve a `localhost` | La *Site URL* sigue siendo la local | Paso 10 |
| Error `redirect_uri_mismatch` de Google | La URI en Google Cloud no coincide | Debe ser exactamente `https://TU-PROYECTO.supabase.co/auth/v1/callback` |
| Google dice *"Access blocked"* | La app está en modo Testing | Añádete como *Test user* o pulsa **Publish app** |

### En el chat

| Síntoma | Causa | Solución |
|---|---|---|
| *"Ups, algo salió mal"* al enviar | Clave de Groq incorrecta o modelo no disponible | Revisa `GROQ_API_KEY`; mira los logs (Render → Logs) |
| *"Vas demasiado rápido"* | Límite de Groq o de PedusGPT | Espera un minuto |
| *"Has alcanzado tu límite de 30 mensajes…"* | Límite diario de ULTRA | Usa PRO o espera a las 00:00 UTC (o un admin te lo resetea) |
| *"Necesitas el Plan MAX"* | Eres usuario normal | Solicita acceso o pide a un admin que te dé MAX |
| No se suben archivos | Faltan los buckets | Vuelve a ejecutar `schema.sql` y comprueba **Storage** |
| *"Error al cargar datos"* | No se ha ejecutado `schema.sql`, o la *secret key* es incorrecta | Paso 5.2 y revisa `SUPABASE_SERVICE_KEY` |
| `permission denied for table profiles` (o error 503 al entrar) | Desde 2026 Supabase ya no da permisos automáticos a las tablas nuevas | Ejecuta de nuevo el `schema.sql` actual, que ya incluye los `grant` necesarios |
| *"Invalid API key"* o *"Invalid JWT"* en los logs | Clave mal copiada (espacios, cortada) o de otro proyecto | Cópiala de nuevo desde **API Keys** |
| El micrófono no hace nada | Falta HTTPS o permiso | En Render ya hay HTTPS; acepta el permiso del navegador (icono 🔒 de la barra de direcciones) |
| La lectura en voz alta suena con acento raro | Tu sistema no tiene esa voz instalada | Instala voces en la configuración de idioma del sistema |
| La primera carga tarda casi un minuto | Render estaba dormido | Configura UptimeRobot (paso 11) |

### En PedusCode

| Problema | Solución |
|---|---|
| *«Falta actualizar la base de datos»* | Vuelve a ejecutar todo `supabase/schema.sql` en Supabase |
| `/carpeta` no hace nada o sale *«Tu navegador no permite abrir carpetas»* | Usa Chrome o Edge en un ordenador (y la web con `https://`). Mientras tanto, usa `/nuevo` (ZIP) |
| Tras actualizar la web, PedusCode se ve como antes o algún botón no responde | Recarga una vez con `Ctrl + Shift + R` (en Mac `Cmd + Shift + R`). A partir de ahora cada versión nueva se descarga sola |
| *«Carpeta no permitida»* | Has elegido una carpeta del sistema o tu carpeta de usuario entera. Elige la carpeta concreta del proyecto |
| *«La carpeta tiene demasiados archivos»* | Elige una subcarpeta más concreta (las dependencias como `node_modules` ya se ignoran solas) |
| Se queda mucho rato en *«Esperando turno»* | Es normal en el plan gratuito de Groq (8.000 tokens/min por modelo). Si pasas al plan Developer, sube `GROQ_TPM_LIMIT` en Render |
| Un archivo sale como *Incompleto* | El agente se quedó sin espacio. Pide una tarea más pequeña o divide el trabajo en varias ejecuciones |
| *«Has usado todas tus ejecuciones de hoy»* | Son 3 al día; se renuevan a las 00:00 UTC. El owner puede reiniciar el contador desde el panel de admin (*Resetear límite*) |

### En Render

| Síntoma | Solución |
|---|---|
| El *build* falla en `pip install` | Comprueba que `PYTHON_VERSION=3.12.7` está en Environment |
| `ModuleNotFoundError: No module named 'main'` | El *Start Command* debe empezar por `cd backend &&` |
| *"Deploy failed – health check"* | Mira los logs: casi siempre es una variable mal escrita |
| La web va bien pero ves cambios antiguos | Ctrl + F5, o comprueba en **Events** que el último deploy terminó |

### Avisos en la consola del navegador que puedes ignorar
- `Connecting to '...js.map' violates the following Content Security Policy...` o `DevTools failed to load source map`: son los *source maps*, unos archivos que solo pide la consola de desarrollador (F12) para depurar librerías. No afectan a la app. Desde la versión actual ya no aparece.

### Cómo leer los logs
- **Local:** en la terminal donde corre `uvicorn`.
- **Render:** servicio → **Logs**. Busca líneas con `ERROR` o `WARNING`.
- **Navegador:** pulsa **F12 → Console** para ver errores de la parte web.

---

## 18. Seguridad y buenas prácticas

- 🔒 **Nunca** compartas ni subas a GitHub `GROQ_API_KEY` ni `SUPABASE_SERVICE_KEY`. Si se filtran, crea claves nuevas (en Groq y en Supabase → API Keys) y borra las viejas.
- 🔒 La **publishable key** sí puede verse en el navegador: es normal y está protegida por las políticas RLS.
- 🔒 Mantén el repositorio de GitHub **privado** si puedes.
- 👤 Usa una contraseña fuerte y activa la verificación en dos pasos (2FA) en GitHub, Supabase, Render y Groq.
- 🧒 **Usuarios menores de edad:** PedusGPT está pensado para estudiantes de 14 a 17 años. En España, la edad mínima para dar consentimiento sobre tus propios datos es 14 años. Es muy recomendable publicar una **política de privacidad** sencilla que explique qué datos guardas (email, nombre, conversaciones, archivos), para qué y cómo pedir que se borren. Si la usas en un centro educativo, coordínalo con el centro. (Esto es orientativo, no asesoramiento legal.)
- 🗑️ Si un usuario pide borrar su cuenta: Supabase → **Authentication → Users** → busca su email → **Delete user**. Su perfil, conversaciones y mensajes se borran en cascada. Sus archivos de Storage no se borran solos: búscalos en **Storage → uploads** y **avatars**, en la carpeta con su ID de usuario.
- 💾 **Copias de seguridad:** el plan gratuito de Supabase no guarda copias que puedas descargar. Cada cierto tiempo, en **Table Editor** puedes exportar las tablas a CSV.

---

## 19. Glosario

| Término | Significado |
|---|---|
| **API** | Forma en que dos programas se hablan (tu web ↔ tu servidor ↔ Groq). |
| **API key / clave** | Contraseña que identifica a tu aplicación ante un servicio. |
| **Backend** | La parte que corre en el servidor (Python/FastAPI). |
| **Frontend** | La parte que ve el usuario en el navegador (HTML/CSS/JS). |
| **Deploy / desplegar** | Publicar una versión nueva en internet. |
| **Variable de entorno** | Configuración (como las claves) que se da al servidor sin escribirla en el código. |
| **`.env`** | Archivo con tus variables de entorno en local. Secreto. |
| **RLS** | Row Level Security: reglas de la base de datos para que cada usuario solo vea lo suyo. |
| **JWT / token** | "Pase" temporal que demuestra que has iniciado sesión. |
| **OAuth** | Sistema para entrar con otra cuenta (Google). |
| **SSE / streaming** | Técnica para que la respuesta llegue palabra a palabra. |
| **Bucket** | "Carpeta" de archivos en Supabase Storage. |
| **Repositorio (repo)** | Carpeta de tu proyecto guardada en GitHub. |
| **Commit / push** | Guardar un cambio con Git / subirlo a GitHub. |
| **Entorno virtual (venv)** | Carpeta aislada con las librerías de Python del proyecto. |
| **Cold start** | Lo que tarda Render en "despertar" un servicio dormido. |
| **UTC** | Hora universal; España va 1 hora por delante en invierno y 2 en verano. |

---

## 20. Lista de comprobación final

**Configuración**
- [ ] Clave de Groq creada y guardada
- [ ] (Opcional) Claves de Mistral, Tavily y Exa
- [ ] Proyecto de Supabase creado
- [ ] `schema.sql` ejecutado sin errores
- [ ] Tablas y buckets visibles en Supabase
- [ ] Publishable key y secret key copiadas
- [ ] (Opcional) Google OAuth configurado y app publicada
- [ ] (Recomendado) SMTP propio configurado

**Local**
- [ ] `.env` relleno
- [ ] `uvicorn` arranca sin avisos
- [ ] Me registro con `OWNER_EMAIL` y aparece **Owner ⚡**
- [ ] El chat responde en streaming

**Publicación**
- [ ] Código en GitHub **sin** el `.env`
- [ ] Servicio desplegado en Render con todas las variables
- [ ] `https://TU-APP.onrender.com/health` responde `ok`
- [ ] *Site URL* y *Redirect URLs* de Supabase actualizadas
- [ ] Origen de Render añadido en Google Cloud
- [ ] Monitor de UptimeRobot cada 5 minutos
- [ ] `/diagnostico` en verde (también Mistral y búsqueda web si las activaste)

**¡Listo!** 🎉 Comparte tu URL y empieza a invitar a gente.

---

<p align="center">Hecho con 💛 para PedusGPT · Si algo no funciona, revisa primero la <a href="#17-solución-de-problemas">sección 17</a> y los logs.</p>
