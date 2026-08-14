// chores-core.js — PURE. The on-day rule and shared/claimed classification
// (TDS_Slice_Wall_Display_App.md §5.1.1, generalized past "today" by
// TDS_Slice_Wall_Calendar_Redesign.md §4.5). Mirrors `planner-core.js:48`
// (`effectiveDueDate`) and `:179` (`onToday`) — re-implemented, not shared,
// per CLAUDE.md §I.A.
//
// §16 Phase 4 adds block classification (§4.4): which of the four canonical
// blocks a chip belongs to, mirroring `planner-core.js:54-56`'s
// `effectiveBlock` for the unplaced case and adding the clock-time
// classification a placed chip needs, which the child app has no equivalent
// of.
//
// The wall's rule deliberately does NOT carry planner-core's `isResolved`
// early-exit: a completed row must still count as "on this day" so §8.4's
// done-in-place chip has a day to render on. Dropping the overdue
// *roll-forward* once a row is no longer `pending` is kept, though — a
// stale completed chore from a past due date must not go on counting itself
// forever. The bound that keeps this from actually being "forever" is the
// 7-day-back fetch window (poll.js): a row due more than a week ago simply
// isn't in `rows` any more.

(function (g) {
  "use strict";

  function parsePayload(raw) {
    if (raw == null) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  // planner-core.js:48 — the child's deferral wins when present.
  function effectiveDueDate(row) {
    return row.deferred_to || row.date;
  }

  // Chores are always required (packet.js pins it true; assignment-core.js's
  // decorate() reads the same payload flag with the same `!== false`
  // fallback so an older row missing the key still rolls forward).
  function isRequired(row) {
    return parsePayload(row.payload).required !== false;
  }

  // §4.5 — generalized past "today": `date` is the day being rendered,
  // `today` is the actual current day. The overdue roll-forward only fires
  // when the two coincide — rendering a PAST day must show exactly what was
  // due that day, not everything still outstanding before it (otherwise
  // scrolling back through the week would show the same overdue chore on
  // every day at once), and rendering a future day never rolls anything
  // forward onto it either.
  function onDate(row, date, today) {
    var due = effectiveDueDate(row);
    if (due === date) return true;
    if (date !== today) return false;
    return due < date && isRequired(row) && row.status === "pending";
  }

  // §4.4 — block mode's four canonical blocks, matching planner-core.js:36
  // (`CANON_BLOCKS`) and the Management App's `BLOCK_HINTS` (chores.js:19)
  // so the wall and the child's own tablet name the parts of a day
  // identically.
  var CANON_BLOCKS = ["morning", "afternoon", "evening", "night"];
  var CANON_BLOCK_SET = { morning: 1, afternoon: 1, evening: 1, night: 1 };

  // §4.4's default block-hour table, in minutes from local midnight. `night`
  // wraps past midnight, so its end is expressed as 1440 + 360 (06:00 the
  // *next* day) rather than folded back into 0-1439 — blockVirtualMin()
  // below is what callers use to place a real clock time inside it.
  var BLOCK_HOURS = {
    morning: { start: 6 * 60, end: 12 * 60 },
    afternoon: { start: 12 * 60, end: 17 * 60 },
    evening: { start: 17 * 60, end: 21 * 60 },
    night: { start: 21 * 60, end: 24 * 60 + 6 * 60 },
  };

  function canonicalBlock(v) { return v && CANON_BLOCK_SET[v] ? v : null; }

  // Mirrors planner-core.js:54-56's `effectiveBlock` exactly:
  // child_block_hint wins, then block_hint, then 'morning'. Used only for an
  // UNPLACED chore (§4.4, §3.4's last paragraph) — a placed one's block
  // comes from where it sits, not from the hint.
  function effectiveBlockHint(row) {
    return canonicalBlock(row.child_block_hint) || canonicalBlock(row.block_hint) || "morning";
  }

  // Which of the four blocks a real clock minute-of-day falls in (§4.4's
  // table). Not a planner-core mirror — the child app has no clock-time
  // concept to mirror here; this is new to the wall.
  function blockFromStartMin(startMin) {
    if (startMin >= BLOCK_HOURS.morning.start && startMin < BLOCK_HOURS.morning.end) return "morning";
    if (startMin >= BLOCK_HOURS.afternoon.start && startMin < BLOCK_HOURS.afternoon.end) return "afternoon";
    if (startMin >= BLOCK_HOURS.evening.start && startMin < BLOCK_HOURS.evening.end) return "evening";
    return "night"; // >= 21:00 or < 06:00 — the wrap
  }

  // §4.4 — "a placed chore's block comes from its start_min... the
  // placement wins" over the hint. `chip` is slots-core.js's resolveChip()
  // result.
  function blockForChip(row, chip) {
    return chip.startMin != null ? blockFromStartMin(chip.startMin) : effectiveBlockHint(row);
  }

  // Maps a real clock minute-of-day into `block`'s own coordinate space, so
  // a single-block grid can place chips with one linear top:px formula even
  // when the block wraps midnight (night only, e.g. a 05:30 chore is drawn
  // near the bottom of the night block, not the top).
  function blockVirtualMin(startMin, block) {
    var hours = BLOCK_HOURS[block];
    return startMin < hours.start ? startMin + 1440 : startMin;
  }

  // Rendering class for a chore row in this child's list (§5.1, last
  // paragraph). A shared chore already claimed by a sibling is visible but
  // not tappable — never hidden, which is the one place this file does NOT
  // mirror the child app's `isPlannable` (assignment-core.js:85-88), which
  // hides such a row outright. The wall shows it on purpose.
  function claimState(row, childId) {
    if (row.claimed_by == null) return "open";
    return row.claimed_by === childId ? "mine" : "claimed-by-sibling";
  }

  // One child's chore rows on one rendered date — the day view's raw
  // material before slots-core.js splits it into placed vs. the unscheduled
  // tray (§3.4). Complete rows are included, not dropped: §8.4 keeps a
  // finished chore visible in its slot rather than removing it.
  function choresForChild(rows, childId, date, today) {
    return (rows || []).filter(function (row) {
      if (row.kind !== "chore" || row.child_id !== childId) return false;
      if (row.rescinded_at != null) return false;
      return onDate(row, date, today);
    });
  }

  g.ChoresCore = {
    CANON_BLOCKS: CANON_BLOCKS,
    BLOCK_HOURS: BLOCK_HOURS,
    effectiveDueDate: effectiveDueDate,
    isRequired: isRequired,
    onDate: onDate,
    claimState: claimState,
    choresForChild: choresForChild,
    effectiveBlockHint: effectiveBlockHint,
    blockFromStartMin: blockFromStartMin,
    blockForChip: blockForChip,
    blockVirtualMin: blockVirtualMin,
  };
})(typeof window !== "undefined" ? window : globalThis);
