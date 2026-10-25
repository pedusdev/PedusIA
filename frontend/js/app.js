/* =====================================================================
   PedusGPT — Núcleo de la aplicación
   Estado global, cliente API, toasts, modales, diálogos, menús,
   utilidades, atajos de teclado e inicialización.
   ===================================================================== */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* --------------------------------------------------------------------- */
/* Estado global                                                          */
/* --------------------------------------------------------------------- */
const App = {
  config: null,
  supabase: null,
  user: null,
  profile: null,
  loadingUser: false,

  /* ---------------- Vistas ---------------- */
  showView(name) {
    $("#auth-view").hidden = name !== "auth";
    $("#banned-view").hidden = name !== "banned";
    $("#app-view").hidden = name !== "app";
    this.hideSplash();
  },

  /* ---------------- Secciones (chat / PedusCode) ---------------- */
  section: "chat",

  showSection(name) {
    this.section = name === "code" ? "code" : "chat";
    $("#chat-area").hidden = this.section !== "chat";
    $("#code-area").hidden = this.section !== "code";
    $("#peduscode-btn").classList.toggle("active", this.section === "code");
    if (this.section === "code") Sidebar.setActive(null);
  },

  hideSplash() {
    const splash = $("#splash");
    if (!splash || splash.classList.contains("hide")) return;
    splash.classList.add("hide");
    setTimeout(() => splash.remove(), 450);
  },

  showBanned(reason) {
    $("#banned-reason").textContent = reason || t("banned_no_reason");
    Modal.closeAll();
    this.showView("banned");
  },

  /* ---------------- Sesión ---------------- */
  async onSignedIn(session) {
    if (!session || this.loadingUser) return;
    if (this.profile && this.profile.id === session.user.id) return;
    this.loadingUser = true;
    try {
      const data = await api("/auth/me");
      this.user = data.user;
      this.profile = data.profile;
      this.syncPreferences();
      this.applyProfile();
      this.showView("app");
      Chat.reset();
      ModelSelector.setInitial();
      await Sidebar.load();
      if (location.hash === "#/code") PedusCode.open();
      else Chat.openFromHash();
    } catch (error) {
      if (error.code === "banned" || error.status === 401) return;
      this.showView("auth");
      toast(errorMessage(error), "error", 6000);
    } finally {
      this.loadingUser = false;
    }
  },

  onSignedOut() {
    this.user = null;
    this.profile = null;
    PedusCode.reset();
    this.showSection("chat");
    Chat.reset();
    Sidebar.clear();
    Modal.closeAll();
    Voice.stopAll();
    if (location.hash) history.replaceState(null, "", location.pathname);
    this.showView("auth");
  },

  /** Idioma/tema: la elección local del usuario manda y se sincroniza con el perfil */
  syncPreferences() {
    const profile = this.profile;
    const updates = {};
    const localLang = localStorage.getItem("pedus_lang");
    if (localLang && localLang !== profile.preferred_language) {
      updates.preferred_language = localLang;
      profile.preferred_language = localLang;
    }
    I18n.setLanguage(profile.preferred_language || "es");

    const localTheme = localStorage.getItem("pedus_theme");
    if (localTheme && localTheme !== profile.preferred_theme) {
      updates.preferred_theme = localTheme;
      profile.preferred_theme = localTheme;
    }
    Themes.set(profile.preferred_theme || "light", { persistRemote: false });

    if (Object.keys(updates).length) {
      api("/profile", { method: "PATCH", body: updates }).catch(() => {});
    }
  },

  /** Refleja el perfil en el sidebar (nombre, avatar, rol, admin) */
  applyProfile() {
    const profile = this.profile;
    if (!profile) return;
    renderAvatar($("#sidebar-avatar"), profile);
    $("#sidebar-name").textContent = profile.display_name || "Usuario";
    const roleEl = $("#sidebar-role");
    roleEl.textContent = t(`role_${profile.role}`);
    roleEl.classList.toggle("is-max", profile.role === "max");
    $("#admin-btn").hidden = !["admin", "owner"].includes(profile.role);
    ModelSelector.render();
    Chat.updateGreeting();
    PedusCode.renderAccess();
  },

  get hasUltra() {
    return !!(this.profile && ["max", "admin", "owner"].includes(this.profile.role));
  },
};

