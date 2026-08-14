// time-core.js — PURE. §11.3's one shared time formatter: every clock, chip
// label, gutter mark, and (in a later phase) the completion sheet's stepper
// renders through this, so a setting change (24h vs 12h) can never leave
// part of the screen half-converted. TDS_Slice_Wall_Calendar_Redesign.md
// §11.3. Not named in §13's file table — it is small enough to have been
// folded into `day-ui.js`, but §14.12 asks for it as a pure, unit-tested
// function, and only `*-core.js` files are DOM-free and loaded by the tests.

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

  g.TimeCore = { formatMinutes: formatMinutes, formatDate: formatDate };
})(typeof window !== "undefined" ? window : globalThis);
