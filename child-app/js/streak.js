// streak.js — Streak (Module 7), wired to IndexedDB. TDS_Slice_M2 §5.
// Sole writer of the `streak` singleton (FR-7) — every other module (Module 4/5's
// notifyStreak trigger, later Module 6/11) reads it or calls into this file only.

(function (g) {
  "use strict";

  var C = g.StreakCore;

  function loadContext() {
    return Promise.all([g.DB.loadState(), g.DB.getAll("activityRecords"), g.DB.getSingleton("streak")])
      .then(function (r) {
        var state = r[0];
        var resolved = Object.create(null);
        r[1].forEach(function (rec) { resolved[rec.activityId] = true; });
        var streak = r[2] || { currentStreak: 0, lastQualifyingDate: null };
        return { rows: state.rows, resolved: resolved, streak: streak };
      });
  }

  // The single write point for the `streak` singleton (FR-7), now also the
  // single upload point (Online Revamp §3.5).
  //
  // `longestStreak` is new and exists because §3.5 has a column for it that
  // only this device can fill — the server stores the result so reporting can
  // read it without recomputing, and there is nowhere else the high-water mark
  // could come from. Nothing in the Child App reads it; it is carried, not
  // used. Derived rather than stored independently, so a device that upgrades
  // mid-semester starts from its current streak instead of zero.
  //
  // Two optional `next` fields, both FR-8/§3.4 of the Child Feedback Loop TDS:
  //   - `priorStreak`: stamped onto the stored record when passed, omitted
  //     (and so cleared — this is a `put`, not a patch) otherwise. Only
  //     recheckToday's live advance below passes one.
  //   - `longestStreak`: when passed, used verbatim instead of the derived
  //     max. undoToday is the only caller that passes this — a restore has
  //     to put the pre-advance high-water mark back exactly, and deriving it
  //     from `prev` here would just re-read the inflated value being undone.
  function write(prev, next) {
    var current = Math.max(0, next.currentStreak || 0);
    var longest = typeof next.longestStreak === "number"
      ? next.longestStreak
      : Math.max((prev && prev.longestStreak) || 0, (prev && prev.currentStreak) || 0, current);
    var record = {
      currentStreak: current,
      lastQualifyingDate: next.lastQualifyingDate || null,
      longestStreak: longest
    };
    if (next.priorStreak) record.priorStreak = next.priorStreak;
    return g.DB.putSingleton("streak", record).then(function () {
      if (!g.Outbox) return record;
      return g.Outbox.enqueueStreak(record).then(function () { return record; });
    });
  }

  // FR-1: live, same-day increment. Called by Module 4/5 right after a write —
  // always re-evaluates *today* specifically, regardless of which date the
  // item that was just resolved actually belonged to.
  function recheckToday() {
    return loadContext().then(function (ctx) {
      var today = g.DateUtil.today();
      var status = C.dayStatus(ctx.rows, ctx.resolved, today);
      if (status !== "resolved") return; // FR-2: neutral/breaking never trigger a change
      if (ctx.streak.lastQualifyingDate === today) return; // already counted today
      return write(ctx.streak, {
        currentStreak: ctx.streak.currentStreak + 1,
        lastQualifyingDate: today,
        // FR-8: what this advance is displacing, so an Undo later today can
        // restore it exactly. FR-1's own same-day cap means at most one of
        // these can ever be live at once.
        priorStreak: {
          currentStreak: ctx.streak.currentStreak,
          lastQualifyingDate: ctx.streak.lastQualifyingDate,
          longestStreak: ctx.streak.longestStreak
        }
      });
    });
  }

  // FR-8/FR-9 (Child Feedback Loop TDS §3.4) — the reversal of recheckToday's
  // live advance. Called from Completion.undoItem, in the same action as that
  // feature's reward clawback, never on its own timer.
  //
  // Writes only when both hold: today is the day most recently counted, and
  // today no longer qualifies now that the just-undone item is unresolved
  // again. Either condition failing means nothing here needs to change —
  // undoing a non-required item, or a required one on a day still fully
  // resolved by its other items, correctly leaves the streak alone.
  function undoToday() {
    return loadContext().then(function (ctx) {
      var today = g.DateUtil.today();
      if (ctx.streak.lastQualifyingDate !== today) return;
      if (C.dayStatus(ctx.rows, ctx.resolved, today) === "resolved") return;

      var prior = ctx.streak.priorStreak;
      if (!prior) return; // nothing to restore to — see §5's priorStreak note
      return write(ctx.streak, {
        currentStreak: prior.currentStreak,
        lastQualifyingDate: prior.lastQualifyingDate,
        // Restored verbatim, not re-derived — see write()'s comment above.
        longestStreak: prior.longestStreak
        // priorStreak intentionally omitted: one level of history is
        // sufficient (FR-1's same-day cap), and the restore consumes it.
      });
    });
  }

  // FR-3: gap catch-up, on every app open. Walks device-local dates from
  // lastQualifyingDate+1 up to (not including) today — FR-4 forbids judging
  // today itself. Stops at the first breaking day found (SRS §5 ordering rule)
  // and resets to 0, advancing lastQualifyingDate to that day so a future
  // reconciliation doesn't re-walk already-judged history. A clean walk leaves
  // currentStreak and lastQualifyingDate both unchanged (TDS §5 — the only two
  // ways lastQualifyingDate ever advances are this reset case and the live path).
  function reconcileOnOpen() {
    return loadContext().then(function (ctx) {
      if (!ctx.streak.lastQualifyingDate) return; // nothing to reconcile yet
      var today = g.DateUtil.today();
      var d = g.DateUtil.addDays(ctx.streak.lastQualifyingDate, 1);
      while (d < today) {
        var status = C.dayStatus(ctx.rows, ctx.resolved, d);
        if (status === "breaking") {
          // A reset keeps longestStreak — that is the point of a high-water
          // mark, and write() derives it from the run being ended.
          // No priorStreak passed: a reset is not an advance, so there is
          // nothing here for a later Undo to walk back to (FR-8's note in
          // §5) — omitting the field clears any stale one left over.
          return write(ctx.streak, { currentStreak: 0, lastQualifyingDate: d });
        }
        d = g.DateUtil.addDays(d, 1);
      }
    });
  }

  g.Streak = { recheckToday: recheckToday, undoToday: undoToday, reconcileOnOpen: reconcileOnOpen, write: write };
})(typeof window !== "undefined" ? window : globalThis);
