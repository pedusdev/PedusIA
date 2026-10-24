/* =====================================================================
   PedusIA — Sidebar: historial de conversaciones agrupado por fecha
   ===================================================================== */

const Sidebar = {
  conversations: [],
  filter: "",
  loaded: false,
  mobileQuery: window.matchMedia("(max-width: 860px)"),

  init() {
    $("#new-chat-btn").addEventListener("click", () => Chat.newConversation());
    $("#sidebar-collapse-btn").addEventListener("click", () => this.toggle());
    $("#sidebar-open-btn").addEventListener("click", () => this.toggle());
    $("#menu-btn").addEventListener("click", () => this.openMobile());
    $("#sidebar-backdrop").addEventListener("click", () => this.closeMobile());
    $("#plan-btn").addEventListener("click", () => { this.closeMobile(); Settings.openPlanModal(); });
    $("#admin-btn").addEventListener("click", () => { this.closeMobile(); Admin.open(); });
    $("#user-chip").addEventListener("click", () => { this.closeMobile(); Settings.open("profile"); });
    $("#settings-btn").addEventListener("click", () => { this.closeMobile(); Settings.open("preferences"); });
    $("#theme-toggle-btn").addEventListener("click", () => Themes.toggle());

    $("#chat-search").addEventListener("input", debounce((event) => {
      this.filter = event.target.value.trim().toLowerCase();
      this.render();
    }, 150));

    const list = $("#conversation-list");
    list.addEventListener("click", (event) => {
      const menuBtn = event.target.closest(".conv-menu-btn");
      const item = event.target.closest(".conv-item");
      if (!item) return;
      const conversation = this.find(item.dataset.id);
      if (!conversation) return;
      if (menuBtn) {
        event.stopPropagation();
        this.showMenu(menuBtn, conversation);
        return;
      }
      Chat.open(conversation.id);
      this.closeMobile();
    });
    list.addEventListener("keydown", (event) => {
      const item = event.target.closest(".conv-item");
      if (item && (event.key === "Enter" || event.key === " ") && event.target === item) {
        event.preventDefault();
        Chat.open(item.dataset.id);
        this.closeMobile();
      }
    });
    // Clic derecho: menú contextual
    list.addEventListener("contextmenu", (event) => {
      const item = event.target.closest(".conv-item");
      if (!item) return;
      event.preventDefault();
      const conversation = this.find(item.dataset.id);
      if (conversation) this.showMenu(item.querySelector(".conv-menu-btn"), conversation, { x: event.clientX, y: event.clientY });
    });

    // Estado colapsado (escritorio) persistente
    if (localStorage.getItem("pedus_sidebar_collapsed") === "1" && !this.mobileQuery.matches) {
      $("#app-view").classList.add("sidebar-collapsed");
    }
  },

  find(id) {
    return this.conversations.find((conv) => conv.id === id);
  },

  /* ------------------------------------------------------------------ */
  async load() {
    this.showSkeleton();
    try {
      const data = await api("/conversations");
      this.conversations = data.conversations || [];
      this.loaded = true;
    } catch (error) {
      this.conversations = [];
      if (error.code !== "banned") toast(t("error_load"), "error");
    }
    this.render();
  },

  clear() {
    this.conversations = [];
    this.loaded = false;
    $("#conversation-list").innerHTML = "";
  },

  showSkeleton() {
    const list = $("#conversation-list");
    list.innerHTML = "";
    const label = document.createElement("div");
    label.className = "skeleton skeleton-label";
    list.appendChild(label);
    for (let i = 0; i < 7; i += 1) {
      const row = document.createElement("div");
      row.className = "skeleton skeleton-conv";
      row.style.width = `${70 + ((i * 13) % 30)}%`;
      list.appendChild(row);
    }
  },

  /** Agrupa por: Hoy, Ayer, Últimos 7 días, Últimos 30 días, Más antiguas */
  groupKey(dateString) {
    const date = new Date(dateString);
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const day = 24 * 60 * 60 * 1000;
    const diff = startToday - date;
    if (date >= startToday) return "group_today";
    if (diff <= day) return "group_yesterday";
    if (diff <= 7 * day) return "group_week";
    if (diff <= 30 * day) return "group_month";
    return "group_older";
  },

  render() {
    const list = $("#conversation-list");
    if (!list || !this.loaded) return;
    list.innerHTML = "";

    const items = [...this.conversations]
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
      .filter((conv) => !this.filter || (conv.title || "").toLowerCase().includes(this.filter));

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "conv-empty";
      empty.textContent = this.filter ? "—" : t("no_chats");
      list.appendChild(empty);
      return;
    }

    let currentGroup = null;
    items.forEach((conv) => {
      const group = this.groupKey(conv.updated_at || conv.created_at);
      if (group !== currentGroup) {
        currentGroup = group;
        const label = document.createElement("div");
        label.className = "conv-group-label";
        label.textContent = t(group);
        list.appendChild(label);
      }
      list.appendChild(this.createItem(conv));
    });
  },

  createItem(conv, animate = false) {
    const item = document.createElement("div");
    item.className = `conv-item${conv.id === Chat.currentId ? " active" : ""}${animate ? " enter" : ""}`;
    item.dataset.id = conv.id;
    item.tabIndex = 0;
    item.setAttribute("role", "button");

    const title = document.createElement("span");
    title.className = "conv-title";
    title.textContent = conv.title || t("new_chat");
    title.title = conv.title || "";

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "icon-btn conv-menu-btn";
    menuBtn.setAttribute("aria-label", t("chat_options"));
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.innerHTML = Icons.more;

    item.append(title, menuBtn);
    return item;
  },

  /** Añade o actualiza una conversación y la sube arriba */
  upsert(conv) {
    const index = this.conversations.findIndex((c) => c.id === conv.id);
    if (index >= 0) this.conversations[index] = { ...this.conversations[index], ...conv };
    else this.conversations.unshift(conv);
    this.loaded = true;
    this.render();
  },

  touch(id) {
    const conv = this.find(id);
    if (!conv) return;
    conv.updated_at = new Date().toISOString();
    this.render();
  },

  updateTitle(id, title) {
    const conv = this.find(id);
    if (!conv) return;
    conv.title = title;
    const el = $(`.conv-item[data-id="${CSS.escape(id)}"] .conv-title`);
    if (el) { el.textContent = title; el.title = title; }
  },

  remove(id) {
    this.conversations = this.conversations.filter((c) => c.id !== id);
    this.render();
  },

  setActive(id) {
    $$(".conv-item").forEach((el) => el.classList.toggle("active", el.dataset.id === id));
  },

  /* ------------------------------------------------------------------ */
  showMenu(anchor, conv, point) {
    openMenu(anchor, [
      { label: t("rename"), icon: "edit", onClick: () => this.rename(conv) },
      { label: t("export_txt"), icon: "file", onClick: () => Exporter.exportTxt(conv.id) },
      { label: t("export_pdf"), icon: "download", onClick: () => Exporter.exportPdf(conv.id) },
      { label: t("export_copy"), icon: "copy", onClick: () => Exporter.copyConversation(conv.id) },
      "separator",
      { label: t("delete"), icon: "trash", danger: true, onClick: () => this.confirmDelete(conv) },
    ], { point });
  },

  async rename(conv) {
    const title = await dialog({
      title: t("rename_title"),
      input: true,
      value: conv.title || "",
      confirmText: t("save"),
      maxLength: 120,
    });
    if (!title || title === conv.title) return;
    try {
      const updated = await api(`/conversations/${conv.id}`, { method: "PATCH", body: { title } });
      this.updateTitle(conv.id, updated.title);
      if (Chat.currentId === conv.id) $("#chat-title").textContent = updated.title;
      toast(t("chat_renamed"), "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  async confirmDelete(conv) {
    const ok = await dialog({
      title: t("delete_title"),
      text: `«${conv.title || t("new_chat")}»\n${t("delete_text")}`,
      confirmText: t("delete"),
      danger: true,
      icon: "🗑️",
    });
    if (!ok) return;
    try {
      await api(`/conversations/${conv.id}`, { method: "DELETE" });
      this.remove(conv.id);
      if (Chat.currentId === conv.id) Chat.newConversation();
      toast(t("chat_deleted"), "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  /* ------------------------------------------------------------------ */
  toggle() {
    if (this.mobileQuery.matches) {
      if (this.isMobileOpen()) this.closeMobile();
      else this.openMobile();
      return;
    }
    const app = $("#app-view");
    app.classList.toggle("sidebar-collapsed");
    localStorage.setItem("pedus_sidebar_collapsed", app.classList.contains("sidebar-collapsed") ? "1" : "0");
  },

  openMobile() {
    $("#app-view").classList.add("sidebar-open");
  },

  closeMobile() {
    $("#app-view").classList.remove("sidebar-open");
  },

  isMobileOpen() {
    return $("#app-view").classList.contains("sidebar-open");
  },
};