/* --------------------------------------------------------------------- */
/* Cliente de la API                                                      */
/* --------------------------------------------------------------------- */
class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/**
 * Llama a la API del backend con el JWT de Supabase.
 * @param {string} path  Ruta relativa a /api/v1
 * @param {{method?:string, body?:any, formData?:FormData, signal?:AbortSignal, raw?:boolean, auth?:boolean}} options
 */
async function api(path, { method = "GET", body, formData, signal, raw = false, auth = true } = {}) {
  const headers = {};
  if (auth) {
    const token = await Auth.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (raw) headers.Accept = "text/event-stream";

  let response;
  try {
    response = await fetch(`/api/v1${path}`, { method, headers, body: payload, signal });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError(0, "network", t("error_network"));
  }

  if (!response.ok) {
    let data = {};
    try { data = await response.json(); } catch (_) { /* sin cuerpo JSON */ }
    const error = new ApiError(response.status, data.error || "http_error", data.message || "", data);
    if (response.status === 401 && auth) Auth.handleUnauthorized();
    if (data.error === "banned") App.showBanned(data.reason);
    throw error;
  }
  if (raw) return response;
  if (response.status === 204) return null;
  return response.json();
}

/** Traduce un error de la API a un mensaje amigable (nunca errores crudos) */
function errorMessage(error) {
  if (!error) return t("error_generic");
  const limit = (App.config && App.config.ultra_daily_limit) || 30;
  const map = {
    network: "error_network",
    rate_limit: null,
    too_many_requests: "rate_limit_general",
    needs_max: "model_locked",
    forbidden: "no_permission",
    file_too_large: "file_too_big",
    invalid_file_type: "file_type_invalid",
    upload_failed: "file_upload_failed",
    db_unavailable: "error_load",
    auth_unavailable: "error_network",
    session_expired: "session_expired",
    unauthorized: "session_expired",
  };
  if (error.code === "rate_limit") return t("rate_limit_text", { limit });
  const key = map[error.code];
  return key ? t(key) : t("error_generic");
}

/* --------------------------------------------------------------------- */
/* Toasts                                                                 */
/* --------------------------------------------------------------------- */
function toast(message, type = "success", duration = 3500) {
  const container = $("#toast-container");
  const icons = { success: "✓", error: "!", info: "i", warning: "!" };
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = icons[type] || "i";
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", t("close"));
  close.innerHTML = Icons.x;

  el.append(icon, text, close);
  container.appendChild(el);
  // Máximo 4 toasts a la vez
  while (container.children.length > 4) container.firstElementChild.remove();

  const remove = () => {
    if (el.classList.contains("leaving")) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 260);
  };
  close.addEventListener("click", remove);
  setTimeout(remove, duration);
}

/* --------------------------------------------------------------------- */
/* Modales                                                                */
/* --------------------------------------------------------------------- */
const Modal = {
  stack: [],
  onCloseHandlers: {},

  init() {
    document.addEventListener("click", (event) => {
      const closer = event.target.closest("[data-close]");
      if (closer) {
        const overlay = closer.closest(".modal-overlay");
        if (overlay) this.close(overlay.id);
        return;
      }
      if (event.target.classList && event.target.classList.contains("modal-overlay")) {
        this.close(event.target.id);
      }
    });
    // Mantener el foco dentro del modal abierto (accesibilidad)
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || !this.stack.length) return;
      const modal = document.getElementById(this.stack[this.stack.length - 1]);
      const focusables = $$('button:not([disabled]), [href], input:not([hidden]):not([type="file"]), select, textarea, [tabindex]:not([tabindex="-1"])', modal)
        .filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  },

  open(id, { onClose } = {}) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    Popover.close();
    overlay.classList.remove("closing");
    overlay.hidden = false;
    overlay._lastFocus = document.activeElement;
    if (!this.stack.includes(id)) this.stack.push(id);
    if (onClose) this.onCloseHandlers[id] = onClose;
    requestAnimationFrame(() => {
      const target = overlay.querySelector("[autofocus], input:not([hidden]):not([readonly]):not([type='file']), .btn-primary, button");
      if (target) target.focus({ preventScroll: true });
    });
  },

  close(id) {
    const overlay = document.getElementById(id);
    if (!overlay || overlay.hidden) return;
    overlay.classList.add("closing");
    setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove("closing");
    }, 170);
    this.stack = this.stack.filter((item) => item !== id);
    const handler = this.onCloseHandlers[id];
    delete this.onCloseHandlers[id];
    if (handler) handler();
    if (overlay._lastFocus && document.contains(overlay._lastFocus)) {
      overlay._lastFocus.focus({ preventScroll: true });
    }
  },

  closeTop() {
    if (!this.stack.length) return false;
    this.close(this.stack[this.stack.length - 1]);
    return true;
  },

  closeAll() {
    [...this.stack].forEach((id) => this.close(id));
  },

  isOpen(id) {
    return this.stack.includes(id);
  },
};

