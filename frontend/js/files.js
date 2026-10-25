/* =====================================================================
   PedusGPT — Subida de archivos (clip, arrastrar y soltar, pegar imagen)
   Tipos: imágenes (jpg, png, gif, webp), PDF, .txt, .md, .csv — máx. 10 MB
   ===================================================================== */

const Files = {
  pending: null,     // archivo ya subido listo para enviar
  uploading: false,
  localPreview: null,
  uploadToken: 0,

  ALLOWED_MIME: ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv"],
  ALLOWED_EXT: ["jpg", "jpeg", "png", "gif", "webp", "pdf", "txt", "md", "csv"],

  get maxBytes() {
    return ((App.config && App.config.max_upload_mb) || 10) * 1024 * 1024;
  },

  init() {
    const input = $("#file-input");
    $("#attach-btn").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files && input.files[0]) this.handle(input.files[0]);
      input.value = "";
    });

    // Arrastrar y soltar sobre el área de chat
    const area = $("#chat-area");
    const overlay = $("#drop-overlay");
    let depth = 0;
    area.addEventListener("dragenter", (event) => {
      if (!this.hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      overlay.hidden = false;
    });
    area.addEventListener("dragover", (event) => {
      if (this.hasFiles(event)) event.preventDefault();
    });
    area.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    area.addEventListener("drop", (event) => {
      if (!this.hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const files = event.dataTransfer.files;
      if (files.length > 1) toast(t("file_one_at_time"), "info");
      if (files[0]) this.handle(files[0]);
    });

    // Pegar imágenes con Ctrl+V
    $("#message-input").addEventListener("paste", (event) => {
      const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
      const fileItem = items.find((item) => item.kind === "file");
      if (fileItem) {
        const file = fileItem.getAsFile();
        if (file) { event.preventDefault(); this.handle(file); }
      }
    });
  },

  hasFiles(event) {
    return event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files");
  },

  validate(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!this.ALLOWED_MIME.includes(file.type) && !this.ALLOWED_EXT.includes(ext)) return t("file_type_invalid");
    if (file.size > this.maxBytes) return t("file_too_big");
    if (file.size === 0) return t("file_type_invalid");
    return null;
  },

  async handle(file) {
    if (!App.profile) return;
    const problem = this.validate(file);
    if (problem) { toast(problem, "error"); return; }

    this.clear();
    const token = ++this.uploadToken;
    const isImage = file.type.startsWith("image/");
    this.localPreview = isImage ? URL.createObjectURL(file) : null;
    this.uploading = true;
    this.renderPreview({ file_name: file.name, file_size: file.size, file_type: file.type, is_image: isImage }, true);
    Chat.updateSendState();

    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const result = await api("/files/upload", { method: "POST", formData: form });
      if (token !== this.uploadToken) return; // se canceló mientras subía
      this.pending = result;
      this.renderPreview(result, false);
    } catch (error) {
      if (token !== this.uploadToken) return;
      toast(errorMessage(error), "error");
      this.clear();
    } finally {
      if (token === this.uploadToken) {
        this.uploading = false;
        Chat.updateSendState();
      }
    }
  },

  /** Restaura un adjunto ya subido (cuando falla el envío) */
  setPending(file) {
    this.clear();
    this.pending = file;
    this.renderPreview(file, false);
    Chat.updateSendState();
  },

  clear() {
    this.uploadToken += 1;
    this.pending = null;
    this.uploading = false;
    if (this.localPreview) URL.revokeObjectURL(this.localPreview);
    this.localPreview = null;
    const preview = $("#attachment-preview");
    if (preview) { preview.innerHTML = ""; preview.hidden = true; }
    if (typeof Chat !== "undefined" && Chat.updateSendState) Chat.updateSendState();
  },

  renderPreview(file, uploading) {
    const preview = $("#attachment-preview");
    preview.innerHTML = "";
    preview.hidden = false;

    const item = document.createElement("div");
    item.className = `attachment-item${uploading ? " uploading" : ""}`;

    const imageUrl = this.localPreview || (file.is_image && /^https:\/\//.test(file.file_url || "") ? file.file_url : null);
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.alt = "";
      item.appendChild(img);
    } else {
      const icon = document.createElement("div");
      icon.className = "file-icon";
      icon.innerHTML = Icons.file;
      item.appendChild(icon);
    }

    const meta = document.createElement("div");
    meta.className = "attachment-meta";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = file.file_name;
    const sub = document.createElement("span");
    sub.className = "attachment-sub";
    sub.textContent = uploading ? t("file_uploading") : formatBytes(file.file_size);
    meta.append(name, sub);
    item.appendChild(meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", t("file_remove"));
    remove.title = t("file_remove");
    remove.innerHTML = Icons.x;
    remove.addEventListener("click", () => this.clear());
    item.appendChild(remove);

    preview.appendChild(item);
  },
};
