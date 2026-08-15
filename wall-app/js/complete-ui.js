// complete-ui.js — the completion sheet: who (already answered by the
// column a tap landed in, §8.2), when (a 5-minute stepper defaulted to
// now, §8.3), and Undo for an already-done chip (§8.5). Wall Calendar
// Redesign §16 Phase 6.
//
// This is the write path TDS_Slice_Wall_Display_App.md §6 already
// specified for the wall but which never shipped — Phase 4a of the
// superseded slice does not exist in the tree, so nothing here replaces
// working code. The shape mirrors child-app/js/completion.js's
// completeItem/undoItem and claim.js's take/release — re-implemented, not
// shared, per CLAUDE.md §I.A.
//
// Like poll.js, this file does the app's actual IO (network writes,
// localStorage) and is not a `*-core.js` — it is not unit-tested per §14;
// the pure lookups it leans on (ChoresCore, SlotsCore) already are.

(function (g) {
  "use strict";

  var STEP_MS = 5 * 60 * 1000; // §8.3 — 5-minute steps, not the grid's 15
  var TOAST_MS = 3000; // §6.3 — "cheerful, three seconds"

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function isSharedClaim(row) {
    return row.claim_group != null;
  }

  function mintEntryId() {
    if (g.crypto && typeof g.crypto.randomUUID === "function") return g.crypto.randomUUID();
    // Same fallback shape completion-core.js:76-81 uses: unique enough to be
    // a primary key, only ever compared for equality (idempotent replay).
    return "rw-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // §6.2's earn rule, restated as code once here: amount = the snapshotted
  // reward_amount, or 1 when NULL; category = the row's own; reason =
  // 'earned'; earned_at = the sheet's own moment, not the tap.
  function buildEntry(row, amount, reason, at) {
    return {
      id: mintEntryId(),
      assignmentId: row.id,
      category: row.reward_category,
      amount: amount,
      reason: reason,
      earnedAt: at,
    };
  }

  function resolvedAmount(row) {
    return typeof row.reward_amount === "number" && isFinite(row.reward_amount) ? row.reward_amount : 1;
  }

  // ---- the pending-earn retry queue (§6.2 — the only retry queue in the app) ----

  function queueEarn(childId, entry) {
    var list = g.Store.getPendingEarns();
    list.push({
      id: entry.id, childId: childId, assignmentId: entry.assignmentId,
      category: entry.category, amount: entry.amount, reason: entry.reason,
      earnedAt: entry.earnedAt, attempts: 0,
    });
    g.Store.setPendingEarns(list);
  }

  function dequeueEarn(id) {
    g.Store.setPendingEarns(g.Store.getPendingEarns().filter(function (e) { return e.id !== id; }));
  }

  // §6.2's table: `rejected` is removed from the queue AND surfaced, so a
  // permanently-refused row in an append-only ledger leaves a trace an
  // admin can act on (POST /api/rewards/adjust) instead of vanishing.
  function recordFailedEarn(childId, entry, reason) {
    var list = g.Store.getFailedEarns();
    list.push({
      id: entry.id, childId: childId, assignmentId: entry.assignmentId,
      category: entry.category, amount: entry.amount, reason: reason, at: Date.now(),
    });
    g.Store.setFailedEarns(list);
  }

  // Sends one earn entry and classifies the Worker's three-answer table
  // (§6.2): applied -> remove; rejected -> remove + surface; deferred or a
  // network error -> keep, retried on the next poll. Never rejects its own
  // promise — a failed send is a queue state change, not a caller error.
  function sendEarn(childId, entry) {
    return g.WallApi.postRewardEntries(childId, [{
      id: entry.id, assignmentId: entry.assignmentId, category: entry.category,
      amount: entry.amount, reason: entry.reason, earnedAt: entry.earnedAt,
    }]).then(function (res) {
      var rejected = (res.rejected || []).find(function (r) { return r.id === entry.id; });
      if (rejected) { dequeueEarn(entry.id); recordFailedEarn(childId, entry, rejected.error); return; }
      var deferred = (res.deferred || []).find(function (d) { return d.id === entry.id; });
      if (deferred) return; // keep queued, retry next poll
      dequeueEarn(entry.id); // applied, or already there (idempotent replay)
    }).catch(function () { /* network error — keep queued, retry next poll */ });
  }

  // Drained on every successful poll (§6.2), not just right after a write —
  // an entry that failed to send at completion time gets another chance
  // every 10 minutes, or sooner via any interaction-triggered poll.
  function drainPendingEarns() {
    var pending = g.Store.getPendingEarns();
    if (!pending.length) return Promise.resolve();
    return pending.reduce(function (p, entry) {
      return p.then(function () { return sendEarn(entry.childId, entry); });
    }, Promise.resolve());
  }

  // A fresh earn send: try once now; on a transient failure (deferred or a
  // network error), fall into the same queue drainPendingEarns retries.
  function creditEarn(childId, row, at) {
    if (row.reward_category == null) return Promise.resolve(); // §6.2 — credits nothing, and says so
    var entry = buildEntry(row, resolvedAmount(row), "earned", at);
    return g.WallApi.postRewardEntries(childId, [{
      id: entry.id, assignmentId: entry.assignmentId, category: entry.category,
      amount: entry.amount, reason: entry.reason, earnedAt: entry.earnedAt,
    }]).then(function (res) {
      var rejected = (res.rejected || []).find(function (r) { return r.id === entry.id; });
      if (rejected) { recordFailedEarn(childId, entry, rejected.error); return; }
      var deferred = (res.deferred || []).find(function (d) { return d.id === entry.id; });
      if (deferred) queueEarn(childId, entry);
    }).catch(function () { queueEarn(childId, entry); });
  }

  // §8.5 — the compensating ledger row. Never a delete; a chore that
  // credited nothing under the NULL-category clause reverses nothing.
  function reverseEarn(childId, row, at) {
    if (row.reward_category == null) return Promise.resolve();
    var entry = buildEntry(row, -resolvedAmount(row), "adjustment", at);
    return g.WallApi.postRewardEntries(childId, [{
      id: entry.id, assignmentId: entry.assignmentId, category: entry.category,
      amount: entry.amount, reason: entry.reason, earnedAt: entry.earnedAt,
    }]).then(function (res) {
      var rejected = (res.rejected || []).find(function (r) { return r.id === entry.id; });
      if (rejected) { recordFailedEarn(childId, entry, rejected.error); return; }
      var deferred = (res.deferred || []).find(function (d) { return d.id === entry.id; });
      if (deferred) queueEarn(childId, entry);
    }).catch(function () { queueEarn(childId, entry); });
  }

  // §6.1 — immediately before a write, re-poll and refuse a row that is no
  // longer `pending`. This is what keeps a chore already ticked on the
  // child's own tablet from being credited twice. `pollNow()` is the same
  // re-fetch every placement write already triggers (day-ui.js).
  function refreshRow(id) {
    return g.Poll.pollNow().then(function () {
      return g.Poll.getState().rows.find(function (r) { return r.id === id; }) || null;
    });
  }

  // §6.1 — an ordinary chore.
  function completeOrdinary(childId, row, at) {
    return g.WallApi.postCompletions(childId, [{ id: row.id, status: "complete", completedAt: at }])
      .then(function (res) {
        var rejected = (res.rejected || []).find(function (r) { return r.id === row.id; });
        if (rejected) return { ok: false, message: rejected.error };
        return creditEarn(childId, row, at).then(function () { return { ok: true }; });
      });
  }

  // §6.3/§8.3.1 — the arbitrated claim, sending the sheet's own time so the
  // ledger and the assignment row agree about when the work happened.
  function completeClaim(childId, row, at) {
    return g.WallApi.claim(childId, row.id, { completedAt: at }).then(function (res) {
      if (!res.claimed) return { ok: false, claimedElsewhere: true };
      return creditEarn(childId, row, at).then(function () { return { ok: true }; });
    });
  }

  // §8.5 — Undo. An ordinary chore posts `pending`; a shared one releases
  // the claim INSTEAD (step 1 is skipped, not reordered, §6.5) — the
  // release route has already written `pending` server-side, and
  // /api/wall/completions refuses a claim_group row outright.
  function undoOrdinary(childId, row) {
    var at = Date.now();
    return g.WallApi.postCompletions(childId, [
      { id: row.id, status: "pending", completedAt: null, grade: null, completionNote: null },
    ]).then(function (res) {
      var rejected = (res.rejected || []).find(function (r) { return r.id === row.id; });
      if (rejected) return { ok: false, message: rejected.error };
      return reverseEarn(childId, row, at).then(function () { return { ok: true }; });
    });
  }

  function undoClaim(childId, row) {
    var at = Date.now();
    return g.WallApi.releaseClaim(childId, row.id).then(function (res) {
      if (!res.released) return { ok: false, message: "This chore was already released." };
      return reverseEarn(childId, row, at).then(function () { return { ok: true }; });
    });
  }

  // ---- the sheet's own DOM -------------------------------------------------

  var current = null; // { row, child, value(ms), hostEl, overlayEl, busy } while open

  function isOpen() {
    return !!current;
  }

  function close() {
    if (current && current.overlayEl && current.overlayEl.parentNode) current.overlayEl.remove();
    current = null;
  }

  function futureBoundBad(ms) {
    return ms > Date.now();
  }

  function timeLabel(ms) {
    var fmt = (g.Store.getSettings().timeFormat) || "24h";
    var d = new Date(ms);
    var today = g.Poll.todayLocal();
    var pad2 = function (n) { return n < 10 ? "0" + n : "" + n; };
    var iso = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    var clock = g.TimeCore.formatDate(d, fmt);
    if (iso === today) return clock;
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + ", " + clock;
  }

  function showEphemeralMessage(hostEl, text, kind) {
    var existing = hostEl.querySelector(".complete-toast");
    if (existing) existing.remove();
    var toast = el('<div class="complete-toast' + (kind ? " " + kind : "") + '"></div>');
    toast.textContent = text;
    hostEl.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("visible"); });
    setTimeout(function () {
      toast.classList.remove("visible");
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 250);
    }, TOAST_MS);
  }

  function setBusy(busy) {
    if (!current) return;
    current.busy = busy;
    var card = current.overlayEl.querySelector(".complete-sheet-card");
    if (card) card.classList.toggle("busy", busy);
    current.overlayEl.querySelectorAll("button").forEach(function (b) { b.disabled = busy; });
  }

  function showError(text) {
    if (!current) return;
    var err = current.overlayEl.querySelector(".err-text");
    if (err) err.textContent = text || "";
  }

  function paintStepper() {
    if (!current) return;
    var valueEl = current.overlayEl.querySelector(".complete-sheet-value");
    var confirmBtn = current.overlayEl.querySelector("#completeConfirm");
    if (valueEl) valueEl.textContent = timeLabel(current.value);
    if (confirmBtn) confirmBtn.disabled = current.busy || futureBoundBad(current.value);
  }

  function submitComplete() {
    if (!current || current.busy || futureBoundBad(current.value)) return;
    var row = current.row, child = current.child, value = current.value, hostEl = current.hostEl;
    setBusy(true);
    showError("");
    refreshRow(row.id).then(function (fresh) {
      if (!current) return; // sheet closed (e.g. rollover) while the pre-check ran
      if (!fresh || fresh.status !== "pending") {
        setBusy(false);
        close();
        showEphemeralMessage(hostEl, "That chore already changed — refreshed.");
        return;
      }
      var write = isSharedClaim(fresh) ? completeClaim : completeOrdinary;
      write(child.id, fresh, value).then(function (result) {
        if (result.claimedElsewhere) {
          // §6.3 — cheerful, three seconds, then the row re-renders as
          // claimed. The claim route's losing answer carries no winner's
          // name (`{ claimed: false }` alone), so this stays generic rather
          // than guessing one.
          setBusy(false);
          close();
          showEphemeralMessage(hostEl, "Someone else got there first!");
          g.Poll.pollNow();
          return;
        }
        if (!result.ok) {
          setBusy(false);
          showError(result.message || "Couldn't save that — try again.");
          return;
        }
        g.Poll.pollNow().then(function () {
          setBusy(false);
          close();
        });
      }).catch(function () {
        setBusy(false);
        showError("Couldn't save that — try again.");
      });
    });
  }

  function submitUndo() {
    if (!current || current.busy) return;
    var row = current.row, child = current.child, hostEl = current.hostEl;
    setBusy(true);
    showError("");
    var undo = isSharedClaim(row) ? undoClaim : undoOrdinary;
    undo(child.id, row).then(function (result) {
      if (!result.ok) {
        setBusy(false);
        showError(result.message || "Couldn't undo — try again.");
        return;
      }
      g.Poll.pollNow().then(function () {
        setBusy(false);
        close();
        showEphemeralMessage(hostEl, "Undone.");
      });
    }).catch(function () {
      setBusy(false);
      showError("Couldn't undo — try again.");
    });
  }

  function buildPendingBody(row) {
    var noReward = row.reward_category == null;
    return (
      '<div class="complete-sheet-stepper">' +
        '<button class="btn ghost complete-step" data-step="-1" type="button">&minus;</button>' +
        '<div class="complete-sheet-value"></div>' +
        '<button class="btn ghost complete-step" data-step="1" type="button">+</button>' +
      "</div>" +
      (noReward ? '<div class="complete-sheet-note">No reward set for this chore.</div>' : "") +
      '<div class="err-text"></div>' +
      '<div class="wiz-actions">' +
        '<button class="btn ghost" id="completeCancel">Cancel</button>' +
        '<button class="btn" id="completeConfirm">Mark complete</button>' +
      "</div>"
    );
  }

  function buildDoneBody(row, fmt) {
    var when = row.completed_at != null ? g.TimeCore.formatDate(new Date(row.completed_at), fmt) : "an earlier time";
    return (
      '<div class="complete-sheet-done-label">Completed at ' + escapeHtml(when) + "</div>" +
      '<div class="err-text"></div>' +
      '<div class="wiz-actions">' +
        '<button class="btn ghost" id="completeClose">Close</button>' +
        '<button class="btn" id="completeUndo">Undo</button>' +
      "</div>"
    );
  }

  // A `waived` row is neither of §8's two states — the wall never writes a
  // waive (§6.6) and has no business un-waiving one through the completion
  // route either, so this is read-only: no confirm, no Undo, just Close.
  function buildWaivedBody() {
    return (
      '<div class="complete-sheet-done-label">Excused — waived by a parent.</div>' +
      '<div class="wiz-actions"><button class="btn" id="completeClose">Close</button></div>'
    );
  }

  // `hostEl` must sit OUTSIDE day-ui.js's render target: a background poll
  // rebuilds that subtree wholesale (root.innerHTML = ""), and an overlay
  // living inside it would be silently torn out from under whoever is
  // mid-adjustment. app.js passes the outer shell root for exactly this
  // reason — the same reason day-ui.js's own duration sheet has to redraw
  // itself on every render instead.
  function open(hostEl, row, child) {
    if (isOpen()) close();
    var fmt = (g.Store.getSettings().timeFormat) || "24h";
    var done = row.status === "complete";
    var waived = row.status === "waived";

    var overlay = el(
      '<div class="complete-sheet-overlay">' +
        '<div class="complete-sheet-card">' +
          '<div class="complete-sheet-child"></div>' +
          '<h2 class="complete-sheet-title"></h2>' +
          '<div class="complete-sheet-body"></div>' +
        "</div>" +
      "</div>"
    );
    overlay.querySelector(".complete-sheet-child").textContent = child.name;
    overlay.querySelector(".complete-sheet-title").textContent = row.title;
    overlay.querySelector(".complete-sheet-body").innerHTML =
      waived ? buildWaivedBody() : done ? buildDoneBody(row, fmt) : buildPendingBody(row);

    hostEl.appendChild(overlay);
    current = { row: row, child: child, value: Date.now(), hostEl: hostEl, overlayEl: overlay, busy: false };

    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) close(); // backdrop tap cancels, same as the duration sheet
    });

    if (waived) {
      overlay.querySelector("#completeClose").addEventListener("click", close);
      return;
    }

    if (done) {
      overlay.querySelector("#completeClose").addEventListener("click", close);
      overlay.querySelector("#completeUndo").addEventListener("click", submitUndo);
      return;
    }

    overlay.querySelectorAll(".complete-step").forEach(function (btn) {
      btn.addEventListener("click", function () {
        current.value += Number(btn.dataset.step) * STEP_MS;
        paintStepper();
      });
    });
    overlay.querySelector("#completeCancel").addEventListener("click", close);
    overlay.querySelector("#completeConfirm").addEventListener("click", submitComplete);
    paintStepper();
  }

  g.CompleteUi = { open: open, close: close, isOpen: isOpen, drainPendingEarns: drainPendingEarns };
})(typeof window !== "undefined" ? window : globalThis);
