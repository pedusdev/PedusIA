/* Aplica el tema guardado ANTES de pintar la página (evita el parpadeo blanco). */
(function () {
  try {
    var pref = localStorage.getItem("pedus_theme") || "light";
    var dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    var lang = localStorage.getItem("pedus_lang");
    if (lang) {
      document.documentElement.lang = lang;
      if (lang === "ar") document.documentElement.dir = "rtl";
    }
  } catch (e) { /* almacenamiento no disponible */ }
})();
