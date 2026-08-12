// claim.js — Shared Chores §5.4-§5.6: the arbitrated claim/release calls.
// TDS_Slice_Shared_Chores.md §5.4 (claim), §5.5 (release), §5.7 (why this is
// the one write path in the Child App that is online-required).
//
// This file owns the network for a `claim_group` row and nothing else — no
// IndexedDB write, no outbox entry, on either branch of either call.
// completion.js decides what a claim's answer means locally; this file only
// asks the question and hands back what the server said, or rejects (network
// error, unpaired) so completion.js can surface that without writing
// anything. §5.7 makes that rejection the correct behavior, not a gap to
// paper over with a local guess: for a shared row the truth genuinely is not
// local.

(function (g) {
  "use strict";

  // Same shape as outbox.js's link() — the pairing this device currently
  // holds, or null when unpaired. Read fresh each call rather than cached,
  // same reasoning as plan-sync.js/outbox.js: syncMeta can change under a
  // long-lived tab (re-pair, revoke).
  function link() {
    return g.DB.getSingleton("syncMeta").then(function (meta) {
      return meta && meta.deviceToken ? { token: meta.deviceToken, childId: meta.childId || null } : null;
    });
  }

  function call(method, id, body, token) {
    return fetch("/api/assignments/" + encodeURIComponent(id) + "/claim", {
      method: method,
      headers: Object.assign(
        { "Authorization": "Bearer " + token },
        body ? { "Content-Type": "application/json" } : {}
      ),
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        var revoked = new Error("Unauthorized");
        revoked.unauthorized = true;
        throw revoked;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  // §5.4 — body carries only what a win records: `grade` and `completionNote`,
  // both optional. `status`/`completedAt` are the route's to set (§5.4), never
  // the caller's.
  function take(item, grade, note) {
    return link().then(function (paired) {
      if (!paired) return Promise.reject(new Error("Not paired"));
      var body = {};
      if (typeof grade === "number") body.grade = grade;
      if (typeof note === "string" && note) body.completionNote = note;
      return call("POST", item.id, body, paired.token);
    });
  }

  // §5.5 — undo, for the winner only (a claimedCard carries no Undo control
  // at all, §6.2). `{ released: false }` means this device no longer holds
  // the claim — already released, or it never won — and the caller treats
  // that as a no-op rather than an error.
  function release(item) {
    return link().then(function (paired) {
      if (!paired) return Promise.reject(new Error("Not paired"));
      return call("DELETE", item.id, null, paired.token);
    });
  }

  g.Claim = { take: take, release: release };
})(typeof window !== "undefined" ? window : globalThis);
