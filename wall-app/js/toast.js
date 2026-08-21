// toast.js — the wall's one popup policy. Every transient message the wall
// shows goes through here, so they all obey the same rule: a toast stays up
// for TOAST_MS, or until the next tap anywhere outside it, whichever comes
// first. Ray, in use on the tablet, 2026-08-21: "increase the amount of time
// anything pops up to show for like 8 seconds or until next tap." That
// supersedes §6.3's "cheerful, three seconds" for the claim message and
// day-ui.js's own 2.2s/4.5s pair.
//
// It hosts on <body> and positions `fixed`, deliberately. day-ui.js rebuilds
// its render target wholesale on every background poll (`root.innerHTML = ""`)
// — including the poll that a write kicks off a moment after it succeeds — so
// a toast parented inside that subtree was torn out well under a second after
// it appeared, which is exactly what Ray was seeing. Nothing in either view's
// render cycle can reach a child of <body>. (complete-ui.js's sheet already
// dodged this by hosting on the outer shell; its own toast now comes through
// here instead of hosting itself.)
//
// One module in wall-app/, used by two of its UI layers. That is not the
// cross-APP sharing CLAUDE.md §I.A forbids — no file here is shared with
// child-app/ or management-app/, and nothing in it is aware of either.
(function (g) {
  "use strict";

  var TOAST_MS = 8000;
  var FADE_MS = 250; // matches the CSS transition on .wall-toast

  var currentEl = null;
  var hideTimer = null;
  var removeTimer = null;
  var dismissHandler = null;

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function stopTimers() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (removeTimer) { clearTimeout(removeTimer); removeTimer = null; }
    if (dismissHandler) {
      document.removeEventListener("pointerdown", dismissHandler, true);
      dismissHandler = null;
    }
  }

  // Takes the toast away now, with its fade. Safe to call at any point in a
  // toast's life, including from the dismissing tap itself.
  function clear() {
    stopTimers();
    var toast = currentEl;
    currentEl = null;
    if (!toast) return;
    toast.classList.remove("visible");
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, FADE_MS);
  }

  // `opts`: { kind, action: { label, run }, sticky }.
  //   kind    — 'warning' | 'placing' | undefined, styled in wall.css.
  //   action  — an Undo (or similar) button inside the toast; tapping it runs
  //             `run` instead of merely dismissing.
  //   sticky  — no auto-hide. The next tap still takes it away: a sticky
  //             toast is an instruction ("tap a time to place this"), and the
  //             tap that follows it is the answer.
  function show(message, opts) {
    opts = opts || {};
    clear();
    if (message == null) return null;

    var toast = el('<div class="wall-toast' + (opts.kind ? " " + opts.kind : "") +
      (opts.action ? " with-action" : "") + '"><span class="wall-toast-text"></span></div>');
    toast.querySelector(".wall-toast-text").textContent = message;

    if (opts.action) {
      var btn = el('<button class="wall-toast-action" type="button"></button>');
      btn.textContent = opts.action.label;
      btn.addEventListener("click", function () {
        clear();
        opts.action.run();
      });
      toast.appendChild(btn);
    }

    document.body.appendChild(toast);
    currentEl = toast;
    requestAnimationFrame(function () { toast.classList.add("visible"); });

    // "or until next tap" — armed on the next tick so the tap that CAUSED
    // this toast can't also dismiss it, and capturing so it sees the tap
    // before any view handler acts on it. A tap inside the toast is not a
    // dismissal: that is how the Undo button gets pressed.
    setTimeout(function () {
      if (currentEl !== toast) return;
      dismissHandler = function (ev) {
        if (toast.contains(ev.target)) return;
        clear();
      };
      document.addEventListener("pointerdown", dismissHandler, true);
    }, 0);

    if (!opts.sticky) hideTimer = setTimeout(clear, TOAST_MS);
    return toast;
  }

  g.Toast = { show: show, clear: clear, TOAST_MS: TOAST_MS };
})(typeof window !== "undefined" ? window : globalThis);
