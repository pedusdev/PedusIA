/* =====================================================================
   PedusIA — Voz (Web Speech API, gratis y en el navegador)
   - Speech-to-Text: SpeechRecognition (respaldo: grabación + Whisper vía backend)
   - Text-to-Speech: speechSynthesis
   ===================================================================== */

const Voice = {
  recognition: null,
  listening: false,
  mediaRecorder: null,
  mediaStream: null,
  chunks: [],
  speakingButton: null,
  speakToken: 0,

  init() {
    $("#mic-btn").addEventListener("click", () => this.toggleListening());
    // Las voces del sistema se cargan de forma asíncrona en algunos navegadores
    if ("speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
  },

  /* ------------------------------------------------------------------ */
  /* Speech-to-Text                                                       */
  /* ------------------------------------------------------------------ */
  toggleListening() {
    if (this.listening) this.stopListening();
    else this.startListening();
  },

  setListening(listening, processing = false) {
    this.listening = listening;
    const button = $("#mic-btn");
    button.classList.toggle("listening", listening);
    button.classList.toggle("processing", processing);
    button.title = t(listening ? "mic_listening" : "mic");
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(listening));
  },

  startListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.startRecognition(SpeechRecognition);
    } else if (window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      this.startRecording();
    } else {
      toast(t("mic_unsupported"), "warning");
    }
  },

  stopListening() {
    if (this.recognition) {
      try { this.recognition.stop(); } catch (_) { /* ya parado */ }
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
    this.setListening(false);
  },

  /** Transcripción en tiempo real con la Web Speech API */
  startRecognition(SpeechRecognition) {
    const input = $("#message-input");
    const recognition = new SpeechRecognition();
    recognition.lang = I18n.locale();
    recognition.interimResults = true;
    recognition.continuous = true;
    const base = input.value ? `${input.value.replace(/\s+$/, "")} ` : "";
    let finalText = "";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      input.value = base + finalText + interim;
      Chat.autoResize();
      Chat.updateSendState();
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") toast(t("mic_denied"), "warning");
      else if (event.error !== "no-speech" && event.error !== "aborted") toast(t("error_generic"), "error");
    };
    recognition.onend = () => {
      this.recognition = null;
      this.setListening(false);
      input.focus();
    };

    try {
      recognition.start();
      this.recognition = recognition;
      this.setListening(true);
    } catch (_) {
      toast(t("mic_unsupported"), "warning");
    }
  },

  /** Respaldo: graba audio y lo transcribe con Whisper en el backend */
  async startRecording() {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      toast(t("mic_denied"), "warning");
      return;
    }
    const mimeType = ["audio/webm", "audio/ogg", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) || "";
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : undefined);
    this.mediaRecorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
    this.mediaRecorder.onstop = () => this.transcribeRecording();
    this.mediaRecorder.start();
    this.setListening(true);
    // Límite de seguridad: 60 segundos
    clearTimeout(this.recordTimer);
    this.recordTimer = setTimeout(() => this.stopListening(), 60000);
  },

  async transcribeRecording() {
    clearTimeout(this.recordTimer);
    if (this.mediaStream) this.mediaStream.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    const type = (this.mediaRecorder && this.mediaRecorder.mimeType) || "audio/webm";
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    if (blob.size < 1000) return;

    this.setListening(false, true);
    try {
      const form = new FormData();
      const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
      form.append("audio", blob, `voz.${ext}`);
      form.append("language", I18n.current);
      const { text } = await api("/voice/transcribe", { method: "POST", formData: form });
      if (text) {
        const input = $("#message-input");
        input.value = input.value ? `${input.value.replace(/\s+$/, "")} ${text}` : text;
        Chat.autoResize();
        Chat.updateSendState();
        input.focus();
      }
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      this.setListening(false, false);
    }
  },

  /* ------------------------------------------------------------------ */
  /* Text-to-Speech                                                       */
  /* ------------------------------------------------------------------ */

  /** Detecta el idioma del texto por su alfabeto (respaldo: idioma de la interfaz) */
  detectLang(text) {
    if (/[\u3040-\u30ff]/.test(text)) return "ja-JP";
    if (/[\uac00-\ud7af]/.test(text)) return "ko-KR";
    if (/[\u4e00-\u9fff]/.test(text)) return "zh-CN";
    if (/[\u0400-\u04ff]/.test(text)) return "ru-RU";
    if (/[\u0600-\u06ff]/.test(text)) return "ar-SA";
    return I18n.locale();
  },

  /** Divide el texto en frases (Chrome corta las locuciones muy largas) */
  chunk(text, max = 220) {
    const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]*\s*/g) || [text];
    const chunks = [];
    let current = "";
    sentences.forEach((sentence) => {
      if ((current + sentence).length > max && current) {
        chunks.push(current.trim());
        current = "";
      }
      current += sentence;
    });
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  },

  toggleSpeak(markdownText, button) {
    if (!("speechSynthesis" in window)) {
      toast(t("tts_unsupported"), "warning");
      return;
    }
    if (this.speakingButton === button) {
      this.stopSpeaking();
      return;
    }
    this.stopSpeaking();

    const text = Markdown.toPlainText(markdownText).replace(/[•#*_`>|]/g, " ");
    if (!text.trim()) return;
    const lang = this.detectLang(text);
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang === lang) || voices.find((v) => v.lang && v.lang.startsWith(lang.slice(0, 2)));
    const token = ++this.speakToken;
    const parts = this.chunk(text);

    this.speakingButton = button;
    button.classList.add("speaking");
    button.innerHTML = Icons.volumeOff;
    button.title = t("stop_listen");

    parts.forEach((part, index) => {
      const utterance = new SpeechSynthesisUtterance(part);
      utterance.lang = lang;
      if (voice) utterance.voice = voice;
      utterance.rate = 1;
      if (index === parts.length - 1) {
        utterance.onend = () => { if (token === this.speakToken) this.resetSpeakButton(); };
      }
      utterance.onerror = () => { if (token === this.speakToken) this.resetSpeakButton(); };
      window.speechSynthesis.speak(utterance);
    });
  },

  resetSpeakButton() {
    const button = this.speakingButton;
    this.speakingButton = null;
    if (!button) return;
    button.classList.remove("speaking");
    button.innerHTML = Icons.volume;
    button.title = t("listen");
  },

  stopSpeaking() {
    this.speakToken += 1;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.resetSpeakButton();
  },

  stopAll() {
    this.stopSpeaking();
    if (this.listening) this.stopListening();
  },
};
