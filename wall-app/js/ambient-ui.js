// ambient-ui.js — the always-on screen (TDS_Slice_Wall_Display_App.md §4.1,
// §0.4). Phase 2 scope only: child tiles from the live roster (§3.3), with no
// plan data behind them yet — no counts, no events, no Done Today. Those join
// in Phase 3 once poll.js and chores-core.js/events-core.js/completed-core.js
// exist. The clock, night overlay and tap-to-open PIN pad are later phases too
// (§10.2, §4). A settings gear is the one live control this phase needs, since
// Settings is what re-pairs a revoked display.

(function (g) {
  "use strict";

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // `children` is the roster as /api/wall/children returns it: [{ id, name }].
  // `onTileTap` and `onSettings` are optional — Phase 2 wires onSettings only.
  function render(root, children, opts) {
    opts = opts || {};
    root.innerHTML = "";

    var shell = el(
      '<div class="ambient">' +
        '<div class="ambient-topbar">' +
          '<div class="ambient-brand">Family Wall Display</div>' +
          '<button class="gear-btn" aria-label="Settings">&#9881;</button>' +
        '</div>' +
        '<div class="ambient-tiles"></div>' +
      '</div>'
    );

    var gear = shell.querySelector(".gear-btn");
    gear.addEventListener("click", function () {
      if (opts.onSettings) opts.onSettings();
    });

    var tiles = shell.querySelector(".ambient-tiles");
    if (!children || children.length === 0) {
      tiles.appendChild(el(
        '<div class="ambient-empty">No active children yet. Add one in the Management App — ' +
        'it appears here automatically.</div>'
      ));
    } else {
      children.forEach(function (child) {
        var tile = el(
          '<button class="child-tile">' +
            '<div class="child-tile-name">' + escapeHtml(child.name) + '</div>' +
            '<div class="child-tile-count">&nbsp;</div>' +
          '</button>'
        );
        tile.addEventListener("click", function () {
          if (opts.onTileTap) opts.onTileTap(child);
        });
        tiles.appendChild(tile);
      });
    }

    root.appendChild(shell);
  }

  g.AmbientUi = { render: render };
})(typeof window !== "undefined" ? window : globalThis);
