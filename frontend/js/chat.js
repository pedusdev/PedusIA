/* =====================================================================
   PedusIA — Chat: selector de modelo, mensajes, streaming SSE y acciones
   ===================================================================== */

const ULTRA_MODEL = "pedus-gpt-2-pro-ultra";

const MODELS = [
  { id: "pedus-gpt-2", name: "PedusGPT 2", icon: "⚡", descKey: "model_basic_desc" },
  { id: "pedus-gpt-2-pro", name: "PedusGPT 2 PRO", icon: "🚀", descKey: "model_pro_desc" },
  { id: ULTRA_MODEL, name: "PedusGPT 2 PRO ULTRA", icon: "👑", descKey: "model_ultra_desc", ultra: true },
];

/* ===================================================================== */
/* Selector de modelo (sidebar + inline en el compositor)                 */
/* ===================================================================== */
const ModelSelector = {
  selected: "pedus-gpt-2",
  containers: ["#model-selector-sidebar", "#model-selector-inline"],

  get current() {
    return MODELS.find((m) => m.id === this.selected) || MODELS[0];
  },

  setInitial() {
    const saved = localStorage.getItem("pedus_model");
    let model = saved || (App.profile && App.profile.default_model) || "pedus-gpt-2";
    if (!MODELS.some((m) => m.id === model)) model = "pedus-gpt-2";
    if (model === ULTRA_MODEL && !App.hasUltra) model = "pedus-gpt-2";
    this.selected = model;
    this.render();
  },

  select(id, { silent = false } = {}) {
    const model = MODELS.find((m) => m.id === id);
    if (!model) return;
    if (model.ultra && !App.hasUltra) {
      toast(t("model_locked"), "info");
      Settings.openPlanModal();
      return;
    }
    this.selected = id;
    localStorage.setItem("pedus_model", id);
    this.render();
    if (!silent) toast(t("model_selected", { name: model.name }), "info", 1800);
  },

  render() {
    const model = this.current;
    this.containers.forEach((selector) => {
      const container = $(selector);
      if (!container) return;
      container.innerHTML = "";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "model-trigger";
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      trigger.title = t("model_label");
      trigger.innerHTML = `<span class="model-icon">${model.icon}</span><span class="model-name"></span>${Icons.chevronDown}`;
      trigger.querySelector(".model-name").textContent = model.name;
      trigger.addEventListener("click", () => this.openMenu(trigger));
      container.appendChild(trigger);
    });

    // Indicador sutil del modelo activo en la cabecera
    const badge = $("#active-model-badge");
    if (badge) {
      badge.textContent = `${model.icon} ${model.name}`;
      badge.classList.toggle("ultra", !!model.ultra);
      badge.classList.toggle("priority", App.hasUltra);
    }
  },

  openMenu(anchor) {
    const wrap = document.createElement("div");
    wrap.className = "model-menu";
    const usage = App.profile && App.profile.ultra;

    MODELS.forEach((model) => {
      const locked = model.ultra && !App.hasUltra;
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(model.id === this.selected));
      option.className = `model-option${model.ultra ? " ultra" : ""}${model.id === this.selected ? " selected" : ""}${locked ? " locked" : ""}`;
      if (locked) option.title = t("model_locked");

      let usageLine = "";
      if (model.ultra && !locked && usage) {
        usageLine = usage.unlimited
          ? `<span class="model-usage">∞</span>`
          : `<span class="model-usage">${usage.used}/${usage.limit}</span>`;
      }
      option.innerHTML = `
        <span class="model-icon">${model.icon}</span>
        <span class="model-option-text">
          <span class="model-option-name"><span class="mo-name"></span>${model.ultra ? '<span class="badge badge-gold badge-xs">MAX</span>' : ""}${locked ? `<span class="model-lock">${Icons.lock}</span>` : ""}</span>
          <span class="model-option-desc"></span>
          ${usageLine}
        </span>
        <span class="model-check">${Icons.check}</span>`;
      option.querySelector(".mo-name").textContent = model.name;
      option.querySelector(".model-option-desc").textContent = locked ? t("model_locked") : t(model.descKey);
      option.addEventListener("click", () => {
        Popover.close();
        this.select(model.id);
      });
      wrap.appendChild(option);
    });
    Popover.open(anchor, wrap);
  },
};

