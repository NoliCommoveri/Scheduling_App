// remind-core.js — PURE. Which placed chores are due to chime, and when
// (TDS_Slice_Wall_Calendar_Redesign.md §11.5, §16 Phase 6b). No DOM, no
// WebAudio, no network — `sound.js` makes the noise and `app.js` schedules
// around this file's answers. Leans on `ChoresCore`/`SlotsCore`, already
// loaded, rather than re-deriving "today's placed chores" a third way.
//
// Exact-minute matching (`c.startMin !== nowMin` in `dueNow`) is the whole
// mechanism behind §14.14's "not retro-fired on boot": a chore due at 08:00
// is a candidate for a chime only in the one minute nowMin equals 480. A
// page loading at 08:47, or a tick that skipped a minute because the tab was
// backgrounded, simply never sees that equality hold again — no "already
// missed" bookkeeping is needed to get that guarantee.

(function (g) {
  "use strict";

  // One entry per PLACED, PENDING chore on `date`, across every active
  // child — the raw material both `dueNow` and `nextChimeMin` read.
  // Unplaced chores (chip.startMin == null) are never chime candidates:
  // this is placement's sound (§11.5), and there is no "when" to ring for
  // one that was never scheduled.
  function chimeCandidates(state, date) {
    var slotsIdx = g.SlotsCore.indexSlots(state.slots);
    var daysIdx = g.SlotsCore.indexDays(state.slotDays);
    var wdIdx = g.SlotsCore.indexWeekdays(state.slotWeekdays);
    var out = [];
    (state.children || []).forEach(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      chores.forEach(function (row) {
        if (row.status !== "pending") return;
        var chip = g.SlotsCore.resolveChip(slotsIdx, wdIdx, daysIdx, row, date);
        if (chip.startMin == null) return;
        out.push({ row: row, child: child, startMin: chip.startMin });
      });
    });
    return out;
  }

  // §10.2's isNight, restated here rather than imported — nav-ui.js's own
  // copy names ambient-ui.js as what it supersedes, and this file has no
  // DOM to share it through anyway (CLAUDE.md §I.A — no file shared across
  // concerns beyond a documented mirror).
  function inQuietHours(nowMin, quietStartHour, quietEndHour) {
    if (quietStartHour == null || quietEndHour == null || quietStartHour === quietEndHour) return false;
    var startMin = quietStartHour * 60, endMin = quietEndHour * 60;
    if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
    return nowMin >= startMin || nowMin < endMin; // wraps midnight, e.g. 21 -> 6
  }

  function fireKey(row, date) {
    return row.id + "@" + date;
  }

  // Entries due at EXACTLY `nowMin` — pending, placed, the child's sound on
  // (default ON — an entry absent from `soundOnByChild` is never silent),
  // outside quiet hours, and not already fired this instant. `firedKeys` is
  // a plain object app.js owns and clears at rollover; passing null treats
  // nothing as already-fired (the tests below do this to isolate the other
  // rules one at a time).
  function dueNow(candidates, nowMin, opts, firedKeys) {
    opts = opts || {};
    var soundOnByChild = opts.soundOnByChild || {};
    var date = opts.date;
    if (inQuietHours(nowMin, opts.quietStartHour, opts.quietEndHour)) return [];
    return candidates.filter(function (c) {
      if (c.startMin !== nowMin) return false;
      if (soundOnByChild[c.child.id] === false) return false;
      var key = fireKey(c.row, date);
      if (firedKeys && firedKeys[key]) return false;
      return true;
    });
  }

  // The earliest upcoming instant strictly after `afterMin`, or null if
  // nothing is left today — how app.js decides whether a local check this
  // minute is worth a network poll at all (§11.5: "one poll immediately
  // before a chime fires, not a faster cadence"). Ignores quiet hours and
  // the per-child toggle on purpose: a scheduled-but-silenced instant still
  // costs nothing to check for locally, and computing "the next AUDIBLE
  // instant" here would duplicate `dueNow`'s own filtering for no benefit.
  function nextChimeMin(candidates, afterMin) {
    var next = null;
    candidates.forEach(function (c) {
      if (c.startMin > afterMin && (next == null || c.startMin < next)) next = c.startMin;
    });
    return next;
  }

  g.RemindCore = {
    chimeCandidates: chimeCandidates,
    inQuietHours: inQuietHours,
    fireKey: fireKey,
    dueNow: dueNow,
    nextChimeMin: nextChimeMin,
  };
})(typeof window !== "undefined" ? window : globalThis);
