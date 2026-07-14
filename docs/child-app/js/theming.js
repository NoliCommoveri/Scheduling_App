// theming.js — Theming (Module 10), wired to IndexedDB. TDS_Slice_M3 §3/§7/§8.
// Sole writer of themeSettings.theme (the same field Module 1's Wizard first
// set — §8, no second field). Switching is always ungated and live (FR-2/FR-7):
// this file performs no PIN check and no confirmation, ever.

(function (g) {
  "use strict";

  var T = g.ThemeCore;

  function getActiveTheme() {
    return g.DB.getSingleton("themeSettings").then(function (ts) {
      return T.getTheme(ts && ts.theme);
    });
  }

  // Applies a theme's Palette live via the data-theme attribute (style.css
  // holds each theme's CSS custom properties) — no reload, no re-layout,
  // just a variable swap (FR-1/FR-7).
  function applyTheme(themeId) {
    document.documentElement.setAttribute("data-theme", T.resolveThemeId(themeId));
  }

  // FR-2/FR-7: no PIN, no confirmation beyond the switch itself; applies
  // immediately. Persists to the single themeSettings.theme field.
  function setTheme(themeId) {
    var resolved = T.resolveThemeId(themeId);
    applyTheme(resolved);
    return g.DB.putSingleton("themeSettings", { theme: resolved });
  }

  g.Theming = { getActiveTheme: getActiveTheme, applyTheme: applyTheme, setTheme: setTheme };
})(typeof window !== "undefined" ? window : globalThis);
