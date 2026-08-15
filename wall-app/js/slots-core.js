// slots-core.js — PURE. Placement lookup: resolving a chore row to its
// standing `wall_slots` position (or none — unplaced, in the tray, §3.4)
// and its rendered duration through the §3.5.1 precedence chain. §16
// Phase 5 adds the collision check (§9) that a drop needs to decide
// whether to warn — still pure: it takes already-resolved `{row, chip}`
// pairs and a candidate range, and touches no DOM and no network. §16
// Phase 5b adds `assignedDurationMin` — row 3/4 of the chain in isolation,
// for the adjust sheet's "Use the assigned time (N)" label (day-ui.js).
// TDS_Slice_Wall_Calendar_Redesign.md §3.1 (placement identity), §3.1.2
// (each vs. claim), §3.5.1 (duration chain), §9 (collisions).
//
// The actual WRITE (the PUT/DELETE calls, drag/tap-to-place, carry-forward
// as a consequence of that write) lives in `day-ui.js` and `api.js` — this
// file only ever reads or evaluates, never calls the network.
//
// No file is shared with the Worker (CLAUDE.md §I.A) — the sentinel and key
// shape are re-stated here to match `migrations/0010`'s primary key, not
// imported from it.

(function (g) {
  "use strict";

  var SENTINEL_CHILD_ID = ""; // migrations/0010 — a claim chore's one placement
  // A NUL separator can never appear inside a real id/title, so it's a safe
  // composite-key join char. Written as the escape, not a literal byte —
  // a raw \0 in the source makes the file look binary to git and diff
  // tooling (found on review of §16 Phase 5's diff), for no behavioral gain.
  var NUL = "\u0000";
  var DEFAULT_DURATION_MIN = 15; // packet.js:43's own fallback (§3.5)

  // This file only ever resolves chore rows. School blocks (§5, §16 Phase 7)
  // are NOT a `wall_slots` subject at all — the 2026-08-15 §5 revision (§20)
  // moved them to their own tables (`school-core.js`, `wall_school_blocks`),
  // since a block's shape (one span, many member courses) doesn't fit this
  // file's singleton (child_id, subject_kind, subject_key, instance_key)
  // key. `subjectKind` is kept as a function rather than inlined 'chore'
  // everywhere it's used, so a reader doesn't have to wonder whether it
  // varies.
  function subjectKind(row) {
    return "chore";
  }

  function subjectKeyOf(row) {
    return row.source_id;
  }

  function instanceKeyOf(row) {
    return row.instance_key || "";
  }

  // §3.1.2 — `each` (including one-child and multi-child) places per child;
  // `claim` places once, on the household sentinel, for every participant.
  function isSharedClaim(row) {
    return row.claim_group != null;
  }

  function placementChildId(row) {
    return isSharedClaim(row) ? SENTINEL_CHILD_ID : row.child_id;
  }

  function slotKey(childId, kind, key, instanceKey) {
    return childId + NUL + kind + NUL + key + NUL + (instanceKey || "");
  }

  function dayKey(childId, kind, key, instanceKey, date) {
    return slotKey(childId, kind, key, instanceKey) + NUL + date;
  }

  // Builds a lookup index from `GET /api/wall/slots`'s `slots` array — O(1)
  // per chip instead of an O(n) scan per row rendered.
  function indexSlots(slots) {
    var idx = Object.create(null);
    (slots || []).forEach(function (s) {
      idx[slotKey(s.child_id, s.subject_kind, s.subject_key, s.instance_key)] = s;
    });
    return idx;
  }

  // Same shape for `wall_slot_days` overrides, keyed with the date appended.
  function indexDays(days) {
    var idx = Object.create(null);
    (days || []).forEach(function (d) {
      idx[dayKey(d.child_id, d.subject_kind, d.subject_key, d.instance_key, d.date)] = d;
    });
    return idx;
  }

  // The standing placement for a chore row, or null if it has never been
  // placed. `slotsIndex` is `indexSlots()`'s output.
  function placementFor(slotsIndex, row) {
    var key = slotKey(placementChildId(row), subjectKind(row), subjectKeyOf(row), instanceKeyOf(row));
    return slotsIndex[key] || null;
  }

  function dayOverrideFor(daysIndex, row, date) {
    var key = dayKey(placementChildId(row), subjectKind(row), subjectKeyOf(row), instanceKeyOf(row), date);
    return daysIndex[key] || null;
  }

  // Row 3/4 of §3.5.1's chain with no override applied at all — what the
  // parent authored, or the 15-minute fallback. Exported on its own so the
  // adjust sheet (day-ui.js, §16 Phase 5b) can label "Use the assigned
  // time (N)" without duplicating the fallback constant.
  function assignedDurationMin(row) {
    return row.expected_duration_min != null ? row.expected_duration_min : DEFAULT_DURATION_MIN;
  }

  // §3.5.1's four-step chain, resolved per chip per rendered date:
  // per-day override, standing override, the parent's own estimate, 15 min.
  function resolveDurationMin(row, slot, dayOverride) {
    if (dayOverride && dayOverride.duration_min != null) return dayOverride.duration_min;
    if (slot && slot.duration_min != null) return slot.duration_min;
    return assignedDurationMin(row);
  }

  function isOverridden(slot, dayOverride) {
    return !!((dayOverride && dayOverride.duration_min != null) || (slot && slot.duration_min != null));
  }

  // §9 — a chore is a party to a collision only when it is PRIVATE
  // (`claim_group IS NULL`). A shared `claim` chore never triggers the
  // warning and never receives it, on either side.
  function isPrivateChore(row) {
    return row.claim_group == null;
  }

  function rangesOverlap(aStart, aDuration, bStart, bDuration) {
    return aStart < bStart + bDuration && bStart < aStart + aDuration;
  }

  // §9 — evaluated at the drag, against the child's OTHER rendered rows for
  // that date, using each row's RESOLVED duration (the §3.5.1 chain), not
  // the authored estimate — an override that shortens a chip can clear a
  // warning. `others` is `{row, chip}` pairs already resolved by the
  // caller (a different child, or the subject being moved, may safely be
  // included — both are filtered out here, so the "same child" half of
  // the rule lives in one place rather than being trusted of every
  // caller). Returns the first colliding entry, or null.
  function findCollision(row, candidateStart, candidateDuration, others) {
    if (!isPrivateChore(row)) return null;
    var hit = null;
    (others || []).some(function (other) {
      if (other.row.id === row.id) return false;
      if (other.row.child_id !== row.child_id) return false;
      if (!isPrivateChore(other.row)) return false;
      if (other.chip.startMin == null) return false;
      if (rangesOverlap(candidateStart, candidateDuration, other.chip.startMin, other.chip.durationMin)) {
        hit = other;
        return true;
      }
      return false;
    });
    return hit;
  }

  // The full read for one row on one rendered date: where it starts (null =
  // unplaced, belongs in the tray), how tall it is, and whether that height
  // is the parent's own estimate or a wall override.
  function resolveChip(slotsIndex, daysIndex, row, date) {
    var slot = placementFor(slotsIndex, row);
    var dayOverride = dayOverrideFor(daysIndex, row, date);
    return {
      startMin: slot ? slot.start_min : null,
      durationMin: resolveDurationMin(row, slot, dayOverride),
      overridden: isOverridden(slot, dayOverride),
    };
  }

  g.SlotsCore = {
    SENTINEL_CHILD_ID: SENTINEL_CHILD_ID,
    subjectKeyOf: subjectKeyOf,
    instanceKeyOf: instanceKeyOf,
    isSharedClaim: isSharedClaim,
    placementChildId: placementChildId,
    indexSlots: indexSlots,
    indexDays: indexDays,
    placementFor: placementFor,
    dayOverrideFor: dayOverrideFor,
    assignedDurationMin: assignedDurationMin,
    resolveDurationMin: resolveDurationMin,
    isOverridden: isOverridden,
    isPrivateChore: isPrivateChore,
    rangesOverlap: rangesOverlap,
    findCollision: findCollision,
    resolveChip: resolveChip,
  };
})(typeof window !== "undefined" ? window : globalThis);
