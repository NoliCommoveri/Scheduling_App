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
        return { activities: state.activities, chores: state.chores, meta: state.meta, resolved: resolved, streak: streak };
      });
  }

  // FR-1: live, same-day increment. Called by Module 4/5 right after a write —
  // always re-evaluates *today* specifically, regardless of which date the
  // item that was just resolved actually belonged to.
  function recheckToday() {
    return loadContext().then(function (ctx) {
      var today = g.DateUtil.today();
      var status = C.dayStatus(ctx.activities, ctx.chores, ctx.meta, ctx.resolved, today);
      if (status !== "resolved") return; // FR-2: neutral/breaking never trigger a change
      if (ctx.streak.lastQualifyingDate === today) return; // already counted today
      return g.DB.putSingleton("streak", {
        currentStreak: ctx.streak.currentStreak + 1,
        lastQualifyingDate: today
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
        var status = C.dayStatus(ctx.activities, ctx.chores, ctx.meta, ctx.resolved, d);
        if (status === "breaking") {
          return g.DB.putSingleton("streak", { currentStreak: 0, lastQualifyingDate: d });
        }
        d = g.DateUtil.addDays(d, 1);
      }
    });
  }

  g.Streak = { recheckToday: recheckToday, reconcileOnOpen: reconcileOnOpen };
})(typeof window !== "undefined" ? window : globalThis);
