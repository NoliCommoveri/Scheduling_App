// day-ui.js — the day view: column-per-child grid, sticky header, the
// events band, the unscheduled tray, early/late strips, and the now-line.
// TDS_Slice_Wall_Calendar_Redesign.md §4 (the day view), §11.3 (time
// format). Replaces `ambient-ui.js` outright (§13).
//
// Layout is plain flexbox, not CSS Grid: §4.3's "vertical scrolling only,
// no horizontal scroll anywhere" means the column count never overflows the
// viewport, so a sticky header over N equal-width flex columns gives the
// same result as a grid with far less code, and chip positioning is then
// just `top`/`height` in px within each column — one scroll container, one
// coordinate system.
//
// §16 Phase 4 added block mode (§4.4): the same day, collapsed into the
// four canonical blocks, or expanded to just one of them at full 15-minute
// resolution. `buildGutter`/`buildGridBody`/`buildColumn` were generalized
// to a `[rangeStart, rangeEnd)` window so the single-block grid reuses the
// exact same positioning code the full grid uses, rather than a second copy
// that could drift from it.
//
// §16 Phase 5 adds placement WRITES: pointer-based drag-and-drop (a chip or
// a tray item, held and moved past a small threshold) and tap-to-place (a
// tray item tapped to select it, then a time on the grid tapped to place
// it there) — both funnel through `commitPlacement`, so a drag and a tap
// produce the exact same write. Both are scoped to the full-day grid and
// the single-expanded-block grid, the two modes with an actual time axis
// to drop onto; collapsed block-mode rows have none and stay read-only, as
// does the events band. `collision-flash`/the toast give §9's warning a
// place to show without ever refusing the write. Un-placing is the mirror
// gesture: drag a placed chip back onto the tray row. A placed chip's TAP
// (as opposed to a drag) calls `opts.onChipTap`, which app.js wires to
// `CompleteUi.open` (§16 Phase 6) — this file only ever fires it on a
// no-movement pointer-up, never as a side effect of a drag, and owns
// nothing about the sheet itself beyond the done-in-place chip styling
// (§8.4, chipHtml/blockItemHtml below).
//
// §16 Phase 5b adds the duration-adjust sheet (§3.5.2). The TDS pins the
// sheet's three actions ("Just this one" / "This and future" / "Use the
// assigned time") but not the gesture that opens it, and a plain tap on a
// placed chip is already spoken for (onChipTap). This build adds a
// LONG-PRESS (held ~550ms with no movement) as the fourth gesture
// `attachGesture` recognizes, alongside tap and drag — flagged for
// confirmation rather than pinned in the TDS as settled, since Ray hasn't
// signed off on it the way §3.3/§3.5's decisions were. Sheet state
// (`sheetState`) lives at module scope, like `selectedForPlacement`,
// specifically so a background poll's re-render (every 10 min, or
// immediately after any write) redraws the open sheet instead of silently
// closing it out from under whoever is mid-adjustment.
//
// §16 Phase 6 adds the completion sheet itself (`complete-ui.js`) and the
// done-in-place styling below (§8.4) — no other change to this file. The
// sheet's own DOM lives outside `day-ui.js`'s render target on purpose
// (see complete-ui.js's `open` doc comment), the same reason the duration
// sheet above has to redraw itself on every render rather than living
// undisturbed alongside it.

