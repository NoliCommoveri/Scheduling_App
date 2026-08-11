// pairing.js — Device pairing (TDS_Slice_Online_Revamp.md §4.3, §5.4).
// Online Revamp Phase 2 (§12): the Child App redeems a parent-minted pairing
// code for a scoped device token and keeps it in the `syncMeta` singleton
// (db.js, version 3). Nothing else in the app reads this token yet — the
// planner still runs on the pre-revamp local stores until Phase 3 rewires it
// to `/api/plan`. Unauthenticated by design: `/api/pair` is the one route
// that needs no bearer (§5.4), since the code itself is the credential.

(function (g) {
  "use strict";

  function getStatus() {
    return g.DB.getSingleton("syncMeta");
  }

  function redeem(code, label) {
    var trimmed = (code || "").trim();
    if (!trimmed) return Promise.resolve({ ok: false, message: "Enter the pairing code." });

    var body = { code: trimmed };
    if (label && label.trim()) body.label = label.trim();

    return fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (parsed) {
        if (!res.ok) return { ok: false, message: (parsed && parsed.error) || ("HTTP " + res.status) };
        return g.DB.putSingleton("syncMeta", {
          deviceToken: parsed.token,
          childId: parsed.childId,
          childName: parsed.childName,
          pairedAt: Date.now()
        }).then(function () { return { ok: true, childName: parsed.childName }; });
      });
    }).catch(function () {
      return { ok: false, message: "Could not reach the server. Check your connection and try again." };
    });
  }

  // Local-only: forgets the token on this device. Does not revoke it
  // server-side — that is the parent's action from the Management App's
  // Devices panel (§5.3), which this app has no credential to reach.
  function forget() {
    return g.DB.del("syncMeta", "syncMeta");
  }

  g.Pairing = { getStatus: getStatus, redeem: redeem, forget: forget };
})(typeof window !== "undefined" ? window : globalThis);
