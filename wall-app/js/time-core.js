// time-core.js — PURE. §11.3's one shared time formatter: every clock, chip
// label, gutter mark, and (in a later phase) the completion sheet's stepper
// renders through this, so a setting change (24h vs 12h) can never leave
// part of the screen half-converted. TDS_Slice_Wall_Calendar_Redesign.md
// §11.3. Not named in §13's file table — it is small enough to have been
// folded into `day-ui.js`, but §14.12 asks for it as a pure, unit-tested
// function, and only `*-core.js` files are DOM-free and loaded by the tests.
// §16 Phase 5b adds `formatDurationMin` — the overridden-chip marker and
// the duration-adjust sheet (§3.5.2) both render a duration as "45m"/"1h
// 15m" rather than a clock time, so it earns its own tiny formatter here
// rather than one-off string building in day-ui.js.

(function (g) {
  "use strict";

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  // `min` — minutes from local midnight, any integer (wrapped into
  // [0, 1440) first, so a caller doing clock-wrap math doesn't have to).
  // `fmt` — '12h' or '24h' (default).
  function formatMinutes(min, fmt) {
    var m = ((Math.round(min) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60;
    if (fmt === "12h") {
      var ap = h >= 12 ? "pm" : "am";
      var h12 = h % 12;
      if (h12 === 0) h12 = 12;
      return h12 + ":" + pad2(mm) + " " + ap;
    }
    return pad2(h) + ":" + pad2(mm);
  }

  // Convenience for a live Date (the topbar clock, the staleness stamp).
  function formatDate(d, fmt) {
    return formatMinutes(d.getHours() * 60 + d.getMinutes(), fmt);
  }

  // A duration, not a clock time — "45m", "1h", "1h 15m". `min` is assumed
  // positive (durations are validated as such server-side, §3.5.1).
  function formatDurationMin(min) {
    var h = Math.floor(min / 60), m = min % 60;
    if (h === 0) return m + "m";
    if (m === 0) return h + "h";
    return h + "h " + m + "m";
  }

  // Placement Scopes §2.3 — a "YYYY-MM-DD" date's LOCAL day of week,
  // 0 = Sunday .. 6 = Saturday, matching §6's Sunday-first week and the month
  // grid's column order.
  //
  // Parse the COMPONENTS, never the string. `new Date("2026-08-23")` parses as
  // UTC midnight, which is the previous day in every timezone west of
  // Greenwich — so `.getDay()` on it answers Saturday for a Sunday in this
  // household, and every weekday override would land one day off for exactly
  // the people who never see it fail in a test run under UTC. §8's test 1
  // pins that under TZ=America/Chicago.
  //
  // This is now the ONLY implementation. nav-ui.js and week-ui.js each had
  // their own copy of these three lines (both correct, neither tested) and
  // both now call this. `month-core.parseIso` builds Date objects for date
  // arithmetic rather than weekday numbers, so it stays as it is — but §8's
  // test 1 checks it against the same trap. Three places used to decide this
  // number when it was cosmetic ("which column"); it is load-bearing now
  // ("does school happen"), so it is decided once.
  function weekdayOf(date) {
    var p = String(date).split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]).getDay();
  }

  // Placement Scopes §6.1 — a weekday NUMBER's name, for the sheet's
  // "Every Friday" button and the toast's "Only Fridays". Sunday-first, to
  // match `weekdayOf` above and §6's week.
  //
  // Not `toLocaleDateString`, which is what nav-ui.js and week-ui.js use for
  // a DATE's name: those have a Date in hand and want the locale's own
  // wording, and this has only the number 5 and wants a plural ("Fridays")
  // that no Intl option produces. A seven-entry table is the honest way to
  // get one, and it is here rather than in day-ui.js because §6.2's block
  // sheet (Phase 5) draws the same seven names down its own column.
  var WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function weekdayName(weekday, plural) {
    var name = WEEKDAY_NAMES[weekday];
    if (name == null) return "";
    return plural ? name + "s" : name;
  }

  // Placement Scopes §6.2 (Phase 5b) — the three-letter form the block
  // sheet's seven-row checklist is drawn with. Same table, so the column of
  // abbreviations and the "Every Friday" button can never name different
  // days; a `.slice(0, 3)` at the call site would work identically today and
  // silently stop matching the moment this table is ever localised.
  function weekdayShortName(weekday) {
    var name = WEEKDAY_NAMES[weekday];
    if (name == null) return "";
    return name.slice(0, 3);
  }

  g.TimeCore = {
    formatMinutes: formatMinutes,
    formatDate: formatDate,
    formatDurationMin: formatDurationMin,
    weekdayOf: weekdayOf,
    weekdayName: weekdayName,
    weekdayShortName: weekdayShortName,
  };
})(typeof window !== "undefined" ? window : globalThis);
