/* =====================================================================
   PedusGPT — Búsqueda web automática (interfaz)
   - Indicador "Buscando en la web…" con las consultas mientras se busca.
   - Fila de fuentes numeradas bajo la respuesta (enlaces externos seguros).
   - Las citas [n] del texto se convierten en enlaces a la fuente n.
   ===================================================================== */

const WebSearch = {
  /** Solo se aceptan enlaces http(s) (nunca javascript:, data:, etc.) */
  safeUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch (_) {
      return null;
    }
  },

  /** Fuentes válidas de un mensaje (las guardadas o las recibidas en streaming) */
  validSources(sources) {
    if (!Array.isArray(sources)) return [];
    return sources
      .map((source, index) => ({
        n: Number(source.n) || index + 1,
        title: String(source.title || source.domain || "").slice(0, 200),
        domain: String(source.domain || "").slice(0, 120),
        url: this.safeUrl(source.url),
        published: source.published ? String(source.published).slice(0, 10) : "",
      }))
      .filter((source) => source.url);
  },

  /** Muestra (o quita) el indicador de búsqueda en curso */
  setSearching(msg, queries) {
    if (!msg || !msg.bubbleEl) return;
    let row = $(".web-searching", msg.bubbleEl);
    if (!queries) {
      if (row) row.remove();
      return;
    }
    if (!row) {
      row = h("div", { class: "web-searching", role: "status" });
      msg.bubbleEl.insertBefore(row, msg.contentEl || null);
    }
    row.innerHTML = "";
    row.appendChild(h("span", { class: "web-icon web-icon-spin", html: Icons.globe }));
    row.appendChild(h("span", { class: "web-searching-label", text: t("search_searching") }));
    (queries || []).slice(0, 3).forEach((query) => {
      row.appendChild(h("span", { class: "web-query", text: String(query).slice(0, 120) }));
    });
    if (typeof Chat !== "undefined" && Chat.scrollToBottom) Chat.scrollToBottom();
  },

  /** Aviso discreto dentro de la burbuja (límite diario o fallo del buscador) */
  setNotice(msg, text) {
    if (!msg || !msg.bubbleEl) return;
    this.setSearching(msg, null);
    let row = $(".web-notice", msg.bubbleEl);
    if (!row) {
      row = h("div", { class: "web-notice" });
      msg.bubbleEl.insertBefore(row, msg.contentEl || null);
    }
    row.innerHTML = "";
    row.append(h("span", { class: "web-icon", html: Icons.globe }), h("span", { text }));
  },

  /** Pinta la fila de fuentes bajo la respuesta */
  renderSources(msg, sources) {
    if (!msg || !msg.bubbleEl) return;
    this.setSearching(msg, null);
    const list = this.validSources(sources);
    msg.sources = list;
    let row = $(".web-sources", msg.bubbleEl);
    if (!list.length) {
      if (row) row.remove();
      return;
    }
    if (!row) {
      row = h("div", { class: "web-sources" });
      msg.bubbleEl.appendChild(row);
    }
    row.innerHTML = "";
    const header = h("div", { class: "web-sources-header" },
      h("span", { class: "web-icon", html: Icons.globe }),
      h("span", { class: "web-sources-title", text: t("search_sources") }),
      h("span", { class: "web-sources-count", text: t("search_n_sources", { n: list.length }) }));
    const chips = h("div", { class: "web-sources-list" });
    list.forEach((source) => {
      chips.appendChild(h("a", {
        class: "web-source",
        href: source.url,
        target: "_blank",
        rel: "noopener noreferrer nofollow",
        title: [source.title, source.published].filter(Boolean).join(" · "),
        "aria-label": t("search_open_source", { n: source.n, title: source.title }),
      },
      h("span", { class: "web-source-n", text: String(source.n) }),
      h("span", { class: "web-source-domain", text: source.domain || source.title }),
      h("span", { class: "web-source-title", text: source.title })));
    });
    row.append(header, chips);
    this.linkCitations(msg);
  },

  /**
   * Convierte las citas [1], [2][3] o [1, 2] del texto en enlaces a las fuentes.
   * Recorre solo nodos de texto (nunca dentro de código ni de enlaces) para no romper el HTML.
   */
  linkCitations(msg) {
    const list = msg && msg.sources;
    const root = msg && msg.contentEl;
    if (!root || !Array.isArray(list) || !list.length) return;
    const byNumber = new Map(list.map((source) => [source.n, source]));
    const pattern = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.indexOf("[") === -1) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest("pre, code, a, .cite")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const text = node.nodeValue;
      pattern.lastIndex = 0;
      if (!pattern.test(text)) return;
      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const numbers = match[1].split(",").map((part) => Number(part.trim()));
        if (!numbers.every((n) => byNumber.has(n))) continue; // [3] sin fuente 3: se deja como texto
        fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
        numbers.forEach((n) => {
          const source = byNumber.get(n);
          fragment.appendChild(h("a", {
            class: "cite",
            href: source.url,
            target: "_blank",
            rel: "noopener noreferrer nofollow",
            title: `${source.title}${source.domain ? ` — ${source.domain}` : ""}`,
            "aria-label": t("search_open_source", { n, title: source.title }),
            text: String(n),
          }));
        });
        last = match.index + match[0].length;
      }
      if (!last) return;
      fragment.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(fragment, node);
    });
  },

  /** Actualiza el uso del perfil y avisa cuando quedan pocas búsquedas */
  updateUsage(usage) {
    if (!usage || !App.profile) return;
    App.profile.search = { ...(App.profile.search || {}), ...usage };
    const left = usage.remaining;
    if (!usage.unlimited && typeof left === "number" && left <= 5) {
      toast(t("search_remaining", { n: left }), "warning", 4000);
    }
  },

  /** Eventos SSE de búsqueda. Devuelve true si el evento era de búsqueda. */
  handleEvent(event, msg) {
    switch (event.type) {
      case "search":
        this.setSearching(msg, Array.isArray(event.queries) ? event.queries : []);
        return true;
      case "sources":
        this.renderSources(msg, event.sources);
        this.updateUsage(event.usage);
        return true;
      case "search_limit":
        if (App.profile && App.profile.search) {
          App.profile.search.remaining = 0;
          App.profile.search.used = App.profile.search.limit;
        }
        this.setNotice(msg, t("search_limit", { limit: event.limit || (App.config && App.config.web_search_daily_limit) || 30 }));
        return true;
      case "search_failed":
        this.setNotice(msg, t("search_failed"));
        return true;
      default:
        return false;
    }
  },
};
