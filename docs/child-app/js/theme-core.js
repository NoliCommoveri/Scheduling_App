// theme-core.js — pure theme bundle registry for Theming (Module 10),
// TDS_Slice_M3 §3/§4/§8. No IndexedDB/DOM access here — same discipline as
// the other -core.js modules. A theme is a build-time bundle (§3): Palette,
// Emoji-icon set, Copy pack, Signature reward visual. Field name is `theme`
// throughout the app (§8) — this module never introduces `themeId`.

(function (g) {
  "use strict";

  // Shared by every Palette theme — only the Palette itself is custom per
  // Palette theme (Module 10 §2/FR-1).
  var GENERIC_COPY = { brand: "Daily Plan", rewardsTitle: "Rewards" };

  // Module 10 FR-3 / TDS §4 — the beyond-base safety net. Under a signature
  // theme this is only ever reached by a category id outside the seeded base
  // four (e.g. a 5th tier a parent adds later); under a palette theme every
  // category resolves here by design. Never a raw categoryId.
  var GENERIC_DEFAULT_DISPLAY = { label: "Bonus", icon: { kind: "emoji", value: "⭐" } };

  var THEMES = {
    daylight: {
      id: "daylight", tier: "palette", name: "Daylight",
      swatch: ["#eef0f8", "#e2913a", "#2792cf", "#3a4694"],
      copy: GENERIC_COPY,
      categoryDisplay: {}
    },
    dusk: {
      id: "dusk", tier: "palette", name: "Dusk",
      swatch: ["#14142a", "#f0a94f", "#a184ef", "#6a77d6"],
      copy: GENERIC_COPY,
      categoryDisplay: {}
    },
    // Signature — Horse Lover "Stable" (Module 10 §2): ribbon-rail reward
    // visual, warm hay/leather palette, horse iconography. Ribbons are
    // reserved for reward icons only (TDS_Slice_M3 §3) — never reused as
    // decoration elsewhere in this theme's visuals.
    stable: {
      id: "stable", tier: "signature", name: "Stable",
      swatch: ["#3a2a18", "#caa057", "#8a5a34", "#c94b3f"],
      copy: { brand: "The Stable", rewardsTitle: "Ribbons earned" },
      categoryDisplay: {
        R01: { label: "White Ribbon", icon: { kind: "ribbon", color: "#f5f3ee" } },
        R02: { label: "Yellow Ribbon", icon: { kind: "ribbon", color: "#e8c34a" } },
        R03: { label: "Red Ribbon", icon: { kind: "ribbon", color: "#c9463a" } },
        R04: { label: "Blue Ribbon", icon: { kind: "ribbon", color: "#3f6fb0" } }
      }
    },
    // Signature — voxel-builder-genre "Builder" (Module 10 §2, FR-4): build-
    // grid reward visual, blocky styling. Evokes the genre only — original
    // art/names, no trademarked textures, logos, or typefaces (FR-4).
    builder: {
      id: "builder", tier: "signature", name: "Builder",
      swatch: ["#2b2b2b", "#7a5a3a", "#8a8a8a", "#4caf50"],
      copy: { brand: "Builder", rewardsTitle: "Resources gathered" },
      categoryDisplay: {
        R01: { label: "Leather", icon: { kind: "emoji", value: "\u{1F7EB}" } },
        R02: { label: "Iron", icon: { kind: "emoji", value: "⚙️" } },
        R03: { label: "Gold", icon: { kind: "emoji", value: "\u{1F947}" } },
        R04: { label: "Diamond", icon: { kind: "emoji", value: "\u{1F48E}" } }
      }
    }
  };

  var DEFAULT_THEME_ID = "daylight";

  // Module 10 validation rule: an unbundled theme id (e.g. after a build
  // downgrade) falls back to the default palette theme rather than erroring.
  function resolveThemeId(id) {
    return THEMES.hasOwnProperty(id) ? id : DEFAULT_THEME_ID;
  }

  function getTheme(id) {
    return THEMES[resolveThemeId(id)];
  }

  function listThemes() {
    return Object.keys(THEMES).map(function (id) { return THEMES[id]; });
  }

  // FR-3: every category the child has ever earned into resolves to a
  // theme-specific mapping if the active theme names it, else the shared
  // generic default — never a raw categoryId, never blank.
  function resolveCategoryDisplay(themeId, categoryId) {
    var theme = getTheme(themeId);
    return theme.categoryDisplay[categoryId] || GENERIC_DEFAULT_DISPLAY;
  }

  g.ThemeCore = {
    DEFAULT_THEME_ID: DEFAULT_THEME_ID,
    listThemes: listThemes,
    resolveThemeId: resolveThemeId,
    getTheme: getTheme,
    resolveCategoryDisplay: resolveCategoryDisplay,
    GENERIC_DEFAULT_DISPLAY: GENERIC_DEFAULT_DISPLAY
  };
})(typeof window !== "undefined" ? window : globalThis);
