/* =====================================================================
   PedusGPT — PedusCode: agente de código con 10 IAs (solo Plan MAX)
   - Lee una carpeta elegida por el usuario (File System Access API).
   - Filtra secretos, carpetas del sistema y dependencias ANTES de enviar.
   - Muestra en directo el trabajo del organizador y de cada agente (SSE).
   - Nada se escribe sin revisión: el usuario elige qué archivos guardar,
     se detectan cambios hechos mientras tanto y se puede deshacer.
   - Si el navegador no permite carpetas, entrega un ZIP.
   ===================================================================== */

const PedusCode = (() => {
  /* ------------------------------------------------------------------ */
  /* Límites (iguales o algo por debajo de los del backend)              */
  /* ------------------------------------------------------------------ */
  const LIMITS = {
    taskChars: 4000,
    maxFiles: 600,          // archivos con contenido enviados
    maxFileChars: 120000,   // por archivo
    maxTotalChars: 580000,  // total enviado (el backend admite 600K)
    maxTree: 3000,          // entradas del árbol
    maxScan: 6000,          // archivos recorridos como máximo
    maxDepth: 12,
    maxPreviewLines: 1500,
    diffCells: 4000000,
  };

  /* Carpetas que nunca se recorren (dependencias, builds, control de versiones, secretos) */
  const IGNORED_DIRS = new Set([
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".tox", ".nox", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", ".turbo",
    ".parcel-cache", ".cache", ".vite", "coverage", "target", "vendor", "bower_components", ".idea", ".vs",
    ".gradle", "Pods", ".dart_tool", "obj", "bin", ".terraform", ".ssh", ".aws", ".gnupg", ".azure", ".kube",
    ".docker", "$recycle.bin", "system volume information",
  ].map((name) => name.toLowerCase()));

  /* Carpetas donde nunca se escribe (mismas que en el backend) */
  const WRITE_BLOCKED_DIRS = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
    ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".terraform"]);

  /* Nombres de carpeta que delatan una carpeta del sistema o personal completa */
  const BLOCKED_ROOT_NAMES = new Set([
    "windows", "system32", "syswow64", "program files", "program files (x86)", "programdata", "appdata",
    "users", "usuarios", "documents and settings", "library", "system", "applications", "usr", "bin", "sbin",
    "etc", "var", "boot", "opt", "private", "volumes", "dev", "proc", "$recycle.bin", "recovery",
  ]);
  /* Si la raíz contiene varios de estos, es un disco o la carpeta personal: se rechaza */
  const SYSTEM_MARKERS = ["windows", "program files", "programdata", "system32", "appdata", "ntuser.dat",
    "library", "applications", "system", "usr", "etc", "boot", "desktop", "escritorio", "downloads", "descargas"];

  const SECRET_NAMES = new Set([
    ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", "credentials.json", "id_rsa", "id_dsa",
    "id_ecdsa", "id_ed25519", "known_hosts", "authorized_keys", "secrets.json", "service-account.json",
  ]);
  const SECRET_EXT = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".ppk"]);
  const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
  const BLOCKED_EXT = new Set([".exe", ".dll", ".msi", ".scr", ".com", ".lnk", ".reg", ".vbs", ".vbe", ".wsf",
    ".wsh", ".hta", ".cpl", ".sys", ".jar", ".app", ".bin", ".so", ".dylib", ".pif", ".gadget", ".msc", ".scf",
    ".inf", ".iso", ".img", ".dmg"]);
  const SCRIPT_EXT = new Set([".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".psm1"]);
  const WINDOWS_RESERVED = new Set(["con", "prn", "aux", "nul",
    ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

  /* Extensiones de texto que se leen y se envían a la IA */
  const TEXT_EXT = new Set([
    ".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json",
    ".jsonc", ".md", ".mdx", ".markdown", ".txt", ".py", ".pyi", ".rb", ".php", ".java", ".kt", ".kts", ".c", ".h",
    ".cpp", ".hpp", ".cc", ".cs", ".go", ".rs", ".swift", ".dart", ".lua", ".sh", ".bash", ".zsh", ".ps1", ".bat",
    ".cmd", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".svg", ".vue", ".svelte", ".astro", ".sql",
    ".graphql", ".gql", ".csv", ".r", ".jl", ".scala", ".ex", ".exs", ".erl", ".hs", ".ml", ".pl", ".gradle",
    ".properties", ".gd", ".tscn", ".rst", ".tex", ".ejs", ".hbs", ".pug", ".njk", ".liquid", ".prisma", ".proto",
    ".sol", ".zig", ".nim", ".v", ".asm", ".s", ".glsl", ".hlsl", ".wgsl", ".lock",
  ]);
  const TEXT_NAMES = new Set(["dockerfile", "makefile", "procfile", "gemfile", "rakefile", "license", "readme",
    ".gitignore", ".gitattributes", ".editorconfig", ".prettierrc", ".eslintrc", ".babelrc", ".nvmrc",
    ".python-version", ".dockerignore", "requirements.txt", ".env.example", ".env.sample", ".env.template", ".env.dist"]);
  /* Archivos que conviene enviar primero (dan contexto del proyecto) */
  const PRIORITY_NAMES = ["package.json", "readme.md", "index.html", "main.py", "app.py", "requirements.txt",
    "pyproject.toml", "cargo.toml", "go.mod", "tsconfig.json", "vite.config.js", "vite.config.ts", "main.js",
    "app.js", "index.js", "main.ts", "index.ts", "styles.css", "style.css"];

  const EXAMPLES = ["code_ex1", "code_ex2", "code_ex3"];

  /* ------------------------------------------------------------------ */
  /* Estado                                                              */
  /* ------------------------------------------------------------------ */
  const state = {
    initialized: false,
    dirHandle: null,
    folderName: "",
    zipMode: false,          // proyecto nuevo sin carpeta
    scan: null,              // { tree, files, stats }
    snapshot: new Map(),     // ruta -> contenido leído (texto normalizado tal cual)
    existing: new Set(),     // todas las rutas que existían al escanear
    scanning: false,
    running: false,
    controller: null,
    timer: null,
    startedAt: 0,
    agents: new Map(),       // id -> { data, el, status }
    results: new Map(),      // ruta -> resultado
    undo: null,              // [{ path, existed, original }]
    saving: false,
    plannerDone: false,
  };

  /* ------------------------------------------------------------------ */
  /* Utilidades de rutas y archivos                                       */
  /* ------------------------------------------------------------------ */
  function extension(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLowerCase() : "";
  }

  function isSecretFile(name) {
    const lower = name.toLowerCase();
    if (lower.startsWith(".env") && !ENV_TEMPLATES.has(lower)) return true;
    if (SECRET_NAMES.has(lower) || lower.startsWith("id_rsa.") || lower.startsWith("id_ed25519.")) return true;
    return SECRET_EXT.has(extension(lower));
  }

  function isTextFile(name) {
    const lower = name.toLowerCase();
    return TEXT_NAMES.has(lower) || TEXT_EXT.has(extension(lower));
  }

  /** Comprobación de seguridad de una ruta relativa (igual que la del backend) */
  function safePath(raw) {
    if (typeof raw !== "string") return null;
    let path = raw.trim().replace(/\\/g, "/");
    while (path.startsWith("./")) path = path.slice(2);
    if (!path || path.length > 200 || /[\x00-\x1f<>:"|?*]/.test(path)) return null;
    if (path.startsWith("/") || path.startsWith("~")) return null;
    const parts = path.split("/");
    if (parts.length > LIMITS.maxDepth || parts.some((part) => !part || part === "." || part === "..")) return null;
    if (parts.some((part) => /[ .]$/.test(part))) return null;
    if (parts.some((part) => WINDOWS_RESERVED.has(part.split(".")[0].toLowerCase()))) return null;
    if (parts.slice(0, -1).some((part) => WRITE_BLOCKED_DIRS.has(part.toLowerCase()))) return null;
    const name = parts[parts.length - 1];
    if (isSecretFile(name) || BLOCKED_EXT.has(extension(name))) return null;
    return path;
  }

  function normalizeNewlines(text) {
    return String(text ?? "").replace(/\r\n/g, "\n");
  }

  function slug(text) {
    return String(text || "proyecto").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "proyecto";
  }

  function formatSeconds(total) {
    const seconds = Math.max(0, Math.round(total));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m ? `${m}:${String(s).padStart(2, "0")}` : `${s} s`;
  }

  /* ------------------------------------------------------------------ */
  /* Acceso a la carpeta                                                  */
  /* ------------------------------------------------------------------ */
  const fsSupported = () => typeof window.showDirectoryPicker === "function" && window.isSecureContext;

  async function ensurePermission(handle, mode = "readwrite") {
    try {
      if ((await handle.queryPermission({ mode })) === "granted") return true;
      return (await handle.requestPermission({ mode })) === "granted";
    } catch (_) {
      return false;
    }
  }

  async function getFileHandle(root, path, create) {
    const parts = path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return { dir, file: await dir.getFileHandle(parts[parts.length - 1], { create }), name: parts[parts.length - 1] };
  }

  /** Lee el contenido actual de un archivo de la carpeta (null si no existe) */
  async function readCurrent(path) {
    try {
      const { file } = await getFileHandle(state.dirHandle, path, false);
      const blob = await file.getFile();
      return await blob.text();
    } catch (error) {
      if (error && (error.name === "NotFoundError" || error.name === "TypeMismatchError")) return null;
      throw error;
    }
  }

  async function writeFileTo(path, content) {
    const { file } = await getFileHandle(state.dirHandle, path, true);
    const writable = await file.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }
  }

  async function removeFile(path) {
    const parts = path.split("/");
    let dir = state.dirHandle;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: false });
    await dir.removeEntry(parts[parts.length - 1]);
  }

  /** Comprueba que la carpeta elegida no sea del sistema ni una carpeta personal entera */
  async function isBlockedRoot(handle) {
    const name = String(handle.name || "").trim().toLowerCase();
    if (!name || /^[a-z]:\\?$/.test(name) || name === "/" || BLOCKED_ROOT_NAMES.has(name)) return true;
    let markers = 0;
    let count = 0;
    for await (const [entryName] of handle.entries()) {
      count += 1;
      if (SYSTEM_MARKERS.includes(entryName.toLowerCase())) markers += 1;
      if (markers >= 2) return true;
      if (count > 400) break;
    }
    return false;
  }

  /** Recorre la carpeta y prepara el árbol y los archivos que se enviarán */
  async function scanFolder(handle) {
    const candidates = [];
    const tree = [];
    const stats = { files: 0, sent: 0, secret: 0, ignored: 0, big: 0, binary: 0, chars: 0 };
    const existing = new Set();
    let visited = 0;

    async function walk(dir, prefix, depth) {
      for await (const [name, entry] of dir.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === "directory") {
          if (IGNORED_DIRS.has(name.toLowerCase()) || depth >= LIMITS.maxDepth - 1) { stats.ignored += 1; continue; }
          await walk(entry, path, depth + 1);
          continue;
        }
        visited += 1;
        if (visited > LIMITS.maxScan) {
          const error = new Error("too_big");
          error.code = "too_big";
          throw error;
        }
        existing.add(path);
        if (isSecretFile(name)) { stats.secret += 1; continue; }
        if (!safePath(path)) { stats.ignored += 1; continue; }
        let size = 0;
        try { size = (await entry.getFile()).size; } catch (_) { stats.ignored += 1; continue; }
        stats.files += 1;
        tree.push({ path, size });
        if (!isTextFile(name)) { stats.binary += 1; continue; }
        if (size > LIMITS.maxFileChars) { stats.big += 1; continue; }
        candidates.push({ path, size, entry, name: name.toLowerCase() });
      }
    }

    await walk(handle, "", 0);

    // Prioridad: archivos clave primero, después los más pequeños y menos profundos
    const priority = (item) => {
      const index = PRIORITY_NAMES.indexOf(item.name);
      return index === -1 ? 100 : index;
    };
    candidates.sort((a, b) => priority(a) - priority(b) || a.path.split("/").length - b.path.split("/").length || a.size - b.size);

    const files = [];
    const snapshot = new Map();
    let total = 0;
    for (const item of candidates) {
      if (files.length >= LIMITS.maxFiles || total + item.size > LIMITS.maxTotalChars) { stats.big += 1; continue; }
      let text;
      try { text = await (await item.entry.getFile()).text(); } catch (_) { stats.ignored += 1; continue; }
      if (text.includes("\u0000")) { stats.binary += 1; continue; }
      if (text.length > LIMITS.maxFileChars || total + text.length > LIMITS.maxTotalChars) { stats.big += 1; continue; }
      files.push({ path: item.path, content: text });
      snapshot.set(item.path, text);
      total += text.length;
    }
    stats.sent = files.length;
    stats.chars = total;

    tree.sort((a, b) => a.path.localeCompare(b.path));
    return { tree: tree.slice(0, LIMITS.maxTree), files, stats, snapshot, existing };
  }

  /* ------------------------------------------------------------------ */
  /* Interfaz: carpeta                                                   */
  /* ------------------------------------------------------------------ */
  function renderFolder() {
    const hasFolder = !!state.dirHandle || state.zipMode;
    $("#code-folder-empty").hidden = hasFolder;
    $("#code-folder-info").hidden = !hasFolder;
    $("#code-fs-unsupported").hidden = fsSupported();
    $("#code-pick-btn").disabled = !fsSupported() || state.scanning;
    $("#code-rescan-btn").hidden = !state.dirHandle;
    if (!hasFolder) return;

    const nameEl = $("#code-folder-name");
    const statsEl = $("#code-folder-stats");
    if (state.zipMode) {
      nameEl.textContent = t("code_new_project_mode");
      statsEl.textContent = t("code_new_project_stats");
      return;
    }
    nameEl.textContent = state.folderName;
    if (state.scanning || !state.scan) {
      statsEl.textContent = t("code_scanning");
      return;
    }
    const s = state.scan.stats;
    const skipped = s.secret + s.ignored + s.big + s.binary;
    statsEl.textContent = t("code_folder_stats", { files: s.sent, skipped });
    statsEl.title = s.secret ? t("code_secret_skipped", { n: s.secret }) : "";
  }

  async function pickFolder() {
    if (!fsSupported()) { toast(t("code_fs_unsupported"), "warning", 6000); return; }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: "peduscode", mode: "readwrite" });
    } catch (error) {
      if (error && error.name === "AbortError") return; // el usuario cerró el selector
      toast(t("code_folder_error"), "error");
      return;
    }
    try {
      if (await isBlockedRoot(handle)) {
        dialog({ icon: "🛡️", title: t("code_folder_blocked_title"), text: t("code_folder_blocked"), confirmText: t("understood"), hideCancel: true });
        return;
      }
    } catch (_) {
      toast(t("code_folder_error"), "error");
      return;
    }
    state.dirHandle = handle;
    state.folderName = handle.name;
    state.zipMode = false;
    state.undo = null;
    $("#code-undo-btn").hidden = true;
    await rescan();
  }

  async function rescan({ silent = false } = {}) {
    if (!state.dirHandle || state.scanning) return !!state.scan;
    state.scanning = true;
    renderFolder();
    try {
      if (!(await ensurePermission(state.dirHandle, "read"))) {
        toast(t("code_permission_denied"), "error");
        return false;
      }
      const result = await scanFolder(state.dirHandle);
      state.scan = { tree: result.tree, files: result.files, stats: result.stats };
      state.snapshot = result.snapshot;
      state.existing = result.existing;
      if (!silent && result.stats.secret) toast(t("code_secret_skipped", { n: result.stats.secret }), "info", 4500);
      return true;
    } catch (error) {
      if (error && error.code === "too_big") {
        dialog({ icon: "📦", title: t("code_folder_too_big_title"), text: t("code_folder_too_big"), confirmText: t("understood"), hideCancel: true });
        clearFolder();
      } else {
        toast(t("code_folder_error"), "error");
      }
      return false;
    } finally {
      state.scanning = false;
      renderFolder();
    }
  }

  function clearFolder() {
    if (state.running) return;
    state.dirHandle = null;
    state.folderName = "";
    state.zipMode = false;
    state.scan = null;
    state.snapshot = new Map();
    state.existing = new Set();
    state.undo = null;
    $("#code-undo-btn").hidden = true;
    renderFolder();
    updateSaveButtons();
  }

  function useZipMode() {
    clearFolder();
    state.zipMode = true;
    renderFolder();
    $("#code-task").focus();
  }

  /* ------------------------------------------------------------------ */
  /* Interfaz: uso, bloqueo y ejemplos                                    */
  /* ------------------------------------------------------------------ */
  function usage() {
    return (App.profile && App.profile.code) || null;
  }

  function renderUsage() {
    const chip = $("#code-usage");
    const info = usage();
    if (!info || !App.hasUltra) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.textContent = info.unlimited ? `💻 ${t("code_usage_unlimited")}` : `💻 ${t("code_usage_chip", { used: info.used, limit: info.limit })}`;
    chip.classList.toggle("ultra", !info.unlimited && info.remaining === 0);
  }

  function renderAccess() {
    const locked = !App.hasUltra;
    $("#code-locked").hidden = !locked;
    $("#code-setup").hidden = locked;
    if (locked) {
      $("#code-progress").hidden = true;
      $("#code-results").hidden = true;
    }
    renderUsage();
  }

  function renderExamples() {
    const box = $("#code-examples");
    box.innerHTML = "";
    EXAMPLES.forEach((key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-example";
      button.textContent = t(key);
      button.addEventListener("click", () => {
        const input = $("#code-task");
        input.value = t(key);
        updateCounter();
        input.focus();
      });
      box.appendChild(button);
    });
  }

  function updateCounter() {
    const length = $("#code-task").value.length;
    const counter = $("#code-task-counter");
    counter.textContent = `${length}/${LIMITS.taskChars}`;
    counter.classList.toggle("char-counter", true);
    counter.classList.toggle("warn", length > LIMITS.taskChars * 0.9);
  }

  function setRunning(running) {
    state.running = running;
    const button = $("#code-run-btn");
    button.disabled = running;
    button.classList.toggle("loading-soft", running);
    $("#code-cancel-btn").hidden = !running;
    $("#code-pick-btn").disabled = running || !fsSupported();
    $("#code-nofolder-btn").disabled = running;
    $("#code-clear-folder-btn").disabled = running;
    $("#code-rescan-btn").disabled = running;
    $("#peduscode-btn").classList.toggle("is-running", running);
    if (running) {
      state.startedAt = Date.now();
      clearInterval(state.timer);
      state.timer = setInterval(updateTimer, 1000);
      updateTimer();
    } else {
      clearInterval(state.timer);
      state.timer = null;
    }
    document.title = running ? `PedusGPT — ${t("code_working_title")}` : `PedusGPT — ${t("app_tagline")}`;
    updateSaveButtons();
  }

  function updateTimer() {
    $("#code-timer").textContent = `⏱ ${formatSeconds((Date.now() - state.startedAt) / 1000)}`;
  }

  /* ------------------------------------------------------------------ */
  /* Ejecución                                                           */
  /* ------------------------------------------------------------------ */
  async function run() {
    if (state.running) return;
    if (!App.hasUltra) { Settings.openPlanModal(); return; }
    const task = $("#code-task").value.trim();
    if (task.length < 3) {
      toast(t("code_task_short"), "warning");
      $("#code-task").focus();
      return;
    }
    const info = usage();
    if (info && !info.unlimited && info.remaining === 0) { showLimitDialog(); return; }

    if (!state.dirHandle && !state.zipMode) {
      if (fsSupported()) {
        toast(t("code_choose_first"), "info");
        return;
      }
      state.zipMode = true;
      renderFolder();
    }

    // Releer la carpeta para trabajar con la versión más reciente
    if (state.dirHandle) {
      const ok = await rescan({ silent: true });
      if (!ok) return;
    }

    const body = {
      task: task.slice(0, LIMITS.taskChars),
      folder_name: state.dirHandle ? state.folderName.slice(0, 200) : "",
      tree: state.scan ? state.scan.tree : [],
      files: state.scan ? state.scan.files : [],
    };

    resetRunUI();
    setRunning(true);
    const controller = new AbortController();
    state.controller = controller;

    let response;
    try {
      response = await api("/code/run", { method: "POST", body, raw: true, signal: controller.signal });
    } catch (error) {
      setRunning(false);
      state.controller = null;
      $("#code-progress").hidden = true;
      if (error.name === "AbortError") return;
      handleRequestError(error);
      return;
    }

    let finished = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = raw.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue; // comentarios ": ping" de mantenimiento
          let event;
          try { event = JSON.parse(line.slice(6)); } catch (_) { continue; }
          if (handleEvent(event)) finished = true;
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        markCancelled();
        finished = true;
      } else {
        showPlannerError(t("error_network"));
        toast(t("error_network"), "error");
        finished = true;
      }
    } finally {
      setRunning(false);
      if (state.controller === controller) state.controller = null;
    }
    if (!finished) {
      showPlannerError(t("code_error_generic"));
      toast(t("code_error_generic"), "error");
    }
    finishAgents();
    renderResults();
  }

  async function cancel() {
    if (!state.running || !state.controller) return;
    const ok = await dialog({ icon: "⏹️", title: t("code_cancel_title"), text: t("code_cancel_confirm"), confirmText: t("code_cancel_yes"), danger: true });
    if (ok && state.controller) state.controller.abort();
  }

  function markCancelled() {
    setPlanner("error", t("code_cancelled"));
    toast(t("code_cancelled"), "info");
  }

  function handleRequestError(error) {
    if (error.code === "needs_max") { Settings.openPlanModal(); return; }
    if (error.code === "rate_limit") {
      if (App.profile && App.profile.code) {
        App.profile.code.remaining = 0;
        App.profile.code.used = App.profile.code.limit;
      }
      renderUsage();
      showLimitDialog();
      return;
    }
    const messages = {
      schema_outdated: "code_schema_outdated",
      project_too_large: "code_project_too_large",
      empty_task: "code_task_short",
      not_configured: "code_not_configured",
      too_many_requests: "rate_limit_general",
      network: "error_network",
    };
    toast(t(messages[error.code] || "code_error_generic"), "error", 6000);
  }

  function showLimitDialog() {
    const limit = (usage() && usage().limit) || (App.config && App.config.peduscode_daily_limit) || 3;
    dialog({ icon: "⏳", title: t("code_limit_title"), text: t("code_limit_text", { limit }), confirmText: t("understood"), hideCancel: true });
  }

  /** Procesa un evento del servidor. Devuelve true si es un evento final. */
  function handleEvent(event) {
    switch (event.type) {
      case "start":
        if (event.usage && App.profile) {
          App.profile.code = { ...(App.profile.code || {}), ...event.usage };
          renderUsage();
        }
        setPlanner("working", t("code_planner_working"));
        return false;
      case "planner":
        if (event.status === "waiting") setPlanner("waiting", `${t("code_planner_working")} · ${t("code_waiting", { s: Math.ceil(event.seconds || 1) })}`);
        else setPlanner("working", t("code_planner_working"));
        return false;
      case "plan":
        renderPlan(event);
        return false;
      case "agent":
        updateAgent(event);
        return false;
      case "file":
        addResult(event);
        return false;
      case "refused":
        setPlanner("error", t("code_refused_title"));
        dialog({ icon: "🙅", title: t("code_refused_title"), text: event.message || "", confirmText: t("understood"), hideCancel: true });
        if (event.refunded) refundLocal();
        return true;
      case "error":
        showPlannerError(event.message || t("code_error_generic"));
        toast(event.message || t("code_error_generic"), "error", 6000);
        if (event.refunded) refundLocal();
        return true;
      case "done":
        onDone(event);
        return true;
      default:
        return false;
    }
  }

  function refundLocal() {
    const info = usage();
    if (info && !info.unlimited && info.used > 0) {
      info.used -= 1;
      info.remaining = Math.max(0, info.limit - info.used);
    }
    renderUsage();
    toast(t("code_refunded"), "info", 4500);
  }

  function onDone(event) {
    const files = event.files || 0;
    if (files > 0) {
      setPlanner("done", t("code_done", { n: files, s: Math.round(event.seconds || 0) }));
      toast(t("code_done", { n: files, s: Math.round(event.seconds || 0) }), "success", 5000);
    } else {
      setPlanner("error", t("code_no_files"));
      toast(t("code_no_files"), "warning", 6000);
    }
    if (event.failed && event.failed.length) {
      const names = event.failed.map((id) => {
        const agent = state.agents.get(id);
        return agent ? agent.data.name : `#${id}`;
      });
      toast(t("code_failed_some", { names: names.join(", ") }), "warning", 6000);
    }
    if (event.refunded) refundLocal();
    $("#code-results").hidden = state.results.size === 0;
    if (state.results.size) {
      requestAnimationFrame(() => $("#code-results").scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Interfaz: organizador y agentes                                     */
  /* ------------------------------------------------------------------ */
  function resetRunUI() {
    state.agents.clear();
    state.results.clear();
    state.undo = null;
    state.plannerDone = false;
    $("#code-undo-btn").hidden = true;
    $("#code-agents").innerHTML = "";
    $("#code-file-list").innerHTML = "";
    $("#code-summary").hidden = true;
    $("#code-results").hidden = true;
    $("#code-progress").hidden = false;
    $("#code-timer").textContent = "";
    setPlanner("working", t("code_connecting"));
    requestAnimationFrame(() => $("#code-progress").scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function setPlanner(status, text) {
    const box = $("#code-planner");
    box.className = `code-planner status-${status}`;
    const icon = status === "done" ? Icons.check : status === "error" ? Icons.alert : '<span class="spinner"></span>';
    box.innerHTML = `<span class="code-planner-icon">${icon}</span><span class="code-planner-text"></span>`;
    box.querySelector(".code-planner-text").textContent = text;
  }

  function showPlannerError(message) {
    setPlanner("error", message);
  }

  function renderPlan(plan) {
    state.plannerDone = true;
    const agents = plan.agents || [];
    const totalFiles = agents.reduce((sum, agent) => sum + (agent.files || []).length, 0);
    setPlanner("done", t("code_plan_ready", { agents: agents.length, files: totalFiles }));
    const summary = $("#code-summary");
    summary.textContent = plan.summary || "";
    summary.hidden = !plan.summary;

    const container = $("#code-agents");
    container.innerHTML = "";
    agents.forEach((agent, index) => {
      const card = document.createElement("article");
      card.className = "agent-card status-queued";
      card.style.animationDelay = `${index * 60}ms`;
      card.innerHTML = `
        <div class="agent-head">
          <span class="agent-emoji"></span>
          <div class="agent-title"><strong></strong><span class="agent-role"></span></div>
        </div>
        <div class="agent-status"><span class="agent-dot"></span><span class="agent-status-text"></span></div>
        <ul class="agent-files"></ul>
        <p class="agent-notes" hidden></p>`;
      card.querySelector(".agent-emoji").textContent = agent.emoji || "🤖";
      card.querySelector("strong").textContent = agent.name || `#${agent.id}`;
      card.querySelector(".agent-role").textContent = agent.role || "";
      const list = card.querySelector(".agent-files");
      (agent.files || []).forEach((file) => {
        const li = document.createElement("li");
        li.dataset.path = file.path;
        li.title = file.purpose || "";
        li.innerHTML = `<span class="agent-file-badge ${file.action === "edit" ? "edit" : "create"}"></span><span class="agent-file-path"></span>`;
        li.querySelector(".agent-file-badge").textContent = file.action === "edit" ? "M" : "+";
        li.querySelector(".agent-file-path").textContent = file.path;
        list.appendChild(li);
      });
      container.appendChild(card);
      const entry = { data: agent, el: card, status: "queued" };
      state.agents.set(agent.id, entry);
      setAgentStatus(entry, "queued", t("code_agent_queued"));
    });
  }

  function setAgentStatus(entry, status, text) {
    entry.status = status;
    entry.el.className = `agent-card status-${status}`;
    entry.el.querySelector(".agent-status-text").textContent = text;
  }

  function updateAgent(event) {
    const entry = state.agents.get(event.id);
    if (!entry) return;
    switch (event.status) {
      case "working":
        setAgentStatus(entry, "working", event.chars ? t("code_agent_writing", { n: event.chars.toLocaleString(I18n.locale()) }) : t("code_agent_thinking"));
        break;
      case "waiting":
        setAgentStatus(entry, "waiting", t("code_waiting", { s: Math.ceil(event.seconds || 1) }));
        break;
      case "done": {
        setAgentStatus(entry, "done", t("code_agent_done"));
        const notes = [];
        if (event.notes) notes.push(event.notes);
        if (event.missing && event.missing.length) notes.push(t("code_agent_missing", { files: event.missing.join(", ") }));
        const notesEl = entry.el.querySelector(".agent-notes");
        notesEl.textContent = notes.join(" · ");
        notesEl.hidden = !notes.length;
        break;
      }
      case "error":
        setAgentStatus(entry, "error", event.message || t("code_agent_error"));
        break;
      default:
        break;
    }
  }

  /** Al terminar, ningún agente se queda "trabajando" en pantalla */
  function finishAgents() {
    state.agents.forEach((entry) => {
      if (["queued", "working", "waiting"].includes(entry.status)) setAgentStatus(entry, "error", t("code_agent_stopped"));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Resultados                                                           */
  /* ------------------------------------------------------------------ */
  function addResult(event) {
    const path = safePath(event.path);
    if (!path) return;
    const original = state.snapshot.has(path) ? state.snapshot.get(path) : null;
    const exists = state.existing.has(path);
    const content = String(event.content ?? "");
    const flags = [];
    if (event.truncated) flags.push("truncated");
    if (original !== null && original.length > 200 && content.length < original.length * 0.4) flags.push("shorter");
    if (SCRIPT_EXT.has(extension(path))) flags.push("script");
    if (exists && original === null) flags.push("unread");
    const identical = original !== null && normalizeNewlines(original) === normalizeNewlines(content);

    const result = {
      path,
      content,
      agentId: event.agent_id,
      action: exists ? "edit" : "create",
      original,
      flags,
      identical,
      selected: !flags.includes("truncated") && !flags.includes("shorter") && !identical,
      saved: false,
    };
    state.results.set(path, result);

    const entry = state.agents.get(event.agent_id);
    if (entry) {
      const li = entry.el.querySelector(`.agent-files li[data-path="${CSS.escape(event.path)}"]`);
      if (li) li.classList.add("delivered");
    }
    $("#code-results").hidden = false;
    renderResults();
  }

  function lineStats(result) {
    if (result.original === null) return { add: normalizeNewlines(result.content).split("\n").length, del: 0 };
    const ops = diffLines(normalizeNewlines(result.original), normalizeNewlines(result.content));
    let add = 0;
    let del = 0;
    ops.forEach(([op]) => { if (op === "+") add += 1; else if (op === "-") del += 1; });
    return { add, del, ops };
  }

  function renderResults() {
    const list = $("#code-file-list");
    const openPaths = new Set($$(".code-file.open", list).map((el) => el.dataset.path));
    list.innerHTML = "";
    const results = Array.from(state.results.values()).sort((a, b) => a.path.localeCompare(b.path));
    results.forEach((result) => {
      if (!result.stats) result.stats = lineStats(result);
      const row = document.createElement("div");
      row.className = `code-file${result.selected ? " selected" : ""}${result.saved ? " saved" : ""}`;
      row.dataset.path = result.path;
      row.innerHTML = `
        <div class="code-file-head">
          <input type="checkbox" class="code-file-check" />
          <button type="button" class="code-file-toggle">
            <span class="code-file-chevron">${Icons.chevron}</span>
            <span class="code-file-path"></span>
          </button>
          <span class="code-file-badge"></span>
          <span class="code-file-lines"><span class="add"></span> <span class="del"></span></span>
        </div>
        <div class="code-file-flags"></div>
        <div class="code-file-preview" hidden></div>`;
      const check = row.querySelector(".code-file-check");
      check.checked = result.selected;
      check.disabled = state.running || state.saving;
      check.setAttribute("aria-label", result.path);
      check.addEventListener("change", () => {
        result.selected = check.checked;
        row.classList.toggle("selected", check.checked);
        updateSaveButtons();
      });
      row.querySelector(".code-file-path").textContent = result.path;
      const badge = row.querySelector(".code-file-badge");
      badge.textContent = result.saved ? t("code_badge_saved") : result.action === "edit" ? t("code_badge_edit") : t("code_badge_new");
      badge.classList.add(result.saved ? "saved" : result.action);
      row.querySelector(".code-file-lines .add").textContent = `+${result.stats.add}`;
      row.querySelector(".code-file-lines .del").textContent = result.stats.del ? `−${result.stats.del}` : "";

      const flagsBox = row.querySelector(".code-file-flags");
      const flagTexts = result.flags.map((flag) => t(`code_flag_${flag}`));
      if (result.identical) flagTexts.push(t("code_identical"));
      flagTexts.forEach((text) => {
        const flag = document.createElement("span");
        flag.className = "code-flag";
        flag.innerHTML = Icons.alert;
        flag.appendChild(document.createTextNode(text));
        flagsBox.appendChild(flag);
      });
      flagsBox.hidden = !flagTexts.length;

      row.querySelector(".code-file-toggle").addEventListener("click", () => togglePreview(row, result));
      list.appendChild(row);
      if (openPaths.has(result.path)) togglePreview(row, result);
    });

    const selectedCount = results.filter((r) => r.selected).length;
    $("#code-results-count").textContent = t("code_files_count", { n: results.length });
    const selectAll = $("#code-select-all");
    selectAll.checked = results.length > 0 && selectedCount === results.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < results.length;
    selectAll.disabled = state.running || state.saving;
    updateSaveButtons();
  }

  function togglePreview(row, result) {
    const preview = row.querySelector(".code-file-preview");
    const open = !row.classList.contains("open");
    row.classList.toggle("open", open);
    preview.hidden = !open;
    if (open && !preview.dataset.ready) {
      preview.innerHTML = buildPreview(result);
      preview.dataset.ready = "1";
    }
  }

  /* Diferencias línea a línea (LCS con recorte de prefijo y sufijo comunes) */
  function diffLines(a, b) {
    const A = a.split("\n");
    const B = b.split("\n");
    let start = 0;
    while (start < A.length && start < B.length && A[start] === B[start]) start += 1;
    let endA = A.length;
    let endB = B.length;
    while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA -= 1; endB -= 1; }
    const midA = A.slice(start, endA);
    const midB = B.slice(start, endB);
    const n = midA.length;
    const m = midB.length;
    const ops = [];
    for (let i = 0; i < start; i += 1) ops.push([" ", A[i]]);
    if (n * m > LIMITS.diffCells) {
      midA.forEach((line) => ops.push(["-", line]));
      midB.forEach((line) => ops.push(["+", line]));
    } else if (n || m) {
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (midA[i] === midB[j]) { ops.push([" ", midA[i]]); i += 1; j += 1; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push(["-", midA[i]]); i += 1; }
        else { ops.push(["+", midB[j]]); j += 1; }
      }
      while (i < n) { ops.push(["-", midA[i]]); i += 1; }
      while (j < m) { ops.push(["+", midB[j]]); j += 1; }
    }
    for (let i = endA; i < A.length; i += 1) ops.push([" ", A[i]]);
    return ops;
  }

  function buildPreview(result) {
    const lines = [];
    let shown = 0;
    const push = (cls, sign, text) => {
      if (shown >= LIMITS.maxPreviewLines) return;
      lines.push(`<div class="dl ${cls}"><span class="dl-sign">${sign}</span><span class="dl-text">${escapeHtml(text) || " "}</span></div>`);
      shown += 1;
    };

    if (result.original === null) {
      normalizeNewlines(result.content).split("\n").forEach((line) => push("dl-add", "+", line));
    } else if (result.identical) {
      return `<p class="code-preview-note">${escapeHtml(t("code_identical"))}</p>`;
    } else {
      const ops = (result.stats && result.stats.ops) || diffLines(normalizeNewlines(result.original), normalizeNewlines(result.content));
      const context = 3;
      // Marca qué líneas sin cambios quedan cerca de un cambio
      const keep = new Uint8Array(ops.length);
      ops.forEach(([op], index) => {
        if (op === " ") return;
        for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) keep[k] = 1;
      });
      let hidden = 0;
      ops.forEach(([op, text], index) => {
        if (op === " " && !keep[index]) { hidden += 1; return; }
        if (hidden) {
          lines.push(`<div class="dl dl-gap">··· ${escapeHtml(t("code_unchanged_lines", { n: hidden }))} ···</div>`);
          hidden = 0;
        }
        push(op === "+" ? "dl-add" : op === "-" ? "dl-del" : "dl-ctx", op === " " ? " " : op === "-" ? "−" : "+", text);
      });
      if (hidden) lines.push(`<div class="dl dl-gap">··· ${escapeHtml(t("code_unchanged_lines", { n: hidden }))} ···</div>`);
    }
    if (shown >= LIMITS.maxPreviewLines) lines.push(`<div class="dl dl-gap">··· ${escapeHtml(t("code_preview_cut"))} ···</div>`);
    return `<div class="code-diff">${lines.join("")}</div>`;
  }

  function selectedResults() {
    return Array.from(state.results.values()).filter((result) => result.selected);
  }

  function updateSaveButtons() {
    const any = selectedResults().length > 0;
    const busy = state.running || state.saving;
    const save = $("#code-save-btn");
    save.hidden = !state.dirHandle;
    save.disabled = busy || !any;
    $("#code-zip-btn").disabled = busy || !any;
    $("#code-zip-btn").classList.toggle("btn-primary", !state.dirHandle);
    $("#code-zip-btn").classList.toggle("btn-secondary", !!state.dirHandle);
    $("#code-undo-btn").disabled = busy;
    $("#code-new-btn").disabled = busy;
  }

  /* ------------------------------------------------------------------ */
  /* Guardar, deshacer y ZIP                                              */
  /* ------------------------------------------------------------------ */
  async function save() {
    const chosen = selectedResults();
    if (!chosen.length) { toast(t("code_nothing_selected"), "warning"); return; }
    if (!state.dirHandle) { downloadZip(); return; }
    if (!(await ensurePermission(state.dirHandle, "readwrite"))) {
      toast(t("code_permission_denied"), "error");
      return;
    }
    state.saving = true;
    updateSaveButtons();
    try {
      // 1) Leer el estado actual para detectar cambios hechos mientras tanto
      const current = new Map();
      const conflicts = [];
      for (const result of chosen) {
        const now = await readCurrent(result.path);
        current.set(result.path, now);
        const before = state.snapshot.has(result.path) ? state.snapshot.get(result.path) : null;
        if (now !== null && now !== before) conflicts.push(result.path);
      }
      if (conflicts.length) {
        const ok = await dialog({
          icon: "⚠️",
          title: t("code_conflict_title"),
          text: `${t("code_conflict_text", { n: conflicts.length })}\n\n${conflicts.slice(0, 6).join("\n")}${conflicts.length > 6 ? "\n…" : ""}`,
          confirmText: t("code_overwrite"),
          danger: true,
        });
        if (!ok) return;
      }

      // 2) Escribir guardando copia para poder deshacer
      const backups = [];
      let failed = 0;
      for (const result of chosen) {
        const before = current.get(result.path);
        let content = result.content;
        // Respetar los saltos de línea de Windows si el archivo original los usaba
        if (before && before.includes("\r\n") && !content.includes("\r\n")) content = content.replace(/\n/g, "\r\n");
        try {
          await writeFileTo(result.path, content);
          backups.push({ path: result.path, existed: before !== null, original: before });
          result.saved = true;
          result.selected = false;
          state.snapshot.set(result.path, content);
          state.existing.add(result.path);
        } catch (_) {
          failed += 1;
        }
      }
      if (backups.length) {
        state.undo = backups;
        $("#code-undo-btn").hidden = false;
        toast(t("code_saved", { n: backups.length, folder: state.folderName }), "success", 5000);
      }
      if (failed) toast(t("code_save_errors", { n: failed }), "error", 6000);
      Array.from(state.results.values()).forEach((result) => { result.stats = null; });
    } catch (_) {
      toast(t("code_folder_error"), "error");
    } finally {
      state.saving = false;
      renderResults();
    }
  }

  async function undo() {
    if (!state.undo || !state.undo.length || !state.dirHandle) return;
    const ok = await dialog({ icon: "↩️", title: t("code_undo"), text: t("code_undo_confirm"), confirmText: t("code_undo") });
    if (!ok) return;
    if (!(await ensurePermission(state.dirHandle, "readwrite"))) { toast(t("code_permission_denied"), "error"); return; }
    state.saving = true;
    updateSaveButtons();
    let failed = 0;
    try {
      for (const backup of [...state.undo].reverse()) {
        try {
          if (backup.existed) {
            await writeFileTo(backup.path, backup.original);
            state.snapshot.set(backup.path, backup.original);
          } else {
            await removeFile(backup.path);
            state.snapshot.delete(backup.path);
            state.existing.delete(backup.path);
          }
          const result = state.results.get(backup.path);
          if (result) { result.saved = false; result.selected = true; }
        } catch (_) {
          failed += 1;
        }
      }
      state.undo = null;
      $("#code-undo-btn").hidden = true;
      if (failed) toast(t("code_save_errors", { n: failed }), "error");
      else toast(t("code_undone"), "success");
    } finally {
      state.saving = false;
      Array.from(state.results.values()).forEach((result) => { result.stats = null; });
      renderResults();
    }
  }

  async function downloadZip() {
    const chosen = selectedResults().length ? selectedResults() : Array.from(state.results.values());
    if (!chosen.length) { toast(t("code_nothing_selected"), "warning"); return; }
    if (typeof window.JSZip !== "function") { toast(t("code_zip_error"), "error"); return; }
    try {
      const zip = new window.JSZip();
      const root = slug(state.folderName || $("#code-task").value.split(/\s+/).slice(0, 5).join(" "));
      const folder = zip.folder(root);
      chosen.forEach((result) => folder.file(result.path, result.content));
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      Exporter.download(blob, `peduscode-${root}.zip`);
      toast(t("code_zip_ready"), "success");
    } catch (_) {
      toast(t("code_zip_error"), "error");
    }
  }

  function newTask() {
    if (state.running) return;
    state.results.clear();
    state.agents.clear();
    state.undo = null;
    $("#code-undo-btn").hidden = true;
    $("#code-progress").hidden = true;
    $("#code-results").hidden = true;
    $("#code-file-list").innerHTML = "";
    $("#code-agents").innerHTML = "";
    $("#code-task").value = "";
    updateCounter();
    $("#code-scroll").scrollTo({ top: 0, behavior: "smooth" });
    $("#code-task").focus();
  }

  /* ------------------------------------------------------------------ */
  /* Navegación                                                          */
  /* ------------------------------------------------------------------ */
  function open() {
    App.showSection("code");
    Sidebar.closeMobile();
    renderAccess();
    renderFolder();
    if (location.hash !== "#/code") history.replaceState(null, "", "#/code");
    if (App.hasUltra) {
      api("/code/usage").then((data) => {
        if (App.profile) App.profile.code = { ...(App.profile.code || {}), ...data };
        renderUsage();
      }).catch(() => {});
      if (!state.running) setTimeout(() => $("#code-task").focus({ preventScroll: true }), 80);
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    $("#peduscode-btn").addEventListener("click", open);
    $("#code-menu-btn").addEventListener("click", () => Sidebar.openMobile());
    $("#code-sidebar-btn").addEventListener("click", () => Sidebar.toggle());
    $("#code-locked-btn").addEventListener("click", () => Settings.openPlanModal());
    $("#code-pick-btn").addEventListener("click", pickFolder);
    $("#code-nofolder-btn").addEventListener("click", useZipMode);
    $("#code-rescan-btn").addEventListener("click", async () => {
      if (await rescan()) toast(t("code_rescanned"), "success");
    });
    $("#code-clear-folder-btn").addEventListener("click", clearFolder);
    $("#code-run-btn").addEventListener("click", run);
    $("#code-cancel-btn").addEventListener("click", cancel);
    $("#code-save-btn").addEventListener("click", save);
    $("#code-zip-btn").addEventListener("click", downloadZip);
    $("#code-undo-btn").addEventListener("click", undo);
    $("#code-new-btn").addEventListener("click", newTask);
    $("#code-select-all").addEventListener("change", (event) => {
      state.results.forEach((result) => { result.selected = event.target.checked; });
      renderResults();
    });
    const input = $("#code-task");
    input.addEventListener("input", updateCounter);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); run(); }
    });
    // Sombra de la cabecera al hacer scroll
    $("#code-scroll").addEventListener("scroll", () => {
      $("#code-area .chat-header").classList.toggle("scrolled", $("#code-scroll").scrollTop > 4);
    }, { passive: true });
    // Avisar antes de cerrar la pestaña con trabajo sin guardar
    window.addEventListener("beforeunload", (event) => {
      const unsaved = Array.from(state.results.values()).some((result) => result.selected && !result.saved);
      if (state.running || (state.dirHandle && unsaved)) { event.preventDefault(); event.returnValue = ""; }
    });
    document.addEventListener("languagechange", () => {
      renderExamples();
      renderFolder();
      renderUsage();
      if (state.results.size) renderResults();
    });
    $("#code-cancel-btn").hidden = true;
    renderExamples();
    renderFolder();
    updateCounter();
    updateSaveButtons();
  }

  /** Al cerrar sesión: limpiar todo */
  function reset() {
    if (state.controller) state.controller.abort();
    clearFolder();
    newTask();
  }

  return { init, open, reset, renderAccess, safePath, diffLines, isSecretFile, get running() { return state.running; } };
})();