/**
 * Diálogo genérico (confirmación, pedir texto o aviso).
 * Devuelve: true / texto introducido al confirmar, null al cancelar.
 */
function dialog({ title, text = "", input = false, allowEmpty = false, inputType = "text", value = "", placeholder = "", maxLength = 120,
  confirmText = t("confirm"), cancelText = t("cancel"), danger = false, icon = "", hideCancel = false } = {}) {
  return new Promise((resolve) => {
    const titleEl = $("#dialog-title");
    const textEl = $("#dialog-text");
    const inputEl = $("#dialog-input");
    const iconEl = $("#dialog-icon");
    const confirmBtn = $("#dialog-confirm");
    const cancelBtn = $("#dialog-cancel");

    titleEl.textContent = title || "";
    textEl.textContent = text;
    textEl.hidden = !text;
    iconEl.hidden = !icon;
    iconEl.textContent = icon;
    inputEl.hidden = !input;
    inputEl.type = inputType;
    inputEl.value = value;
    inputEl.placeholder = placeholder;
    inputEl.maxLength = maxLength;
    confirmBtn.textContent = confirmText;
    confirmBtn.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    cancelBtn.textContent = cancelText;
    cancelBtn.hidden = hideCancel;

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      inputEl.onkeydown = null;
      resolve(result);
    };
    confirmBtn.onclick = () => {
      if (input && !allowEmpty && !inputEl.value.trim()) { inputEl.classList.add("shake"); setTimeout(() => inputEl.classList.remove("shake"), 450); return; }
      finish(input ? inputEl.value.trim() : true);
      Modal.close("dialog-modal");
    };
    cancelBtn.onclick = () => Modal.close("dialog-modal");
    inputEl.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); confirmBtn.click(); } };

    Modal.open("dialog-modal", { onClose: () => finish(null) });
    if (input) setTimeout(() => { inputEl.focus(); inputEl.select(); }, 60);
    else setTimeout(() => confirmBtn.focus(), 60);
  });
}

/* --------------------------------------------------------------------- */
/* Popovers y menús contextuales                                          */
/* --------------------------------------------------------------------- */
const Popover = {
  current: null,

  open(anchor, content, { onClose, point } = {}) {
    this.close();
    const pop = document.createElement("div");
    pop.className = "popover";
    pop.setAttribute("role", "menu");
    pop.appendChild(content);
    document.body.appendChild(pop);

    // Posicionamiento: debajo del ancla (o encima si no cabe)
    const rect = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) top = Math.max(margin, rect.top - popRect.height - 6);
    const rtl = document.documentElement.dir === "rtl";
    let left = rtl ? rect.right - popRect.width : rect.left;
    left = Math.min(Math.max(margin, left), window.innerWidth - popRect.width - margin);
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;

    if (anchor) { anchor.classList.add("open"); anchor.setAttribute("aria-expanded", "true"); }
    this.current = { pop, anchor, onClose };

    this._outside = (event) => {
      if (!pop.contains(event.target) && !(anchor && anchor.contains(event.target))) this.close();
    };
    this._reposition = () => this.close();
    setTimeout(() => {
      document.addEventListener("mousedown", this._outside);
      document.addEventListener("touchstart", this._outside, { passive: true });
      window.addEventListener("resize", this._reposition);
    }, 0);
    const first = pop.querySelector("button");
    if (first) first.focus({ preventScroll: true });
    return pop;
  },

  close() {
    if (!this.current) return false;
    const { pop, anchor, onClose } = this.current;
    pop.remove();
    if (anchor) { anchor.classList.remove("open"); anchor.setAttribute("aria-expanded", "false"); }
    document.removeEventListener("mousedown", this._outside);
    document.removeEventListener("touchstart", this._outside);
    window.removeEventListener("resize", this._reposition);
    this.current = null;
    if (onClose) onClose();
    return true;
  },
};

/**
 * Abre un menú con elementos { label, icon, onClick, danger } o "separator".
 */