/* ===================================================================== */
/* Chat                                                                   */
/* ===================================================================== */
const Chat = {
  currentId: null,
  messages: [], // { id, role, content, file_url, file_type, file_name, liked, el, contentEl }
  streaming: false,
  abortController: null,
  editing: null,
  autoScroll: true,
  openToken: 0,
  renderPending: false,

  init() {
    const input = $("#message-input");
    input.addEventListener("input", () => { this.autoResize(); this.updateSendState(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    });

    $("#send-btn").addEventListener("click", () => {
      if (this.streaming) this.stop();
      else this.send();
    });

    $("#suggestions").addEventListener("click", (event) => {
      const card = event.target.closest(".suggestion-card");
      if (!card) return;
      input.value = t(card.dataset.prompt);
      this.autoResize();
      this.updateSendState();
      input.focus();
    });

    $("#message-list").addEventListener("click", (event) => this.handleAction(event));

    const scroller = $("#messages");
    scroller.addEventListener("scroll", () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      this.autoScroll = distance < 80;
      $("#scroll-bottom-btn").hidden = this.autoScroll || !this.messages.length;
      $(".chat-header").classList.toggle("scrolled", scroller.scrollTop > 4);
    }, { passive: true });

    $("#scroll-bottom-btn").addEventListener("click", () => this.scrollToBottom(true, true));
    $("#cancel-edit-btn").addEventListener("click", () => this.cancelEdit());
    $("#export-btn").addEventListener("click", (event) => Exporter.openMenu(event.currentTarget, this.currentId));

    document.addEventListener("languagechange", () => {
      this.updateGreeting();
      this.setStreaming(this.streaming);
      ModelSelector.render();
    });

    this.updateGreeting();
    this.updateSendState();
  },

  /* ------------------------------------------------------------------ */
  /* Estado general                                                      */
  /* ------------------------------------------------------------------ */
  reset() {
    this.stop();
    this.openToken += 1;
    this.currentId = null;
    this.messages = [];
    $("#message-list").innerHTML = "";
    this.cancelEdit(false);
    this.showEmpty(true);
    $("#chat-title").textContent = "PedusIA";
    Files.clear();
    Voice.stopSpeaking();
  },

  newConversation() {
    this.reset();
    Sidebar.setActive(null);
    if (location.hash) history.replaceState(null, "", location.pathname);
    Sidebar.closeMobile();
    $("#message-input").focus();
  },

  updateGreeting() {
    const name = (App.profile && App.profile.display_name) || "";
    $("#greeting-text").textContent = t("greeting", { name: name.split(" ")[0] || "👋" });
  },

  showEmpty(empty) {
    $("#empty-state").hidden = !empty;
    $("#export-btn").hidden = empty;
    $("#scroll-bottom-btn").hidden = true;
  },

  autoResize() {
    const input = $("#message-input");
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  },

  updateSendState() {
    const button = $("#send-btn");
    if (this.streaming) { button.disabled = false; return; }
    const hasText = $("#message-input").value.trim().length > 0;
    button.disabled = Files.uploading || (!hasText && !Files.pending);
  },

  setStreaming(streaming) {
    this.streaming = streaming;
    const button = $("#send-btn");
    button.classList.toggle("stop", streaming);
    button.innerHTML = streaming ? Icons.stop : Icons.send;
    button.title = t(streaming ? "stop" : "send");
    button.setAttribute("aria-label", button.title);
    document.title = streaming ? `PedusIA — ${t("writing_title")}` : `PedusIA — ${t("app_tagline")}`;
    this.updateSendState();
  },

  scrollToBottom(force = false, smooth = false) {
    if (!force && !this.autoScroll) return;
    const scroller = $("#messages");
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  },

  /* ------------------------------------------------------------------ */
  /* Abrir conversaciones                                                */
  /* ------------------------------------------------------------------ */
  async open(id) {
    if (!id || id === this.currentId) return;
    this.reset();
    const token = this.openToken;
    this.currentId = id;
    Sidebar.setActive(id);
    history.replaceState(null, "", `#/c/${id}`);
    const conv = Sidebar.find(id);
    $("#chat-title").textContent = (conv && conv.title) || t("new_chat");
    this.showEmpty(false);
    this.showSkeleton();

    try {
      const data = await api(`/conversations/${id}/messages`);
      if (token !== this.openToken) return; // el usuario cambió de conversación mientras cargaba
      $("#message-list").innerHTML = "";
      if (data.conversation && data.conversation.title) $("#chat-title").textContent = data.conversation.title;
      (data.messages || []).forEach((row) => this.appendMessage({ ...row }, { animate: false }));
      if (!this.messages.length) this.showEmpty(true);
      this.updateLastClass();
      requestAnimationFrame(() => this.scrollToBottom(true));
    } catch (error) {
      if (token !== this.openToken) return;
      if (error.status === 404) {
        Sidebar.remove(id);
        this.newConversation();
      } else {
        $("#message-list").innerHTML = "";
        toast(t("error_load"), "error");
      }
    }
  },

  openFromHash() {
    const match = location.hash.match(/^#\/c\/([0-9a-f-]{36})$/i);
    if (match && Sidebar.find(match[1])) this.open(match[1]);
  },

  showSkeleton() {
    const list = $("#message-list");
    list.innerHTML = "";
    for (let i = 0; i < 3; i += 1) {
      const user = document.createElement("div");
      user.className = "skeleton skeleton-bubble-user";
      const ai = document.createElement("div");
      ai.className = "skeleton-message";
      ai.innerHTML = '<div class="skeleton skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton skeleton-line" style="width:92%"></div><div class="skeleton skeleton-line" style="width:76%"></div><div class="skeleton skeleton-line" style="width:54%"></div></div>';
      list.append(user, ai);
    }
  },

  /* ------------------------------------------------------------------ */
  /* Renderizado de mensajes                                             */
  /* ------------------------------------------------------------------ */
  actionButton(action, icon, labelKey) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn";
    button.dataset.action = action;
    button.title = t(labelKey);
    button.setAttribute("aria-label", t(labelKey));
    button.innerHTML = Icons[icon];
    return button;
  },

  buildAttachment(msg) {
    if (!msg.file_url) return null;
    const wrap = document.createElement("div");
    wrap.className = "message-attachment";
    const safeUrl = /^https:\/\//i.test(msg.file_url) || msg.file_url.startsWith("blob:") ? msg.file_url : "";
    if ((msg.file_type || "").startsWith("image/") && safeUrl) {
      const img = document.createElement("img");
      img.src = safeUrl;
      img.alt = msg.file_name || "";
      img.loading = "lazy";
      img.addEventListener("click", () => window.open(safeUrl, "_blank", "noopener"));
      wrap.appendChild(img);
    } else {
      const chip = document.createElement("a");
      chip.className = "file-chip";
      if (safeUrl) { chip.href = safeUrl; chip.target = "_blank"; chip.rel = "noopener noreferrer"; }
      chip.innerHTML = Icons.file;
      const name = document.createElement("span");
      name.textContent = msg.file_name || "archivo";
      chip.appendChild(name);
      wrap.appendChild(chip);
    }
    return wrap;
  },

  createMessageElement(msg, { typing = false } = {}) {
    const el = document.createElement("div");
    el.className = `message message-${msg.role === "user" ? "user" : "ai"}`;
    const body = document.createElement("div");
    body.className = "message-body";
    const actions = document.createElement("div");
    actions.className = "message-actions";

    if (msg.role === "user") {
      const attachment = this.buildAttachment(msg);
      if (attachment) body.appendChild(attachment);
      if (msg.content) {
        const bubble = document.createElement("div");
        bubble.className = "bubble bubble-user";
        bubble.textContent = msg.content; // texto plano: nunca HTML del usuario
        body.appendChild(bubble);
        msg.contentEl = bubble;
      }
      actions.append(this.actionButton("copy", "copy", "copy"), this.actionButton("edit", "edit", "edit"));
    } else {
      const avatar = document.createElement("img");
      avatar.className = "message-avatar";
      avatar.src = "/assets/logo.png";
      avatar.alt = "PedusGPT";
      el.appendChild(avatar);

      const bubble = document.createElement("div");
      bubble.className = "bubble bubble-ai";
      const content = document.createElement("div");
      content.className = "markdown";
      if (typing) {
        content.innerHTML = `<div class="typing"><span class="typing-dots"><span></span><span></span><span></span></span><span>${escapeHtml(t("thinking"))}</span></div>`;
      } else {
        Markdown.render(content, msg.content);
      }
      bubble.appendChild(content);
      body.appendChild(bubble);
      msg.contentEl = content;
      msg.bubbleEl = bubble;

      const like = this.actionButton("like", "thumbsUp", "like");
      const dislike = this.actionButton("dislike", "thumbsDown", "dislike");
      if (msg.liked === true) like.classList.add("liked");
      if (msg.liked === false) dislike.classList.add("disliked");
      actions.append(
        this.actionButton("copy", "copy", "copy"),
        this.actionButton("regenerate", "refresh", "regenerate"),
        like,
        dislike,
        this.actionButton("speak", "volume", "listen"),
      );
      if (typing) actions.hidden = true;
    }
    body.appendChild(actions);
    msg.actionsEl = actions;
    el.appendChild(body);
    if (msg.id) el.dataset.id = msg.id;
    return el;
  },

  appendMessage(msg, { animate = true, typing = false } = {}) {
    const el = this.createMessageElement(msg, { typing });
    if (animate) el.classList.add("message-enter");
    msg.el = el;
    this.messages.push(msg);
    $("#message-list").appendChild(el);
    this.updateLastClass();
    return msg;
  },

  removeMessage(msg) {
    if (!msg) return;
    const index = this.messages.indexOf(msg);
    if (index >= 0) this.messages.splice(index, 1);
    if (msg.el) msg.el.remove();
    this.updateLastClass();
  },

  /** Solo el último mensaje de la IA muestra "Regenerar" y acciones visibles */
  updateLastClass() {
    const lastAi = [...this.messages].reverse().find((m) => m.role === "assistant");
    this.messages.forEach((m) => {
      if (!m.el) return;
      m.el.classList.toggle("last", m === lastAi && m === this.messages[this.messages.length - 1]);
      const regen = m.el.querySelector('[data-action="regenerate"]');
      if (regen) regen.hidden = m !== this.messages[this.messages.length - 1];
    });
  },

  findMessage(el) {
    return this.messages.find((m) => m.el === el);
  },

  /** Asigna ids reales a los mensajes que aún no los tienen */
  async syncIds() {
    if (!this.currentId) return;
    try {
      const data = await api(`/conversations/${this.currentId}/messages`);
      const rows = data.messages || [];
      if (rows.length !== this.messages.length) return;
      rows.forEach((row, index) => {
        const msg = this.messages[index];
        if (msg.role === row.role) {
          msg.id = row.id;
          if (msg.el) msg.el.dataset.id = row.id;
        }
      });
    } catch (_) { /* silencioso */ }
  },

  /* ------------------------------------------------------------------ */
  /* Enviar                                                              */
  /* ------------------------------------------------------------------ */
  async send() {
    if (this.streaming || Files.uploading) return;
    const input = $("#message-input");
    const text = input.value.trim();
    const file = Files.pending;
    if (!text && !file) return;

    if (ModelSelector.selected === ULTRA_MODEL && !App.hasUltra) {
      Settings.openPlanModal();
      return;
    }

    // Edición: borrar el mensaje editado y todo lo posterior
    if (this.editing) {
      const target = this.editing.message;
      try {
        if (!target.id) await this.syncIds();
        if (target.id) {
          await api(`/conversations/${this.currentId}/messages?from_id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
        }
      } catch (error) {
        toast(errorMessage(error), "error");
        return;
      }
      const index = this.messages.indexOf(target);
      if (index >= 0) this.messages.splice(index).forEach((m) => m.el && m.el.remove());
      this.cancelEdit(false);
    }

    // Crear la conversación si es nueva
    let isFirst = this.messages.length === 0;
    if (!this.currentId) {
      try {
        const conv = await api("/conversations", { method: "POST", body: { model: ModelSelector.selected } });
        this.currentId = conv.id;
        Sidebar.upsert(conv);
        Sidebar.setActive(conv.id);
        history.replaceState(null, "", `#/c/${conv.id}`);
        $("#chat-title").textContent = conv.title || t("new_chat");
        isFirst = true;
      } catch (error) {
        toast(errorMessage(error), "error");
        return;
      }
    }

    const userMsg = {
      id: null,
      role: "user",
      content: text,
      file_url: file ? file.file_url : null,
      file_type: file ? file.file_type : null,
      file_name: file ? file.file_name : null,
    };
    this.showEmpty(false);
    this.appendMessage(userMsg);
    input.value = "";
    this.autoResize();
    Files.clear();
    this.autoScroll = true;
    this.scrollToBottom(true);

    const conversationId = this.currentId;
    const ok = await this.stream({
      message: text,
      fileIds: file ? [file.id] : [],
      userMsg,
      restore: { text, file },
    });
    if (ok && isFirst) this.generateTitle(conversationId, text || (file && file.file_name) || "");
  },

  stop() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  },

  /**
   * Envía la petición de streaming y va pintando la respuesta.
   * Devuelve true si se llegó a recibir respuesta.
   */
  async stream({ message = "", fileIds = [], regenerate = false, userMsg = null, restore = null, restoreMessage = null }) {
    const conversationId = this.currentId;
    const model = ModelSelector.selected;
    const aiMsg = this.appendMessage({ id: null, role: "assistant", content: "", liked: null }, { typing: true });
    this.scrollToBottom(true);
    this.setStreaming(true);
    const controller = new AbortController();
    this.abortController = controller;

    let response;
    try {
      response = await api("/chat/stream", {
        method: "POST",
        body: { conversation_id: conversationId, message, model, files: fileIds, regenerate },
        raw: true,
        signal: controller.signal,
      });
    } catch (error) {
      this.setStreaming(false);
      this.abortController = null;
      // El usuario cambió de conversación mientras tanto: no tocar la UI nueva
      if (conversationId !== this.currentId) return false;
      this.removeMessage(aiMsg);
      if (error.name === "AbortError") {
        if (restoreMessage) this.appendMessage(restoreMessage, { animate: false });
        return false;
      }
      // El backend rechazó la petición antes de guardar nada: deshacer en la UI
      if (userMsg) {
        this.removeMessage(userMsg);
        if (restore) {
          $("#message-input").value = restore.text;
          this.autoResize();
          if (restore.file) Files.setPending(restore.file);
        }
        if (!this.messages.length) this.showEmpty(true);
      }
      if (restoreMessage) this.appendMessage(restoreMessage, { animate: false });
      this.handleRequestError(error);
      return false;
    }

    let aborted = false;
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
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = rawEvent.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch (_) { continue; }
          this.handleStreamEvent(event, aiMsg, userMsg);
        }
      }
    } catch (error) {
      if (error.name === "AbortError") aborted = true;
      else if (!aiMsg.errorMessage) aiMsg.errorMessage = t("error_network");
    } finally {
      this.setStreaming(false);
      if (this.abortController === controller) this.abortController = null;
    }

    // Si el usuario cambió de conversación mientras tanto, no tocar la UI
    if (conversationId !== this.currentId) return true;

    this.finalizeAiMessage(aiMsg);
    if (aborted && aiMsg.content) setTimeout(() => this.syncIds(), 1200);
    if (aiMsg.errorMessage) toast(aiMsg.errorMessage, "error");
    Sidebar.touch(conversationId);
    return true;
  },

  handleStreamEvent(event, aiMsg, userMsg) {
    switch (event.type) {
      case "start":
        if (userMsg && event.user_message_id) {
          userMsg.id = event.user_message_id;
          if (userMsg.el) userMsg.el.dataset.id = userMsg.id;
        }
        if (event.ultra && App.profile) {
          App.profile.ultra = { ...App.profile.ultra, ...event.ultra };
          const remaining = event.ultra.remaining;
          if (typeof remaining === "number" && remaining <= 5) {
            toast(t("ultra_remaining", { n: remaining }), "warning", 4000);
          }
        }
        break;
      case "token":
        aiMsg.content += event.content || "";
        this.scheduleRender(aiMsg);
        break;
      case "done":
        if (event.message_id) {
          aiMsg.id = event.message_id;
          aiMsg.el.dataset.id = aiMsg.id;
        }
        break;
      case "error":
        if (event.message_id) {
          aiMsg.id = event.message_id;
          aiMsg.el.dataset.id = aiMsg.id;
        }
        aiMsg.errorMessage = event.status === 429 ? t("rate_limit_general") : t("error_generic");
        break;
      default:
        break; // "thinking": el indicador de escritura ya está visible
    }
  },

  /** Repinta el markdown como mucho una vez por frame */
  scheduleRender(aiMsg) {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      if (!aiMsg.contentEl || !aiMsg.content) return;
      Markdown.render(aiMsg.contentEl, aiMsg.content, { streaming: true });
      this.scrollToBottom();
    });
  },

  finalizeAiMessage(aiMsg) {
    this.renderPending = false;
    if (!aiMsg.content) {
      if (aiMsg.errorMessage) {
        aiMsg.bubbleEl.classList.add("error");
        aiMsg.contentEl.textContent = aiMsg.errorMessage;
        aiMsg.actionsEl.hidden = false;
        $$('[data-action]:not([data-action="regenerate"])', aiMsg.actionsEl).forEach((b) => { b.hidden = true; });
        aiMsg.failed = true;
      } else {
        this.removeMessage(aiMsg);
      }
    } else {
      Markdown.render(aiMsg.contentEl, aiMsg.content);
      aiMsg.actionsEl.hidden = false;
    }
    this.updateLastClass();
    this.scrollToBottom();
  },

  handleRequestError(error) {
    const limit = (App.config && App.config.ultra_daily_limit) || 30;
    if (error.code === "rate_limit") {
      if (App.profile && App.profile.ultra) {
        App.profile.ultra.remaining = 0;
        App.profile.ultra.used = App.profile.ultra.limit;
      }
      dialog({
        icon: "⏳",
        title: t("rate_limit_title"),
        text: t("rate_limit_text", { limit }),
        confirmText: t("understood"),
        hideCancel: true,
      });
      return;
    }
    if (error.code === "needs_max") {
      Settings.openPlanModal();
      return;
    }
    if (error.code === "banned" || error.status === 401) return;
    toast(errorMessage(error), "error");
  },

  async generateTitle(conversationId, text) {
    if (!text) return;
    try {
      const { title } = await api("/chat/title", {
        method: "POST",
        body: { message: text.slice(0, 1500), conversation_id: conversationId },
      });
      Sidebar.updateTitle(conversationId, title);
      if (conversationId === this.currentId) $("#chat-title").textContent = title;
    } catch (_) { /* el título por defecto se queda */ }
  },

  /* ------------------------------------------------------------------ */
  /* Acciones sobre mensajes                                             */
  /* ------------------------------------------------------------------ */
  async handleAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    if (action === "copy-code") {
      const code = button.closest(".code-block").querySelector("code");
      if (await copyToClipboard(code.innerText)) {
        const label = button.querySelector("span");
        button.classList.add("copied");
        label.textContent = t("copied");
        setTimeout(() => { button.classList.remove("copied"); label.textContent = t("copy_code"); }, 2000);
      }
      return;
    }

    const msg = this.findMessage(button.closest(".message"));
    if (!msg) return;

    switch (action) {
      case "copy":
        if (await copyToClipboard(msg.content || msg.file_name || "")) {
          toast(t("copied"), "success", 2000);
          button.innerHTML = Icons.check;
          setTimeout(() => { button.innerHTML = Icons.copy; }, 1500);
        }
        break;
      case "regenerate":
        this.regenerate();
        break;
      case "like":
      case "dislike":
        this.feedback(msg, action === "like", button);
        break;
      case "speak":
        Voice.toggleSpeak(msg.content, button);
        break;
      case "edit":
        this.startEdit(msg);
        break;
      default:
        break;
    }
  },

  async regenerate() {
    if (this.streaming || !this.currentId) return;
    if (ModelSelector.selected === ULTRA_MODEL && !App.hasUltra) { Settings.openPlanModal(); return; }
    const last = this.messages[this.messages.length - 1];
    let removed = null;
    if (last && last.role === "assistant") {
      removed = last.failed ? null : { ...last, el: null };
      this.removeMessage(last);
    }
    if (!this.messages.some((m) => m.role === "user")) return;
    await this.stream({ regenerate: true, restoreMessage: removed });
  },

  async feedback(msg, positive, button) {
    if (!msg.id) await this.syncIds();
    if (!msg.id) return;
    const value = positive ? (msg.liked === true ? null : true) : (msg.liked === false ? null : false);
    try {
      await api(`/messages/${msg.id}/feedback`, { method: "PATCH", body: { liked: value } });
      msg.liked = value;
      const like = msg.el.querySelector('[data-action="like"]');
      const dislike = msg.el.querySelector('[data-action="dislike"]');
      like.classList.toggle("liked", value === true);
      dislike.classList.toggle("disliked", value === false);
      button.classList.remove("pop");
      void button.offsetWidth; // reiniciar animación
      button.classList.add("pop");
      if (value !== null) toast(t("feedback_thanks"), "success", 2000);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  startEdit(msg) {
    if (this.streaming) return;
    this.editing = { message: msg };
    const input = $("#message-input");
    input.value = msg.content || "";
    $("#edit-bar").hidden = false;
    this.messages.forEach((m) => m.el && m.el.classList.toggle("editing-target", m === msg));
    this.autoResize();
    this.updateSendState();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  },

  cancelEdit(clearInput = true) {
    if (!this.editing) { $("#edit-bar").hidden = true; return; }
    this.editing = null;
    $("#edit-bar").hidden = true;
    if (clearInput) {
      $("#message-input").value = "";
      this.autoResize();
    }
    this.updateSendState();
  },
};
