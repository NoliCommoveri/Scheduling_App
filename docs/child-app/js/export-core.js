// export-core.js — pure logic for Completion CSV Export (Module 8), TDS_Slice_M2 §7.
// No IndexedDB, no DOM, no file I/O here — same discipline as the other
// -core.js modules. Column list/order matches Interchange Contract §2 and
// SRS Module 08 §3 exactly, verified against fixtures/completions_sample.csv.

(function (g) {
  "use strict";

  var COLUMNS = [
    "activityId", "date", "course", "activity", "activityType",
    "plannedBlock", "status", "grade", "childName", "semesterLabel", "sequenceNumber"
  ];

  // FR-1: eligible iff resolved (complete/waived) and not yet exported.
  function isEligible(record) {
    return (record.status === "complete" || record.status === "waived") && record.exported === false;
  }

  // sourceItem: the received Activity or Chore matching record.activityId.
  // isChore distinguishes column sourcing (course/sequenceNumber blank, per §3).
  function buildRow(record, sourceItem, isChore, childName, semesterLabel) {
    return {
      activityId: record.activityId,
      date: record.date,
      course: isChore ? "" : (sourceItem.courseName || ""),
      activity: sourceItem.title || "",
      activityType: isChore ? (sourceItem.choreType || "") : (sourceItem.activityType || ""),
      plannedBlock: sourceItem.blockHint || "",
      status: record.status,
      grade: typeof record.grade === "number" ? record.grade : "",
      childName: childName || "",
      semesterLabel: semesterLabel || "",
      sequenceNumber: typeof sourceItem.sequenceNumber === "number" ? sourceItem.sequenceNumber : ""
    };
  }

  // RFC 4180 field quoting: quote only when the field contains a comma, quote,
  // or newline; internal quotes double.
  function csvField(value) {
    var s = value === null || value === undefined ? "" : String(value);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // Header row always present, always these eleven names, always this order —
  // "the header IS the version" (Interchange Contract §2).
  function toCsv(rows) {
    var lines = [COLUMNS.join(",")];
    rows.forEach(function (row) {
      lines.push(COLUMNS.map(function (col) { return csvField(row[col]); }).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  // Interchange Contract §7: lowercased, non-alphanumerics collapsed to "-".
  function buildChildSlug(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "child";
  }

  // TDS_Slice_M3 §9: themeDisplayName is resolved through the active theme's
  // display mapping (Domain Model §3.9) by the caller — never the raw
  // categoryId. categoryBalances: [{ categoryId, themeDisplayName, balance }],
  // one per category present in the snapshot or with tail-only entries.
  function buildRecoveryNote(dateStr, currentStreak, categoryBalances) {
    var lines = [];
    lines.push("Recovery note — " + dateStr);
    lines.push("");
    lines.push("Streak: " + currentStreak + " day" + (currentStreak === 1 ? "" : "s"));
    lines.push("");
    lines.push("Reward balances:");
    if (categoryBalances.length === 0) {
      lines.push("  (none yet)");
    } else {
      categoryBalances.forEach(function (c) {
        lines.push("  " + c.themeDisplayName + ": " + c.balance);
      });
    }
    lines.push("");
    return lines.join("\n");
  }

  g.ExportCore = {
    COLUMNS: COLUMNS,
    isEligible: isEligible,
    buildRow: buildRow,
    toCsv: toCsv,
    buildChildSlug: buildChildSlug,
    buildRecoveryNote: buildRecoveryNote
  };
})(typeof window !== "undefined" ? window : globalThis);
