// pairing.js — Device pairing (TDS_Slice_Online_Revamp.md §4.3, §5.4).
// The Child App redeems a parent-minted pairing code for a scoped device token
// and keeps it in the `syncMeta` singleton (db.js, version 3). That token is
// what every read (`plan-sync.js`) and every write (`outbox.js`) presents, so
// an unpaired device has no plan and nothing to upload — which is why pairing
// is a step of the Startup Wizard (Module 1 §7) and not only a Settings action.
// Unauthenticated by design: `/api/pair` is the one route that needs no bearer
// (§5.4), since the code itself is the credential.

(function (g) {
  "use strict";

  function getStatus() {
    return g.DB.getSingleton("syncMeta");
  }

  // The code is 8 characters from a Crockford-style alphabet (§3.6) read off
  // one screen and typed into another, so spaces and dashes are what a person
  // adds to keep their place. The Worker already trims and uppercases; this
  // strips the separators it would otherwise reject as an unknown code.
  function normalizeCode(raw) {
    return String(raw || "").replace(/[\s-]/g, "").toUpperCase();
  }

  // §4.3 step 4 returns the child this token is scoped to. That answer is the
  // server's, so it seeds the local Child record's `name` — the Wizard no
  // longer asks anyone to type it.
  //
  // Only when there is no local name yet, or when this device has been paired
  // to a *different* child than the one it held before. A parent who renamed
  // "Elizabeth" to "Ellie" in Settings (Module 11 FR-1) chose a display name
  // for this device, and re-pairing the same child — after a revoke, say —
  // must not silently undo it.
  function adoptChildName(previousChildId, parsed) {
    return g.DB.getSingleton("child").then(function (child) {
      var name = parsed && parsed.childName;
      if (!name) return;
      var childChanged = previousChildId && parsed.childId && previousChildId !== parsed.childId;
      if (child && child.name && !childChanged) return;
      return g.DB.putSingleton("child", Object.assign({}, child, { name: name }));
    });
  }

  function redeem(code, label) {
    var normalized = normalizeCode(code);
    if (!normalized) return Promise.resolve({ ok: false, message: "Enter the pairing code." });

    var body = { code: normalized };
    if (label && label.trim()) body.label = label.trim();

    return g.DB.getSingleton("syncMeta").then(function (previous) {
      var previousChildId = previous && previous.childId;
      return fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (parsed) {
          if (!res.ok) return { ok: false, message: (parsed && parsed.error) || ("HTTP " + res.status) };
          // Token first, name second. If the second write fails the device is
          // still paired and Settings can repair the name; the reverse would
          // leave a named device with no credential and no way to get one
          // without burning a fresh code.
          return g.DB.putSingleton("syncMeta", {
            deviceToken: parsed.token,
            childId: parsed.childId,
            childName: parsed.childName,
            pairedAt: Date.now()
          })
            .then(function () { return adoptChildName(previousChildId, parsed); })
            .then(function () { return { ok: true, childName: parsed.childName }; });
        });
      }).catch(function () {
        return { ok: false, message: "Could not reach the server. Check your connection and try again." };
      });
    });
  }

  // Local-only: forgets the token on this device. Does not revoke it
  // server-side — that is the parent's action from the Management App's
  // Devices panel (§5.3), which this app has no credential to reach.
  function forget() {
    return g.DB.del("syncMeta", "syncMeta");
  }

  g.Pairing = { getStatus: getStatus, redeem: redeem, forget: forget, normalizeCode: normalizeCode };
})(typeof window !== "undefined" ? window : globalThis);
