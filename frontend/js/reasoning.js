/* =====================================================================
   PedusGPT — Modo pensar y nivel de esfuerzo
   - Botón del compositor: clic = activar/desactivar, flecha = elegir esfuerzo
   - Bloque "Pensando…" en directo dentro de la respuesta, plegable
     ("Pensó durante X s"), con las fases de UltraMAX
   ===================================================================== */

const EFFORTS = [
  { id: "low", bars: 1 },
  { id: "medium", bars: 2 },
  { id: "high", bars: 3 },
  { id: "ultra", bars: 4, max: true },
  { id: "ultramax", bars: 5, max: true },
];

const PHASE_RE = /⟦phase:(draft|review|final)⟧/;
const PHASE_ICONS = { draft: "📝", review: "🔍", final: "✨" };

const Reasoning = {
  think: true,
  effort: "medium",

  init() {
    this.think = localStorage.getItem("pedus_think") !== "0";
    const saved = localStorage.getItem("pedus_effort");
    if (EFFORTS.some((e) => e.id === saved)) this.effort = saved;

    const toggle = $("#think-btn");
    const menu = $("#effort-btn");
    if (toggle) toggle.addEventListener("click", () => this.toggle());
    if (menu) menu.addEventListener("click", (event) => this.openMenu(event.currentTarget));

    // Clic en la cabecera de un bloque de pensamiento: plegar / desplegar
    $("#message-list").addEventListener("click", (event) => {
      const head = event.target.closest(".think-head");
      if (!head) return;
      const block = head.closest(".think-block");
      const msg = Chat.messages.find((m) => m.thinkState && m.thinkState.el === block);
      if (msg) msg.thinkState.userToggled = true;
      this.setOpen(block, !block.classList.contains("open"));
    });

    document.addEventListener("languagechange", () => this.render());
    this.render();
  },

  /* ------------------------------------------------------------------ */
  /* Estado del compositor                                               */
  /* ------------------------------------------------------------------ */

  /** Esfuerzo efectivo: Ultra/UltraMAX solo con Plan MAX */
  get currentEffort() {
    const info = EFFORTS.find((e) => e.id === this.effort) || EFFORTS[1];
    if (info.max && !App.hasUltra) return "high";
    return info.id;
  },

  save() {
    localStorage.setItem("pedus_think", this.think ? "1" : "0");
    localStorage.setItem("pedus_effort", this.effort);
  },

  render() {
    const toggle = $("#think-btn");
    const group = $("#think-group");
    if (!toggle || !group) return;
    const effort = this.currentEffort;
    group.classList.toggle("on", this.think);
    group.classList.toggle("max-effort", this.think && (effort === "ultra" || effort === "ultramax"));
    toggle.setAttribute("aria-pressed", String(this.think));
    toggle.title = this.think ? t("think_on") : t("think_off");
    const label = $(".think-label-text", toggle);
    if (label) label.textContent = this.think ? t(`effort_${effort}`) : t("think_toggle");
    const menu = $("#effort-btn");
    if (menu) menu.title = t("effort_title");
  },

  toggle() {
    this.think = !this.think;
    this.save();
    this.render();
    toast(this.think ? t("think_on") : t("think_off"), "info", 1400);
  },

  select(id) {
    const info = EFFORTS.find((e) => e.id === id);
    if (!info) return;
    if (info.max && !App.hasUltra) {
      toast(t("effort_locked"), "info");
      Settings.openPlanModal();
      return;
    }
    this.effort = id;
    this.think = true;
    this.save();
    this.render();
    toast(t("effort_selected", { name: t(`effort_${id}`) }), "info", 1500);
  },

  /** Campos que se envían al backend */
  payload() {
    return { think: this.think, effort: this.think ? this.currentEffort : null };
  },

  usageLine() {
    const usage = App.profile && App.profile.ultramax;
    if (!usage || !App.hasUltra) return "";
    if (usage.unlimited) return t("ultramax_unlimited");
    const limit = usage.limit || (App.config && App.config.ultramax_daily_limit) || 10;
    return t("ultramax_usage", { used: usage.used || 0, limit });
  },

  openMenu(anchor) {
    const wrap = document.createElement("div");
    wrap.className = "effort-menu";

    // Interruptor del modo pensar
    const row = document.createElement("button");
    row.type = "button";
    row.className = "effort-switch-row";
    row.setAttribute("role", "menuitemcheckbox");
    row.setAttribute("aria-checked", String(this.think));
    row.innerHTML = `
      <span class="effort-switch-icon">${Icons.brain}</span>
      <span class="effort-switch-text"><span class="effort-switch-title"></span><span class="effort-switch-desc"></span></span>
      <span class="switch${this.think ? " on" : ""}" aria-hidden="true"><i></i></span>`;
    $(".effort-switch-title", row).textContent = t("think_title");
    $(".effort-switch-desc", row).textContent = t("think_desc");
    row.addEventListener("click", () => {
      Popover.close();
      this.toggle();
    });
    wrap.appendChild(row);

    const head = document.createElement("div");
    head.className = "effort-head";
    head.textContent = this.think ? t("effort_title") : t("effort_needs_think");
    wrap.appendChild(head);

    const current = this.currentEffort;
    EFFORTS.forEach((effort) => {
      const locked = effort.max && !App.hasUltra;
      const selected = this.think && effort.id === current;
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(selected));
      option.className = `effort-option${selected ? " selected" : ""}${locked ? " locked" : ""}${this.think ? "" : " dim"}${effort.max ? " max" : ""}`;
      option.dataset.effort = effort.id;
      const bars = Array.from({ length: 5 }, (_, i) => `<i class="${i < effort.bars ? "on" : ""}"></i>`).join("");
      option.innerHTML = `
        <span class="effort-bars" data-level="${effort.bars}">${bars}</span>
        <span class="effort-text">
          <span class="effort-name"><span class="effort-name-text"></span>${effort.max ? '<span class="badge badge-gold badge-xs">MAX</span>' : ""}${locked ? `<span class="model-lock">${Icons.lock}</span>` : ""}</span>
          <span class="effort-desc"></span>
        </span>
        <span class="model-check">${Icons.check}</span>`;
      $(".effort-name-text", option).textContent = t(`effort_${effort.id}`);
      let desc = locked ? t("effort_locked") : t(`effort_${effort.id}_desc`);
      if (effort.id === "ultramax" && !locked) {
        const usage = this.usageLine();
        if (usage) desc += ` · ${usage}`;
      }
      $(".effort-desc", option).textContent = desc;
      option.addEventListener("click", () => {
        Popover.close();
        this.select(effort.id);
      });
      wrap.appendChild(option);
    });
    Popover.open(anchor, wrap);
  },

  /* ------------------------------------------------------------------ */
  /* Bloque de pensamiento en los mensajes                               */
  /* ------------------------------------------------------------------ */

  formatDuration(ms) {
    const total = Math.max(1, Math.round((Number(ms) || 0) / 1000));
    if (total < 60) return t("time_s", { n: total });
    return t("time_min", { m: Math.floor(total / 60), s: total % 60 });
  },

  /** Crea el bloque (plegado para mensajes guardados, abierto y en directo al generar) */
  createBlock(msg, { live = false } = {}) {
    const block = document.createElement("div");
    block.className = `think-block${live ? " live open" : ""}`;
    if (msg.effort) block.dataset.effort = msg.effort;
    block.innerHTML = `
      <button type="button" class="think-head" aria-expanded="${live}">
        <span class="think-icon">${Icons.brain}</span>
        <span class="think-label"></span>
        <span class="think-effort"></span>
        <span class="think-chevron">${Icons.chevronDown}</span>
      </button>
      <div class="think-body-wrap"><div class="think-body"></div></div>`;
    const state = {
      el: block,
      labelEl: $(".think-label", block),
      bodyEl: $(".think-body", block),
      text: "",
      textNode: null,
      started: Date.now(),
      live,
      finished: !live,
      answerStarted: false,
      userToggled: false,
      timer: null,
      waiting: null,
    };
    if (msg.effort) $(".think-effort", block).textContent = t(`effort_${msg.effort}`);
    msg.thinkState = state;

    if (live) {
      this.updateLiveLabel(state);
      state.timer = setInterval(() => {
        if (!document.contains(block)) { clearInterval(state.timer); return; }
        this.updateLiveLabel(state);
      }, 1000);
    } else {
      state.text = msg.reasoning || "";
      this.renderBody(state);
      state.labelEl.textContent = msg.thinking_ms ? t("thought_for", { time: this.formatDuration(msg.thinking_ms) }) : t("thought");
    }
    return block;
  },

  /** Inserta el bloque en directo en la respuesta que se está generando */
  attachLive(msg, effort) {
    msg.effort = effort;
    const block = this.createBlock(msg, { live: true });
    msg.bubbleEl.insertBefore(block, msg.bubbleEl.firstChild);
    msg.bubbleEl.classList.add("has-think");
    msg.contentEl.innerHTML = "";
  },

  updateLiveLabel(state) {
    if (state.finished || state.answerStarted) return;
    const seconds = Math.floor((Date.now() - state.started) / 1000);
    let text = t("thinking_live");
    if (state.phase) text = `${PHASE_ICONS[state.phase]} ${t(`phase_${state.phase}`)}…`;
    if (state.waiting && state.waiting > Date.now()) {
      text = t("waiting_retry", { n: Math.ceil((state.waiting - Date.now()) / 1000) });
    }
    state.labelEl.textContent = seconds >= 1 ? `${text} ${t("time_s", { n: seconds })}` : text;
  },

  setOpen(block, open) {
    block.classList.toggle("open", open);
    const head = $(".think-head", block);
    if (head) head.setAttribute("aria-expanded", String(open));
  },

  /** Pinta todo el texto (con secciones por fase) */
  renderBody(state) {
    const body = state.bodyEl;
    body.innerHTML = "";
    state.textNode = null;
    const pieces = (state.text || "").split(PHASE_RE);
    // split con grupo: [texto, fase, texto, fase, texto...]
    this.appendText(state, pieces[0]);
    for (let i = 1; i < pieces.length; i += 2) {
      this.appendPhaseHeader(state, pieces[i]);
      this.appendText(state, (pieces[i + 1] || "").replace(/^\n+/, ""));
    }
    if (!(state.text || "").replace(PHASE_RE, "").trim() && state.finished) {
      const empty = document.createElement("p");
      empty.className = "think-empty";
      empty.textContent = t("think_empty");
      body.appendChild(empty);
    }
  },

  appendPhaseHeader(state, phase) {
    // Quitar los saltos de línea sobrantes al final del texto anterior
    if (state.textNode) {
      let node = state.textNode.lastChild;
      while (node && node.nodeType === 3) {
        node.nodeValue = node.nodeValue.replace(/\s+$/, "");
        if (node.nodeValue) break;
        const prev = node.previousSibling;
        node.remove();
        node = prev;
      }
      if (!state.textNode.textContent) state.textNode.remove();
    }
    const header = document.createElement("div");
    header.className = `think-phase think-phase-${phase}`;
    header.textContent = `${PHASE_ICONS[phase] || "•"} ${t(`phase_${phase}`)}`;
    state.bodyEl.appendChild(header);
    state.textNode = null;
  },

  appendText(state, text) {
    if (!text) return;
    if (!state.textNode) {
      const para = document.createElement("div");
      para.className = "think-text";
      state.bodyEl.appendChild(para);
      state.textNode = para;
      text = text.replace(/^\s+/, "");
      if (!text) return;
    }
    // Texto plano: nunca HTML del modelo
    state.textNode.appendChild(document.createTextNode(text));
  },

  /** Nuevo trozo de razonamiento en directo */
  append(msg, text) {
    const state = msg.thinkState;
    if (!state || !text) return;
    state.text += text;
    const body = state.bodyEl;
    const wrap = body.parentElement;
    const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
    this.appendText(state, text);
    if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
  },

  setPhase(msg, phase) {
    const state = msg.thinkState;
    if (!state) return;
    state.text += `\n\n⟦phase:${phase}⟧\n`;
    state.phase = phase;
    this.appendPhaseHeader(state, phase);
    this.updateLiveLabel(state);
    const wrap = state.bodyEl.parentElement;
    wrap.scrollTop = wrap.scrollHeight;
  },

  setWaiting(msg, seconds) {
    const state = msg.thinkState;
    const until = Date.now() + Math.max(1, Number(seconds) || 1) * 1000;
    if (state) {
      state.waiting = until;
      this.updateLiveLabel(state);
      return;
    }
    // Sin modo pensar: mostrarlo en el indicador de escritura
    const typing = msg.contentEl && $(".typing span:last-child", msg.contentEl);
    if (typing) typing.textContent = t("waiting_retry", { n: Math.ceil(seconds) });
  },

  /** Empieza la respuesta: se pliega el razonamiento (salvo que el usuario lo abriera) */
  answerStarted(msg) {
    const state = msg.thinkState;
    if (!state || state.answerStarted) return;
    state.answerStarted = true;
    state.answerAt = Date.now();
    clearInterval(state.timer);
    state.el.classList.remove("live");
    state.labelEl.textContent = t("thought_for", { time: this.formatDuration(state.answerAt - state.started) });
    if (!state.userToggled) this.setOpen(state.el, false);
  },

  /** Fin de la generación (o detenida) */
  finish(msg, { thinkingMs = null, stopped = false } = {}) {
    const state = msg.thinkState;
    if (!state || state.finished) return;
    state.finished = true;
    clearInterval(state.timer);
    state.el.classList.remove("live");
    const elapsed = thinkingMs || (state.answerAt || Date.now()) - state.started;
    msg.reasoning = state.text;
    msg.thinking_ms = elapsed;
    if (stopped && !state.answerStarted) {
      state.labelEl.textContent = t("thought_stopped", { time: this.formatDuration(elapsed) });
    } else {
      state.labelEl.textContent = t("thought_for", { time: this.formatDuration(elapsed) });
    }
    if (!state.text.replace(PHASE_RE, "").trim()) this.renderBody(state);
    if (!state.userToggled && state.answerStarted) this.setOpen(state.el, false);
  },
};