function openMenu(anchor, items, options = {}) {
  const list = document.createElement("div");
  items.forEach((item) => {
    if (item === "separator") {
      const sep = document.createElement("div");
      sep.className = "menu-separator";
      list.appendChild(sep);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `menu-item${item.danger ? " danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.innerHTML = item.icon ? Icons[item.icon] || "" : "";
    const label = document.createElement("span");
    label.textContent = item.label;
    button.appendChild(label);
    button.addEventListener("click", () => {
      Popover.close();
      item.onClick();
    });
    list.appendChild(button);
  });
  // Navegación con flechas
  list.addEventListener("keydown", (event) => {
    const buttons = $$("button", list);
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") { event.preventDefault(); buttons[(index + 1) % buttons.length].focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length].focus(); }
  });
  return Popover.open(anchor, list, options);
}

/* --------------------------------------------------------------------- */
/* Utilidades                                                             */
/* --------------------------------------------------------------------- */
function escapeHtml(text) {
  return Markdown.escape(text);
}

function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function formatDate(iso, options = { day: "numeric", month: "short", year: "numeric" }) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(I18n.locale(), options).format(new Date(iso));
  } catch (_) {
    return new Date(iso).toLocaleDateString();
  }
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function initials(name) {
  const parts = String(name || "U").trim().split(/\s+/).filter(Boolean);
  const letters = (parts[0] ? parts[0][0] : "U") + (parts[1] ? parts[1][0] : "");
  return letters.toUpperCase();
}

/** Pinta un avatar (foto o iniciales) en un elemento .avatar */
function renderAvatar(el, profile) {
  if (!el) return;
  el.innerHTML = "";
  const url = profile && profile.avatar_url;
  if (url && /^https:\/\//i.test(url)) {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = url;
    img.onerror = () => { el.textContent = initials(profile.display_name); };
    el.appendChild(img);
  } else {
    el.textContent = initials(profile && profile.display_name);
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Respaldo para contextos sin Clipboard API
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }
}

function injectIcons(root = document) {
  $$("[data-icon]", root).forEach((el) => {
    const icon = Icons[el.dataset.icon];
    if (!icon || el.dataset.iconDone) return;
    el.dataset.iconDone = "1";
    if (!el.children.length && !el.textContent.trim()) el.innerHTML = icon;
    else el.insertAdjacentHTML("afterbegin", icon);
  });
}

function populateLanguageSelect(select) {
  select.innerHTML = "";
  LANGUAGES.forEach((lang) => {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = `${lang.flag}  ${lang.name}`;
    select.appendChild(option);
  });
  select.value = I18n.current;
}

/* --------------------------------------------------------------------- */
/* Conexión, atajos y arranque                                            */
/* --------------------------------------------------------------------- */
function setupConnectionBanner() {
  const banner = $("#offline-banner");
  const update = () => { banner.hidden = navigator.onLine; };
  window.addEventListener("online", () => { update(); });
  window.addEventListener("offline", update);
  update();
}

function setupShortcuts() {
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    // Algunos eventos (autocompletado del navegador, gestores de contraseñas) no traen "key"
    if (typeof event.key !== "string") return;
    const key = event.key.toLowerCase();

    if (event.key === "Escape") {
      if (Popover.close()) return;
      if (Modal.closeTop()) return;
      if (Chat.editing) { Chat.cancelEdit(); return; }
      if (Sidebar.isMobileOpen()) { Sidebar.closeMobile(); return; }
      Voice.stopSpeaking();
      return;
    }
    if ($("#app-view").hidden) return;

    if (mod && event.shiftKey && key === "n") {
      event.preventDefault();
      Chat.newConversation();
    } else if (mod && event.shiftKey && key === "s") {
      event.preventDefault();
      Sidebar.toggle();
    } else if (mod && (key === "/" || event.code === "Slash")) {
      event.preventDefault();
      $(App.section === "code" ? "#code-task" : "#message-input").focus();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  injectIcons();
  I18n.setLanguage(I18n.detect(), { persist: false });
  Themes.init();
  Markdown.init();
  Modal.init();
  setupConnectionBanner();
  setupShortcuts();

  Sidebar.init();
  Chat.init();
  Files.init();
  Voice.init();
  Exporter.init();
  Settings.init();
  Admin.init();
  PedusCode.init();

  // Traducciones dinámicas al cambiar de idioma
  document.addEventListener("languagechange", () => {
    if (App.profile) App.applyProfile();
    Sidebar.render();
  });

  // Configuración pública del backend
  try {
    App.config = await api("/config", { auth: false });
  } catch (error) {
    App.config = null;
  }
  await Auth.init();
});
