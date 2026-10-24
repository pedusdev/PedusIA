/* =====================================================================
   PedusIA — Exportar conversaciones: TXT, PDF (jsPDF) y copiar
   ===================================================================== */

const Exporter = {
  init() {
    // Sin estado propio: los menús se abren desde la cabecera y el sidebar
  },

  openMenu(anchor, conversationId) {
    if (!conversationId) {
      toast(t("export_empty"), "info");
      return;
    }
    openMenu(anchor, [
      { label: t("export_txt"), icon: "file", onClick: () => this.exportTxt(conversationId) },
      { label: t("export_pdf"), icon: "download", onClick: () => this.exportPdf(conversationId) },
      "separator",
      { label: t("export_copy"), icon: "copy", onClick: () => this.copyConversation(conversationId) },
    ]);
  },

  /** Obtiene título y mensajes (de memoria si es la conversación abierta) */
  async getData(conversationId) {
    const conv = Sidebar.find(conversationId);
    if (conversationId === Chat.currentId && Chat.messages.length && !Chat.streaming) {
      return {
        title: (conv && conv.title) || $("#chat-title").textContent || "PedusIA",
        messages: Chat.messages
          .filter((m) => !m.failed)
          .map((m) => ({ role: m.role, content: m.content, file_name: m.file_name, created_at: m.created_at })),
      };
    }
    const data = await api(`/conversations/${conversationId}/messages`);
    return {
      title: (data.conversation && data.conversation.title) || (conv && conv.title) || "PedusIA",
      messages: data.messages || [],
    };
  },

  roleLabel(role) {
    return role === "user" ? t("you") : "PedusGPT";
  },

  /** Convierte la conversación a texto plano legible */
  toText({ title, messages }) {
    const lines = [
      `PedusIA — ${title}`,
      `${t("exported_on")}: ${new Date().toLocaleString(I18n.locale())}`,
      "=".repeat(48),
      "",
    ];
    messages.forEach((m) => {
      const when = m.created_at ? ` · ${new Date(m.created_at).toLocaleString(I18n.locale())}` : "";
      lines.push(`[${this.roleLabel(m.role)}]${when}`);
      if (m.file_name) lines.push(`📎 ${m.file_name}`);
      lines.push(m.role === "assistant" ? Markdown.toPlainText(m.content || "") : (m.content || ""));
      lines.push("");
    });
    return lines.join("\n").trim() + "\n";
  },

  fileName(title, ext) {
    const slug = (title || "conversacion")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 50) || "conversacion";
    return `pedusia-${slug}.${ext}`;
  },

  download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  async exportTxt(conversationId) {
    try {
      const data = await this.getData(conversationId);
      if (!data.messages.length) { toast(t("export_empty"), "info"); return; }
      this.download(new Blob([this.toText(data)], { type: "text/plain;charset=utf-8" }), this.fileName(data.title, "txt"));
      toast(t("export_done"), "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  async copyConversation(conversationId) {
    try {
      const data = await this.getData(conversationId);
      if (!data.messages.length) { toast(t("export_empty"), "info"); return; }
      if (await copyToClipboard(this.toText(data))) toast(t("copied"), "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  /** Quita emojis y símbolos que las fuentes estándar de PDF no pueden dibujar */
  pdfSafe(text) {
    return String(text || "")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, "")
      .replace(/\t/g, "    ");
  },

  /** ¿El texto usa solo caracteres que las fuentes estándar de jsPDF soportan? */
  isLatin(text) {
    return !/[^\x00-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/.test(text);
  },

  async exportPdf(conversationId) {
    try {
      const data = await this.getData(conversationId);
      if (!data.messages.length) { toast(t("export_empty"), "info"); return; }
      const allText = this.pdfSafe(this.toText(data));
      const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
      if (jsPDFCtor && this.isLatin(allText)) this.buildPdf(jsPDFCtor, data);
      else this.printFallback(data); // alfabetos no latinos (ja, zh, ko, ru, ar…)
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  },

  buildPdf(JsPDF, { title, messages }) {
    const doc = new JsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 52;
    const width = pageWidth - margin * 2;
    let y = margin;

    const ensureSpace = (needed) => {
      if (y + needed > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    };

    // Cabecera
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(26, 26, 26);
    doc.splitTextToSize(this.pdfSafe(title), width).forEach((line) => {
      ensureSpace(24);
      doc.text(line, margin, y);
      y += 24;
    });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(107, 107, 107);
    doc.text(`PedusIA · ${t("exported_on")}: ${new Date().toLocaleString(I18n.locale())}`, margin, y);
    y += 14;
    doc.setDrawColor(229, 227, 220);
    doc.line(margin, y, pageWidth - margin, y);
    y += 22;

    messages.forEach((m) => {
      const isUser = m.role === "user";
      ensureSpace(36);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(isUser ? 45 : 160, isUser ? 45 : 110, isUser ? 45 : 0);
      doc.text(this.roleLabel(m.role), margin, y);
      y += 15;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.setTextColor(26, 26, 26);
      let body = isUser ? (m.content || "") : Markdown.toPlainText(m.content || "");
      if (m.file_name) body = `[${m.file_name}]\n${body}`;
      body = this.pdfSafe(body);
      body.split("\n").forEach((paragraph) => {
        const lines = paragraph.trim() ? doc.splitTextToSize(paragraph, width) : [""];
        lines.forEach((line) => {
          ensureSpace(14);
          doc.text(line, margin, y);
          y += 14;
        });
      });
      y += 12;
    });

    // Numeración de páginas
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i += 1) {
      doc.setPage(i);
      doc.setFontSize(8.5);
      doc.setTextColor(154, 154, 154);
      doc.text(`${i} / ${pages}`, pageWidth - margin, pageHeight - 26, { align: "right" });
    }
    doc.save(this.fileName(title, "pdf"));
    toast(t("export_done"), "success");
  },

  /** Alternativa universal: diálogo de impresión del navegador → "Guardar como PDF" */
  printFallback({ title, messages }) {
    const dir = document.documentElement.dir || "ltr";
    const items = messages.map((m) => {
      const body = m.role === "assistant" ? Markdown.toHtml(m.content || "") : `<p>${escapeHtml(m.content || "").replace(/\n/g, "<br>")}</p>`;
      const file = m.file_name ? `<div class="file">📎 ${escapeHtml(m.file_name)}</div>` : "";
      return `<section class="msg ${m.role === "user" ? "user" : "ai"}"><h3>${escapeHtml(this.roleLabel(m.role))}</h3>${file}<div class="body">${body}</div></section>`;
    }).join("");

    const html = `<!DOCTYPE html><html lang="${I18n.current}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
      <style>
        body{font-family:Inter,-apple-system,"Segoe UI","Noto Sans",sans-serif;color:#1A1A1A;margin:40px;line-height:1.55;font-size:12pt}
        h1{font-size:20pt;margin:0 0 4px} .meta{color:#6B6B6B;font-size:9pt;border-bottom:1px solid #E5E3DC;padding-bottom:12px;margin-bottom:20px}
        .msg{margin-bottom:18px;page-break-inside:avoid} .msg h3{font-size:10.5pt;margin:0 0 4px}
        .user h3{color:#2D2D2D} .ai h3{color:#A06E00} .file{color:#6B6B6B;font-size:10pt}
        pre{background:#F5F5F0;padding:10px;border-radius:6px;white-space:pre-wrap;font-size:9.5pt}
        code{font-family:ui-monospace,Menlo,Consolas,monospace} table{border-collapse:collapse} td,th{border:1px solid #E5E3DC;padding:4px 8px}
        blockquote{border-inline-start:3px solid #E5E3DC;margin:0;padding-inline-start:12px;color:#6B6B6B}
        .copy-code-btn,.code-lang{display:none}
      </style></head><body><h1>${escapeHtml(title)}</h1>
      <div class="meta">PedusIA · ${escapeHtml(t("exported_on"))}: ${escapeHtml(new Date().toLocaleString(I18n.locale()))}</div>${items}</body></html>`;

    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    const frameDoc = frame.contentWindow.document;
    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();
    setTimeout(() => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (_) {
        toast(t("error_generic"), "error");
      }
      setTimeout(() => frame.remove(), 60000);
    }, 300);
  },
};
