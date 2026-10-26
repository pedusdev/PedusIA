/* =====================================================================
   PedusGPT — PedusCode: agente de código con 10 IAs (solo Plan MAX)
   Interfaz de terminal al estilo de los agentes de programación:
   - Comandos con "/" y autocompletado, historial con ↑/↓.
   - Lee una carpeta elegida por el usuario (File System Access API).
   - Filtra secretos, carpetas del sistema y dependencias ANTES de enviar.
   - Muestra en directo el organizador y cada agente (SSE).
   - Nada se escribe sin revisión: menús de opciones con flechas,
     detección de cambios externos y deshacer. ZIP como alternativa.
   ===================================================================== */

const PedusCode = (() => {
  /* ------------------------------------------------------------------ */
  /* Límites (iguales o algo por debajo de los del backend)              */
  /* ------------------------------------------------------------------ */
  const LIMITS = {
    taskChars: 4000,
    maxFiles: 600,
    maxFileChars: 120000,
    maxTotalChars: 580000,
    maxTree: 3000,
    maxScan: 6000,
    maxDepth: 12,
    maxPreviewLines: 1500,
    diffCells: 4000000,
    history: 50,
  };

  /* Carpetas que nunca se recorren (dependencias, builds, control de versiones, secretos) */
  const IGNORED_DIRS = new Set([
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".tox", ".nox", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", ".turbo",
    ".parcel-cache", ".cache", ".vite", "coverage", "target", "vendor", "bower_components", ".idea", ".vs",
    ".gradle", "pods", ".dart_tool", "obj", "bin", ".terraform", ".ssh", ".aws", ".gnupg", ".azure", ".kube",
    ".docker", "$recycle.bin", "system volume information",
  ]);
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

  /* Animación del indicador de actividad */
  const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

  /* ------------------------------------------------------------------ */
  /* Estado                                                              */
  /* ------------------------------------------------------------------ */
  const state = {
    initialized: false,
    dirHandle: null,
    folderName: "",
    zipMode: false,
    scan: null,
    snapshot: new Map(),
    existing: new Set(),
    scanning: false,
    running: false,
    controller: null,
    startedAt: 0,
    statusTimer: null,
    spinner: 0,
    statusMain: "",
    escArmedAt: 0,
    agents: new Map(),
    results: new Map(),
    plannedFiles: 0,
    deliveredFiles: 0,
    undo: null,
    saving: false,
    history: [],
    historyIndex: -1,
    draft: "",
    choice: null,
    suggestIndex: 0,
    suggestions: [],
    review: null,
    pristine: true,
    lockedShown: null,
    stick: true,
  };

  /* ------------------------------------------------------------------ */
  /* Comandos                                                            */
  /* ------------------------------------------------------------------ */
  const COMMANDS = [
    { name: "carpeta", aliases: ["folder", "cd", "open", "abrir"], desc: "term_cmd_carpeta", busy: true, run: () => pickFolder() },
    { name: "nuevo", aliases: ["new"], desc: "term_cmd_nuevo", busy: true, run: () => useZipMode() },
    { name: "archivos", aliases: ["ls", "files", "tree"], desc: "term_cmd_archivos", run: () => listFiles() },
    { name: "releer", aliases: ["rescan", "reload"], desc: "term_cmd_releer", busy: true, run: () => rescanCmd() },
    { name: "cerrar", aliases: ["close"], desc: "term_cmd_cerrar", busy: true, run: () => closeFolderCmd() },
    { name: "guardar", aliases: ["save"], desc: "term_cmd_guardar", busy: true, run: () => saveCmd() },
    { name: "deshacer", aliases: ["undo"], desc: "term_cmd_deshacer", busy: true, run: () => undoCmd() },
    { name: "zip", aliases: ["download"], desc: "term_cmd_zip", busy: true, run: () => zipCmd() },
    { name: "uso", aliases: ["usage", "status"], desc: "term_cmd_uso", free: true, run: () => usageCmd() },
    { name: "limpiar", aliases: ["clear", "cls"], desc: "term_cmd_limpiar", free: true, run: () => clearScreen() },
    { name: "ayuda", aliases: ["help", "?"], desc: "term_cmd_ayuda", free: true, run: () => helpCmd() },
  ];

  function findCommand(name) {
    return COMMANDS.find((cmd) => cmd.name === name || cmd.aliases.includes(name)) || null;
  }

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

  const normalizeNewlines = (text) => String(text ?? "").replace(/\r\n/g, "\n");

  function slug(text) {
    return String(text || "proyecto").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "proyecto";
  }

  function formatSeconds(total) {
    const seconds = Math.max(0, Math.round(total));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
  }

  const formatNumber = (n) => Number(n || 0).toLocaleString(I18n.locale());

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
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  /** Contenido actual de un archivo de la carpeta (null si no existe) */
  async function readCurrent(path) {
    try {
      const handle = await getFileHandle(state.dirHandle, path, false);
      return await (await handle.getFile()).text();
    } catch (error) {
      if (error && (error.name === "NotFoundError" || error.name === "TypeMismatchError")) return null;
      throw error;
    }
  }

  async function writeFileTo(path, content) {
    const handle = await getFileHandle(state.dirHandle, path, true);
    const writable = await handle.createWritable();
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

  /** La carpeta elegida no puede ser del sistema ni una carpeta personal entera */
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

    // Prioridad: archivos clave primero, después los menos profundos y más pequeños
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
  /* Salida de la terminal                                               */
  /* ------------------------------------------------------------------ */
  const output = () => $("#term-output");
  const input = () => $("#term-input");

  function el(tag, className = "", text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
  }

  function scrollDown(force = false) {
    const body = $("#term-body");
    if (force || state.stick) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }

  function append(node) {
    output().appendChild(node);
    scrollDown();
    return node;
  }

  /** Línea simple de texto */
  function printLine(text, className = "") {
    state.pristine = false;
    return append(el("div", `term-line ${className}`.trim(), text));
  }

  /** Elemento con viñeta "⏺" (como las acciones de un agente) */
  function printItem(text, color = "", bullet = "⏺") {
    state.pristine = false;
    const root = el("div", "term-item");
    const head = el("div", "term-item-head");
    const dot = el("span", `term-bullet ${color ? `b-${color}` : ""}`.trim(), bullet);
    const label = el("span", "term-item-text", text);
    head.append(dot, label);
    const subs = el("div", "term-subs");
    root.append(head, subs);
    append(root);
    return { root, dot, label, subs };
  }

  /** Línea secundaria "⎿" debajo de un elemento */
  function addSub(item, text, className = "") {
    const row = el("div", `term-sub ${className}`.trim());
    const glyph = el("span", "term-sub-glyph", item.subs.children.length ? " " : "⎿");
    const label = el("span", "term-sub-text", text);
    row.append(glyph, label);
    item.subs.appendChild(row);
    scrollDown();
    return label;
  }

  function printError(text, detail = "") {
    const item = printItem(text, "red");
    if (detail) addSub(item, detail);
    return item;
  }

  /** Eco de lo que escribió el usuario */
  function printUser(text) {
    state.pristine = false;
    const row = el("div", "term-user");
    row.append(el("span", "term-user-caret", ">"), el("span", "term-user-text", text));
    return append(row);
  }

  /** Botón con aspecto de comando dentro de la salida */
  function chip(label, onClick, className = "") {
    const button = el("button", `term-chip ${className}`.trim(), label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function clearScreen() {
    dismissChoice();
    output().innerHTML = "";
    state.review = null;
    state.agents.forEach((entry) => { entry.detached = true; });
  }

  /* ------------------------------------------------------------------ */
  /* Pantalla de bienvenida                                              */
  /* ------------------------------------------------------------------ */
  function cwdLabel() {
    if (state.dirHandle) return `~/${state.folderName}`;
    if (state.zipMode) return `~/${t("term_zip_mode")}`;
    return "~";
  }

  function printWelcome() {
    const box = el("div", "term-welcome");
    const head = el("div", "term-welcome-head");
    head.append(el("span", "term-star", "✻"), el("strong", "", t("term_welcome")));
    box.append(head, el("div", "term-welcome-sub", t("code_subtitle")));
    const meta = el("div", "term-welcome-meta");
    meta.append(el("span", "", "cwd: "), el("span", "term-welcome-cwd", cwdLabel()));
    box.appendChild(meta);
    output().appendChild(box);

    if (!App.hasUltra) {
      printLocked();
    } else {
      const tips = el("div", "term-tips");
      tips.appendChild(el("div", "term-tips-title", t("term_tips_title")));
      ["term_tip1", "term_tip2", "term_tip3"].forEach((key, index) => {
        tips.appendChild(el("div", "term-tip", `${index + 1}. ${t(key)}`));
      });
      const row = el("div", "term-chips");
      if (fsSupported()) row.appendChild(chip("📁 /carpeta", () => submitText("/carpeta")));
      row.appendChild(chip("✨ /nuevo", () => submitText("/nuevo")));
      row.appendChild(chip("? /ayuda", () => submitText("/ayuda")));
      tips.appendChild(row);
      const tryRow = el("div", "term-try");
      tryRow.appendChild(el("span", "term-dim", `${t("term_try")} `));
      const example = el("button", "term-example", `"${t("code_ex1")}"`);
      example.type = "button";
      example.addEventListener("click", () => { input().value = t("code_ex1"); autoResize(); focusInput(); });
      tryRow.appendChild(example);
      tips.appendChild(tryRow);
      if (!fsSupported()) tips.appendChild(el("div", "term-line c-yellow", `⚠ ${t("code_fs_unsupported")}`));
      output().appendChild(tips);
    }
    state.pristine = true;
    scrollDown(true);
  }

  function printLocked() {
    const item = printItem(t("code_locked_text"), "accent", "✻");
    const row = el("div", "term-chips");
    row.appendChild(chip(`👑 ${t("code_see_plan")}`, () => Settings.openPlanModal(), "term-chip-gold"));
    item.subs.appendChild(row);
  }

  function printLimit() {
    const limit = (usage() && usage().limit) || (App.config && App.config.peduscode_daily_limit) || 3;
    const item = printItem(t("code_limit_title"), "yellow");
    addSub(item, t("code_limit_text", { limit }));
  }

  /* ------------------------------------------------------------------ */
  /* Cabecera, pistas y uso                                              */
  /* ------------------------------------------------------------------ */
  function usage() {
    return (App.profile && App.profile.code) || null;
  }

  function updateChrome() {
    $("#term-title").textContent = `pedus@code: ${cwdLabel()}`;
    const cwd = $("#term-hint-right");
    if (state.dirHandle) {
      cwd.textContent = state.scan ? `📁 ${state.folderName} · ${t("code_files_count", { n: state.scan.stats.sent })}` : `📁 ${state.folderName}`;
    } else if (state.zipMode) {
      cwd.textContent = `✨ ${t("term_zip_mode")}`;
    } else {
      cwd.textContent = t("term_no_folder");
    }
    const locked = !App.hasUltra;
    const field = input();
    field.disabled = locked;
    field.placeholder = locked ? t("code_locked_text") : t("term_placeholder");
    $("#term-hint-left").textContent = state.running ? `${t("term_hint_running")} · ${t("term_hint")}` : t("term_hint");
    renderUsage();
  }

  function renderUsage() {
    const chipEl = $("#code-usage");
    const info = usage();
    if (!info || !App.hasUltra) { chipEl.hidden = true; return; }
    chipEl.hidden = false;
    chipEl.textContent = info.unlimited ? `∞ ${t("code_usage_unlimited")}` : t("code_usage_chip", { used: info.used, limit: info.limit });
    chipEl.classList.toggle("empty", !info.unlimited && info.remaining === 0);
  }

  /* ------------------------------------------------------------------ */
  /* Indicador de actividad (línea de estado animada)                     */
  /* ------------------------------------------------------------------ */
  function startStatus(text) {
    state.statusMain = text;
    const box = $("#term-status");
    box.innerHTML = "";
    box.append(el("span", "term-spin", SPINNER[0]), el("span", "term-status-main"), el("span", "term-status-meta"));
    box.hidden = false;
    clearInterval(state.statusTimer);
    state.statusTimer = setInterval(() => { state.spinner += 1; renderStatus(); }, 120);
    renderStatus();
  }

  function setStatus(text) {
    state.statusMain = text;
    renderStatus();
  }

  function renderStatus() {
    const box = $("#term-status");
    if (box.hidden || !box.firstChild) return;
    box.querySelector(".term-spin").textContent = SPINNER[state.spinner % SPINNER.length];
    box.querySelector(".term-status-main").textContent = state.statusMain;
    const armed = Date.now() - state.escArmedAt < 2500;
    const meta = box.querySelector(".term-status-meta");
    meta.textContent = ` (${formatSeconds((Date.now() - state.startedAt) / 1000)} · ${armed ? t("term_esc_again") : t("term_hint_running")})`;
    meta.classList.toggle("armed", armed);
  }

  function stopStatus() {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
    $("#term-status").hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* Menús de opciones (↑/↓, Enter, números, Esc)                         */
  /* ------------------------------------------------------------------ */
  function choose(question, options, { details = [], danger = false } = {}) {
    dismissChoice();
    state.pristine = false;
    return new Promise((resolve) => {
      const box = el("div", `term-choice${danger ? " danger" : ""}`);
      box.tabIndex = 0;
      const questionEl = el("div", "term-choice-q", question);
      box.appendChild(questionEl);
      details.forEach((line) => box.appendChild(el("div", "term-choice-detail", line)));
      const list = el("div", "term-choice-list");
      list.setAttribute("role", "listbox");
      const buttons = options.map((label, index) => {
        const button = el("button", "term-option");
        button.type = "button";
        button.setAttribute("role", "option");
        button.append(el("span", "term-option-caret", "❯"), el("span", "term-option-n", `${index + 1}.`), el("span", "term-option-label", label));
        button.addEventListener("click", () => finish(index));
        button.addEventListener("mousemove", () => setIndex(index));
        list.appendChild(button);
        return button;
      });
      box.appendChild(list);
      const hint = el("div", "term-choice-hint", t("term_choice_hint"));
      box.appendChild(hint);

      const choice = { box, questionEl, index: 0, count: options.length, setIndex, finish };
      function setIndex(index) {
        choice.index = (index + options.length) % options.length;
        buttons.forEach((button, i) => {
          button.classList.toggle("active", i === choice.index);
          button.setAttribute("aria-selected", i === choice.index ? "true" : "false");
        });
      }
      function finish(index) {
        if (state.choice !== choice) return;
        state.choice = null;
        box.classList.add("answered");
        buttons.forEach((button, i) => { button.disabled = true; button.classList.toggle("chosen", i === index); });
        hint.remove();
        resolve(index);
        focusInput();
      }
      state.choice = choice;
      append(box);
      setIndex(0);
      box.focus({ preventScroll: true });
      scrollDown(true);
    });
  }

  function dismissChoice() {
    if (state.choice) state.choice.finish(-1);
  }

  function handleChoiceKey(event) {
    const choice = state.choice;
    if (!choice) return false;
    const field = input();
    if (event.target === field && field.value) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") choice.setIndex(choice.index + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") choice.setIndex(choice.index - 1);
    else if (event.key === "Enter") choice.finish(choice.index);
    else if (event.key === "Escape") choice.finish(choice.count - 1);
    else if (/^[1-9]$/.test(event.key) && Number(event.key) <= choice.count) choice.finish(Number(event.key) - 1);
    else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Entrada: envío, historial y autocompletado                           */
  /* ------------------------------------------------------------------ */
  function focusInput() {
    const field = input();
    if (!field.disabled && !$("#code-area").hidden) field.focus({ preventScroll: true });
  }

  function autoResize() {
    const field = input();
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 220)}px`;
  }

  function pushHistory(text) {
    if (state.history[state.history.length - 1] !== text) state.history.push(text);
    if (state.history.length > LIMITS.history) state.history.shift();
    state.historyIndex = -1;
    state.draft = "";
  }

  function browseHistory(direction) {
    if (!state.history.length) return false;
    const field = input();
    if (state.historyIndex === -1) {
      if (direction > 0) return false;
      state.draft = field.value;
      state.historyIndex = state.history.length - 1;
    } else {
      state.historyIndex += direction;
      if (state.historyIndex < 0) state.historyIndex = 0;
      if (state.historyIndex >= state.history.length) {
        state.historyIndex = -1;
        field.value = state.draft;
        autoResize();
        return true;
      }
    }
    field.value = state.history[state.historyIndex];
    autoResize();
    requestAnimationFrame(() => field.setSelectionRange(field.value.length, field.value.length));
    return true;
  }

  function updateSuggest() {
    const box = $("#term-suggest");
    const value = input().value;
    if (!value.startsWith("/") || /\s/.test(value)) { hideSuggest(); return; }
    const query = value.slice(1).toLowerCase();
    state.suggestions = COMMANDS.filter((cmd) => cmd.name.startsWith(query) || cmd.aliases.some((alias) => alias.startsWith(query)));
    if (!state.suggestions.length) { hideSuggest(); return; }
    state.suggestIndex = Math.min(state.suggestIndex, state.suggestions.length - 1);
    box.innerHTML = "";
    state.suggestions.forEach((cmd, index) => {
      const row = el("button", `term-suggest-row${index === state.suggestIndex ? " active" : ""}`);
      row.type = "button";
      row.setAttribute("role", "option");
      row.append(el("span", "term-suggest-name", `/${cmd.name}`), el("span", "term-suggest-desc", t(cmd.desc)));
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        submitText(`/${cmd.name}`);
      });
      box.appendChild(row);
    });
    box.hidden = false;
  }

  function hideSuggest() {
    $("#term-suggest").hidden = true;
    state.suggestions = [];
    state.suggestIndex = 0;
  }

  function onInputKeydown(event) {
    if (event.isComposing) return;
    const field = input();
    const suggesting = !$("#term-suggest").hidden && state.suggestions.length;

    if (suggesting) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        state.suggestIndex = (state.suggestIndex + delta + state.suggestions.length) % state.suggestions.length;
        updateSuggest();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        field.value = `/${state.suggestions[state.suggestIndex].name}`;
        hideSuggest();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const typed = field.value.slice(1).toLowerCase();
        const exact = findCommand(typed);
        submitText(exact ? field.value : `/${state.suggestions[state.suggestIndex].name}`);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideSuggest();
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "ArrowUp" && field.selectionStart === 0 && field.selectionEnd === 0 && !state.choice) {
      if (browseHistory(-1)) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && field.selectionStart === field.value.length && state.historyIndex !== -1) {
      if (browseHistory(1)) event.preventDefault();
      return;
    }
    if (event.key.toLowerCase() === "c" && (event.ctrlKey || event.metaKey) && field.selectionStart === field.selectionEnd && state.running) {
      event.preventDefault();
      requestCancel();
      return;
    }
    if (event.key.toLowerCase() === "l" && event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      clearScreen();
    }
  }

  function submit() {
    submitText(input().value);
  }

  function submitText(raw) {
    const text = String(raw || "").trim();
    const field = input();
    field.value = "";
    autoResize();
    hideSuggest();
    if (!text) return;
    dismissChoice();
    pushHistory(text);
    state.stick = true;
    if (text.startsWith("/") || text === "?") runCommand(text);
    else runTask(text);
    focusInput();
  }

  function runCommand(text) {
    printUser(text);
    const name = text === "?" ? "ayuda" : text.slice(1).split(/\s+/)[0].toLowerCase();
    const cmd = findCommand(name);
    if (!cmd) { printLine(t("term_unknown_cmd", { cmd: `/${name}` }), "c-red"); return; }
    if (!App.hasUltra && !cmd.free) { printLocked(); return; }
    if ((state.running || state.saving) && cmd.busy) { printLine(t("term_busy"), "c-yellow"); return; }
    Promise.resolve()
      .then(() => cmd.run())
      .catch(() => printError(t("code_error_generic")));
  }

  /* ------------------------------------------------------------------ */
  /* Comandos: carpeta                                                   */
  /* ------------------------------------------------------------------ */
  async function pickFolder() {
    if (!fsSupported()) { printLine(`⚠ ${t("code_fs_unsupported")}`, "c-yellow"); return false; }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: "peduscode", mode: "readwrite" });
    } catch (error) {
      if (error && error.name === "AbortError") { printLine(t("term_pick_cancelled"), "c-dim"); return false; }
      printError(t("code_folder_error"));
      return false;
    }
    return useHandle(handle);
  }

  async function useHandle(handle) {
    try {
      if (await isBlockedRoot(handle)) {
        printError(t("code_folder_blocked_title"), t("code_folder_blocked"));
        return false;
      }
    } catch (_) {
      printError(t("code_folder_error"));
      return false;
    }
    state.dirHandle = handle;
    state.folderName = handle.name;
    state.zipMode = false;
    state.undo = null;
    state.scan = null;
    updateChrome();
    const item = printItem(t("term_folder_opened", { folder: handle.name }), "accent");
    const sub = addSub(item, t("code_scanning"), "c-dim");
    const ok = await rescan({ quiet: true });
    if (ok) {
      sub.textContent = folderStatsText();
      sub.parentElement.classList.remove("c-dim");
      item.dot.className = "term-bullet b-green";
    } else {
      sub.textContent = t("code_folder_error");
      item.dot.className = "term-bullet b-red";
    }
    return ok;
  }

  function folderStatsText() {
    if (!state.scan) return "";
    const s = state.scan.stats;
    let text = t("code_folder_stats", { files: s.sent, skipped: s.secret + s.ignored + s.big + s.binary });
    if (s.secret) text += ` · 🔒 ${t("code_secret_skipped", { n: s.secret })}`;
    return text;
  }

  async function rescan({ quiet = false } = {}) {
    if (!state.dirHandle || state.scanning) return !!state.scan;
    state.scanning = true;
    try {
      if (!(await ensurePermission(state.dirHandle, "read"))) {
        printError(t("code_permission_denied"));
        return false;
      }
      const result = await scanFolder(state.dirHandle);
      state.scan = { tree: result.tree, files: result.files, stats: result.stats };
      state.snapshot = result.snapshot;
      state.existing = result.existing;
      if (!quiet) addSub(printItem(t("code_rescanned"), "green"), folderStatsText());
      return true;
    } catch (error) {
      if (error && error.code === "too_big") {
        printError(t("code_folder_too_big_title"), t("code_folder_too_big"));
        clearFolder();
      } else {
        printError(t("code_folder_error"));
      }
      return false;
    } finally {
      state.scanning = false;
      updateChrome();
    }
  }

  async function rescanCmd() {
    if (!state.dirHandle) { printLine(t("term_no_folder_open"), "c-dim"); return; }
    await rescan();
  }

  function clearFolder() {
    state.dirHandle = null;
    state.folderName = "";
    state.zipMode = false;
    state.scan = null;
    state.snapshot = new Map();
    state.existing = new Set();
    state.undo = null;
    updateChrome();
  }

  function closeFolderCmd() {
    if (!state.dirHandle && !state.zipMode) { printLine(t("term_no_folder_open"), "c-dim"); return; }
    clearFolder();
    printLine(t("term_folder_closed"), "c-dim");
  }

  function useZipMode() {
    clearFolder();
    state.zipMode = true;
    updateChrome();
    const item = printItem(t("code_new_project_mode"), "accent");
    addSub(item, t("code_new_project_stats"), "c-dim");
  }

  function listFiles() {
    if (!state.scan) { printLine(t("term_no_folder_open"), "c-dim"); return; }
    const item = printItem(`📁 ${state.folderName}`, "accent");
    const tree = state.scan.tree;
    const sent = new Set(state.scan.files.map((file) => file.path));
    const pre = el("div", "term-tree");
    tree.slice(0, 60).forEach((entry) => {
      const row = el("div", `term-tree-row${sent.has(entry.path) ? "" : " skipped"}`);
      row.append(el("span", "term-tree-path", entry.path), el("span", "term-tree-size", formatBytes(entry.size)));
      pre.appendChild(row);
    });
    if (tree.length > 60) pre.appendChild(el("div", "term-tree-row skipped", t("term_files_more", { n: tree.length - 60 })));
    item.subs.appendChild(pre);
    addSub(item, folderStatsText(), "c-dim");
  }

  function usageCmd() {
    const info = usage();
    if (!App.hasUltra) { printLocked(); return; }
    if (!info) { printLine(t("code_error_generic"), "c-red"); return; }
    if (info.unlimited) printLine(`∞ ${t("code_usage_unlimited")}`, "c-green");
    else printLine(t("term_usage_line", { used: info.used, limit: info.limit }), info.remaining === 0 ? "c-yellow" : "");
  }

  function helpCmd() {
    const item = printItem(t("term_help_title"), "accent");
    const table = el("div", "term-help");
    COMMANDS.forEach((cmd) => {
      const row = el("button", "term-help-row");
      row.type = "button";
      row.append(el("span", "term-help-name", `/${cmd.name}`), el("span", "term-help-desc", t(cmd.desc)));
      row.addEventListener("click", () => { input().value = `/${cmd.name}`; focusInput(); });
      table.appendChild(row);
    });
    item.subs.appendChild(table);
    addSub(item, t("term_shortcuts"), "c-dim");
  }

  /* ------------------------------------------------------------------ */
  /* Ejecución de una tarea                                              */
  /* ------------------------------------------------------------------ */
  async function runTask(task) {
    printUser(task);
    if (!App.hasUltra) { printLocked(); return; }
    if (state.running || state.saving) { printLine(t("term_busy"), "c-yellow"); return; }
    if (task.length < 3) { printLine(t("code_task_short"), "c-yellow"); return; }
    const info = usage();
    if (info && !info.unlimited && info.remaining === 0) { printLimit(); return; }

    // Sin carpeta: preguntar dónde trabajar
    if (!state.dirHandle && !state.zipMode) {
      if (fsSupported()) {
        const pick = await choose(t("term_where_question"), [t("term_opt_open_folder"), t("code_new_project"), t("cancel")]);
        if (pick === 0) { if (!(await pickFolder())) return; }
        else if (pick === 1) useZipMode();
        else return;
      } else {
        useZipMode();
      }
    }

    // Releer la carpeta para trabajar con la versión más reciente
    if (state.dirHandle && !(await rescan({ quiet: true }))) return;

    const body = {
      task: task.slice(0, LIMITS.taskChars),
      folder_name: state.dirHandle ? state.folderName.slice(0, 200) : "",
      tree: state.scan ? state.scan.tree : [],
      files: state.scan ? state.scan.files : [],
    };

    state.agents.clear();
    state.results.clear();
    state.review = null;
    state.undo = null;
    state.plannedFiles = 0;
    state.deliveredFiles = 0;
    setRunning(true);
    startStatus(t("term_status_planning"));
    const controller = new AbortController();
    state.controller = controller;

    let response;
    try {
      response = await api("/code/run", { method: "POST", body, raw: true, signal: controller.signal });
    } catch (error) {
      stopStatus();
      setRunning(false);
      state.controller = null;
      if (error.name === "AbortError") { printLine(t("code_cancelled"), "c-dim"); return; }
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
      finished = true;
      if (error.name === "AbortError") printItem(t("code_cancelled"), "yellow", "⏹");
      else printError(t("error_network"));
    } finally {
      stopStatus();
      setRunning(false);
      if (state.controller === controller) state.controller = null;
    }
    if (!finished) printError(t("code_error_generic"));
    finishAgents();
    if (state.results.size) showReview();
  }

  function setRunning(running) {
    state.running = running;
    state.escArmedAt = 0;
    if (running) state.startedAt = Date.now();
    $("#peduscode-btn").classList.toggle("is-running", running);
    $("#term-prompt").classList.toggle("running", running);
    document.title = running ? `PedusGPT — ${t("code_working_title")}` : `PedusGPT — ${t("app_tagline")}`;
    updateChrome();
  }

  /** Esc o Ctrl+C dos veces seguidas cancelan la ejecución */
  function requestCancel() {
    if (!state.running || !state.controller) return false;
    const now = Date.now();
    if (now - state.escArmedAt < 2500) {
      state.escArmedAt = 0;
      state.controller.abort();
    } else {
      state.escArmedAt = now;
      renderStatus();
    }
    return true;
  }

  function handleRequestError(error) {
    if (error.code === "needs_max") { printLocked(); return; }
    if (error.code === "rate_limit") {
      if (App.profile && App.profile.code) {
        App.profile.code.remaining = 0;
        App.profile.code.used = App.profile.code.limit;
      }
      renderUsage();
      printLimit();
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
    printError(t(messages[error.code] || "code_error_generic"));
  }

  /** Procesa un evento del servidor. Devuelve true si es un evento final. */
  function handleEvent(event) {
    switch (event.type) {
      case "start":
        if (event.usage && App.profile) {
          App.profile.code = { ...(App.profile.code || {}), ...event.usage };
          renderUsage();
        }
        return false;
      case "planner":
        setStatus(event.status === "waiting"
          ? `${t("term_status_planning")} · ${t("code_waiting", { s: Math.ceil(event.seconds || 1) })}`
          : t("term_status_planning"));
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
      case "refused": {
        const item = printError(t("code_refused_title"), event.message || "");
        if (event.refunded) refundLocal(item);
        return true;
      }
      case "error": {
        const item = printError(event.message || t("code_error_generic"));
        if (event.refunded) refundLocal(item);
        return true;
      }
      case "done":
        onDone(event);
        return true;
      default:
        return false;
    }
  }

  function refundLocal(item) {
    const info = usage();
    if (info && !info.unlimited && info.used > 0) {
      info.used -= 1;
      info.remaining = Math.max(0, info.limit - info.used);
    }
    renderUsage();
    if (item) addSub(item, t("code_refunded"), "c-dim");
  }

  function onDone(event) {
    stopStatus();
    const files = event.files || 0;
    const seconds = Math.round(event.seconds || 0);
    const item = files > 0
      ? printItem(t("code_done", { n: files, s: seconds }), "green")
      : printItem(t("code_no_files"), "yellow");
    if (event.failed && event.failed.length) {
      const names = event.failed.map((id) => {
        const agent = state.agents.get(id);
        return agent ? agent.data.name : `#${id}`;
      });
      addSub(item, t("code_failed_some", { names: names.join(", ") }), "c-yellow");
    }
    if (event.refunded) refundLocal(item);
  }

  /* ------------------------------------------------------------------ */
  /* Organizador y agentes                                               */
  /* ------------------------------------------------------------------ */
  function renderPlan(plan) {
    const agents = plan.agents || [];
    state.plannedFiles = agents.reduce((sum, agent) => sum + (agent.files || []).length, 0);
    const planItem = printItem(plan.summary || t("term_plan"), "accent");
    addSub(planItem, t("code_plan_ready", { agents: agents.length, files: state.plannedFiles }), "c-dim");

    agents.forEach((agent) => {
      const item = printItem("", "queued");
      item.root.classList.add("term-agent");
      item.label.append(el("span", "term-agent-name", `${agent.emoji || "🤖"} ${agent.name || `#${agent.id}`}`));
      if (agent.role) item.label.append(el("span", "term-dim", ` · ${agent.role}`));
      const statusEl = addSub(item, t("code_agent_queued"), "term-agent-status");
      const filesEl = el("div", "term-agent-files");
      (agent.files || []).forEach((file) => {
        const fileChip = el("span", `term-fchip ${file.action === "edit" ? "edit" : "create"}`);
        fileChip.dataset.path = file.path;
        fileChip.title = file.purpose || "";
        fileChip.append(el("span", "term-fchip-sym", file.action === "edit" ? "~" : "+"), el("span", "term-fchip-path", file.path), el("span", "term-fchip-stat"));
        filesEl.appendChild(fileChip);
      });
      item.subs.appendChild(filesEl);
      const notesEl = el("div", "term-sub term-agent-notes");
      notesEl.hidden = true;
      item.subs.appendChild(notesEl);
      state.agents.set(agent.id, { data: agent, item, statusEl, filesEl, notesEl, status: "queued" });
    });
    setStatus(t("term_status_working", { done: 0, total: state.plannedFiles }));
    scrollDown();
  }

  function setAgentStatus(entry, status, text) {
    entry.status = status;
    entry.item.dot.className = `term-bullet b-${status}`;
    entry.statusEl.textContent = text;
    entry.statusEl.parentElement.classList.toggle("c-red", status === "error");
  }

  function updateAgent(event) {
    const entry = state.agents.get(event.id);
    if (!entry) return;
    switch (event.status) {
      case "working":
        setAgentStatus(entry, "working", event.chars ? t("code_agent_writing", { n: formatNumber(event.chars) }) : t("code_agent_thinking"));
        break;
      case "waiting":
        setAgentStatus(entry, "waiting", t("code_waiting", { s: Math.ceil(event.seconds || 1) }));
        break;
      case "done": {
        setAgentStatus(entry, "done", t("code_agent_done"));
        const notes = [];
        if (event.notes) notes.push(event.notes);
        if (event.missing && event.missing.length) notes.push(t("code_agent_missing", { files: event.missing.join(", ") }));
        entry.notesEl.textContent = notes.join(" · ");
        entry.notesEl.hidden = !notes.length;
        break;
      }
      case "error":
        setAgentStatus(entry, "error", event.message || t("code_agent_error"));
        break;
      default:
        break;
    }
    scrollDown();
  }

  /** Al terminar, ningún agente se queda "trabajando" en pantalla */
  function finishAgents() {
    state.agents.forEach((entry) => {
      if (["queued", "working", "waiting"].includes(entry.status)) setAgentStatus(entry, "error", t("code_agent_stopped"));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Resultados y revisión                                               */
  /* ------------------------------------------------------------------ */
  function lineStats(result) {
    if (result.original === null) return { add: normalizeNewlines(result.content).split("\n").length, del: 0, ops: null };
    const ops = diffLines(normalizeNewlines(result.original), normalizeNewlines(result.content));
    let add = 0;
    let del = 0;
    ops.forEach(([op]) => { if (op === "+") add += 1; else if (op === "-") del += 1; });
    return { add, del, ops };
  }

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
    result.stats = lineStats(result);
    state.results.set(path, result);
    state.deliveredFiles += 1;

    // Marcar el archivo en la tarjeta del agente
    const entry = state.agents.get(event.agent_id);
    if (entry) {
      let fileChip = Array.from(entry.filesEl.children).find((node) => node.dataset.path === event.path || node.dataset.path === path);
      if (!fileChip) {
        fileChip = el("span", "term-fchip");
        fileChip.dataset.path = path;
        fileChip.append(el("span", "term-fchip-sym", "+"), el("span", "term-fchip-path", path), el("span", "term-fchip-stat"));
        entry.filesEl.appendChild(fileChip);
      }
      fileChip.classList.add("done");
      if (event.truncated) fileChip.classList.add("warn");
      fileChip.querySelector(".term-fchip-sym").textContent = event.truncated ? "!" : "✓";
      fileChip.querySelector(".term-fchip-stat").textContent = ` +${result.stats.add}${result.stats.del ? ` −${result.stats.del}` : ""}`;
    }
    setStatus(t("term_status_working", { done: state.deliveredFiles, total: Math.max(state.plannedFiles, state.deliveredFiles) }));
  }

  function selectedResults() {
    return Array.from(state.results.values()).filter((result) => result.selected && !result.saved);
  }

  function pendingResults() {
    return Array.from(state.results.values()).filter((result) => !result.saved);
  }

  function showReview() {
    const box = el("div", "term-review");
    const head = el("div", "term-review-head");
    head.append(el("span", "term-review-title", t("code_step_review")), el("span", "term-dim", ` · ${t("term_review_hint")}`));
    box.appendChild(head);
    box.appendChild(el("div", "term-review-list"));
    state.review = box;
    append(box);
    renderReviewRows();
    showSaveChoice();
  }

  function renderReviewRows() {
    if (!state.review) return;
    const list = state.review.querySelector(".term-review-list");
    const open = new Set(Array.from(list.querySelectorAll(".term-file.open")).map((row) => row.dataset.path));
    list.innerHTML = "";
    Array.from(state.results.values()).sort((a, b) => a.path.localeCompare(b.path)).forEach((result) => {
      const wrap = el("div", `term-file${result.saved ? " saved" : ""}`);
      wrap.dataset.path = result.path;
      const row = el("div", "term-file-row");

      const check = el("button", `term-check${result.selected ? " on" : ""}`, result.saved ? "[✓]" : result.selected ? "[x]" : "[ ]");
      check.type = "button";
      check.disabled = result.saved || state.running || state.saving;
      check.setAttribute("aria-pressed", result.selected ? "true" : "false");
      check.setAttribute("aria-label", result.path);
      check.addEventListener("click", () => {
        result.selected = !result.selected;
        renderReviewRows();
        updateSaveQuestion();
      });

      const name = el("button", "term-fname");
      name.type = "button";
      name.append(el("span", "term-fname-arrow", "▸"), el("span", "term-fname-path", result.path));
      name.addEventListener("click", () => toggleDiff(wrap, result));

      const badgeKey = result.saved ? "code_badge_saved" : result.action === "edit" ? "code_badge_edit" : "code_badge_new";
      const badge = el("span", `term-badge ${result.saved ? "saved" : result.action}`, t(badgeKey));
      const stats = el("span", "term-fstat");
      stats.append(el("span", "c-green", `+${result.stats.add}`));
      if (result.stats.del) stats.append(el("span", "c-red", ` −${result.stats.del}`));
      row.append(check, name, badge, stats);
      wrap.appendChild(row);

      const flagTexts = result.flags.map((flag) => t(`code_flag_${flag}`));
      if (result.identical) flagTexts.push(t("code_identical"));
      flagTexts.forEach((text) => wrap.appendChild(el("div", "term-flag", `⚠ ${text}`)));

      const diff = el("div", "term-diff");
      diff.hidden = true;
      wrap.appendChild(diff);
      list.appendChild(wrap);
      if (open.has(result.path)) toggleDiff(wrap, result);
    });
  }

  function toggleDiff(wrap, result) {
    const diff = wrap.querySelector(".term-diff");
    const opening = !wrap.classList.contains("open");
    wrap.classList.toggle("open", opening);
    wrap.querySelector(".term-fname-arrow").textContent = opening ? "▾" : "▸";
    diff.hidden = !opening;
    if (opening && !diff.dataset.ready) {
      diff.innerHTML = buildPreview(result);
      diff.dataset.ready = "1";
    }
  }

  function saveQuestion() {
    const n = selectedResults().length;
    return state.dirHandle ? t("term_save_question", { n, folder: state.folderName }) : t("term_zip_question", { n });
  }

  function updateSaveQuestion() {
    if (state.choice && state.choice.kind === "save") state.choice.questionEl.textContent = saveQuestion();
  }

  async function showSaveChoice() {
    if (!pendingResults().length) return;
    const options = state.dirHandle
      ? [t("term_opt_save"), t("code_download_zip"), t("term_opt_later")]
      : [t("code_download_zip"), t("term_opt_later")];
    const promise = choose(saveQuestion(), options);
    if (state.choice) state.choice.kind = "save";
    const pick = await promise;
    if (pick === -1) return;
    if (state.dirHandle) {
      if (pick === 0) await save();
      else if (pick === 1) await downloadZip();
      else printLine(t("term_later"), "c-dim");
    } else if (pick === 0) {
      await downloadZip();
    } else {
      printLine(t("term_later"), "c-dim");
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

  /** Vista de cambios con números de línea, como en un editor */
  function buildPreview(result) {
    const lines = [];
    let shown = 0;
    const push = (cls, number, sign, text) => {
      if (shown >= LIMITS.maxPreviewLines) return;
      lines.push(`<div class="dl ${cls}"><span class="dl-num">${number}</span><span class="dl-sign">${sign}</span><span class="dl-text">${escapeHtml(text) || " "}</span></div>`);
      shown += 1;
    };
    const gap = (n) => lines.push(`<div class="dl dl-gap">··· ${escapeHtml(t("code_unchanged_lines", { n }))} ···</div>`);

    if (result.original === null) {
      normalizeNewlines(result.content).split("\n").forEach((line, index) => push("dl-add", index + 1, "+", line));
    } else if (result.identical) {
      return `<div class="dl dl-gap">${escapeHtml(t("code_identical"))}</div>`;
    } else {
      const ops = result.stats.ops || diffLines(normalizeNewlines(result.original), normalizeNewlines(result.content));
      const context = 3;
      const keep = new Uint8Array(ops.length);
      ops.forEach(([op], index) => {
        if (op === " ") return;
        for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) keep[k] = 1;
      });
      let oldLine = 0;
      let newLine = 0;
      let hidden = 0;
      ops.forEach(([op, text], index) => {
        if (op !== "+") oldLine += 1;
        if (op !== "-") newLine += 1;
        if (op === " " && !keep[index]) { hidden += 1; return; }
        if (hidden) { gap(hidden); hidden = 0; }
        if (op === "+") push("dl-add", newLine, "+", text);
        else if (op === "-") push("dl-del", oldLine, "-", text);
        else push("dl-ctx", newLine, " ", text);
      });
      if (hidden) gap(hidden);
    }
    if (shown >= LIMITS.maxPreviewLines) lines.push(`<div class="dl dl-gap">··· ${escapeHtml(t("code_preview_cut"))} ···</div>`);
    return `<div class="code-diff">${lines.join("")}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Guardar, deshacer y ZIP                                              */
  /* ------------------------------------------------------------------ */
  async function save() {
    const chosen = selectedResults();
    if (!chosen.length) { printLine(t("code_nothing_selected"), "c-yellow"); return; }
    if (!state.dirHandle) { await downloadZip(); return; }
    if (!(await ensurePermission(state.dirHandle, "readwrite"))) { printError(t("code_permission_denied")); return; }
    state.saving = true;
    renderReviewRows();
    try {
      // 1) Detectar cambios hechos en la carpeta desde que se leyó
      const current = new Map();
      const conflicts = [];
      for (const result of chosen) {
        const now = await readCurrent(result.path);
        current.set(result.path, now);
        const before = state.snapshot.has(result.path) ? state.snapshot.get(result.path) : null;
        if (now !== null && now !== before) conflicts.push(result.path);
      }
      if (conflicts.length) {
        const details = [t("code_conflict_text", { n: conflicts.length }), ...conflicts.slice(0, 8).map((p) => `  • ${p}`)];
        if (conflicts.length > 8) details.push(`  ${t("term_files_more", { n: conflicts.length - 8 })}`);
        const pick = await choose(t("code_conflict_title"), [t("code_overwrite"), t("cancel")], { details, danger: true });
        if (pick !== 0) { printLine(t("term_save_cancelled"), "c-dim"); return; }
      }

      // 2) Escribir guardando una copia para poder deshacer
      const backups = [];
      const failed = [];
      for (const result of chosen) {
        const before = current.get(result.path);
        let content = result.content;
        // Respetar los saltos de línea de Windows si el original los usaba
        if (before && before.includes("\r\n") && !content.includes("\r\n")) content = content.replace(/\n/g, "\r\n");
        try {
          await writeFileTo(result.path, content);
          backups.push({ path: result.path, existed: before !== null, original: before, result });
          result.saved = true;
          state.snapshot.set(result.path, content);
          state.existing.add(result.path);
        } catch (_) {
          failed.push(result.path);
        }
      }
      if (backups.length) {
        state.undo = backups;
        const item = printItem(t("code_saved", { n: backups.length, folder: state.folderName }), "green");
        backups.forEach(({ result }) => {
          const stats = `+${result.stats.add}${result.stats.del ? ` −${result.stats.del}` : ""}`;
          addSub(item, `${result.action === "edit" ? "Update" : "Write"}(${result.path})  ${stats}`);
        });
        addSub(item, t("term_undo_hint"), "c-dim");
      }
      if (failed.length) printError(t("code_save_errors", { n: failed.length }), failed.join(", "));
    } catch (_) {
      printError(t("code_folder_error"));
    } finally {
      state.saving = false;
      renderReviewRows();
    }
  }

  function saveCmd() {
    if (!pendingResults().length) { printLine(t("term_nothing_to_save"), "c-dim"); return; }
    if (!state.review) showReview();
    else showSaveChoice();
  }

  async function undoCmd() {
    if (!state.undo || !state.undo.length || !state.dirHandle) { printLine(t("term_nothing_to_undo"), "c-dim"); return; }
    const pick = await choose(`${t("code_undo")}?`, [t("code_undo"), t("cancel")], { details: [t("code_undo_confirm")] });
    if (pick !== 0) return;
    if (!(await ensurePermission(state.dirHandle, "readwrite"))) { printError(t("code_permission_denied")); return; }
    state.saving = true;
    const item = printItem(t("code_undone"), "green");
    let failed = 0;
    try {
      for (const backup of [...state.undo].reverse()) {
        try {
          if (backup.existed) {
            await writeFileTo(backup.path, backup.original);
            state.snapshot.set(backup.path, backup.original);
            addSub(item, `Restore(${backup.path})`);
          } else {
            await removeFile(backup.path);
            state.snapshot.delete(backup.path);
            state.existing.delete(backup.path);
            addSub(item, `Delete(${backup.path})`);
          }
          const result = state.results.get(backup.path);
          if (result) { result.saved = false; result.selected = true; }
        } catch (_) {
          failed += 1;
        }
      }
      state.undo = null;
      if (failed) {
        item.dot.className = "term-bullet b-red";
        addSub(item, t("code_save_errors", { n: failed }), "c-red");
      }
    } finally {
      state.saving = false;
      renderReviewRows();
    }
  }

  async function zipCmd() {
    if (!state.results.size) { printLine(t("term_nothing_to_save"), "c-dim"); return; }
    await downloadZip();
  }

  async function downloadZip() {
    const chosen = selectedResults().length ? selectedResults() : Array.from(state.results.values());
    if (!chosen.length) { printLine(t("code_nothing_selected"), "c-yellow"); return; }
    if (typeof window.JSZip !== "function") { printError(t("code_zip_error")); return; }
    try {
      const zip = new window.JSZip();
      const lastTask = state.history.filter((entry) => !entry.startsWith("/")).pop() || "";
      const root = slug(state.folderName || lastTask.split(/\s+/).slice(0, 5).join(" "));
      const folder = zip.folder(root);
      chosen.forEach((result) => folder.file(result.path, result.content));
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const filename = `peduscode-${root}.zip`;
      Exporter.download(blob, filename);
      const item = printItem(t("code_zip_ready"), "green");
      addSub(item, `${filename} · ${t("code_files_count", { n: chosen.length })}`, "c-dim");
    } catch (_) {
      printError(t("code_zip_error"));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Navegación y ciclo de vida                                          */
  /* ------------------------------------------------------------------ */
  function showSection() {
    if (typeof App.showSection === "function") {
      App.showSection("code");
      return;
    }
    // Respaldo por si app.js es de una versión anterior
    $("#chat-area").hidden = true;
    $("#code-area").hidden = false;
    $("#peduscode-btn").classList.add("active");
  }

  function open() {
    showSection();
    if (typeof Sidebar !== "undefined") Sidebar.closeMobile();
    if (location.hash !== "#/code") history.replaceState(null, "", "#/code");
    renderAccess();
    if (App.hasUltra) {
      api("/code/usage").then((data) => {
        if (App.profile) App.profile.code = { ...(App.profile.code || {}), ...data };
        renderUsage();
      }).catch(() => {});
    }
    scrollDown(true);
    setTimeout(focusInput, 60);
  }

  /** Muestra la bienvenida o el bloqueo según el plan del usuario */
  function renderAccess() {
    if (!state.initialized || !App.profile) return;
    const locked = !App.hasUltra;
    if (state.lockedShown !== locked) {
      if (state.pristine || !output().children.length) {
        output().innerHTML = "";
        printWelcome();
      } else if (locked) {
        printLocked();
      }
      state.lockedShown = locked;
    }
    updateChrome();
  }

  /** Esc fuera del cuadro de texto (lo llama el gestor global de atajos) */
  function handleEscape() {
    if ($("#code-area").hidden) return false;
    if (state.choice) { state.choice.finish(state.choice.count - 1); return true; }
    if (!$("#term-suggest").hidden) { hideSuggest(); return true; }
    return requestCancel();
  }

  function setupDragAndDrop() {
    const body = $("#term-body");
    const overlay = $("#term-drop");
    const hasFiles = (event) => Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes("Files");
    body.addEventListener("dragover", (event) => {
      if (!hasFiles(event) || !App.hasUltra) return;
      event.preventDefault();
      overlay.hidden = false;
    });
    body.addEventListener("dragleave", (event) => {
      if (!body.contains(event.relatedTarget)) overlay.hidden = true;
    });
    body.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      overlay.hidden = true;
      if (!App.hasUltra || state.running || state.saving) return;
      const item = Array.from(event.dataTransfer.items || []).find((entry) => entry.kind === "file");
      if (!item || typeof item.getAsFileSystemHandle !== "function") {
        printLine(`⚠ ${t("code_fs_unsupported")}`, "c-yellow");
        return;
      }
      // Hay que pedir el handle dentro del propio evento, antes de cualquier await
      item.getAsFileSystemHandle().then((handle) => {
        if (handle && handle.kind === "directory") {
          printUser(`/carpeta ${handle.name}`);
          useHandle(handle);
        } else {
          printLine(t("term_drop_folder_only"), "c-yellow");
        }
      }).catch(() => printError(t("code_folder_error")));
    });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    const field = input();

    $("#peduscode-btn").addEventListener("click", open);
    $("#code-menu-btn").addEventListener("click", () => Sidebar.openMobile());
    $("#code-sidebar-btn").addEventListener("click", () => Sidebar.toggle());

    field.addEventListener("keydown", onInputKeydown);
    field.addEventListener("input", () => {
      autoResize();
      state.suggestIndex = 0;
      updateSuggest();
    });
    field.addEventListener("blur", () => setTimeout(hideSuggest, 120));

    const body = $("#term-body");
    // Teclas de los menús de opciones y cancelación con Esc
    body.addEventListener("keydown", (event) => {
      if (handleChoiceKey(event)) return;
      if (event.key === "Escape" && (state.running || !$("#term-suggest").hidden)) {
        event.preventDefault();
        event.stopPropagation();
        if (!$("#term-suggest").hidden) hideSuggest();
        else requestCancel();
      }
    });
    // Clic en una zona vacía: volver al cuadro de texto (sin romper la selección de texto)
    body.addEventListener("click", (event) => {
      if (event.target.closest("button, a, textarea, input, .term-choice, .term-diff")) return;
      const selection = window.getSelection();
      if (selection && String(selection).length) return;
      if (state.choice) state.choice.box.focus({ preventScroll: true });
      else focusInput();
    });
    body.addEventListener("scroll", () => {
      state.stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    }, { passive: true });

    // Escribir en cualquier parte de PedusCode lleva el texto a la terminal
    document.addEventListener("keydown", (event) => {
      if ($("#code-area").hidden || Modal.stack.length || state.choice) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
      const active = document.activeElement;
      if (active && (active.matches("input, textarea, select") || active.isContentEditable)) return;
      focusInput();
    });

    setupDragAndDrop();

    // Avisar antes de cerrar la pestaña con trabajo sin guardar
    window.addEventListener("beforeunload", (event) => {
      const unsaved = state.dirHandle && selectedResults().length > 0;
      if (state.running || unsaved) { event.preventDefault(); event.returnValue = ""; }
    });
    document.addEventListener("languagechange", () => {
      if (state.pristine && App.profile) {
        output().innerHTML = "";
        printWelcome();
      }
      updateChrome();
      if (state.review) renderReviewRows();
    });
    updateChrome();
    renderAccess();
  }

  /** Al cerrar sesión: dejar la terminal como nueva */
  function reset() {
    if (state.controller) state.controller.abort();
    stopStatus();
    dismissChoice();
    clearFolder();
    state.results.clear();
    state.agents.clear();
    state.review = null;
    state.history = [];
    state.historyIndex = -1;
    state.lockedShown = null;
    state.pristine = true;
    if (state.initialized) output().innerHTML = "";
  }

  return {
    init, open, reset, renderAccess, handleEscape,
    safePath, diffLines, isSecretFile,
    get running() { return state.running; },
  };
})();

/* Arranque de respaldo: PedusCode funciona aunque otro módulo falle al iniciar */
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    try { PedusCode.init(); } catch (_) { /* ya iniciado o la página no tiene PedusCode */ }
  }, 0);
});
