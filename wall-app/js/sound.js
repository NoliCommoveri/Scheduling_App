// sound.js — WebAudio: the two synthesized tones, the lazy AudioContext and
// its first-gesture unlock (TDS_Slice_Wall_Calendar_Redesign.md §11.5,
// §11.5.1, §16 Phase 6b). `remind-core.js` decides WHEN to chime; this file
// only ever makes the noise, and does no DOM or network IO of its own — the
// "tap to enable sound" indicator lives in nav-ui.js, wired through
// `onUnlock` below.
//
// Synthesis, not assets (§11.5): one `OscillatorNode` through a `GainNode`
// per tone, with a short linear attack-decay envelope. Nothing to precache,
// nothing for the service worker to version, no CDN.

(function (g) {
  "use strict";

  var ctx = null;
  var unlocked = false;
  var unlockListeners = [];

  function getCtx() {
    if (ctx) return ctx;
    var AC = g.AudioContext || g.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  function tone(freq, durationMs, delayMs) {
    var c = getCtx();
    if (!c || !unlocked) return;
    setTimeout(function () {
      var osc = c.createOscillator();
      var gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(c.destination);
      var now = c.currentTime;
      var dur = durationMs / 1000;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + dur);
      osc.start(now);
      osc.stop(now + dur);
    }, delayMs || 0);
  }

  // §11.5 — the start-time chime: a rising two-note tone (C5 then E5, a
  // beat later). No coalescing cap (§11.5's own decision) — three chores at
  // once produce three of these in quick succession, by design.
  function chime() {
    tone(523.25, 180, 0);
    tone(659.25, 220, 120);
  }

  // §11.5 — the completion confirmation: brief and higher, one note.
  function confirm() {
    tone(880, 140, 0);
  }

  function isUnlocked() {
    return unlocked;
  }

  // §11.5.1 — resumed on the first user gesture of the page load. Fails
  // open (marks unlocked without a context) on a browser with no WebAudio
  // at all, rather than leaving the "tap to enable sound" indicator on
  // forever for a device that can never satisfy it.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    var c = getCtx();
    if (c && c.state === "suspended") c.resume();
    unlockListeners.forEach(function (fn) {
      try { fn(); } catch (e) { /* a bad listener must not break the unlock */ }
    });
  }

  function onUnlock(fn) {
    unlockListeners.push(fn);
  }

  g.Sound = {
    chime: chime,
    confirm: confirm,
    unlock: unlock,
    isUnlocked: isUnlocked,
    onUnlock: onUnlock,
  };
})(typeof window !== "undefined" ? window : globalThis);
