// date-util.js — single source of truth for "device-local today" (YYYY-MM-DD),
// shared by every module that needs it (Modules 3-9 all read or write dates this
// way, per TDS_Slice_M1 §4 / TDS_Slice_M2). Previously duplicated privately
// inside planner-ui.js; extracted here so M2 modules don't each re-implement it.

(function (g) {
  "use strict";

  function localISODate(d) {
    d = d || new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function today() { return localISODate(new Date()); }

  // Calendar-day arithmetic on a YYYY-MM-DD string (Module 7's gap catch-up
  // walk). Constructed from local y/m/d parts, not parsed as UTC, so it stays
  // on the device-local calendar day boundary (TDS_Slice_M2 §5/FR-6).
  function addDays(dateStr, n) {
    var parts = dateStr.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + n);
    return localISODate(d);
  }

  // Device-local YYYYMMDD-HHmm, zero-padded (Interchange Contract §7 filename
  // convention — Module 8's CSV/recovery-note pair share this exact stem).
  function filenameTimestamp(d) {
    d = d || new Date();
    var stamp = localISODate(d).replace(/-/g, "");
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return stamp + "-" + hh + mm;
  }

  g.DateUtil = {
    localISODate: localISODate,
    today: today,
    addDays: addDays,
    filenameTimestamp: filenameTimestamp
  };
})(typeof window !== "undefined" ? window : globalThis);
