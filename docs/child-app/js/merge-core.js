// merge-core.js — additive merge with refresh-on-pending (Module 2 FR-4, §2.2/§2.3).
// Pure: takes the existing records as maps and a validated packet, returns the
// records to write. Never touches plannerMeta (child overrides survive imports).
//
// isResolved(id) is real as of Module 4 (importer.js builds it from
// activityRecords) — a re-import of an already-completed/waived item is now a
// genuine no-op, per SRS Module 2 §2.3.

(function (g) {
  "use strict";

  function maxReceiptIndex(existingActivities, existingChores) {
    var max = -1;
    function scan(map) {
      for (var id in map) {
        var r = map[id];
        if (r && typeof r.receiptIndex === "number" && r.receiptIndex > max) max = r.receiptIndex;
      }
    }
    scan(existingActivities);
    scan(existingChores);
    return max;
  }

  // existing*: { id -> record } maps of what's already on the device.
  // isResolved(id): true iff the item has a completion/waive record.
  function mergePacket(packet, existing, isResolved) {
    existing = existing || {};
    var exA = existing.activities || {};
    var exC = existing.chores || {};
    var exE = existing.events || {};
    isResolved = isResolved || function () { return false; };

    var activityPuts = [];
    var chorePuts = [];
    var eventPuts = [];

    // Single counter, seeded past any existing receipt index so re-imports append
    // rather than collide (tie-break on id keeps order total regardless).
    var counter = maxReceiptIndex(exA, exC) + 1;

    // Refresh copies only received fields; it must preserve receiptIndex and must
    // not carry any device-only bookkeeping beyond it.
    function mergeItem(incoming, existingRecord, puts) {
      if (!existingRecord) {
        // New item — add and stamp receipt order.
        var added = Object.assign({}, incoming, { receiptIndex: counter++ });
        puts.push(added);
      } else if (isResolved(incoming.id)) {
        // Resolved (completed/waived) — full no-op. Nothing pushed.
        return;
      } else {
        // Pending — refresh received fields, keep the original receiptIndex.
        var refreshed = Object.assign({}, incoming, { receiptIndex: existingRecord.receiptIndex });
        puts.push(refreshed);
      }
    }

    (packet.days || []).forEach(function (day) {
      // Traversal order for receiptIndex: days in order, activities then chores.
      (day.activities || []).forEach(function (a) {
        // Activities carry no date of their own in the packet — copy it down.
        var record = Object.assign({}, a, { date: day.date });
        mergeItem(record, exA[a.id], activityPuts);
      });
      (day.chores || []).forEach(function (c) {
        // Chores already carry their own date directly.
        mergeItem(c, exC[c.id], chorePuts);
      });
      (day.events || []).forEach(function (e) {
        // Events have no receiptIndex and no pending/resolved lifecycle.
        // A multi-day event repeats its EVT id across days; put is idempotent.
        if (!exE[e.id]) eventPuts.push(e);
        exE[e.id] = e; // guard against re-pushing the same repeated id this import
      });
    });

    return { activityPuts: activityPuts, chorePuts: chorePuts, eventPuts: eventPuts };
  }

  g.MergeCore = { mergePacket: mergePacket };
})(typeof window !== "undefined" ? window : globalThis);


