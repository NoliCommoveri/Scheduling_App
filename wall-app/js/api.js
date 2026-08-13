// api.js — fetch wrappers for the wall's one bearer credential.
// Phase 2: pairing and the roster read (TDS_Slice_Wall_Display_App.md §13).
// Phase 3 adds the plan read. Completions/rewards/claim calls join in
// Phase 4b — the shape (one wall token, childId per call, 401 -> unpaired)
// is set here so later phases only add routes, not a second convention.

(function (g) {
  "use strict";

  // Thrown on any 401: the token is missing, wrong, or revoked. app.js catches
  // this one error class to route to the "This display has been unpaired"
  // screen (§3.2) rather than treating it like an ordinary fetch failure.
  function UnpairedError() {
    this.name = "UnpairedError";
    this.message = "This display has been unpaired.";
  }
  UnpairedError.prototype = Object.create(Error.prototype);

  function authHeaders() {
    var token = g.Store.getToken();
    return token ? { Authorization: "Bearer " + token } : {};
  }

  function request(path, options) {
    options = options || {};
    var headers = Object.assign({}, authHeaders(), options.headers || {});
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) throw new UnpairedError();
      return res.json().catch(function () { return {}; }).then(function (parsed) {
        if (!res.ok) {
          var err = new Error((parsed && parsed.error) || "HTTP " + res.status);
          err.status = res.status;
          err.body = parsed;
          throw err;
        }
        return parsed;
      });
    });
  }

  // Unauthenticated, like /api/pair (§3.2). Redeems a pair code minted from
  // Management App -> Devices -> Pair wall display.
  function pair(code, label) {
    return request("/api/wall/pair", { method: "POST", body: { code: code, label: label } });
  }

  // §3.3 — SELECT id, name FROM children WHERE active = 1 ORDER BY name.
  function getChildren() {
    return request("/api/wall/children").then(function (res) { return res.children || []; });
  }

  // §5.1/§5.2 — handlePlan's body: { assignments, from, to, truncated?, limit? }.
  // `since`, when given, is the incremental watermark (max updated_at from
  // the last successful fetch of this child's window); omit for a full fetch.
  function getPlan(childId, from, to, since) {
    var qs = "childId=" + encodeURIComponent(childId) +
      "&from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
    if (since != null) qs += "&since=" + encodeURIComponent(since);
    return request("/api/wall/plan?" + qs);
  }

  g.WallApi = {
    UnpairedError: UnpairedError,
    pair: pair,
    getChildren: getChildren,
    getPlan: getPlan,
    request: request,
  };
})(typeof window !== "undefined" ? window : globalThis);