(function (g) {
  "use strict";

  var GRID_START_MIN = 6 * 60; // 06:00 (§4.3)
  var GRID_END_MIN = 23 * 60; // 23:00
  var ROW_MIN = 15;
  var DRAG_THRESHOLD_PX = 8; // below this, a pointer-down+up is a TAP, not a drag
  var LONG_PRESS_MS = 550; // held this long with no movement opens the duration sheet (§16 Phase 5b)
  var MAX_ADJUST_MIN = 8 * 60; // stepper ceiling; the Worker enforces no max besides "positive multiple of 15"

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function rowHeightPx() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--row-h");
    return parseFloat(v) || 18;
  }

  function parsePayload(raw) {
    if (raw == null) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  // ---- events band (§4.2 — family-wide, full width, above the grid) -------

  function eventRowHtml(row, date) {
    var p = parsePayload(row.payload);
    var span = g.EventsCore.spanLabel(row, date);
    var bits = [];
    if (p.time) bits.push('<span class="event-time">' + escapeHtml(p.time) + "</span>");
    bits.push('<span class="event-title">' + escapeHtml(row.title) + "</span>");
    if (span) bits.push('<span class="event-span">' + escapeHtml(span) + "</span>");
    return '<div class="event-row">' + bits.join("") + "</div>";
  }

  function buildEventsBand(rows, date) {
    var todays = g.EventsCore.eventsOn(rows, date);
    if (!todays.length) return el('<div class="day-events-band day-events-empty"></div>');
    return el(
      '<div class="day-events-band">' +
        todays.map(function (row) { return eventRowHtml(row, date); }).join("") +
      "</div>"
    );
  }

  // ---- sticky header (§4.2 — frozen at the top of the scroll) -------------
  // Shared by every mode, so it takes the raw roster rather than a
  // mode-specific layout shape.

  function buildStickyHeader(children) {
    var cols = (children || []).map(function (c) {
      return '<div class="day-col-header">' + escapeHtml(c.name) + "</div>";
    }).join("");
    return el(
      '<div class="day-sticky-header">' +
        '<div class="day-gutter-spacer"></div>' + cols +
      "</div>"
    );
  }

  // ---- mode bar (§4.4 — switching between the full grid and block mode) ---

  function buildModeBar(mode, setMode) {
    var isGrid = mode === "grid";
    var bar = el(
      '<div class="day-mode-bar">' +
        '<button class="day-mode-btn' + (isGrid ? " active" : "") + '" data-mode="grid">Full day</button>' +
        '<button class="day-mode-btn' + (!isGrid ? " active" : "") + '" data-mode="blocks">Blocks</button>' +
      "</div>"
    );
    bar.querySelector('[data-mode="grid"]').addEventListener("click", function () { setMode("grid"); });
    bar.querySelector('[data-mode="blocks"]').addEventListener("click", function () { setMode("blocks"); });
    return bar;
  }

  // ---- placement writes (§16 Phase 5): drag-and-drop, tap-to-place,
  // collisions, and the toast that reports both without ever refusing a
  // write (§3.6, §9). Everything below reads/writes `current`/`currentRoot`
  // (the module state `render()` already keeps) and is pure UI wiring — the
  // actual write goes through `WallApi.putSlot`/`deleteSlot` and the
  // collision math goes through the pure `SlotsCore.findCollision`.

  function pointInRect(x, y, rect) {
    return rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function snapToRow(rawMin) {
    return Math.round(rawMin / ROW_MIN) * ROW_MIN;
  }

  // Pointer Y -> a startMin in the SAME coordinate space `bodyEl` was laid
  // out in (real clock minutes in grid mode; §4.4's block-virtual minutes,
  // which may run past 1440, in single-block mode) — `% 1440` at the call
  // site converts back to a real clock minute before it reaches the API.
  function startMinFromPointer(clientY, bodyEl, rangeStart, rangeEnd) {
    var rect = bodyEl.getBoundingClientRect();
    var rh = rowHeightPx();
    var rawMin = ((clientY - rect.top) / rh) * ROW_MIN;
    var snapped = rangeStart + snapToRow(rawMin);
    var maxStart = rangeEnd - ROW_MIN;
    if (snapped < rangeStart) snapped = rangeStart;
    if (snapped > maxStart) snapped = maxStart;
    return snapped;
  }

  function showToast(message, kind, sticky) {
    var root = currentRoot;
    if (!root) return;
    var existing = root.querySelector(".wall-toast");
    if (existing) existing.remove();
    if (message == null) return;
    var toast = el('<div class="wall-toast' + (kind ? " " + kind : "") + '"></div>');
    toast.textContent = message;
    root.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("visible"); });
    if (!sticky) {
      setTimeout(function () {
        toast.classList.remove("visible");
        setTimeout(function () { if (toast.parentNode) toast.remove(); }, 250);
      }, kind === "warning" ? 4500 : 2200);
    }
  }

  function rerenderNow() {
    if (currentRoot && current.state) render(currentRoot, current.state, current.date, current.opts);
  }

  function buildGhost(title) {
    var ghost = el('<div class="drag-ghost"></div>');
    ghost.textContent = title;
    return ghost;
  }

  function positionGhost(ghost, x, y) {
    ghost.style.transform = "translate(" + (x + 14) + "px, " + (y - 28) + "px)";
  }

  // §9 — "that day's rows", not the placements alone: gathers the SAME
  // child's other chores on the rendered date, each resolved to its
  // current chip (so an already-placed neighbour's real duration is what
  // gets checked, wherever it renders — main grid, or an early/late strip).
  function findCollisionForDrop(row, candidateStart, candidateDuration) {
    if (!g.SlotsCore.isPrivateChore(row)) return null;
    var slotsIdx = g.SlotsCore.indexSlots(current.state.slots);
    var daysIdx = g.SlotsCore.indexDays(current.state.slotDays);
    var chores = g.ChoresCore.choresForChild(current.state.rows, row.child_id, current.date, current.state.today);
    var others = [];
    chores.forEach(function (r) {
      if (r.id === row.id) return; // exclude the subject being moved
      others.push({ row: r, chip: g.SlotsCore.resolveChip(slotsIdx, daysIdx, r, current.date) });
    });
    return g.SlotsCore.findCollision(row, candidateStart, candidateDuration, others);
  }

  function applyOptimisticSlot(childId, subjectKey, instanceKey, startMin, durationMin) {
    var slots = current.state.slots || (current.state.slots = []);
    var found = null;
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (s.child_id === childId && s.subject_kind === "chore" && s.subject_key === subjectKey &&
          (s.instance_key || "") === instanceKey) {
        found = s;
        break;
      }
    }
    if (found) {
      found.start_min = startMin;
      found.duration_min = durationMin;
    } else {
      slots.push({
        child_id: childId, subject_kind: "chore", subject_key: subjectKey,
        instance_key: instanceKey, start_min: startMin, duration_min: durationMin,
      });
    }
  }

  function applyOptimisticUnplace(childId, subjectKey, instanceKey) {
    current.state.slots = (current.state.slots || []).filter(function (s) {
      return !(s.child_id === childId && s.subject_kind === "chore" && s.subject_key === subjectKey &&
        (s.instance_key || "") === instanceKey);
    });
    current.state.slotDays = (current.state.slotDays || []).filter(function (d) {
      return !(d.child_id === childId && d.subject_kind === "chore" && d.subject_key === subjectKey &&
        (d.instance_key || "") === instanceKey);
    });
  }

  // §16 Phase 5b — the `wall_slot_days` half of an optimistic write:
  // upsert-in-place, mirroring `applyOptimisticSlot`'s shape for `wall_slots`.
  function applyOptimisticDayOverride(childId, subjectKey, instanceKey, date, durationMin) {
    var days = current.state.slotDays || (current.state.slotDays = []);
    var found = null;
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      if (d.child_id === childId && d.subject_kind === "chore" && d.subject_key === subjectKey &&
          (d.instance_key || "") === instanceKey && d.date === date) {
        found = d;
        break;
      }
    }
    if (found) {
      found.duration_min = durationMin;
    } else {
      days.push({
        child_id: childId, subject_kind: "chore", subject_key: subjectKey,
        instance_key: instanceKey, date: date, duration_min: durationMin,
      });
    }
  }

  function applyOptimisticDayOverrideClear(childId, subjectKey, instanceKey, date) {
    current.state.slotDays = (current.state.slotDays || []).filter(function (d) {
      return !(d.child_id === childId && d.subject_kind === "chore" && d.subject_key === subjectKey &&
        (d.instance_key || "") === instanceKey && d.date === date);
    });
  }

  function flashCollision(rowId, otherRowId) {
    [rowId, otherRowId].forEach(function (id) {
      var chipEl = currentRoot.querySelector('.day-chip[data-assignment-id="' + id + '"]');
      if (!chipEl) return;
      chipEl.classList.add("collision-flash");
      setTimeout(function () { chipEl.classList.remove("collision-flash"); }, 2500);
    });
  }

  // The one place both drag-drop and tap-to-place end up: a candidate
  // startMin, already converted to real clock minutes. §3.3 — this writes
  // the STANDING placement, so it (and every future date the chore recurs
  // on) carries forward from here; there is no "just today" in v1.
  function commitPlacement(row, startMin) {
    var childId = g.SlotsCore.placementChildId(row);
    var subjectKey = g.SlotsCore.subjectKeyOf(row);
    var instanceKey = g.SlotsCore.instanceKeyOf(row);
    var slotsIdx = g.SlotsCore.indexSlots(current.state.slots);
    var existingSlot = g.SlotsCore.placementFor(slotsIdx, row);
    var durationOverride = existingSlot ? existingSlot.duration_min : null; // preserved, never guessed (§3.5.1)
    var chip = g.SlotsCore.resolveChip(slotsIdx, g.SlotsCore.indexDays(current.state.slotDays), row, current.date);
    var collision = findCollisionForDrop(row, startMin, chip.durationMin);
    var fmt = (g.Store.getSettings().timeFormat) || "24h";

    g.WallApi.putSlot(childId, "chore", subjectKey, instanceKey, startMin, durationOverride).then(function () {
      applyOptimisticSlot(childId, subjectKey, instanceKey, startMin, durationOverride);
      rerenderNow();
      if (collision) {
        showToast(
          row.title + " overlaps " + collision.row.title + " at " +
          g.TimeCore.formatMinutes(collision.chip.startMin, fmt), "warning");
        flashCollision(row.id, collision.row.id);
      } else {
        showToast(row.title + " moved to " + g.TimeCore.formatMinutes(startMin, fmt));
      }
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't place “" + row.title + "” — try again.", "warning");
    });
  }

  function unplace(row) {
    var childId = g.SlotsCore.placementChildId(row);
    var subjectKey = g.SlotsCore.subjectKeyOf(row);
    var instanceKey = g.SlotsCore.instanceKeyOf(row);
    g.WallApi.deleteSlot(childId, "chore", subjectKey, instanceKey).then(function () {
      applyOptimisticUnplace(childId, subjectKey, instanceKey);
      rerenderNow();
      showToast(row.title + " moved to Not scheduled");
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't move “" + row.title + "” — try again.", "warning");
    });
  }

  // ---- duration-adjust sheet (§16 Phase 5b, §3.5.2) -------------------------
  // Opened by a long-press on a placed chip (attachGesture's onLongPress).
  // `sheetState` holds only `{row, value}` — everything else (the current
  // placement, whether it's overridden, the assigned-time label) is
  // re-derived fresh from `current.state` on every build, so a background
  // poll landing while the sheet is open never shows it stale data.

  function showDurationSheet(row) {
    var slotsIdx = g.SlotsCore.indexSlots(current.state.slots);
    var daysIdx = g.SlotsCore.indexDays(current.state.slotDays);
    var chip = g.SlotsCore.resolveChip(slotsIdx, daysIdx, row, current.date);
    if (chip.startMin == null) return; // not placed — the sheet has nothing to adjust
    sheetState = { row: row, value: chip.durationMin };
    rerenderNow();
  }

  function closeDurationSheet() {
    sheetState = null;
    rerenderNow();
  }

  // "This and future" keeps the chore's current start time — a duration
  // adjustment is never a move — and preserves the collision warning the
  // same drop/drag path gives (§9): growing a chip can newly overlap a
  // neighbour just as moving one can.
  function submitDurationOverride(row, value, scope) {
    var childId = g.SlotsCore.placementChildId(row);
    var subjectKey = g.SlotsCore.subjectKeyOf(row);
    var instanceKey = g.SlotsCore.instanceKeyOf(row);
    var slot = g.SlotsCore.placementFor(g.SlotsCore.indexSlots(current.state.slots), row);
    var date = current.date;
    var fmt = (g.Store.getSettings().timeFormat) || "24h";
    sheetState = null;
    rerenderNow();
    if (!slot) return; // un-placed from under us while the sheet was open

    var startMin = slot.start_min;
    var write = scope === "day"
      ? g.WallApi.putSlotDay(childId, "chore", subjectKey, instanceKey, date, value)
      : g.WallApi.putSlot(childId, "chore", subjectKey, instanceKey, startMin, value);

    write.then(function () {
      if (scope === "day") applyOptimisticDayOverride(childId, subjectKey, instanceKey, date, value);
      else applyOptimisticSlot(childId, subjectKey, instanceKey, startMin, value);
      rerenderNow();
      var collision = findCollisionForDrop(row, startMin, value);
      if (collision) {
        showToast(
          row.title + " overlaps " + collision.row.title + " at " +
          g.TimeCore.formatMinutes(collision.chip.startMin, fmt), "warning");
        flashCollision(row.id, collision.row.id);
      } else {
        showToast(row.title + " now " + g.TimeCore.formatDurationMin(value) +
          (scope === "day" ? " today" : " going forward"));
      }
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't change “" + row.title + "”'s duration — try again.", "warning");
    });
  }

  // "Use the assigned time" returns the chip to row 3/4 of the §3.5.1 chain
  // unconditionally — both a day override and a standing one may be in
  // force at once (someone set "this and future", then "just this one" on
  // top of it), and leaving either behind would silently disagree with what
  // the button just promised. Both calls are made regardless of which
  // override actually exists; deleting/clearing one that was never set is
  // a no-op, not an error.
  function submitDurationClear(row) {
    var childId = g.SlotsCore.placementChildId(row);
    var subjectKey = g.SlotsCore.subjectKeyOf(row);
    var instanceKey = g.SlotsCore.instanceKeyOf(row);
    var slot = g.SlotsCore.placementFor(g.SlotsCore.indexSlots(current.state.slots), row);
    var date = current.date;
    sheetState = null;
    rerenderNow();
    if (!slot) return;
    var startMin = slot.start_min;

    Promise.all([
      g.WallApi.deleteSlotDay(childId, "chore", subjectKey, instanceKey, date),
      g.WallApi.putSlot(childId, "chore", subjectKey, instanceKey, startMin, null),
    ]).then(function () {
      applyOptimisticDayOverrideClear(childId, subjectKey, instanceKey, date);
      applyOptimisticSlot(childId, subjectKey, instanceKey, startMin, null);
      rerenderNow();
      showToast(row.title + " back to the assigned time");
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't reset “" + row.title + "”'s duration — try again.", "warning");
    });
  }

  function buildDurationSheet() {
    var s = sheetState;
    var row = s.row;
    var slotsIdx = g.SlotsCore.indexSlots(current.state.slots);
    var daysIdx = g.SlotsCore.indexDays(current.state.slotDays);
    var slot = g.SlotsCore.placementFor(slotsIdx, row);
    if (!slot) { sheetState = null; return; } // un-placed from under us while open — drop silently
    var dayOverride = g.SlotsCore.dayOverrideFor(daysIdx, row, current.date);
    var overridden = g.SlotsCore.isOverridden(slot, dayOverride);
    var assigned = g.SlotsCore.assignedDurationMin(row);

    var overlay = el(
      '<div class="duration-sheet-overlay">' +
        '<div class="duration-sheet-card">' +
          "<h2>Adjust duration</h2>" +
          '<div class="duration-sheet-title"></div>' +
          '<div class="duration-sheet-stepper">' +
            '<button class="btn ghost dur-step" data-step="-15" type="button">&minus;</button>' +
            '<div class="duration-sheet-value"></div>' +
            '<button class="btn ghost dur-step" data-step="15" type="button">+</button>' +
          "</div>" +
          (overridden ? '<button class="btn ghost duration-sheet-reset" id="durUseAssigned"></button>' : "") +
          '<div class="duration-sheet-actions">' +
            '<button class="btn" id="durFuture">This and future</button>' +
            '<button class="btn ghost" id="durJustThis">Just this one</button>' +
            '<button class="btn ghost" id="durCancel">Cancel</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
    overlay.querySelector(".duration-sheet-title").textContent = row.title;
    overlay.querySelector(".duration-sheet-value").textContent = g.TimeCore.formatDurationMin(s.value);
    var resetBtn = overlay.querySelector("#durUseAssigned");
    if (resetBtn) resetBtn.textContent = "Use the assigned time (" + g.TimeCore.formatDurationMin(assigned) + ")";

    overlay.querySelectorAll(".dur-step").forEach(function (btn) {
      btn.addEventListener("click", function () {
        s.value = Math.max(ROW_MIN, Math.min(MAX_ADJUST_MIN, s.value + Number(btn.dataset.step)));
        rerenderNow();
      });
    });
    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) closeDurationSheet(); // backdrop tap cancels
    });
    overlay.querySelector("#durCancel").addEventListener("click", closeDurationSheet);
    if (resetBtn) resetBtn.addEventListener("click", function () { submitDurationClear(row); });
    overlay.querySelector("#durJustThis").addEventListener("click", function () {
      submitDurationOverride(row, s.value, "day");
    });
    overlay.querySelector("#durFuture").addEventListener("click", function () {
      submitDurationOverride(row, s.value, "standing");
    });

    currentRoot.appendChild(overlay);
  }

  function tryToggleSelection(row, child) {
    if (selectedForPlacement && selectedForPlacement.row.id === row.id) {
      selectedForPlacement = null;
      rerenderNow();
      return;
    }
    selectedForPlacement = { row: row, child: child };
    rerenderNow();
    showToast("Tap a time to place “" + row.title + "” — tap it again to cancel.", "placing", true);
  }

  // A tap anywhere in the grid body while a tray item is armed places it
  // there; a tap on a chip is left to the chip's own gesture handler.
  function attachGridTapToPlace(bodyEl, rangeStart, rangeEnd) {
    bodyEl.addEventListener("click", function (ev) {
      if (!selectedForPlacement || ev.target.closest(".day-chip")) return;
      var virtual = startMinFromPointer(ev.clientY, bodyEl, rangeStart, rangeEnd);
      var row = selectedForPlacement.row;
      selectedForPlacement = null;
      commitPlacement(row, virtual % 1440);
    });
  }

  // Pointer-down+move+up, unified for the gestures a chip or a tray item
  // supports: a small movement is a TAP (`onTap`); past `DRAG_THRESHOLD_PX`
  // it's a DRAG, tracked with a floating ghost and resolved on release by
  // where the pointer let go — the grid body (place/move), the tray row
  // (un-place), or neither (cancel, nothing written, §3.6). A stationary
  // hold past `LONG_PRESS_MS` is a fourth gesture, `onLongPress` (§16
  // Phase 5b) — passed only for placed chips, never tray items, since it
  // opens the duration sheet and an unplaced chore has nothing to adjust
  // yet. Firing it tears down the same listeners a drag or tap would have
  // used, so a long-press can never also resolve as either.
  function attachGesture(itemEl, row, onTap, onLongPress) {
    itemEl.addEventListener("pointerdown", function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      var startX = ev.clientX, startY = ev.clientY;
      var pointerId = ev.pointerId;
      var moved = false;
      var ghost = null;
      var longPressTimer = null;
      var bodyEl = currentRoot.querySelector(".day-grid-body");
      var trayRowEl = currentRoot.querySelector(".day-tray-row");

      function clearLongPress() {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        itemEl.classList.remove("pressing");
      }

      function onMove(mv) {
        var dx = mv.clientX - startX, dy = mv.clientY - startY;
        if (!moved) {
          if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return;
          clearLongPress();
          moved = true;
          ghost = buildGhost(row.title);
          currentRoot.appendChild(ghost);
          itemEl.classList.add("drag-source");
          if (bodyEl) bodyEl.classList.add("drop-armed");
        }
        positionGhost(ghost, mv.clientX, mv.clientY);
        var overBody = pointInRect(mv.clientX, mv.clientY, bodyEl && bodyEl.getBoundingClientRect());
        var overTray = pointInRect(mv.clientX, mv.clientY, trayRowEl && trayRowEl.getBoundingClientRect());
        if (bodyEl) bodyEl.classList.toggle("drop-hover", overBody);
        if (trayRowEl) trayRowEl.classList.toggle("drop-hover", overTray && !overBody);
      }

      function cleanup() {
        clearLongPress();
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        if (itemEl.releasePointerCapture) { try { itemEl.releasePointerCapture(pointerId); } catch (e) {} }
        if (bodyEl) bodyEl.classList.remove("drop-armed", "drop-hover");
        if (trayRowEl) trayRowEl.classList.remove("drop-hover");
      }

      function onUp(up) {
        cleanup();
        if (!moved) {
          itemEl.classList.remove("drag-source");
          if (ghost) ghost.remove();
          if (onTap) onTap();
          return;
        }
        itemEl.classList.remove("drag-source");
        if (ghost) ghost.remove();

        var overTray = trayRowEl && pointInRect(up.clientX, up.clientY, trayRowEl.getBoundingClientRect());
        var overBody = !overTray && bodyEl && pointInRect(up.clientX, up.clientY, bodyEl.getBoundingClientRect());

        if (overTray) {
          if (g.SlotsCore.placementFor(g.SlotsCore.indexSlots(current.state.slots), row)) unplace(row);
          return; // already unplaced (dragged from the tray itself) — no-op
        }
        if (!overBody || !current.range) return; // dropped nowhere valid — cancel, nothing written (§3.6)

        var virtual = startMinFromPointer(up.clientY, bodyEl, current.range.start, current.range.end);
        commitPlacement(row, virtual % 1440);
      }

      ev.preventDefault();
      if (itemEl.setPointerCapture) { try { itemEl.setPointerCapture(pointerId); } catch (e) {} }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);

      if (onLongPress) {
        itemEl.classList.add("pressing");
        longPressTimer = setTimeout(function () {
          longPressTimer = null;
          cleanup();
          onLongPress();
        }, LONG_PRESS_MS);
      }
    });
  }

  // ---- unscheduled tray (§3.4) ---------------------------------------------
  // Used by grid mode for every unplaced chore, and by single-block mode
  // for the unplaced chores whose hint puts them in *this* block — an
  // unplaced chore has no start_min, so it cannot sit on a time grid however
  // narrow. Block mode's collapsed view doesn't need this: there, an
  // unplaced chore renders inline in its block row instead (§3.4).

  function buildTrayItem(row, child) {
    var li = el("<li></li>");
    li.textContent = row.title;
    if (selectedForPlacement && selectedForPlacement.row.id === row.id) li.classList.add("selected");
    attachGesture(li, row, function () { tryToggleSelection(row, child); });
    return li;
  }

  function buildTrayCell(entry) {
    var n = entry.unplaced.length;
    var cell = el('<div class="day-tray-cell"></div>');
    if (!n) return cell;
    var toggle = el('<button class="day-tray-toggle">Not scheduled &middot; ' + n + "</button>");
    var list = el('<ul class="day-tray-list"></ul>');
    entry.unplaced.forEach(function (row) { list.appendChild(buildTrayItem(row, entry.child)); });
    toggle.addEventListener("click", function () { cell.classList.toggle("expanded"); });
    cell.appendChild(toggle);
    cell.appendChild(list);
    return cell;
  }

  function buildTrayRow(perChild) {
    var any = perChild.some(function (c) { return c.unplaced.length > 0; });
    var wrap = el('<div class="day-tray-row"><div class="day-gutter-spacer"></div></div>');
    if (!any) return wrap;
    perChild.forEach(function (entry) { wrap.appendChild(buildTrayCell(entry)); });
    return wrap;
  }

  // ---- early/late strips (§4.3 — never hidden, never clamped; grid mode only,
  // since block mode's night block already covers everything outside 06:00-23:00) --

  function buildStrip(kind, perChild, fmt) {
    var items = [];
    perChild.forEach(function (entry) {
      (entry[kind] || []).forEach(function (placed) {
        items.push({ row: placed.row, chip: placed.chip, childName: entry.child.name });
      });
    });
    if (!items.length) return null;
    items.sort(function (a, b) { return a.chip.startMin - b.chip.startMin; });
    var label = kind === "early" ? "Before " + g.TimeCore.formatMinutes(GRID_START_MIN, fmt)
      : "After " + g.TimeCore.formatMinutes(GRID_END_MIN, fmt);
    var wrap = el(
      '<div class="day-strip ' + kind + '">' +
        '<button class="day-strip-toggle">' + escapeHtml(label) + " &middot; " + items.length + "</button>" +
        '<ul class="day-strip-list"></ul>' +
      "</div>"
    );
    var list = wrap.querySelector(".day-strip-list");
    items.forEach(function (item) {
      list.appendChild(el(
        "<li>" +
          '<span class="strip-time">' + g.TimeCore.formatMinutes(item.chip.startMin, fmt) + "</span>" +
          '<span class="strip-title">' + escapeHtml(item.row.title) + "</span>" +
          '<span class="strip-child">' + escapeHtml(item.childName) + "</span>" +
        "</li>"
      ));
    });
    wrap.querySelector(".day-strip-toggle").addEventListener("click", function () {
      wrap.classList.toggle("expanded");
    });
    return wrap;
  }

  // ---- the grid body: gutter, columns, chips, now-line ---------------------
  // Generalized over a [rangeStart, rangeEnd) minute window so the full-day
  // grid (Phase 3) and a single expanded block (Phase 4, §4.4) share one
  // implementation. A `placed` entry's `topMin` is the coordinate to draw
  // it at — equal to its real `chip.startMin` in grid mode, but remapped by
  // `ChoresCore.blockVirtualMin` in single-block mode so the night block's
  // midnight wrap draws on one continuous axis (§4.4).

  // Time and title share one line (not stacked) because a 15-minute chore
  // with no authored estimate is the common case today (§4.3) and renders
  // as exactly one grid row — too short for two stacked lines to fit. The
  // duration marker (§3.5.2) only ever appears alongside them when a wall
  // override is in force — an un-overridden chip carries no duration text
  // at all, since its height already shows it.
  // §8.4 — done-in-place: a completed chip keeps its slot and gains a
  // check, a muted fill (the day-chip-done class, wall.css), a strike on
  // the title, and the completion time added as a label alongside the
  // planned start time it already shows. Nothing moves, nothing collapses.
  function chipHtml(placed, fmt) {
    var row = placed.row;
    var done = row.status === "complete";
    var durationBadge = placed.chip.overridden
      ? '<span class="chip-duration">' + escapeHtml(g.TimeCore.formatDurationMin(placed.chip.durationMin)) + "</span>"
      : "";
    var doneBadge = done && row.completed_at != null
      ? '<span class="chip-done-time">' + escapeHtml(g.TimeCore.formatDate(new Date(row.completed_at), fmt)) + "</span>"
      : "";
    return (
      '<div class="day-chip' + (done ? " day-chip-done" : "") + '" data-assignment-id="' + escapeHtml(row.id) + '">' +
        (done ? '<span class="chip-check">&#10003;</span>' : "") +
        '<span class="chip-time">' + g.TimeCore.formatMinutes(placed.chip.startMin, fmt) + "</span>" +
        '<span class="chip-title">' + escapeHtml(row.title) + "</span>" +
        durationBadge + doneBadge +
      "</div>"
    );
  }

  function buildGutter(rh, rangeStart, rangeEnd) {
    var gutter = el('<div class="day-gutter"></div>');
    var hStart = rangeStart / 60;
    var hEndExclusive = rangeEnd / 60;
    for (var h = hStart; h < hEndExclusive; h++) {
      var top = ((h * 60 - rangeStart) / ROW_MIN) * rh;
      var label = el('<div class="day-gutter-label"></div>');
      label.style.top = top + "px";
      label.textContent = g.TimeCore.formatMinutes((h * 60) % 1440, "24h");
      gutter.appendChild(label);
    }
    var bottom = el('<div class="day-gutter-label bottom"></div>');
    bottom.style.top = ((rangeEnd - rangeStart) / ROW_MIN) * rh + "px";
    bottom.textContent = g.TimeCore.formatMinutes(rangeEnd % 1440, "24h");
    gutter.appendChild(bottom);
    return gutter;
  }

  function buildColumn(entry, rh, rangeStart, opts) {
    var col = el('<div class="day-column"></div>');
    entry.placed.forEach(function (placed) {
      var top = ((placed.topMin - rangeStart) / ROW_MIN) * rh;
      var rows = Math.max(1, Math.ceil(placed.chip.durationMin / ROW_MIN));
      var chip = el(chipHtml(placed, opts.fmt));
      chip.style.top = top + "px";
      chip.style.height = (rows * rh - 2) + "px"; // 2px gap between chips
      attachGesture(chip, placed.row, function () {
        if (opts.onChipTap) opts.onChipTap(placed.row, entry.child);
      }, function () {
        showDurationSheet(placed.row);
      });
      col.appendChild(chip);
    });
    return col;
  }

  function buildGridBody(perChild, rangeStart, rangeEnd, opts) {
    var rh = rowHeightPx();
    var body = el('<div class="day-grid-body"></div>');
    body.style.height = (((rangeEnd - rangeStart) / ROW_MIN) * rh) + "px";
    body.appendChild(buildGutter(rh, rangeStart, rangeEnd));
    perChild.forEach(function (entry) {
      body.appendChild(buildColumn(entry, rh, rangeStart, opts));
    });
    var nowLine = el('<div class="day-now-line"></div>');
    nowLine.style.display = "none";
    body.appendChild(nowLine);
    return body;
  }

  // `virtualMin` is already in the same coordinate space as rangeStart/End
  // (grid mode: a real clock minute; single-block mode: blockVirtualMin's
  // output). Grid mode pins to the nearest edge rather than vanishing
  // outside its range (§4.3); single-block mode's caller never calls this
  // unless "now" is actually inside the block, so no pinning is needed there.
  function positionNowLine(body, rh, rangeStart, rangeEnd, virtualMin) {
    var nowLine = body.querySelector(".day-now-line");
    if (!nowLine) return;
    var totalH = ((rangeEnd - rangeStart) / ROW_MIN) * rh;
    var top;
    if (virtualMin < rangeStart) top = 0;
    else if (virtualMin >= rangeEnd) top = totalH;
    else top = ((virtualMin - rangeStart) / ROW_MIN) * rh;
    nowLine.style.display = "";
    nowLine.style.top = top + "px";
  }

  // ---- staleness stamp (§10.4, unchanged) ----------------------------------

  function buildStaleStamp(state, fmt) {
    if (!state.lastSuccessAt) return el('<div class="day-stale-stamp">Loading&hellip;</div>');
    var ageMin = (Date.now() - state.lastSuccessAt) / 60000;
    var cls = ageMin > 10 ? "day-stale-stamp amber" : "day-stale-stamp";
    var text = "Last updated " + g.TimeCore.formatDate(new Date(state.lastSuccessAt), fmt);
    var stamp = el('<div class="' + cls + '"></div>');
    stamp.textContent = text;
    return stamp;
  }

  // ---- grid mode (§4.3) ------------------------------------------------------

  function layoutPerChildGrid(state, date) {
    var slotsIdx = g.SlotsCore.indexSlots(state.slots);
    var daysIdx = g.SlotsCore.indexDays(state.slotDays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var placed = [], unplaced = [], early = [], late = [];
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, daysIdx, row, date);
        if (chip.startMin == null) { unplaced.push(row); return; }
        if (chip.startMin < GRID_START_MIN) { early.push({ row: row, chip: chip }); return; }
        if (chip.startMin >= GRID_END_MIN) { late.push({ row: row, chip: chip }); return; }
        placed.push({ row: row, chip: chip, topMin: chip.startMin });
      });
      return { child: child, placed: placed, unplaced: unplaced, early: early, late: late };
    });
  }

  function buildGridContent(scroll, state, date, opts, fmt) {
    var perChild = layoutPerChildGrid(state, date);

    scroll.appendChild(buildTrayRow(perChild));

    var earlyStrip = buildStrip("early", perChild, fmt);
    if (earlyStrip) scroll.appendChild(earlyStrip);

    var body = buildGridBody(perChild, GRID_START_MIN, GRID_END_MIN, { fmt: fmt, onChipTap: opts.onChipTap });
    attachGridTapToPlace(body, GRID_START_MIN, GRID_END_MIN);
    scroll.appendChild(body);

    var lateStrip = buildStrip("late", perChild, fmt);
    if (lateStrip) scroll.appendChild(lateStrip);

    return { body: body, rangeStart: GRID_START_MIN, rangeEnd: GRID_END_MIN, scrollToNowIfToday: true, block: null };
  }

  // ---- block mode, collapsed (§4.4) -------------------------------------------

  function layoutPerChildByBlock(state, date) {
    var slotsIdx = g.SlotsCore.indexSlots(state.slots);
    var daysIdx = g.SlotsCore.indexDays(state.slotDays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var buckets = { morning: [], afternoon: [], evening: [], night: [] };
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, daysIdx, row, date);
        buckets[g.ChoresCore.blockForChip(row, chip)].push({ row: row, chip: chip });
      });
      g.ChoresCore.CANON_BLOCKS.forEach(function (b) {
        // Placed items first, ordered by time; unplaced last (§6's convention
        // for week view, reused here for the same reason: a time beats no time).
        buckets[b].sort(function (a, bItem) {
          var at = a.chip.startMin, bt = bItem.chip.startMin;
          if (at == null && bt == null) return 0;
          if (at == null) return 1;
          if (bt == null) return -1;
          return at - bt;
        });
      });
      return { child: child, buckets: buckets };
    });
  }

  // §8.4, mirrored for block mode's list rows — same four appearance
  // changes as chipHtml, just laid out inline rather than absolutely
  // positioned.
  function blockItemHtml(item, fmt) {
    var row = item.row;
    var done = row.status === "complete";
    var time = item.chip.startMin != null
      ? '<span class="block-item-time">' + g.TimeCore.formatMinutes(item.chip.startMin, fmt) + "</span>"
      : "";
    var doneBadge = done && row.completed_at != null
      ? '<span class="block-item-done-time">' + escapeHtml(g.TimeCore.formatDate(new Date(row.completed_at), fmt)) + "</span>"
      : "";
    return "<li" + (done ? ' class="block-item-done"' : "") + ">" +
      (done ? '<span class="chip-check">&#10003;</span>' : "") + time +
      '<span class="block-item-title">' + escapeHtml(row.title) + "</span>" + doneBadge + "</li>";
  }

  function buildBlockRow(blockName, perChildBuckets, opts, expandBlock) {
    var label = blockName.charAt(0).toUpperCase() + blockName.slice(1);
    var row = el('<div class="day-block-row"></div>');
    var headerCell = el('<div class="day-block-label"><button class="day-block-toggle"></button></div>');
    row.appendChild(headerCell);

    var totalCount = 0;
    perChildBuckets.forEach(function (entry) {
      var items = entry.buckets[blockName];
      totalCount += items.length;
      var cell = el('<div class="day-block-cell"></div>');
      if (items.length) {
        var list = el('<ul class="day-block-list"></ul>');
        items.forEach(function (item) {
          var li = el(blockItemHtml(item, opts.fmt));
          li.addEventListener("click", function () {
            if (opts.onChipTap) opts.onChipTap(item.row, entry.child);
          });
          list.appendChild(li);
        });
        cell.appendChild(list);
      }
      row.appendChild(cell);
    });

    var toggle = headerCell.querySelector(".day-block-toggle");
    toggle.textContent = label + " · " + totalCount;
    toggle.addEventListener("click", function () { expandBlock(blockName); });
    return row;
  }

  function buildBlocksContent(scroll, state, date, opts, fmt, expandBlock) {
    var perChild = layoutPerChildByBlock(state, date);
    g.ChoresCore.CANON_BLOCKS.forEach(function (blockName) {
      scroll.appendChild(buildBlockRow(blockName, perChild, { fmt: fmt, onChipTap: opts.onChipTap }, expandBlock));
    });
    return { body: null, rangeStart: null, rangeEnd: null, scrollToNowIfToday: false, block: null };
  }

  // ---- block mode, expanded — one block's own 15-minute grid (§4.4) ----------

  function buildSingleBlockHeader(blockName, collapseBlock) {
    var label = blockName.charAt(0).toUpperCase() + blockName.slice(1);
    var header = el(
      '<div class="day-block-expanded-header">' +
        '<button class="day-block-back">&#8249; Blocks</button>' +
        '<span class="day-block-expanded-title"></span>' +
      "</div>"
    );
    header.querySelector(".day-block-expanded-title").textContent = label;
    header.querySelector(".day-block-back").addEventListener("click", collapseBlock);
    return header;
  }

  function layoutPerChildForBlock(state, date, blockName) {
    var slotsIdx = g.SlotsCore.indexSlots(state.slots);
    var daysIdx = g.SlotsCore.indexDays(state.slotDays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var placed = [], unplaced = [];
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, daysIdx, row, date);
        if (g.ChoresCore.blockForChip(row, chip) !== blockName) return;
        if (chip.startMin == null) { unplaced.push(row); return; }
        placed.push({ row: row, chip: chip, topMin: g.ChoresCore.blockVirtualMin(chip.startMin, blockName) });
      });
      return { child: child, placed: placed, unplaced: unplaced };
    });
  }

  function buildSingleBlockContent(scroll, state, date, blockName, opts, fmt, collapseBlock) {
    var hours = g.ChoresCore.BLOCK_HOURS[blockName];
    var perChild = layoutPerChildForBlock(state, date, blockName);

    scroll.appendChild(buildSingleBlockHeader(blockName, collapseBlock));
    scroll.appendChild(buildTrayRow(perChild));

    var body = buildGridBody(perChild, hours.start, hours.end, { fmt: fmt, onChipTap: opts.onChipTap });
    attachGridTapToPlace(body, hours.start, hours.end);
    scroll.appendChild(body);

    return { body: body, rangeStart: hours.start, rangeEnd: hours.end, scrollToNowIfToday: true, block: blockName };
  }

  // ---- assembly --------------------------------------------------------------

  var current = { state: null, date: null, opts: {}, range: null };
  var currentRoot = null;
  var dayMode = "grid"; // "grid" | "blocks" | one of ChoresCore.CANON_BLOCKS
  var nowLineTimer = null;
  var staleTimer = null;
  var lastRenderedDate = null;
  var lastRenderedMode = null;
  var selectedForPlacement = null; // tap-to-place: {row, child} armed by a tray tap, or null
  var sheetState = null; // duration-adjust sheet: {row, value} while open, or null (§16 Phase 5b)

  function setMode(mode) {
    dayMode = mode;
    if (currentRoot && current.state) render(currentRoot, current.state, current.date, current.opts);
  }

  function stopTimers() {
    if (nowLineTimer) { clearInterval(nowLineTimer); nowLineTimer = null; }
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
  }

  // `state` is Poll.getState()'s shape, now carrying `.slots`/`.slotDays`
  // too (poll.js). `date` is the rendered day (nav-ui.js's state.date).
  function render(root, state, date, opts) {
    opts = opts || {};
    stopTimers();
    current = { state: state, date: date, opts: opts, range: null };
    currentRoot = root;

    var settings = g.Store.getSettings();
    var fmt = settings.timeFormat || "24h";
    var today = state.today;

    var oldScroll = root.querySelector(".day-scroll");
    var prevScrollTop = oldScroll ? oldScroll.scrollTop : null;
    var isNewDate = date !== lastRenderedDate;
    var isNewMode = dayMode !== lastRenderedMode;
    lastRenderedDate = date;
    lastRenderedMode = dayMode;

    // Tap-to-place is scoped to one rendered grid; a stale selection
    // carried into a different date or into collapsed block mode (no grid
    // to tap) would arm a placement nobody can see. The duration sheet is
    // scoped the same way — it names a rendered date via `current.date`.
    if ((isNewDate || isNewMode) && selectedForPlacement) selectedForPlacement = null;
    if ((isNewDate || isNewMode) && sheetState) sheetState = null;

    root.innerHTML = "";

    if (!state.children || state.children.length === 0) {
      root.appendChild(el(
        '<div class="day-empty">No active children yet. Add one in the Management App — ' +
        "it appears here automatically.</div>"
      ));
      return;
    }

    var modeClass = dayMode === "grid" ? "day-mode-grid" : dayMode === "blocks" ? "day-mode-blocks" : "day-mode-block-expanded";
    var shell = el('<div class="day-view ' + modeClass + '"><div class="day-scroll"></div></div>');
    var scroll = shell.querySelector(".day-scroll");

    scroll.appendChild(buildStickyHeader(state.children));
    scroll.appendChild(buildModeBar(dayMode, setMode));
    scroll.appendChild(buildEventsBand(state.rows, date));

    var result;
    if (dayMode === "grid") {
      result = buildGridContent(scroll, state, date, opts, fmt);
    } else if (dayMode === "blocks") {
      result = buildBlocksContent(scroll, state, date, opts, fmt, setMode);
    } else {
      result = buildSingleBlockContent(scroll, state, date, dayMode, opts, fmt, function () { setMode("blocks"); });
    }
    // A candidate startMin from a drop is meaningful only in the SAME
    // coordinate space `result.body` was laid out in — real clock minutes
    // in grid mode, block-virtual minutes in single-block mode (§4.4). Set
    // once here so `attachGesture`'s onUp (bound long before this render,
    // for a chip that survived from the last one) always reads the
    // CURRENT mode's range rather than a stale closure over the old one.
    current.range = result.body ? { start: result.rangeStart, end: result.rangeEnd } : null;

    scroll.appendChild(buildStaleStamp(state, fmt));
    root.appendChild(shell);

    // Re-shown on every render, not just the one that opened it — a
    // background poll's re-render (every 10 min, or right after any write)
    // rebuilds `root` from scratch, and without this the sheet would
    // silently vanish mid-adjustment (§16 Phase 5b).
    if (sheetState) buildDurationSheet();

    var rh = rowHeightPx();
    if (result.body) {
      var nowVirtual = null;
      if (date === today) {
        var now = new Date();
        var nowMin = now.getHours() * 60 + now.getMinutes();
        if (dayMode === "grid") {
          nowVirtual = nowMin; // grid always shows a (possibly edge-clamped) now-line, §4.3
        } else if (g.ChoresCore.blockFromStartMin(nowMin) === result.block) {
          nowVirtual = g.ChoresCore.blockVirtualMin(nowMin, result.block);
        }
      }
      if (nowVirtual != null) {
        positionNowLine(result.body, rh, result.rangeStart, result.rangeEnd, nowVirtual);
        (function (rangeStart, rangeEnd, block) {
          nowLineTimer = setInterval(function () {
            var n = new Date();
            var m = n.getHours() * 60 + n.getMinutes();
            var v = block ? g.ChoresCore.blockVirtualMin(m, block) : m;
            positionNowLine(result.body, rh, rangeStart, rangeEnd, v);
          }, 30000);
        })(result.rangeStart, result.rangeEnd, result.block);
      }
    }

    var resetScroll = isNewDate || isNewMode;
    if (!resetScroll && prevScrollTop != null) {
      scroll.scrollTop = prevScrollTop;
    } else if (result.scrollToNowIfToday && date === today && result.body) {
      requestAnimationFrame(function () {
        var nowLine = result.body.querySelector(".day-now-line");
        var target = (nowLine && nowLine.style.display !== "none") ? nowLine.offsetTop : 0;
        scroll.scrollTop = Math.max(0, target - scroll.clientHeight / 3);
      });
    }

    staleTimer = setInterval(function () {
      var stamp = scroll.querySelector(".day-stale-stamp");
      if (!stamp || !current.state || !current.state.lastSuccessAt) return;
      var ageMin = (Date.now() - current.state.lastSuccessAt) / 60000;
      stamp.classList.toggle("amber", ageMin > 10);
      stamp.textContent = "Last updated " + g.TimeCore.formatDate(new Date(current.state.lastSuccessAt), fmt);
    }, 15000);
  }

  function stop() {
    stopTimers();
    lastRenderedDate = null;
    lastRenderedMode = null;
    selectedForPlacement = null;
    sheetState = null;
  }

  g.DayUi = { render: render, stop: stop };
})(typeof window !== "undefined" ? window : globalThis);
