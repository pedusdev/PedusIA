/* =====================================================================
   PedusIA — Panel de administración (solo admin y owner)
   ===================================================================== */

const Admin = {
  page: 1,
  limit: 20,
  total: 0,
  users: [],
  loadToken: 0,

  init() {
    $("#admin-search").addEventListener("input", debounce(() => { this.page = 1; this.loadUsers(); }, 350));
    $("#admin-role-filter").addEventListener("change", () => { this.page = 1; this.loadUsers(); });
    $("#admin-status-filter").addEventListener("change", () => { this.page = 1; this.loadUsers(); });
    $("#admin-refresh").addEventListener("click", () => { this.loadStats(); this.loadUsers(); });
    $("#admin-table-body").addEventListener("click", (event) => this.handleRowAction(event));
    $("#admin-table-body").addEventListener("change", (event) => {
      const select = event.target.closest(".role-select");
      if (select) this.changeRole(select.dataset.id, select.value, select);
    });
    document.addEventListener("languagechange", () => {
      if (Modal.isOpen("admin-modal")) { this.renderRows(); this.renderPagination(); this.loadStats(); }
    });
  },

  get isStaff() {
    return !!(App.profile && ["admin", "owner"].includes(App.profile.role));
  },

  open() {
    if (!this.isStaff) {
      toast(t("no_permission"), "error");
      return;
    }
    Modal.open("admin-modal");
    this.page = 1;
    this.loadStats();
    this.loadUsers();
  },

  /* ------------------------------------------------------------------ */
  /* Estadísticas                                                         */
  /* ------------------------------------------------------------------ */
  async loadStats() {
    const grid = $("#admin-stats");
    grid.innerHTML = Array.from({ length: 6 }, () => '<div class="stat-card"><div class="skeleton skeleton-line" style="width:50%;height:22px"></div><div class="skeleton skeleton-line" style="width:80%;margin-top:8px"></div></div>').join("");
    try {
      const stats = await api("/admin/stats");
      const cards = [
        ["👥", stats.total_users, "stat_total_users"],
        ["🟢", stats.active_today, "stat_active_today"],
        ["💬", stats.total_conversations, "stat_conversations"],
        ["✉️", stats.total_messages, "stat_messages"],
        ["👑", stats.max_users, "stat_max"],
        ["⛔", stats.banned_users, "stat_banned"],
      ];
      const number = new Intl.NumberFormat(I18n.locale());
      grid.innerHTML = cards.map(([icon, value, key]) => `
        <div class="stat-card fade-in-up">
          <div class="stat-value">${number.format(value || 0)}</div>
          <div class="stat-label">${icon} ${escapeHtml(t(key))}</div>
        </div>`).join("");
    } catch (error) {
      grid.innerHTML = "";
      toast(errorMessage(error), "error");
    }
  },

  /* ------------------------------------------------------------------ */
  /* Usuarios                                                             */
  /* ------------------------------------------------------------------ */
  async loadUsers() {
    const token = ++this.loadToken;
    const body = $("#admin-table-body");
    body.innerHTML = Array.from({ length: 5 }, () => `<tr>${'<td><div class="skeleton skeleton-line" style="width:80%"></div></td>'.repeat(6)}</tr>`).join("");

    const params = new URLSearchParams({ page: String(this.page), limit: String(this.limit) });
    const search = $("#admin-search").value.trim();
    const role = $("#admin-role-filter").value;
    const status = $("#admin-status-filter").value;
    if (search) params.set("search", search);
    if (role) params.set("role", role);
    if (status) params.set("status", status);

    try {
      const data = await api(`/admin/users?${params.toString()}`);
      if (token !== this.loadToken) return;
      this.users = data.users || [];
      this.total = data.total || 0;
      this.renderRows();
      this.renderPagination();
    } catch (error) {
      if (token !== this.loadToken) return;
      this.users = [];
      body.innerHTML = `<tr><td colspan="6" class="table-empty">${escapeHtml(t("error_load"))}</td></tr>`;
      toast(errorMessage(error), "error");
    }
  },

  /** ¿Puede el usuario actual modificar a este usuario? (misma regla que el backend) */
  canManage(target) {
    const actor = App.profile;
    if (!actor || target.id === actor.id || target.role === "owner") return false;
    if (actor.role === "admin" && target.role === "admin") return false;
    return true;
  },

  assignableRoles() {
    return App.profile.role === "owner" ? ["user", "max", "admin"] : ["user", "max"];
  },

  findUser(id) {
    return this.users.find((u) => u.id === id);
  },

  renderRows() {
    const body = $("#admin-table-body");
    body.innerHTML = "";
    if (!this.users.length) {
      body.innerHTML = `<tr><td colspan="6" class="table-empty">${escapeHtml(t("admin_no_users"))}</td></tr>`;
      return;
    }
    this.users.forEach((user) => body.appendChild(this.buildRow(user)));
  },

  buildRow(user) {
    const tr = document.createElement("tr");
    tr.dataset.id = user.id;
    const manageable = this.canManage(user);
    const limit = (App.config && App.config.ultra_daily_limit) || 30;

    // Usuario (avatar + nombre + email)
    const userCell = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "admin-user";
    const avatar = document.createElement("span");
    avatar.className = "avatar avatar-sm";
    renderAvatar(avatar, user);
    const text = document.createElement("div");
    text.className = "admin-user-text";
    const name = document.createElement("span");
    name.className = "admin-user-name";
    name.textContent = user.display_name || "—";
    const email = document.createElement("span");
    email.className = "admin-user-email";
    email.textContent = user.email || "";
    text.append(name, email);
    wrap.append(avatar, text);
    userCell.appendChild(wrap);

    // Rol: selector si se puede gestionar, si no una etiqueta
    const roleCell = document.createElement("td");
    const roles = this.assignableRoles();
    if (manageable && roles.includes(user.role)) {
      const select = document.createElement("select");
      select.className = "select select-sm role-select";
      select.dataset.id = user.id;
      select.setAttribute("aria-label", t("col_role"));
      roles.forEach((role) => {
        const option = document.createElement("option");
        option.value = role;
        option.textContent = t(`role_${role}`);
        select.appendChild(option);
      });
      select.value = user.role;
      roleCell.appendChild(select);
    } else {
      const badge = document.createElement("span");
      badge.className = `role-badge role-${user.role}`;
      badge.textContent = t(`role_${user.role}`);
      roleCell.appendChild(badge);
    }

    // Estado
    const statusCell = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `status-pill ${user.is_banned ? "status-banned" : "status-active"}`;
    pill.textContent = t(user.is_banned ? "status_banned" : "status_active");
    if (user.is_banned && user.ban_reason) pill.title = user.ban_reason;
    statusCell.appendChild(pill);

    // Fecha de registro
    const joinedCell = document.createElement("td");
    joinedCell.textContent = formatDate(user.created_at);

    // Uso de PRO ULTRA hoy
    const usageCell = document.createElement("td");
    if (user.role === "owner") usageCell.textContent = "∞";
    else if (["max", "admin"].includes(user.role)) usageCell.textContent = `${user.ultra_used_today || 0}/${limit}`;
    else usageCell.textContent = "—";

    // Acciones
    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const addAction = (action, icon, label, danger = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `icon-btn${danger ? " danger" : ""}`;
      button.dataset.action = action;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.innerHTML = Icons[icon];
      actions.appendChild(button);
    };
    addAction("history", "history", t("action_history"));
    if (manageable) {
      addAction("reset", "refresh", t("action_reset"));
      if (user.is_banned) addAction("unban", "check", t("action_unban"));
      else addAction("ban", "x", t("action_ban"), true);
    }
    actionsCell.appendChild(actions);

    tr.append(userCell, roleCell, statusCell, joinedCell, usageCell, actionsCell);
    return tr;
  },

  replaceUser(updated) {
    const index = this.users.findIndex((u) => u.id === updated.id);
    if (index < 0) return;
    this.users[index] = { ...this.users[index], ...updated };
    const row = $(`#admin-table-body tr[data-id="${CSS.escape(updated.id)}"]`);
    if (row) row.replaceWith(this.buildRow(this.users[index]));
  },

  renderPagination() {
    const container = $("#admin-pagination");
    container.innerHTML = "";
    const pages = Math.max(1, Math.ceil(this.total / this.limit));
    const info = document.createElement("span");
    info.textContent = t("page_of", { page: this.page, pages });
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "btn btn-secondary";
    prev.textContent = t("prev");
    prev.disabled = this.page <= 1;
    prev.addEventListener("click", () => { this.page -= 1; this.loadUsers(); });
    const next = document.createElement("button");
    next.type = "button";
    next.className = "btn btn-secondary";
    next.textContent = t("next");
    next.disabled = this.page >= pages;
    next.addEventListener("click", () => { this.page += 1; this.loadUsers(); });
    container.append(info, prev, next);
  },

  /* ------------------------------------------------------------------ */
  /* Acciones                                                             */
  /* ------------------------------------------------------------------ */
  handleRowAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const row = button.closest("tr");
    const user = row && this.findUser(row.dataset.id);
    if (!user) return;
    switch (button.dataset.action) {
      case "history": this.showHistory(user); break;
      case "reset": this.resetLimits(user); break;
      case "ban": this.ban(user); break;
      case "unban": this.unban(user); break;
      default: break;
    }
  },

  async changeRole(userId, role, select) {
    const user = this.findUser(userId);
    if (!user || user.role === role) return;
    const previous = user.role;
    const ok = await dialog({
      title: t("col_role"),
      text: t("role_change_text", { name: user.display_name || user.email, role: t(`role_${role}`) }),
      confirmText: t("confirm"),
      icon: "🛡️",
    });
    if (!ok) { select.value = previous; return; }
    select.disabled = true;
    try {
      const updated = await api(`/admin/users/${userId}/role`, { method: "PATCH", body: { role } });
      this.replaceUser(updated);
      toast(t("role_updated"), "success");
      this.loadStats();
    } catch (error) {
      select.value = previous;
      select.disabled = false;
      toast(errorMessage(error), "error");
    }
  },

  async ban(user) {
    const reason = await dialog({
      title: t("ban_title", { name: user.display_name || user.email }),
      text: t("ban_text"),
      input: true,
      allowEmpty: true,
      placeholder: t("ban_reason_ph"),
      maxLength: 300,
      confirmText: t("action_ban"),
      danger: true,
      icon: "⛔",
    });
    if (reason === null) return;
    try {
      const updated = await api(`/admin/users/${user.id}/ban`, {
        method: "PATCH",
        body: { is_banned: true, ban_reason: String(reason).trim() },
      });
      this.replaceUser(updated);
      toast(t("user_banned"), "success");
      this.loadStats();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  async unban(user) {
    const ok = await dialog({
      title: t("action_unban"),
      text: t("unban_text", { name: user.display_name || user.email }),
      confirmText: t("action_unban"),
      icon: "✅",
    });
    if (!ok) return;
    try {
      const updated = await api(`/admin/users/${user.id}/ban`, { method: "PATCH", body: { is_banned: false, ban_reason: "" } });
      this.replaceUser(updated);
      toast(t("user_unbanned"), "success");
      this.loadStats();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  async resetLimits(user) {
    const ok = await dialog({
      title: t("action_reset"),
      text: t("reset_text", { name: user.display_name || user.email }),
      confirmText: t("confirm"),
      icon: "🔄",
    });
    if (!ok) return;
    try {
      const updated = await api(`/admin/users/${user.id}/reset-limits`, { method: "PATCH" });
      this.replaceUser(updated);
      toast(t("limits_reset"), "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  async showHistory(user) {
    $("#history-title").textContent = t("history_title", { name: user.display_name || user.email });
    const list = $("#history-list");
    list.innerHTML = Array.from({ length: 4 }, () => '<li><div class="skeleton skeleton-line" style="width:70%"></div></li>').join("");
    Modal.open("history-modal");
    try {
      const data = await api(`/admin/users/${user.id}/conversations`);
      list.innerHTML = "";
      const rows = data.conversations || [];
      if (!rows.length) {
        const empty = document.createElement("li");
        empty.className = "muted";
        empty.textContent = t("history_empty");
        list.appendChild(empty);
        return;
      }
      rows.forEach((conv) => {
        const li = document.createElement("li");
        const title = document.createElement("span");
        title.textContent = conv.title || t("new_chat");
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = formatDate(conv.updated_at || conv.created_at);
        li.append(title, meta);
        list.appendChild(li);
      });
    } catch (error) {
      list.innerHTML = "";
      toast(errorMessage(error), "error");
    }
  },
};
