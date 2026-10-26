/* =====================================================================
   PedusGPT — Skills (instrucciones especializadas, Plan MAX)
   - Botón del compositor: elegir hasta 3 skills o dejar que la IA elija
   - Escribe "/" para buscar una skill por su identificador
   - Modal: lista, editor y búsqueda / importación desde GitHub
   ===================================================================== */

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SKILL_MAX_SELECTED = 3;
const SKILL_RESOURCE_MAX = 15000;
const SKILL_RESOURCE_COUNT = 10;

/** Crea un elemento con atributos e hijos (texto siempre como textContent) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "html") el.innerHTML = value; // solo para iconos SVG propios
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  });
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return el;
}

/** Convierte un título en identificador: "Profe de Mates" -> "profe-de-mates" */
function skillSlug(text) {
  return String(text || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 40).replace(/-+$/, "");
}

/** Lee un SKILL.md (cabecera YAML sencilla + instrucciones) */
function parseSkillMarkdown(text, fallbackName = "") {
  const source = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const meta = {};
  let body = source;
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match) {
    body = source.slice(match[0].length);
    let key = null;
    match[1].split("\n").forEach((line) => {
      const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (pair) {
        key = pair[1].toLowerCase();
        meta[key] = pair[2].replace(/^[>|][+-]?\s*$/, "").replace(/^["']|["']$/g, "").trim();
      } else if (key && /^\s+\S/.test(line) && ["description", "title"].includes(key)) {
        meta[key] = `${meta[key]} ${line.trim()}`.trim();
      }
    });
  }
  body = body.trim();
  const heading = body.match(/^#\s+(.+)$/m);
  const name = skillSlug(meta.name || fallbackName || (heading && heading[1]) || "skill");
  const title = (meta.title || (heading && heading[1]) || name.replace(/-/g, " ")).slice(0, 60);
  return {
    name,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    emoji: meta.emoji || "🧩",
    description: (meta.description || "").slice(0, 500),
    instructions: body.slice(0, 30000),
  };
}

const Skills = {
  list: [],
  loaded: false,
  loading: null,
  limit: 20,
  hasAccess: false,
  schemaOutdated: false,
  selected: [],
  auto: true,
  view: "list",
  draft: null,
  github: { url: "", preview: null, picked: new Set(), busy: false },
  suggest: { open: false, items: [], index: 0 },

  init() {
    this.auto = localStorage.getItem("pedus_auto_skills") !== "0";
    const button = $("#skills-btn");
    if (button) button.addEventListener("click", (event) => this.openPicker(event.currentTarget));
    $("#skill-chips").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-skill]");
      if (remove) this.toggleSelect(remove.dataset.removeSkill, false);
    });
    $("#skill-suggest").addEventListener("mousedown", (event) => {
      const item = event.target.closest("[data-skill-id]");
      if (!item) return;
      event.preventDefault();
      this.pickSuggestion(item.dataset.skillId);
    });
    document.addEventListener("languagechange", () => {
      this.renderButton();
      this.renderChips();
      if (Modal.isOpen("skills-modal")) this.renderModal();
    });
    this.renderButton();
  },

  /** Llamado al cargar el perfil: precarga la lista si el usuario tiene acceso */
  renderAccess() {
    this.renderButton();
    if (App.hasUltra && !this.loaded && !this.loading) this.refresh().catch(() => {});
  },

  async refresh() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const data = await api("/skills");
        this.list = data.skills || [];
        this.limit = data.limit || this.limit;
        this.hasAccess = !!data.has_access;
        this.schemaOutdated = !!data.schema_outdated;
        this.loaded = true;
        const ids = new Set(this.list.filter((s) => s.enabled).map((s) => s.id));
        this.selected = this.selected.filter((id) => ids.has(id));
      } finally {
        this.loading = null;
        this.renderButton();
        this.renderChips();
      }
      return this.list;
    })();
    return this.loading;
  },

  get enabledSkills() {
    return this.list.filter((s) => s.enabled);
  },

  find(id) {
    return this.list.find((s) => s.id === id);
  },

  /* ------------------------------------------------------------------ */
  /* Compositor                                                          */
  /* ------------------------------------------------------------------ */

  renderButton() {
    const button = $("#skills-btn");
    if (!button) return;
    const count = this.selected.length;
    const autoOn = App.hasUltra && this.auto && this.enabledSkills.some((s) => s.auto);
    button.classList.toggle("active", count > 0);
    button.classList.toggle("auto-on", !count && autoOn);
    button.title = t("skills");
    const badge = $(".skills-badge", button);
    if (badge) {
      badge.hidden = !count;
      badge.textContent = String(count);
    }
  },

  renderChips() {
    const wrap = $("#skill-chips");
    if (!wrap) return;
    wrap.innerHTML = "";
    const skills = this.selected.map((id) => this.find(id)).filter(Boolean);
    wrap.hidden = !skills.length;
    skills.forEach((skill) => {
      wrap.appendChild(h("span", { class: "skill-chip" },
        h("span", { class: "skill-chip-emoji", text: skill.emoji || "🧩" }),
        h("span", { class: "skill-chip-name", text: skill.title }),
        h("button", { type: "button", class: "skill-chip-remove", "data-remove-skill": skill.id, "aria-label": t("skill_remove"), title: t("skill_remove"), html: Icons.x })));
    });
  },

  toggleSelect(id, value) {
    const isSelected = this.selected.includes(id);
    const next = value === undefined ? !isSelected : value;
    if (next && !isSelected) {
      if (this.selected.length >= SKILL_MAX_SELECTED) {
        toast(t("skills_max_selected"), "info");
        return false;
      }
      this.selected.push(id);
    } else if (!next) {
      this.selected = this.selected.filter((item) => item !== id);
    }
    this.renderButton();
    this.renderChips();
    return true;
  },

  setAuto(value) {
    this.auto = value;
    localStorage.setItem("pedus_auto_skills", value ? "1" : "0");
    this.renderButton();
  },

  /** Al cambiar o crear conversación se quitan las skills elegidas a mano */
  resetSelection() {
    this.selected = [];
    this.hideSuggest();
    this.renderButton();
    this.renderChips();
  },

  payload() {
    if (!App.hasUltra) return { skill_ids: [], auto_skills: false };
    return { skill_ids: this.selected.slice(0, SKILL_MAX_SELECTED), auto_skills: this.auto };
  },

  async openPicker(anchor) {
    const wrap = h("div", { class: "skills-menu" });
    if (!App.hasUltra) {
      wrap.append(
        h("div", { class: "skills-locked" },
          h("div", { class: "skills-locked-icon", html: Icons.puzzle }),
          h("strong", { text: t("skills_locked_title") }),
          h("p", { text: t("skills_locked_text") }),
          h("button", { type: "button", class: "btn btn-gold btn-sm", text: t("see_plan"), onclick: () => { Popover.close(); Settings.openPlanModal(); } })),
      );
      Popover.open(anchor, wrap);
      return;
    }
    if (!this.loaded) {
      wrap.appendChild(h("div", { class: "skills-menu-loading", text: t("loading") }));
      Popover.open(anchor, wrap);
      try { await this.refresh(); } catch (_) { toast(t("error_load"), "error"); Popover.close(); return; }
      if (!Popover.current || !Popover.current.pop.contains(wrap)) return;
      Popover.close();
      this.openPicker(anchor);
      return;
    }

    const autoRow = h("button", { type: "button", class: "effort-switch-row", role: "menuitemcheckbox", "aria-checked": String(this.auto) },
      h("span", { class: "effort-switch-icon", html: Icons.sparkles }),
      h("span", { class: "effort-switch-text" },
        h("span", { class: "effort-switch-title", text: t("skills_auto") }),
        h("span", { class: "effort-switch-desc", text: t("skills_auto_desc") })),
      h("span", { class: `switch${this.auto ? " on" : ""}`, "aria-hidden": "true" }, h("i")));
    autoRow.addEventListener("click", () => {
      this.setAuto(!this.auto);
      autoRow.setAttribute("aria-checked", String(this.auto));
      $(".switch", autoRow).classList.toggle("on", this.auto);
    });
    wrap.appendChild(autoRow);

    const skills = this.enabledSkills;
    wrap.appendChild(h("div", { class: "effort-head", text: skills.length ? t("skills_pick_hint") : t("skills_none") }));
    const list = h("div", { class: "skills-menu-list" });
    skills.forEach((skill) => {
      const checked = this.selected.includes(skill.id);
      const item = h("button", { type: "button", class: `skills-menu-item${checked ? " selected" : ""}`, role: "menuitemcheckbox", "aria-checked": String(checked) },
        h("span", { class: "skills-menu-emoji", text: skill.emoji || "🧩" }),
        h("span", { class: "skills-menu-text" },
          h("span", { class: "skills-menu-name", text: skill.title }),
          h("span", { class: "skills-menu-desc", text: skill.description || `/${skill.name}` })),
        h("span", { class: "skills-check", html: Icons.check }));
      item.addEventListener("click", () => {
        if (this.toggleSelect(skill.id)) {
          const on = this.selected.includes(skill.id);
          item.classList.toggle("selected", on);
          item.setAttribute("aria-checked", String(on));
        }
      });
      list.appendChild(item);
    });
    wrap.appendChild(list);
    wrap.appendChild(h("div", { class: "skills-menu-footer" },
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { Popover.close(); this.openModal("edit"); } },
        h("span", { html: Icons.plus }), h("span", { text: t("skill_new") })),
      h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => { Popover.close(); this.openModal("list"); } },
        h("span", { text: t("skills_manage") }))));
    Popover.open(anchor, wrap);
  },

  /* ------------------------------------------------------------------ */
  /* Sugerencias al escribir "/"                                         */
  /* ------------------------------------------------------------------ */

  handleInput() {
    const input = $("#message-input");
    const match = input.value.match(/^\/([a-z0-9-]*)$/i);
    if (!match || !App.hasUltra) { this.hideSuggest(); return; }
    if (!this.loaded) {
      this.refresh().then(() => this.handleInput()).catch(() => {});
      return;
    }
    const query = match[1].toLowerCase();
    const items = this.enabledSkills
      .filter((s) => !query || s.name.includes(query) || s.title.toLowerCase().includes(query))
      .slice(0, 8);
    this.suggest.items = items;
    this.suggest.index = 0;
    this.renderSuggest(query);
  },

  renderSuggest() {
    const box = $("#skill-suggest");
    box.innerHTML = "";
    if (!this.suggest.items.length) {
      box.appendChild(h("div", { class: "skill-suggest-empty", text: this.enabledSkills.length ? t("skills_suggest_empty") : t("skills_none") }));
    }
    this.suggest.items.forEach((skill, index) => {
      const selected = this.selected.includes(skill.id);
      box.appendChild(h("div", { class: `skill-suggest-item${index === this.suggest.index ? " active" : ""}`, role: "option", "data-skill-id": skill.id, "aria-selected": String(index === this.suggest.index) },
        h("span", { class: "skills-menu-emoji", text: skill.emoji || "🧩" }),
        h("span", { class: "skill-suggest-name", text: `/${skill.name}` }),
        h("span", { class: "skill-suggest-desc", text: skill.title }),
        selected ? h("span", { class: "skills-check", html: Icons.check }) : null));
    });
    box.hidden = false;
    this.suggest.open = true;
  },

  hideSuggest() {
    const box = $("#skill-suggest");
    if (box) box.hidden = true;
    this.suggest.open = false;
  },

  pickSuggestion(id) {
    const input = $("#message-input");
    if (!this.selected.includes(id)) this.toggleSelect(id, true);
    input.value = "";
    this.hideSuggest();
    Chat.autoResize();
    Chat.updateSendState();
    input.focus();
  },

  /** Teclas dentro de las sugerencias. Devuelve true si se ha gestionado. */
  handleKeydown(event) {
    if (!this.suggest.open) return false;
    const items = this.suggest.items;
    if (event.key === "Escape") {
      event.preventDefault();
      this.hideSuggest();
      return true;
    }
    if (!items.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.suggest.index = (this.suggest.index + delta + items.length) % items.length;
      this.renderSuggest();
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      this.pickSuggestion(items[this.suggest.index].id);
      return true;
    }
    return false;
  },

  /** Skills usadas en una respuesta (fila encima del texto) */
  renderUsed(msg, skills, auto = false) {
    if (!msg.bubbleEl || !skills || !skills.length) return;
    let row = $(".skills-used", msg.bubbleEl);
    if (!row) {
      row = h("div", { class: "skills-used" });
      const think = $(".think-block", msg.bubbleEl);
      msg.bubbleEl.insertBefore(row, think ? think.nextSibling : msg.bubbleEl.firstChild);
    }
    row.innerHTML = "";
    row.appendChild(h("span", { class: "skills-used-icon", html: Icons.puzzle }));
    skills.forEach((skill) => {
      row.appendChild(h("span", { class: "skills-used-chip", title: `/${skill.name}` },
        h("span", { text: skill.emoji || "🧩" }), h("span", { text: skill.title || skill.name })));
    });
    if (auto) row.appendChild(h("span", { class: "skills-used-auto", text: t("skill_auto_tag") }));
    msg.skills = skills;
  },

  setRouting(msg, active) {
    if (!msg.bubbleEl) return;
    let row = $(".skills-routing", msg.bubbleEl);
    if (!active) { if (row) row.remove(); return; }
    if (!row) {
      row = h("div", { class: "skills-routing" }, h("span", { class: "skills-used-icon", html: Icons.puzzle }), h("span", { text: t("skills_routing") }));
      msg.bubbleEl.insertBefore(row, msg.bubbleEl.firstChild);
    }
  },

  /* ------------------------------------------------------------------ */
  /* Modal                                                               */
  /* ------------------------------------------------------------------ */

  async openModal(view = "list", skill = null) {
    this.view = view;
    this.draft = view === "edit" ? this.emptyDraft(skill) : null;
    Modal.open("skills-modal");
    this.renderModal();
    if (App.hasUltra && !this.loaded) {
      try { await this.refresh(); } catch (_) { toast(t("error_load"), "error"); }
      this.renderModal();
    }
  },

  emptyDraft(skill) {
    if (skill) return { ...skill, resources: (skill.resources || []).map((r) => ({ ...r })), nameTouched: true };
    return { id: null, title: "", name: "", emoji: "🧩", description: "", instructions: "", resources: [], enabled: true, auto: true, nameTouched: false };
  },

  setView(view, skill = null) {
    this.view = view;
    if (view === "edit") this.draft = this.emptyDraft(skill);
    this.renderModal();
  },

  renderModal() {
    const body = $("#skills-modal-body");
    if (!body) return;
    body.innerHTML = "";
    const count = $("#skills-count");
    if (count) count.textContent = App.hasUltra && this.loaded ? `${this.list.length}/${this.limit}` : "";
    if (!App.hasUltra) {
      body.appendChild(h("div", { class: "skills-locked skills-locked-lg" },
        h("div", { class: "skills-locked-icon", html: Icons.puzzle }),
        h("strong", { text: t("skills_locked_title") }),
        h("p", { text: t("skills_locked_text") }),
        h("button", { type: "button", class: "btn btn-gold", text: t("see_plan"), onclick: () => { Modal.close("skills-modal"); Settings.openPlanModal(); } })));
      return;
    }
    if (this.schemaOutdated) body.appendChild(h("div", { class: "skills-warning", text: t("schema_outdated") }));
    if (this.view === "edit") body.appendChild(this.renderEditor());
    else if (this.view === "github") body.appendChild(this.renderGithub());
    else body.appendChild(this.renderList());
  },

  renderList() {
    const wrap = h("div", { class: "skills-view" });
    wrap.appendChild(h("p", { class: "muted small skills-subtitle", text: t("skills_subtitle") }));
    wrap.appendChild(h("div", { class: "skills-toolbar" },
      h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => this.setView("edit") },
        h("span", { html: Icons.plus }), h("span", { text: t("skill_new") })),
      h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => this.setView("github") },
        h("span", { html: Icons.github }), h("span", { text: t("skill_import_github") }))));

    if (!this.loaded) {
      wrap.appendChild(h("div", { class: "skills-empty", text: t("loading") }));
      return wrap;
    }
    if (!this.list.length) {
      wrap.appendChild(h("div", { class: "skills-empty" },
        h("div", { class: "skills-empty-icon", html: Icons.puzzle }),
        h("strong", { text: t("skills_none") }),
        h("p", { class: "muted small", text: t("skills_empty_text") })));
      return wrap;
    }
    const grid = h("div", { class: "skills-grid" });
    this.list.forEach((skill) => grid.appendChild(this.renderCard(skill)));
    wrap.appendChild(grid);
    return wrap;
  },

  renderCard(skill) {
    const switchEl = (field, label) => {
      const button = h("button", { type: "button", class: "skill-switch", role: "switch", "aria-checked": String(!!skill[field]), title: label },
        h("span", { class: `switch switch-sm${skill[field] ? " on" : ""}`, "aria-hidden": "true" }, h("i")),
        h("span", { text: label }));
      button.addEventListener("click", () => this.patch(skill, { [field]: !skill[field] }));
      return button;
    };
    const meta = [`/${skill.name}`];
    if (skill.uses) meta.push(t("skill_uses", { n: skill.uses }));
    return h("article", { class: `skill-card${skill.enabled ? "" : " disabled"}` },
      h("div", { class: "skill-card-head" },
        h("span", { class: "skill-card-emoji", text: skill.emoji || "🧩" }),
        h("div", { class: "skill-card-title" },
          h("strong", { text: skill.title }),
          h("span", { class: "skill-card-meta", text: meta.join(" · ") }),
          skill.source_url ? h("a", { class: "skill-card-source", href: skill.source_url, target: "_blank", rel: "noopener noreferrer" },
            h("span", { html: Icons.github }), h("span", { text: t("skill_from_github") })) : null),
        h("div", { class: "skill-card-actions" },
          h("button", { type: "button", class: "icon-btn", title: t("edit"), "aria-label": t("edit"), html: Icons.edit, onclick: () => this.edit(skill) }),
          h("button", { type: "button", class: "icon-btn", title: t("skill_export"), "aria-label": t("skill_export"), html: Icons.download, onclick: () => this.exportSkill(skill) }),
          h("button", { type: "button", class: "icon-btn danger", title: t("delete"), "aria-label": t("delete"), html: Icons.trash, onclick: () => this.remove(skill) }))),
      skill.description ? h("p", { class: "skill-card-desc", text: skill.description }) : null,
      h("div", { class: "skill-card-switches" }, switchEl("enabled", t("skill_enabled")), switchEl("auto", t("skill_auto_label"))));
  },

  async edit(skill) {
    try {
      const full = await api(`/skills/${skill.id}`);
      this.setView("edit", full);
    } catch (error) {
      toast(this.errorText(error), "error");
    }
  },

  async patch(skill, changes) {
    try {
      const updated = await api(`/skills/${skill.id}`, { method: "PATCH", body: changes });
      Object.assign(skill, updated);
      if (changes.enabled === false) this.toggleSelect(skill.id, false);
      this.renderModal();
      this.renderButton();
    } catch (error) {
      toast(this.errorText(error), "error");
    }
  },

  async remove(skill) {
    const ok = await dialog({ title: t("delete"), text: t("skill_delete_confirm", { name: skill.title }), confirmText: t("delete"), danger: true, icon: "🗑️" });
    if (!ok) return;
    try {
      await api(`/skills/${skill.id}`, { method: "DELETE" });
      this.list = this.list.filter((s) => s.id !== skill.id);
      this.toggleSelect(skill.id, false);
      this.renderModal();
      toast(t("skill_deleted"));
    } catch (error) {
      toast(this.errorText(error), "error");
    }
  },

  async exportSkill(skill) {
    try {
      const full = skill.instructions ? skill : await api(`/skills/${skill.id}`);
      const yaml = (value) => JSON.stringify(String(value || ""));
      const text = `---\nname: ${full.name}\ntitle: ${yaml(full.title)}\nemoji: ${yaml(full.emoji)}\ndescription: ${yaml(full.description)}\n---\n\n${full.instructions}\n`;
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = h("a", { href: url, download: `${full.name}-SKILL.md` });
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (error) {
      toast(this.errorText(error), "error");
    }
  },

  /* ---------------------------- Editor ------------------------------ */

  renderEditor() {
    const draft = this.draft;
    const form = h("form", { class: "skills-view skill-form", novalidate: true });
    const field = (labelKey, control, hintKey, full = true) => h("label", { class: `form-label${full ? " form-full" : ""}` },
      h("span", { text: t(labelKey) }), control, hintKey ? h("span", { class: "form-hint", text: t(hintKey) }) : null);

    const emoji = h("input", { type: "text", class: "input skill-emoji-input", maxlength: "8", value: draft.emoji || "🧩", "aria-label": t("skill_emoji_label") });
    const title = h("input", { type: "text", class: "input", maxlength: "60", required: true, value: draft.title || "" });
    const name = h("input", { type: "text", class: "input mono", maxlength: "40", value: draft.name || "", spellcheck: "false", autocomplete: "off" });
    const description = h("textarea", { class: "input", maxlength: "500", rows: "2", placeholder: t("skill_desc_ph") });
    description.value = draft.description || "";
    const instructions = h("textarea", { class: "input mono skill-instructions", maxlength: "30000", rows: "12", placeholder: t("skill_instr_ph") });
    instructions.value = draft.instructions || "";
    const counter = h("span", { class: "form-hint skill-counter", text: `${instructions.value.length}/30000` });

    title.addEventListener("input", () => {
      draft.title = title.value;
      if (!draft.nameTouched) { draft.name = skillSlug(title.value); name.value = draft.name; }
    });
    name.addEventListener("input", () => {
      draft.nameTouched = true;
      draft.name = name.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
      if (name.value !== draft.name) name.value = draft.name;
    });
    emoji.addEventListener("input", () => { draft.emoji = emoji.value; });
    description.addEventListener("input", () => { draft.description = description.value; });
    instructions.addEventListener("input", () => {
      draft.instructions = instructions.value;
      counter.textContent = `${instructions.value.length}/30000`;
    });

    // Cargar un SKILL.md local
    const mdInput = h("input", { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain", hidden: true });
    mdInput.addEventListener("change", async () => {
      const file = mdInput.files && mdInput.files[0];
      mdInput.value = "";
      if (!file) return;
      if (file.size > 120000) { toast(t("skill_file_invalid"), "error"); return; }
      try {
        const parsed = parseSkillMarkdown(await file.text(), file.name.replace(/\.(md|markdown|txt)$/i, "").replace(/^SKILL$/i, ""));
        Object.assign(draft, parsed, { nameTouched: true });
        this.renderModal();
      } catch (_) {
        toast(t("skill_file_invalid"), "error");
      }
    });

    // Archivos de referencia
    const resInput = h("input", { type: "file", multiple: true, accept: ".md,.txt,.csv,.json,.py,.js,.ts,.html,.css,.java,.c,.cpp,.yaml,.yml,text/*", hidden: true });
    const resList = h("ul", { class: "skill-resources" });
    const renderResources = () => {
      resList.innerHTML = "";
      draft.resources.forEach((res, index) => {
        resList.appendChild(h("li", {},
          h("span", { html: Icons.file }),
          h("span", { class: "skill-resource-name", text: res.path }),
          h("span", { class: "muted small", text: `${Math.ceil(res.content.length / 1000)} K` }),
          h("button", { type: "button", class: "icon-btn", "aria-label": t("skill_remove"), title: t("skill_remove"), html: Icons.x,
            onclick: () => { draft.resources.splice(index, 1); renderResources(); } })));
      });
    };
    resInput.addEventListener("change", async () => {
      const files = [...(resInput.files || [])];
      resInput.value = "";
      for (const file of files) {
        if (draft.resources.length >= SKILL_RESOURCE_COUNT) break;
        if (file.size > SKILL_RESOURCE_MAX * 2) { toast(`${file.name}: ${t("skill_file_invalid")}`, "error"); continue; }
        try {
          const content = (await file.text()).slice(0, SKILL_RESOURCE_MAX);
          if (content.includes("\u0000")) { toast(`${file.name}: ${t("skill_file_invalid")}`, "error"); continue; }
          const path = file.name.replace(/[^\w.\-]/g, "_").slice(0, 120);
          draft.resources = draft.resources.filter((r) => r.path !== path);
          draft.resources.push({ path, content });
        } catch (_) {
          toast(`${file.name}: ${t("skill_file_invalid")}`, "error");
        }
      }
      renderResources();
    });
    renderResources();

    const autoSwitch = h("button", { type: "button", class: "skill-switch", role: "switch", "aria-checked": String(!!draft.auto) },
      h("span", { class: `switch switch-sm${draft.auto ? " on" : ""}`, "aria-hidden": "true" }, h("i")),
      h("span", { text: t("skill_auto_label") }));
    autoSwitch.addEventListener("click", () => {
      draft.auto = !draft.auto;
      autoSwitch.setAttribute("aria-checked", String(draft.auto));
      $(".switch", autoSwitch).classList.toggle("on", draft.auto);
    });

    const saveBtn = h("button", { type: "submit", class: "btn btn-primary", text: t("save") });
    form.append(
      h("div", { class: "skill-form-top" },
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => this.setView("list") }, h("span", { text: `← ${t("back")}` })),
        h("strong", { text: draft.id ? t("skill_edit") : t("skill_new") }),
        h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => mdInput.click() },
          h("span", { html: Icons.paperclip }), h("span", { text: t("skill_upload_md") }))),
      h("div", { class: "form-grid" },
        h("div", { class: "skill-title-row form-full" },
          field("skill_emoji_label", emoji, null, false),
          field("skill_title_label", title, null, false)),
        field("skill_name_label", name, "skill_name_hint"),
        field("skill_desc_label", description, "skill_desc_hint"),
        h("label", { class: "form-label form-full" }, h("span", { text: t("skill_instr_label") }), instructions, counter),
        h("div", { class: "form-label form-full" },
          h("span", { text: t("skill_resources") }),
          resList,
          h("button", { type: "button", class: "btn btn-ghost btn-sm skill-add-file", onclick: () => resInput.click() },
            h("span", { html: Icons.plus }), h("span", { text: t("skill_add_file") })),
          h("span", { class: "form-hint", text: t("skill_resources_hint") })),
        h("div", { class: "form-full" }, autoSwitch)),
      mdInput, resInput,
      h("div", { class: "form-actions" },
        h("button", { type: "button", class: "btn btn-secondary", text: t("cancel"), onclick: () => this.setView("list") }),
        saveBtn));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.saveDraft(saveBtn);
    });
    requestAnimationFrame(() => (draft.id ? instructions : title).focus({ preventScroll: true }));
    return form;
  },

  async saveDraft(button) {
    const draft = this.draft;
    const name = draft.name || skillSlug(draft.title);
    if (!draft.title.trim() || draft.instructions.trim().length < 10 || (name && !SKILL_NAME_RE.test(name))) {
      toast(t("skill_invalid"), "error");
      return;
    }
    const body = {
      title: draft.title.trim(),
      name: name || undefined,
      emoji: (draft.emoji || "🧩").trim(),
      description: (draft.description || "").trim(),
      instructions: draft.instructions,
      resources: draft.resources,
      auto: !!draft.auto,
    };
    button.disabled = true;
    try {
      const saved = draft.id
        ? await api(`/skills/${draft.id}`, { method: "PATCH", body })
        : await api("/skills", { method: "POST", body });
      const light = { id: saved.id, name: saved.name, title: saved.title, emoji: saved.emoji, description: saved.description,
        enabled: saved.enabled, auto: saved.auto, uses: saved.uses || 0, source_url: saved.source_url || null };
      const index = this.list.findIndex((s) => s.id === saved.id);
      if (index >= 0) this.list[index] = { ...this.list[index], ...light };
      else this.list.push(light);
      toast(t("skill_saved"));
      this.setView("list");
      this.renderButton();
    } catch (error) {
      toast(this.errorText(error), "error");
    } finally {
      button.disabled = false;
    }
  },

  /* ---------------------------- GitHub ------------------------------ */

  renderGithub() {
    const state = this.github;
    const wrap = h("div", { class: "skills-view" });
    wrap.appendChild(h("div", { class: "skill-form-top" },
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => this.setView("list") }, h("span", { text: `← ${t("back")}` })),
      h("strong", {}, h("span", { html: Icons.github }), " ", t("skill_import_github")),
      h("span")));

    const input = h("input", { type: "url", class: "input", placeholder: t("github_url_ph"), value: state.url, maxlength: "500", spellcheck: "false", autocomplete: "off" });
    const search = h("button", { type: "submit", class: "btn btn-primary", text: state.busy ? t("loading") : t("github_search"), disabled: state.busy });
    const form = h("form", { class: "github-form" }, input, search);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      state.url = input.value.trim();
      if (state.url) this.githubPreview();
    });
    wrap.append(
      h("label", { class: "form-label" }, h("span", { text: t("github_url_label") })),
      form,
      h("p", { class: "form-hint", text: t("github_hint") }),
      h("div", { class: "github-examples" },
        ...["anthropics/skills"].map((example) => h("button", { type: "button", class: "chip-btn", text: example,
          onclick: () => { state.url = example; this.githubPreview(); } }))));

    const preview = state.preview;
    if (preview) {
      const valid = preview.skills.filter((s) => !s.error);
      wrap.appendChild(h("div", { class: "github-summary" },
        h("span", { text: t("github_found", { n: preview.total, repo: preview.repo }) }),
        valid.length > 1 ? h("button", { type: "button", class: "link-btn", text: state.picked.size === valid.length ? t("github_select_none") : t("github_select_all"),
          onclick: () => {
            if (state.picked.size === valid.length) state.picked.clear();
            else valid.slice(0, 20).forEach((s) => state.picked.add(s.path));
            this.renderModal();
          } }) : null));
      const list = h("div", { class: "github-list" });
      preview.skills.forEach((skill) => {
        if (skill.error) {
          list.appendChild(h("div", { class: "github-item error" }, h("span", { text: "⚠️" }), h("span", { text: `${skill.path || "/"} — ${skill.error}` })));
          return;
        }
        const checked = state.picked.has(skill.path);
        const item = h("label", { class: `github-item${checked ? " selected" : ""}` },
          h("input", { type: "checkbox", checked }),
          h("span", { class: "skills-menu-emoji", text: skill.emoji || "🧩" }),
          h("span", { class: "github-item-text" },
            h("span", { class: "github-item-name" }, h("strong", { text: skill.title }), h("span", { class: "skill-card-meta", text: ` /${skill.name}` }),
              skill.exists ? h("span", { class: "badge badge-xs github-exists", text: t("github_will_update") }) : null),
            skill.description ? h("span", { class: "skills-menu-desc", text: skill.description }) : null,
            h("span", { class: "skill-card-meta", text: `${skill.path || "/"}${skill.files ? ` · +${skill.files} ${t("skill_resources").toLowerCase()}` : ""}` })));
        $("input", item).addEventListener("change", (event) => {
          if (event.target.checked) {
            if (state.picked.size >= 20) { event.target.checked = false; return; }
            state.picked.add(skill.path);
          } else {
            state.picked.delete(skill.path);
          }
          item.classList.toggle("selected", event.target.checked);
          importBtn.textContent = t("github_import_selected", { n: state.picked.size });
          importBtn.disabled = !state.picked.size || state.busy;
        });
        list.appendChild(item);
      });
      wrap.appendChild(list);
      const importBtn = h("button", { type: "button", class: "btn btn-primary", text: t("github_import_selected", { n: state.picked.size }),
        disabled: !state.picked.size || state.busy, onclick: () => this.githubImport(importBtn) });
      wrap.appendChild(h("div", { class: "form-actions" }, importBtn));
    }
    requestAnimationFrame(() => { if (!preview) input.focus({ preventScroll: true }); });
    return wrap;
  },

  async githubPreview() {
    const state = this.github;
    state.busy = true;
    state.preview = null;
    state.picked = new Set();
    this.renderModal();
    try {
      const data = await api("/skills/github/preview", { method: "POST", body: { url: state.url } });
      state.preview = data;
      const valid = data.skills.filter((s) => !s.error);
      if (valid.length === 1) state.picked.add(valid[0].path);
    } catch (error) {
      toast(this.errorText(error), "error");
    } finally {
      state.busy = false;
      if (Modal.isOpen("skills-modal") && this.view === "github") this.renderModal();
    }
  },

  async githubImport(button) {
    const state = this.github;
    if (!state.picked.size) return;
    state.busy = true;
    button.disabled = true;
    button.textContent = t("loading");
    try {
      const result = await api("/skills/github/import", { method: "POST", body: { url: state.url, paths: [...state.picked] } });
      const created = result.created || [];
      const updated = result.updated || [];
      const errors = result.errors || [];
      toast(t("github_imported", { created: created.length, updated: updated.length }), created.length || updated.length ? "success" : "info", 4000);
      if (errors.length) toast(`${t("github_errors", { n: errors.length })}: ${errors.slice(0, 2).map((e) => e.reason).join(" · ")}`, "warning", 6000);
      state.preview = null;
      state.picked = new Set();
      this.loaded = false;
      await this.refresh();
      this.setView("list");
    } catch (error) {
      toast(this.errorText(error), "error");
      button.disabled = false;
      button.textContent = t("github_import_selected", { n: state.picked.size });
    } finally {
      state.busy = false;
    }
  },

  /** Mensaje de error comprensible */
  errorText(error) {
    if (!error) return t("error_generic");
    const map = {
      skill_exists: t("skill_exists"),
      skills_limit: t("skills_limit_reached", { limit: this.limit }),
      schema_outdated: t("schema_outdated"),
      invalid_skill: t("skill_invalid"),
      needs_max: t("effort_locked"),
    };
    if (map[error.code]) return map[error.code];
    // Los errores de GitHub vienen ya explicados por el servidor
    if (error.code === "github_error" && error.message) return error.message;
    return errorMessage(error);
  },
};
