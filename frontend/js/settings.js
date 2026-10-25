/* =====================================================================
   PedusGPT — Configuración: perfil, preferencias y Plan MAX
   ===================================================================== */

const Settings = {
  init() {
    // Pestañas
    $$("#settings-modal .tab").forEach((tab) => {
      tab.addEventListener("click", () => this.switchTab(tab.dataset.tab));
    });

    // Perfil
    $("#profile-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.saveProfile();
    });
    $("#profile-bio").addEventListener("input", () => this.updateBioCounter());
    $("#avatar-change-btn").addEventListener("click", () => $("#avatar-input").click());
    $("#avatar-input").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (file) this.uploadAvatar(file);
    });
    $("#logout-btn").addEventListener("click", async () => {
      const ok = await dialog({
        title: t("logout"),
        text: t("logout_confirm"),
        confirmText: t("logout"),
        icon: "👋",
      });
      if (ok) {
        Modal.closeAll();
        Auth.logout();
      }
    });

    // Preferencias
    populateLanguageSelect($("#pref-language"));
    $("#pref-language").addEventListener("change", (event) => this.changeLanguage(event.target.value));
    $("#pref-theme").addEventListener("change", (event) => Themes.set(event.target.value));
    $("#pref-default-model").addEventListener("change", (event) => this.changeDefaultModel(event.target.value));

    document.addEventListener("languagechange", () => {
      if (Modal.isOpen("settings-modal")) this.fill();
      if (Modal.isOpen("plan-modal")) this.renderPlanModal();
    });
  },

  /* ------------------------------------------------------------------ */
  /* Apertura y pestañas                                                  */
  /* ------------------------------------------------------------------ */
  open(tab = "profile") {
    if (!App.profile) return;
    this.fill();
    this.switchTab(tab);
    Modal.open("settings-modal");
    this.refreshProfile();
  },

  switchTab(name) {
    $$("#settings-modal .tab").forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    $$("#settings-modal .tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `tab-${name}`);
    });
  },

  /** Rellena todos los campos a partir del perfil actual */
  fill() {
    const profile = App.profile;
    if (!profile) return;
    renderAvatar($("#profile-avatar"), profile);
    $("#profile-head-name").textContent = profile.display_name || "";
    const badge = $("#profile-role-badge");
    badge.className = `role-badge role-${profile.role}`;
    badge.textContent = t(`role_${profile.role}`);
    $("#profile-member-since").textContent = t("member_since", { date: formatDate(profile.created_at) });

    $("#profile-name").value = profile.display_name || "";
    $("#profile-email").value = profile.email || (App.user && App.user.email) || "";
    $("#profile-bio").value = profile.bio || "";
    $("#profile-interests").value = profile.interests || "";
    $("#profile-animal").value = profile.favorite_animal || "";
    this.updateBioCounter();

    $("#pref-language").value = I18n.current;
    $("#pref-theme").value = Themes.preference;
    this.fillModelSelect();
    this.renderPlanTab();
  },

  fillModelSelect() {
    const select = $("#pref-default-model");
    select.innerHTML = "";
    MODELS.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      const locked = model.ultra && !App.hasUltra;
      option.textContent = `${model.icon}  ${model.name}${locked ? " 🔒" : ""}`;
      option.disabled = locked;
      select.appendChild(option);
    });
    const current = App.profile.default_model || "pedus-gpt-2";
    select.value = current === ULTRA_MODEL && !App.hasUltra ? "pedus-gpt-2" : current;
  },

  updateBioCounter() {
    const length = $("#profile-bio").value.length;
    const counter = $("#bio-counter");
    counter.textContent = `${length}/200`;
    counter.classList.toggle("warn", length >= 180);
  },

  /** Recarga el perfil (uso de ULTRA actualizado) sin bloquear la interfaz */
  async refreshProfile() {
    try {
      const profile = await api("/profile");
      App.profile = { ...App.profile, ...profile };
      App.applyProfile();
      if (Modal.isOpen("settings-modal")) this.renderPlanTab();
      if (Modal.isOpen("plan-modal")) this.renderPlanModal();
    } catch (_) { /* se mantienen los datos en memoria */ }
  },

  /* ------------------------------------------------------------------ */
  /* Guardar perfil                                                       */
  /* ------------------------------------------------------------------ */
  async saveProfile() {
    const nameInput = $("#profile-name");
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.classList.add("invalid", "shake");
      setTimeout(() => nameInput.classList.remove("shake"), 500);
      nameInput.focus();
      toast(t("err_name_required"), "error");
      return;
    }
    nameInput.classList.remove("invalid");

    const button = $("#profile-save-btn");
    button.classList.add("loading");
    button.disabled = true;
    try {
      const profile = await api("/profile", {
        method: "PATCH",
        body: {
          display_name: name,
          bio: $("#profile-bio").value.trim(),
          interests: $("#profile-interests").value.trim(),
          favorite_animal: $("#profile-animal").value.trim(),
        },
      });
      App.profile = { ...App.profile, ...profile };
      App.applyProfile();
      this.fill();
      toast(t("profile_saved"), "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      button.classList.remove("loading");
      button.disabled = false;
    }
  },

  async uploadAvatar(file) {
    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)) {
      toast(t("file_type_invalid"), "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast(t("avatar_too_big"), "error");
      return;
    }
    const avatar = $("#profile-avatar");
    avatar.classList.add("loading");
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const profile = await api("/profile/avatar", { method: "POST", formData: form });
      App.profile = { ...App.profile, ...profile };
      App.applyProfile();
      renderAvatar(avatar, App.profile);
      toast(t("avatar_updated"), "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      avatar.classList.remove("loading");
    }
  },

  /* ------------------------------------------------------------------ */
  /* Preferencias                                                         */
  /* ------------------------------------------------------------------ */
  async changeLanguage(lang) {
    I18n.setLanguage(lang);
    if (App.profile) App.profile.preferred_language = lang;
    try {
      await api("/profile", { method: "PATCH", body: { preferred_language: lang } });
      toast(t("preferences_saved"), "success", 1800);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  async changeDefaultModel(model) {
    try {
      await api("/profile", { method: "PATCH", body: { default_model: model } });
      App.profile.default_model = model;
      ModelSelector.select(model, { silent: true });
      toast(t("preferences_saved"), "success", 1800);
    } catch (error) {
      toast(errorMessage(error), "error");
      this.fillModelSelect();
    }
  },

  /* ------------------------------------------------------------------ */
  /* Plan MAX                                                             */
  /* ------------------------------------------------------------------ */
  mailtoLink() {
    const email = (App.config && App.config.contact_email) || "";
    const subject = encodeURIComponent(t("plan_mail_subject"));
    const body = encodeURIComponent(t("plan_mail_body", {
      name: (App.profile && App.profile.display_name) || "",
      email: (App.profile && App.profile.email) || "",
    }));
    return `mailto:${email}?subject=${subject}&body=${body}`;
  },

  /** Tarjeta de cristal con beneficios (para quien aún no tiene MAX) */
  buildPricingCard() {
    const card = document.createElement("div");
    card.className = "plan-card plan-card-premium";
    const limit = (App.config && App.config.ultra_daily_limit) || 30;
    const codeLimit = (App.config && App.config.peduscode_daily_limit) || 3;
    const benefits = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<li>${escapeHtml(t(`max_b${i}`, { limit, code_limit: codeLimit }))}</li>`).join("");
    card.innerHTML = `
      <div class="plan-crown">${Icons.crown}</div>
      <h2 class="plan-title">PedusGPT 2 PRO ULTRA <span class="badge badge-gold">MAX</span></h2>
      <p class="plan-subtitle">${escapeHtml(t("max_subtitle"))}</p>
      <ul class="plan-benefits">${benefits}</ul>
      <p class="plan-note">${escapeHtml(t("max_invite"))}</p>
      <a class="btn btn-gold btn-block" href="${escapeHtml(this.mailtoLink())}">${Icons.mail}<span>${escapeHtml(t("max_request"))}</span></a>`;
    return card;
  },

  /** Tarjeta para quien ya tiene acceso: uso del día y barra de progreso */
  buildHaveCard() {
    const profile = App.profile;
    const usage = profile.ultra || { used: 0, limit: 30, unlimited: false };
    const card = document.createElement("div");
    card.className = "plan-card plan-card-premium";

    let usageBlock;
    if (usage.unlimited) {
      usageBlock = `<p class="plan-note">${escapeHtml(t("plan_owner_unlimited"))}</p>`;
    } else {
      const percent = Math.min(100, Math.round((usage.used / usage.limit) * 100));
      usageBlock = `
        <div class="usage-label"><span>👑 PedusGPT 2 PRO ULTRA</span><strong>${usage.used}/${usage.limit}</strong></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${usage.limit}" aria-valuenow="${usage.used}">
          <div class="progress-bar${percent >= 100 ? " full" : ""}" style="width:0%"></div>
        </div>
        <p class="plan-note" style="margin-top:10px">${escapeHtml(t("max_usage", { used: usage.used, limit: usage.limit }))} · ${escapeHtml(t("plan_resets"))}</p>`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const bar = card.querySelector(".progress-bar");
        if (bar) bar.style.width = `${percent}%`;
      }));
    }

    // Uso de PedusCode (agente de código)
    const code = profile.code || { used: 0, limit: (App.config && App.config.peduscode_daily_limit) || 3, unlimited: usage.unlimited };
    if (!code.unlimited && code.limit) {
      const codePercent = Math.min(100, Math.round((code.used / code.limit) * 100));
      usageBlock += `
        <div class="usage-label" style="margin-top:14px"><span>💻 PedusCode</span><strong>${code.used}/${code.limit}</strong></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${code.limit}" aria-valuenow="${code.used}">
          <div class="progress-bar progress-bar-code${codePercent >= 100 ? " full" : ""}" style="width:0%"></div>
        </div>`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const bar = card.querySelector(".progress-bar-code");
        if (bar) bar.style.width = `${codePercent}%`;
      }));
    }

    const title = profile.role === "max" ? t("max_have") : t("plan_staff_access", { role: t(`role_${profile.role}`) });
    card.innerHTML = `
      <div class="plan-crown">${Icons.crown}</div>
      <p class="plan-have">${escapeHtml(title)}</p>
      ${usageBlock}
      <div class="plan-perks">
        <span class="perk">👑 PRO ULTRA</span>
        <span class="perk">⚡ ${escapeHtml(t("max_fast"))}</span>
        <span class="perk">💬 ${escapeHtml(t("max_priority"))}</span>
        <span class="perk">💻 PedusCode</span>
      </div>`;
    return card;
  },

  renderPlanTab() {
    const container = $("#plan-tab-content");
    if (!container || !App.profile) return;
    container.innerHTML = "";

    const current = document.createElement("div");
    current.className = "plan-card plan-current-card";
    if (App.hasUltra) {
      current.innerHTML = `<div class="plan-crown">${Icons.crown}</div><div class="plan-current-text"><strong></strong><span class="muted small"></span></div><span class="badge badge-gold">MAX</span>`;
      current.querySelector("strong").textContent = t("plan_max_name");
      current.querySelector(".muted").textContent = `${t("plan_current")} · ${t("max_subtitle")}`;
      container.append(current, this.buildHaveCard());
    } else {
      current.innerHTML = `<div class="plan-current-icon">⚡</div><div class="plan-current-text"><strong></strong><span class="muted small"></span></div>`;
      current.querySelector("strong").textContent = t("plan_free");
      current.querySelector(".muted").textContent = `${t("plan_current")} · ${t("plan_free_desc")}`;
      container.append(current, this.buildPricingCard());
    }
  },

  renderPlanModal() {
    const container = $("#plan-modal-content");
    container.innerHTML = "";
    container.appendChild(App.hasUltra ? this.buildHaveCard() : this.buildPricingCard());
  },

  openPlanModal() {
    if (!App.profile) return;
    this.renderPlanModal();
    Modal.open("plan-modal");
    this.refreshProfile();
  },
};
