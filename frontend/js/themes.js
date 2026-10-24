/* =====================================================================
   PedusIA — Temas: claro / oscuro / sistema
   ===================================================================== */

const Themes = {
  preference: "light", // "light" | "dark" | "system"
  media: window.matchMedia("(prefers-color-scheme: dark)"),

  init() {
    this.preference = localStorage.getItem("pedus_theme") || "light";
    this.apply(false);
    // Si el usuario eligió "sistema", seguir los cambios del SO en vivo
    this.media.addEventListener("change", () => {
      if (this.preference === "system") this.apply(true);
    });
  },

  /** Tema efectivo que se está mostrando */
  get effective() {
    if (this.preference === "system") return this.media.matches ? "dark" : "light";
    return this.preference;
  },

  /** Aplica el tema con una transición suave de 500ms */
  apply(animate = true) {
    const root = document.documentElement;
    if (animate) {
      root.classList.add("theme-transition");
      clearTimeout(this._timer);
      this._timer = setTimeout(() => root.classList.remove("theme-transition"), 550);
    }
    root.setAttribute("data-theme", this.effective);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", this.effective === "dark" ? "#1A1A1A" : "#F5F5F0");
    this.updateToggleIcon();
  },

  /** Cambia la preferencia (y la guarda en el perfil si hay sesión) */
  set(preference, { persistRemote = true } = {}) {
    if (!["light", "dark", "system"].includes(preference)) preference = "light";
    this.preference = preference;
    localStorage.setItem("pedus_theme", preference);
    this.apply(true);
    if (persistRemote && typeof App !== "undefined" && App.profile) {
      App.profile.preferred_theme = preference;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        api("/profile", { method: "PATCH", body: { preferred_theme: preference } }).catch(() => {});
      }, 600);
    }
    const select = document.getElementById("pref-theme");
    if (select) select.value = preference;
  },

  /** Botón rápido del sidebar: alterna claro <-> oscuro */
  toggle() {
    this.set(this.effective === "dark" ? "light" : "dark");
  },

  updateToggleIcon() {
    const btn = document.getElementById("theme-toggle-btn");
    if (!btn) return;
    btn.innerHTML = this.effective === "dark" ? Icons.sun : Icons.moon;
  },
};
