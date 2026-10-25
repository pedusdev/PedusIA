/* =====================================================================
   PedusGPT — Autenticación (Supabase Auth: email + Google OAuth)
   ===================================================================== */

const Auth = {
  mode: "login", // "login" | "register"
  refreshing: null,

  async init() {
    this.bindUI();

    const config = App.config;
    if (!config || !config.configured || !config.supabase_url || !config.supabase_anon_key) {
      $("#config-warning").hidden = !(config && !config.configured);
      if (!config) toast(t("error_network"), "error", 6000);
      App.showView("auth");
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      toast(t("error_load"), "error", 8000);
      App.showView("auth");
      return;
    }

    App.supabase = window.supabase.createClient(config.supabase_url, config.supabase_anon_key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    // Importante: no llamar a Supabase dentro del callback (se difiere con setTimeout)
    App.supabase.auth.onAuthStateChange((event, session) => {
      setTimeout(() => this.handleAuthEvent(event, session), 0);
    });

    try {
      const { data } = await App.supabase.auth.getSession();
      if (data && data.session) await App.onSignedIn(data.session);
      else App.showView("auth");
    } catch (_) {
      App.showView("auth");
    }
  },

  handleAuthEvent(event, session) {
    if (event === "SIGNED_IN" && session) App.onSignedIn(session);
    else if (event === "SIGNED_OUT") App.onSignedOut();
    else if (event === "PASSWORD_RECOVERY") this.promptNewPassword();
  },

  /** Token JWT actual (se refresca automáticamente si ha caducado) */
  async getToken() {
    if (!App.supabase) return null;
    try {
      const { data } = await App.supabase.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    } catch (_) {
      return null;
    }
  },

  /** El backend dijo 401: intentar refrescar; si falla, cerrar sesión */
  handleUnauthorized() {
    if (this.refreshing || !App.supabase) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const { data, error } = await App.supabase.auth.refreshSession();
        if (error || !data.session) throw error || new Error("no session");
      } catch (_) {
        if (App.profile) toast(t("session_expired"), "warning");
        await this.logout();
      } finally {
        setTimeout(() => { this.refreshing = null; }, 3000);
      }
    })();
    return this.refreshing;
  },

  async logout() {
    try {
      if (App.supabase) await App.supabase.auth.signOut();
    } catch (_) { /* sin conexión: limpiar igualmente */ }
    App.onSignedOut();
  },

  /* ------------------------------------------------------------------ */
  /* Interfaz                                                            */
  /* ------------------------------------------------------------------ */
  bindUI() {
    $("#auth-tab-login").addEventListener("click", () => this.setMode("login"));
    $("#auth-tab-register").addEventListener("click", () => this.setMode("register"));
    $("#auth-form").addEventListener("submit", (event) => { event.preventDefault(); this.submit(); });
    $("#google-btn").addEventListener("click", () => this.loginWithGoogle());
    $("#forgot-btn").addEventListener("click", () => this.forgotPassword());
    $("#banned-logout-btn").addEventListener("click", () => this.logout());

    const toggle = $("#toggle-password");
    toggle.addEventListener("click", () => {
      const input = $("#auth-password");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.innerHTML = show ? Icons.eyeOff : Icons.eye;
    });

    ["#auth-name", "#auth-email", "#auth-password"].forEach((id) => {
      $(id).addEventListener("input", () => { $(id).classList.remove("invalid"); this.setError(""); });
    });

    const langSelect = $("#auth-lang-select");
    populateLanguageSelect(langSelect);
    langSelect.addEventListener("change", () => I18n.setLanguage(langSelect.value));
    document.addEventListener("languagechange", () => { langSelect.value = I18n.current; });
  },

  setMode(mode) {
    this.mode = mode;
    const register = mode === "register";
    $(".segmented").dataset.mode = mode;
    $("#auth-tab-login").classList.toggle("active", !register);
    $("#auth-tab-register").classList.toggle("active", register);
    $("#auth-tab-login").setAttribute("aria-selected", String(!register));
    $("#auth-tab-register").setAttribute("aria-selected", String(register));
    $("#field-name").hidden = !register;
    $("#forgot-btn").hidden = register;
    $("#auth-password").autocomplete = register ? "new-password" : "current-password";
    const label = $("#auth-submit .btn-label");
    label.dataset.i18n = register ? "auth_submit_register" : "auth_submit_login";
    label.textContent = t(label.dataset.i18n);
    this.setError("");
    (register ? $("#auth-name") : $("#auth-email")).focus();
  },

  setError(message) {
    $("#auth-error").textContent = message;
  },

  setLoading(loading) {
    const button = $("#auth-submit");
    button.classList.toggle("loading", loading);
    button.disabled = loading;
    $("#google-btn").disabled = loading;
  },

  markInvalid(id, messageKey) {
    const el = $(id);
    el.classList.add("invalid");
    el.focus();
    $(".auth-card").classList.add("shake");
    setTimeout(() => $(".auth-card").classList.remove("shake"), 450);
    this.setError(t(messageKey));
  },

  validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  },

  /** Traduce errores de Supabase Auth a mensajes amigables */
  mapAuthError(error) {
    const message = String((error && error.message) || "").toLowerCase();
    if (message.includes("invalid login") || message.includes("invalid credentials")) return t("err_invalid_credentials");
    if (message.includes("already registered") || message.includes("already exists")) return t("err_email_taken");
    if (message.includes("not confirmed")) return t("err_email_not_confirmed");
    if (message.includes("password should") || message.includes("at least 6")) return t("err_password_short");
    if (message.includes("rate limit") || (error && error.status === 429)) return t("rate_limit_general");
    if (message.includes("invalid email") || message.includes("validate email")) return t("err_invalid_email");
    if (message.includes("fetch") || message.includes("network")) return t("error_network");
    return t("error_generic");
  },

  async submit() {
    if (!App.supabase) { this.setError(t("not_configured")); return; }
    const name = $("#auth-name").value.trim();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;

    if (this.mode === "register" && !name) return this.markInvalid("#auth-name", "err_name_required");
    if (!this.validEmail(email)) return this.markInvalid("#auth-email", "err_invalid_email");
    if (password.length < 6) return this.markInvalid("#auth-password", "err_password_short");

    this.setLoading(true);
    this.setError("");
    try {
      if (this.mode === "login") {
        const { error } = await App.supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange(SIGNED_IN) carga la app
      } else {
        const { data, error } = await App.supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name }, emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        // Supabase devuelve identities vacías si el email ya existe
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error("already registered");
        }
        if (!data.session) {
          toast(t("auth_check_email"), "info", 7000);
          this.setMode("login");
          $("#auth-email").value = email;
          $("#auth-password").value = "";
        }
      }
    } catch (error) {
      this.setError(this.mapAuthError(error));
    } finally {
      this.setLoading(false);
    }
  },

  async loginWithGoogle() {
    if (!App.supabase) { this.setError(t("not_configured")); return; }
    this.setLoading(true);
    try {
      const { error } = await App.supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
    } catch (error) {
      this.setError(this.mapAuthError(error));
      this.setLoading(false);
    }
  },

  async forgotPassword() {
    if (!App.supabase) { this.setError(t("not_configured")); return; }
    const email = $("#auth-email").value.trim();
    if (!this.validEmail(email)) return this.markInvalid("#auth-email", "err_invalid_email");
    try {
      const { error } = await App.supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      if (error) throw error;
      toast(t("auth_reset_sent"), "info", 6000);
    } catch (error) {
      this.setError(this.mapAuthError(error));
    }
  },

  /** Tras pulsar el enlace de recuperación del email */
  async promptNewPassword() {
    const password = await dialog({
      title: t("auth_new_password"),
      input: true,
      inputType: "password",
      placeholder: t("auth_new_password"),
      confirmText: t("save"),
      maxLength: 72,
    });
    if (!password) return;
    if (password.length < 6) { toast(t("err_password_short"), "error"); return this.promptNewPassword(); }
    const { error } = await App.supabase.auth.updateUser({ password });
    if (error) toast(this.mapAuthError(error), "error");
    else toast(t("auth_password_updated"), "success");
  },
};
