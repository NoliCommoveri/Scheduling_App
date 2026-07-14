// importer.js — the browser front door for Packet Import (Module 2 FR-1).
// Acquisition (file selection) is a swappable step; validation + merge below are
// source-independent and identical to what the Node harness exercises.

(function (g) {
  "use strict";

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  }

  // Resolved (completed/waived) iff activityRecords holds an entry for this id
  // (Module 4 landed; Module 5/Waive will write the same store). merge-core.js
  // calls this synchronously per item, so the resolved set is loaded up front.
  function buildIsResolved(activityRecords) {
    var resolved = Object.create(null);
    activityRecords.forEach(function (rec) { resolved[rec.activityId] = true; });
    return function (id) { return !!resolved[id]; };
  }

  // Returns a Promise of the import outcome:
  //   { ok:true, counts:{added, refreshed} }
  //   { ok:false, versionError|parseError, message }
  //   { ok:false, errors:[...] }
  function importText(text) {
    var result = g.ImportCore.parseAndValidate(text, g.PACKET_SCHEMA);
    if (!result.ok) return Promise.resolve(result);

    var packet = result.packet;
    return Promise.all([g.DB.loadState(), g.DB.getAll("activityRecords")]).then(function (r) {
      var state = r[0];
      var isResolved = buildIsResolved(r[1]);
      var existing = { activities: {}, chores: {}, events: {} };
      state.activities.forEach(function (a) { existing.activities[a.id] = a; });
      state.chores.forEach(function (c) { existing.chores[c.id] = c; });
      state.events.forEach(function (e) { existing.events[e.id] = e; });

      var merge = g.MergeCore.mergePacket(packet, existing, isResolved);
      return g.DB.applyMerge(merge).then(function () {
        var addedActivities = merge.activityPuts.filter(function (r) { return !existing.activities[r.id]; }).length;
        var addedChores = merge.chorePuts.filter(function (r) { return !existing.chores[r.id]; }).length;
        var added = addedActivities + addedChores + merge.eventPuts.length;
        var refreshed = (merge.activityPuts.length + merge.chorePuts.length) - addedActivities - addedChores;
        return { ok: true, counts: { added: added, refreshed: refreshed }, semesterLabel: packet.semesterLabel };
      });
    });
  }

  function importFile(file) {
    return readFileText(file).then(importText);
  }

  g.Importer = { importFile: importFile, importText: importText };
})(typeof window !== "undefined" ? window : globalThis);


