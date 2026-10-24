/* =====================================================================
   PedusIA — Renderizado de Markdown
   Usa marked + DOMPurify + highlight.js (CDN). Si el CDN no carga, usa un
   renderizador propio seguro (todo el texto se escapa antes de formatear).
   ===================================================================== */

const Markdown = {
  ready: false,

  init() {
    if (window.marked) {
      window.marked.setOptions({ gfm: true, breaks: true });
    }
    if (window.DOMPurify) {
      // Todos los enlaces se abren en pestaña nueva de forma segura
      window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A") {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer nofollow");
        }
      });
    }
    this.ready = true;
  },

  /** Escapa HTML */
  escape(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },

  /** Markdown -> HTML sanitizado */
  toHtml(text) {
    if (!this.ready) this.init();
    const source = String(text || "");
    let html;
    if (window.marked && window.DOMPurify) {
      try {
        html = window.marked.parse(source);
        return window.DOMPurify.sanitize(html, {
          FORBID_TAGS: ["style", "script", "iframe", "form", "input", "textarea", "select", "button", "object", "embed"],
          FORBID_ATTR: ["style", "onerror", "onclick", "onload"],
        });
      } catch (error) {
        return this.fallback(source);
      }
    }
    return this.fallback(source);
  },

  /**
   * Renderiza markdown dentro de un contenedor.
   * @param {HTMLElement} container
   * @param {string} text
   * @param {{streaming?: boolean}} options
   */
  render(container, text, { streaming = false } = {}) {
    container.innerHTML = this.toHtml(text);
    this.enhance(container, { highlight: !streaming });
    if (streaming) this.appendCursor(container);
  },

  /** Añade cabecera con lenguaje + botón copiar a cada bloque de código */
  enhance(container, { highlight = true } = {}) {
    container.querySelectorAll("pre > code").forEach((code) => {
      const pre = code.parentElement;
      if (pre.parentElement && pre.parentElement.classList.contains("code-block")) return;
      const langMatch = (code.className || "").match(/language-([\w+#-]+)/);
      const lang = langMatch ? langMatch[1] : "";

      if (highlight && window.hljs) {
        try {
          if (lang && window.hljs.getLanguage(lang)) {
            code.innerHTML = window.hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
          } else {
            code.innerHTML = window.hljs.highlightAuto(code.textContent).value;
          }
          code.classList.add("hljs");
        } catch (error) { /* sin resaltado */ }
      }

      const wrapper = document.createElement("div");
      wrapper.className = "code-block";
      const header = document.createElement("div");
      header.className = "code-header";
      const label = document.createElement("span");
      label.className = "code-lang";
      label.textContent = lang || "code";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code-btn";
      button.dataset.action = "copy-code";
      button.innerHTML = `${Icons.copy}<span>${this.escape(t("copy_code"))}</span>`;
      header.append(label, button);
      pre.replaceWith(wrapper);
      wrapper.append(header, pre);
    });

    // Tablas con scroll horizontal en móvil
    container.querySelectorAll("table").forEach((table) => {
      if (table.parentElement.classList.contains("table-wrap")) return;
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });
  },

  /** Cursor parpadeante al final del texto durante el streaming */
  appendCursor(container) {
    const cursor = document.createElement("span");
    cursor.className = "stream-cursor";
    let target = container.lastElementChild;
    while (target && ["UL", "OL", "BLOCKQUOTE"].includes(target.tagName) && target.lastElementChild) {
      target = target.lastElementChild;
    }
    if (target && ["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6"].includes(target.tagName)) {
      target.appendChild(cursor);
    } else {
      container.appendChild(cursor);
    }
  },

  /** Markdown -> texto plano (para voz y exportar) */
  toPlainText(text) {
    return String(text || "")
      .replace(/```[\w+#-]*\n?([\s\S]*?)```/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "• ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  },

  /* ------------------------------------------------------------------
     Renderizador de respaldo (sin dependencias). Seguro: escapa primero.
     Soporta: bloques de código, títulos, listas, citas, negrita, cursiva,
     código en línea, enlaces, separadores y párrafos.
     ------------------------------------------------------------------ */
  fallback(source) {
    const codeBlocks = [];
    let text = source.replace(/```([\w+#-]*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
      codeBlocks.push(`<pre><code class="language-${this.escape(lang || "plaintext")}">${this.escape(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });
    text = this.escape(text);

    const inline = (line) =>
      line
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/__(.+?)__/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/~~(.+?)~~/g, "<del>$1</del>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');

    const lines = text.split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
        paragraph = [];
      }
    };
    const closeList = () => {
      if (list) { out.push(`</${list}>`); list = null; }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      let match;
      if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
        flushParagraph(); closeList();
        out.push(line.trim());
      } else if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
        flushParagraph(); closeList();
        out.push(`<h${match[1].length}>${inline(match[2])}</h${match[1].length}>`);
      } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        flushParagraph(); closeList();
        out.push("<hr>");
      } else if ((match = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushParagraph();
        if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${inline(match[1])}</li>`);
      } else if ((match = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushParagraph();
        if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
        out.push(`<li>${inline(match[1])}</li>`);
      } else if ((match = line.match(/^&gt;\s?(.*)$/))) {
        flushParagraph(); closeList();
        out.push(`<blockquote><p>${inline(match[1])}</p></blockquote>`);
      } else if (!line.trim()) {
        flushParagraph(); closeList();
      } else {
        closeList();
        paragraph.push(line);
      }
    }
    flushParagraph(); closeList();
    return out.join("\n").replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);
  },
};
