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
//
// §16 Phase 7 adds school blocks (§5, revised 2026-08-15 — a block is a span
// holding several member courses, §20). They are NOT chore rows and do not
// go through SlotsCore — they live in their own state
// (`state.schoolBlocks`/`state.schoolBlockCourses`, poll.js) and their own
// tables (migration 0011). `attachGesture` is generalized from a
// chore-specific `onTap`/`onLongPress` pair to also take `onDrop`/
// `onTrayDrop` callbacks, so the same pointer-gesture machinery serves a
// school block's drag-to-move without hardcoding SlotsCore/commitPlacement
// calls into it — a block's tap opens the membership picker (§5.2), its
// long-press opens a span/label editor (§5.4, with no precedence chain to
// show, unlike the chore duration sheet), and it has no tray drop at all
// (removal goes through the sheet, §5.4's "long-press sheet → remove"). The
// "+ School" affordance lives in the tray header (`buildTrayCell`), which is
// therefore now always rendered rather than hidden when nothing's unplaced.
//
// TDS_Slice_Wall_Placement_Scopes.md Phase 3 made every read resolve through
// three scopes (this occurrence / this weekday / standing); Phase 4 makes the
// WRITES do the same, and it is the whole of this file's share of that slice.
// Three things change and one deliberately does not:
//   * §7.1 — a drag writes the level ALREADY IN FORCE for the rendered date
//     (`resolveChip().scope`), not the standing row unconditionally. You move
//     what you see. A family that has never touched the scope controls sees
//     no difference: every chip resolves at 'standing'.
//   * §7.2 — the move toast names the scope in words and offers the two
//     levels it did not write, so "actually, Fridays only" is two taps on the
//     gesture already being made.
//   * §6.1 — the duration sheet becomes an ADJUST sheet: a start stepper
//     above the duration one, and three scope buttons in place of the old
//     "Just this one / This and future" fork.
//   * §11.6 — un-placing stays standing-scoped and is no longer destructive.
//     A tray drag deletes the placement and leaves both override levels
//     dormant beneath it (§2.1's gate), so it cannot take a year of
//     per-weekday times with it.
// Which level a gesture writes (`planScopeWrite`) and what may go in the body
// (`overrideWrite`) are decided in `slots-core.js`, where they can be tested;
// this file holds the dispatch, the optimistic mirror and the wording.

(function (g) {
  "use strict";

  var GRID_START_MIN = 6 * 60; // 06:00 (§4.3)
  var GRID_END_MIN = 23 * 60; // 23:00
  var ROW_MIN = 15;
  // ---- gesture tolerances ---------------------------------------------------
  // A mouse pointer is precise and a fingertip is not. The wall is a tablet
  // on a kitchen wall, tapped in passing by children with the flat of a
  // finger: a tap there routinely travels 15-30px between touchdown and
  // lift, which the original single 8px threshold read as a DRAG — so
  // trying to tick a chore off moved it instead, silently and with no undo.
  // That is the worst possible failure for this app: a destructive action
  // produced by the gesture meant for the safe one.
  //
  // So a touch pointer gets three separate tolerances, and a mouse keeps
  // the old behaviour exactly:
  //   * it must travel further before anything counts as a drag,
  //   * it cannot start a drag AT ALL in the first DRAG_ARM_MS — a press
  //     and lift inside that window is a tap however far the finger rolled,
  //   * and a tap stays a tap out to TOUCH_TAP_ROLL_PX, well past the drag
  //     slop, so a wobbly tap still ticks the chore off rather than doing
  //     nothing. Past that, an early lift is read as a swipe and does
  //     nothing at all — never a move the child didn't ask for.
  var DRAG_THRESHOLD_PX = 8; // mouse/pen: below this, a pointer-down+up is a TAP, not a drag
  var TOUCH_DRAG_SLOP_PX = 44; // finger: floor for how far it must travel before a drag is possible
  var TOUCH_TAP_ROLL_PX = 40; // finger: how far a tap may roll and still be a tap
  var DRAG_ARM_MS = 140; // finger: no drag may begin before this — a quick tap can never move anything

  // The slop a finger has to beat, which is deliberately at least a row
  // taller than the grid's snap: the drop snaps to a 15-minute row, so a
  // drag shorter than one row cannot express anything a tap doesn't
  // already say, and reading one as a move is all cost and no meaning.
  // Scales with the zoom for the same reason — a row is 18px at one end of
  // ZOOM_STEPS and 52px at the other.
  function touchDragSlopPx() {
    return Math.max(TOUCH_DRAG_SLOP_PX, rowHeightPx() + 8);
  }
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
    return parseFloat(v) || DEFAULT_ROW_H;
  }

  // ---- zoom (§4.3's 15-minute row, in pixels) --------------------------------
  // A row is always 15 minutes of MEANING; how many PIXELS that is, is a
  // property of the glass it is drawn on. A 10" wall tablet wants far fewer
  // hours on screen at once than a desktop browser does, and there is no
  // one right density to hard-code. So --row-h stays the single place the
  // height is stated (CSS declares the default, day-ui.js reads it back —
  // the no-drift property the CSS comment describes), and the zoom simply
  // sets it on the root element before layout.
  //
  // Stored per tablet in wall settings, never on the server: this is about
  // the device's screen, not about the household. Steps rather than a
  // slider — a wall gets a fat button pressed by a child walking past, not
  // a drag handle (§11.2).
  var ZOOM_STEPS = [18, 24, 32, 40, 52];
  var DEFAULT_ROW_H = 32;
  // Set by setZoom so the render it triggers can keep the same CLOCK TIME
  // under the reader's eye: scrollTop is in pixels, and every pixel just
  // changed what it means.
  var zoomScrollScale = null;
  // Last render's visible grid band, in px, for the zoom readout (see
  // hoursOnScreenLabel).
  var lastScrollHeightPx = 0;

  function storedRowH() {
    var v = Number(g.Store.getSettings().dayRowH);
    return ZOOM_STEPS.indexOf(v) >= 0 ? v : DEFAULT_ROW_H;
  }

  function applyRowH() {
    document.documentElement.style.setProperty("--row-h", storedRowH() + "px");
  }

  function setZoom(step) {
    var cur = storedRowH();
    var next = ZOOM_STEPS[ZOOM_STEPS.indexOf(cur) + step];
    if (next == null) return;
    zoomScrollScale = next / cur;
    g.Store.setSettings({ dayRowH: next });
    if (currentRoot && current.state) render(currentRoot, current.state, current.date, current.opts);
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
    // Blocks mode draws no time grid at all (§4.4), so it has nothing to
    // zoom — the control is hidden there rather than shown doing nothing.
    var hasGrid = mode !== "blocks";
    var rowH = storedRowH();
    var zoom = hasGrid
      ? '<div class="day-zoom">' +
          '<button class="day-zoom-btn" data-zoom="-1" aria-label="Show more hours"' +
            (rowH === ZOOM_STEPS[0] ? " disabled" : "") + ">&minus;</button>" +
          '<span class="day-zoom-label">' + hoursOnScreenLabel(rowH) + "</span>" +
          '<button class="day-zoom-btn" data-zoom="1" aria-label="Show fewer, larger hours"' +
            (rowH === ZOOM_STEPS[ZOOM_STEPS.length - 1] ? " disabled" : "") + ">+</button>" +
        "</div>"
      : "";
    var bar = el(
      '<div class="day-mode-bar">' +
        '<button class="day-mode-btn' + (isGrid ? " active" : "") + '" data-mode="grid">Full day</button>' +
        '<button class="day-mode-btn' + (!isGrid ? " active" : "") + '" data-mode="blocks">Blocks</button>' +
        zoom +
      "</div>"
    );
    bar.querySelector('[data-mode="grid"]').addEventListener("click", function () { setMode("grid"); });
    bar.querySelector('[data-mode="blocks"]').addEventListener("click", function () { setMode("blocks"); });
    bar.querySelectorAll(".day-zoom-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { setZoom(Number(btn.dataset.zoom)); });
    });
    return bar;
  }

  // The zoom's own readout, in the unit the reader actually cares about:
  // not "32px", but roughly how much of the day fits on this screen at
  // this step. Measured against the scroll container when there is one,
  // so a tablet and a desktop each get their own honest number.
  function hoursOnScreenLabel(rowH) {
    // Measured off the last render's grid band (render() clears the root
    // before it builds this bar, so there is nothing to measure by the
    // time we get here — render() rewrites the label once there is). The
    // first paint of a page load falls back to a sane tablet-ish height.
    var px = lastScrollHeightPx || 420;
    var hours = (px / rowH) * (ROW_MIN / 60);
    // Halves below three hours, whole hours above — a readout, not a
    // measurement, and "3.0h" reads worse than "3h" for the same number.
    return (hours < 3 ? String(Math.round(hours * 2) / 2) : String(Math.round(hours))) + "h";
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

  // Every transient message on the wall goes through toast.js, which owns
  // the one policy (8 seconds or the next tap) and hosts on <body> so a
  // background poll's re-render cannot tear it out from under the reader.
  // `action` is an optional { label, run } — the Undo a move offers (§3.6:
  // a placement is never refused, so recovery from a wrong one has to be
  // immediate and in reach) — or, Placement Scopes §7.2, an ARRAY of them:
  // a move now offers the two scopes it did not write beside Undo.
  function showToast(message, kind, sticky, action) {
    if (message == null) return g.Toast.clear();
    var opts = { kind: kind, sticky: sticky };
    if (Array.isArray(action)) opts.actions = action; else opts.action = action;
    g.Toast.show(message, opts);
  }

  function rerenderNow() {
    if (currentRoot && current.state) render(currentRoot, current.state, current.date, current.opts);
  }

  function buildGhost(title) {
    var ghost = el('<div class="drag-ghost"></div>');
    ghost.textContent = title;
    return ghost;
  }

  // §16 Phase 7 — school blocks (§5). A block lives in its own table
  // (wall_school_blocks/wall_school_block_courses), not wall_slots, and has
  // no `assignments` row of its own — so these helpers work from
  // `state.schoolBlocks`/`state.schoolBlockCourses` directly rather than
  // through SlotsCore, which only ever resolves chore rows (§3.1's table).

  // Placement Scopes §5.2 (Phase 3) — was `blocksForChild(state, childId)`,
  // which filtered on `child_id` alone. THAT is §0.1: nothing asked which days
  // a block happens on, so every block rendered on every date, weekends
  // included. It now filters on the child AND `blockOccursOn`.
  //
  // The returned rows are live references into `state.schoolBlocks` — this
  // filters, it does not clone — because `moveSchoolBlock` mutates one in
  // place to keep an optimistic render in sync. The resolved span rides on
  // the block ENTRY instead (`blockEntry` below), which is the read side.
  function blockIndexes(state) {
    return {
      weekdays: g.SchoolCore.indexBlockWeekdays(state.schoolBlockWeekdays),
      dates: g.SchoolCore.indexBlockDates(state.schoolBlockDates),
    };
  }

  function blocksForChildOn(state, childId, date) {
    var idx = blockIndexes(state);
    var weekday = g.TimeCore.weekdayOf(date);
    return (state.schoolBlocks || []).filter(function (b) {
      return b.child_id === childId &&
        g.SchoolCore.blockOccursOn(idx.weekdays, idx.dates, b.id, date, weekday);
    });
  }

  function membersOf(state, blockId) {
    return (state.schoolBlockCourses || [])
      .filter(function (c) { return c.block_id === blockId; })
      .map(function (c) { return c.course_name; });
  }

  function blockLabel(block) {
    return block.label || "School";
  }

  // The full read for one block on one rendered date: its member courses'
  // rollups (§5.3), whether every one of them is checked, and — Placement
  // Scopes §2.2 — the span to actually draw it at.
  //
  // `startMin`/`endMin` here are the RESOLVED pair (date row, else weekday
  // row, else the block's own), not `block.start_min`/`block.end_min`. Every
  // render path reads them from the entry; the write paths (moveSchoolBlock,
  // the block sheet) still address `block` directly, which is correct for
  // today — they write the standing level, and §7.1's "write the level that
  // is winning" rule is Phase 5's.
  //
  // `collapsed` and the rollups are computed from the RENDERABLE rollups
  // (§5.3): a member with nothing that date has nothing to show and is not
  // drawn, so it must not be able to hold the block open either.
  function blockEntry(state, child, block, date) {
    var members = membersOf(state, block.id);
    var rollups = g.SchoolCore.renderableRollups(
      g.SchoolCore.memberRollups(state.rows, child.id, date, members)
    );
    var idx = blockIndexes(state);
    var placement = g.SchoolCore.resolvePlacement(
      idx.weekdays, idx.dates, block, date, g.TimeCore.weekdayOf(date)
    );
    return {
      block: block,
      rollups: rollups,
      collapsed: g.SchoolCore.isCollapsed(rollups),
      startMin: placement.startMin,
      endMin: placement.endMin,
      spanScope: placement.spanScope,
    };
  }

  // Adapts a block entry to the shape buildStrip (§4.3's early/late strips)
  // already expects from a chore — {row: {title}, chip: {startMin}} — so a
  // block placed outside 06:00-23:00 shows there too rather than being
  // silently dropped.
  function blockStripItem(be) {
    return { row: { title: blockLabel(be.block) }, chip: { startMin: be.startMin } };
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
    var wdIdx = g.SlotsCore.indexWeekdays(current.state.slotWeekdays);
    var chores = g.ChoresCore.choresForChild(current.state.rows, row.child_id, current.date, current.state.today);
    var others = [];
    chores.forEach(function (r) {
      if (r.id === row.id) return; // exclude the subject being moved
      others.push({ row: r, chip: g.SlotsCore.resolveChip(slotsIdx, wdIdx, daysIdx, r, current.date) });
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

  // Placement Scopes §11.6 — the override levels are NOT swept, matching what
  // `DELETE /api/wall/slots` now does server-side. This used to drop
  // `slotDays` locally, which was already a divergence the next poll undid;
  // it matters more now that un-placing deliberately leaves both override
  // levels dormant beneath the missing placement (§2.1's gate), because
  // re-placing the chore is supposed to bring its weekday and date times
  // back with it.
  function applyOptimisticUnplace(childId, subjectKey, instanceKey) {
    current.state.slots = (current.state.slots || []).filter(function (s) {
      return !(s.child_id === childId && s.subject_kind === "chore" && s.subject_key === subjectKey &&
        (s.instance_key || "") === instanceKey);
    });
  }

  // ---- writing a level (Placement Scopes §4.1, §4.2, §6.1) -----------------
  // Three levels, three routes, one shape. Which level a gesture writes is
  // `SlotsCore.planScopeWrite`'s answer and what goes in the body is
  // `SlotsCore.overrideValuesFor`'s; this half is the dispatch and the
  // optimistic mirror, which is all that is left once those two are pure.

  function slotIdent(row) {
    return {
      childId: g.SlotsCore.placementChildId(row),
      subjectKey: g.SlotsCore.subjectKeyOf(row),
      instanceKey: g.SlotsCore.instanceKeyOf(row),
    };
  }

  // The three rows a chore has on the rendered date, freshly re-derived.
  // Always re-read rather than closed over: a background poll may have landed
  // between a gesture and the write it triggers.
  function levelRowsFor(row, date) {
    var slotsIdx = g.SlotsCore.indexSlots(current.state.slots);
    var wdIdx = g.SlotsCore.indexWeekdays(current.state.slotWeekdays);
    var daysIdx = g.SlotsCore.indexDays(current.state.slotDays);
    var weekday = g.TimeCore.weekdayOf(date);
    return {
      weekday: weekday,
      slot: g.SlotsCore.placementFor(slotsIdx, row),
      weekdayRow: g.SlotsCore.weekdayOverrideFor(wdIdx, row, weekday),
      dayRow: g.SlotsCore.dayOverrideFor(daysIdx, row, date),
      chip: g.SlotsCore.resolveChip(slotsIdx, wdIdx, daysIdx, row, date),
    };
  }

  // One level's write. `startMin`/`durationMin` are THAT LEVEL'S OWN values
  // (§4.1) — never the resolved numbers the chip is drawing with — and a pair
  // of nulls on an override level is a DELETE, which is how a level goes away.
  function writeLevel(row, level, startMin, durationMin, date, weekday) {
    var id = slotIdent(row);
    var w = g.SlotsCore.overrideWrite(level, startMin, durationMin);
    if (level === "standing") {
      return g.WallApi.putSlot(id.childId, "chore", id.subjectKey, id.instanceKey, w.startMin, w.durationMin);
    }
    if (level === "weekday") {
      return w.verb === "delete"
        ? g.WallApi.deleteSlotWeekday(id.childId, "chore", id.subjectKey, id.instanceKey, weekday)
        : g.WallApi.putSlotWeekday(id.childId, "chore", id.subjectKey, id.instanceKey, weekday, w.startMin, w.durationMin);
    }
    return w.verb === "delete"
      ? g.WallApi.deleteSlotDay(id.childId, "chore", id.subjectKey, id.instanceKey, date)
      : g.WallApi.putSlotDay(id.childId, "chore", id.subjectKey, id.instanceKey, date, w.startMin, w.durationMin);
  }

  // Clearing an OVERRIDE level is the both-null write. Never called with
  // 'standing': `planScopeWrite` cannot return it, because deleting the
  // standing row is not a clear — it un-places the chore on every day of the
  // year (§6.1).
  function clearLevel(row, level, date, weekday) {
    return writeLevel(row, level, null, null, date, weekday);
  }

  // §16 Phase 5b — the optimistic mirror of `writeLevel`, so the re-render a
  // successful write kicks off draws the new placement without waiting for
  // the poll. Keyed exactly like the Worker's own ON CONFLICT clauses.
  function applyOptimisticLevel(row, level, startMin, durationMin, date, weekday) {
    var id = slotIdent(row);
    var w = g.SlotsCore.overrideWrite(level, startMin, durationMin);
    if (level === "standing") {
      applyOptimisticSlot(id.childId, id.subjectKey, id.instanceKey, w.startMin, w.durationMin);
      return;
    }
    var listKey = level === "weekday" ? "slotWeekdays" : "slotDays";
    var list = current.state[listKey] || (current.state[listKey] = []);
    var matches = function (r) {
      return r.child_id === id.childId && r.subject_kind === "chore" && r.subject_key === id.subjectKey &&
        (r.instance_key || "") === id.instanceKey &&
        (level === "weekday" ? r.weekday === weekday : r.date === date);
    };
    if (w.verb === "delete") {
      current.state[listKey] = list.filter(function (r) { return !matches(r); });
      return;
    }
    for (var i = 0; i < list.length; i++) {
      if (matches(list[i])) {
        list[i].start_min = w.startMin;
        list[i].duration_min = w.durationMin;
        return;
      }
    }
    var fresh = {
      child_id: id.childId, subject_kind: "chore", subject_key: id.subjectKey,
      instance_key: id.instanceKey, start_min: w.startMin, duration_min: w.durationMin,
    };
    if (level === "weekday") fresh.weekday = weekday; else fresh.date = date;
    list.push(fresh);
  }

  function applyOptimisticClear(row, level, date, weekday) {
    applyOptimisticLevel(row, level, null, null, date, weekday);
  }

  // How a scope reads to the family, in the two places it is said out loud:
  // the toast's tail ("moved to 4:00 PM — every Friday") and the sheet's own
  // buttons. `weekday` is the rendered date's, so the button standing at the
  // tablet on a Friday says Friday (§6.1).
  function scopeWord(level, weekday) {
    if (level === "day") return "just today";
    if (level === "weekday") return "every " + g.TimeCore.weekdayName(weekday);
    return "every day";
  }

  function scopeButtonLabel(level, weekday) {
    if (level === "day") return "Only today";
    if (level === "weekday") return "Only " + g.TimeCore.weekdayName(weekday, true);
    return "Every day";
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
  // startMin, already converted to real clock minutes.
  //
  // Placement Scopes §7.1 — YOU MOVE WHAT YOU SEE. This used to write the
  // standing placement unconditionally; it now writes the level that put the
  // chip where the finger found it, which is `resolveChip().scope`. A chore
  // dragged out of the tray has no level yet, so its first placement is
  // still the standing one — §2.1's gate means it could not be anything
  // else, since an override cannot place a chore. A family that has never
  // touched the scope controls therefore sees no change at all: every chip
  // resolves at 'standing' and every drag writes `wall_slots.start_min`.
  //
  // The duration column is the level's OWN value, verbatim (§4.1) — never
  // the resolved number the chip is drawing with. A drag is a move, not a
  // re-timing, so it must not freeze a chip against the parent's
  // `expected_duration_min` (test 4b) nor overwrite a duration override
  // sitting at the level it happens to be writing.
  function commitPlacement(row, startMin) {
    var date = current.date;
    var rows = levelRowsFor(row, date);
    var level = rows.chip.scope || "standing";
    var own = g.SlotsCore.levelRow(level, rows.slot, rows.weekdayRow, rows.dayRow);
    var wasAt = own ? own.start_min : null; // that level's own start — null = it was in the tray
    var ownDuration = own ? own.duration_min : null; // preserved, never guessed (§3.5.1/§4.1)
    var collision = findCollisionForDrop(row, startMin, rows.chip.durationMin);
    var fmt = (g.Store.getSettings().timeFormat) || "24h";

    writeLevel(row, level, startMin, ownDuration, date, rows.weekday).then(function () {
      applyOptimisticLevel(row, level, startMin, ownDuration, date, rows.weekday);
      rerenderNow();
      if (collision) {
        showToast(
          row.title + " overlaps " + collision.row.title + " at " +
          g.TimeCore.formatMinutes(collision.chip.startMin, fmt), "warning");
        flashCollision(row.id, collision.row.id);
      } else {
        showToast(
          row.title + " moved to " + g.TimeCore.formatMinutes(startMin, fmt) +
            " — " + scopeWord(level, rows.weekday), null, false,
          moveActions(row, level, startMin, wasAt, ownDuration, date, rows.weekday, fmt));
      }
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't place “" + row.title + "” — try again.", "warning");
    });
  }

  // §7.2 — the toast is where scope becomes visible: the move that just
  // happened, plus the two levels it did NOT write, plus Undo.
  //
  // The scope buttons appear only when the drag re-timed an EXISTING
  // placement. A chore coming from the tray (`wasAt == null`) gets Undo
  // alone, because §2.1's gate makes "placed on Fridays only" unreachable by
  // design (§11.7): re-homing that first placement onto an override level
  // would write a dormant row and leave the chore in the tray, which is the
  // gesture visibly failing to do what it looked like it did.
  function moveActions(row, level, startMin, wasAt, wasDuration, date, weekday, fmt) {
    var undo = { label: "Undo", run: function () { revertPlacement(row, level, wasAt, wasDuration, date, weekday, fmt); } };
    if (wasAt == null) return undo;
    var others = ["day", "weekday", "standing"].filter(function (l) { return l !== level; });
    return others.map(function (target) {
      return {
        label: scopeButtonLabel(target, weekday),
        run: function () { rehomeMove(row, level, target, startMin, wasAt, wasDuration, date, weekday, fmt); },
      };
    }).concat([undo]);
  }

  // §7.2 — "actually, Fridays only": undo the drag at the level it landed on,
  // then write the same time at the level the family asked for. Two taps
  // total, on the gesture they were already making.
  //
  // "Undo it at the level it landed on" is §6.1's table, not a plain restore,
  // and the difference is the whole gesture on one of the six paths. Dragging
  // a chip whose time comes from its Friday row and then tapping "Every day"
  // must CLEAR that Friday row: restoring it would leave Friday overriding
  // the standing time the family just asked for, so the chip would sit
  // exactly where it was and the button would appear to do nothing — §7.1's
  // worst failure, arriving through the affordance meant to prevent it. Going
  // the other way (standing → an override) clears nothing, so there the
  // standing row is restored to what it held.
  //
  // The undo half goes FIRST, deliberately. Both writes are online-required
  // with no outbox (§1), so either can fail alone. This order fails visibly —
  // the chip sits where it started and the toast says so. The other fails
  // invisibly: the new, more specific level lands and looks right on THIS
  // date while the level underneath keeps a time nobody chose for every other
  // one. Nothing re-renders between the two, so there is no flicker.
  function rehomeMove(row, fromLevel, toLevel, startMin, wasAt, wasDuration, date, weekday, fmt) {
    var plan = g.SlotsCore.planScopeWrite(fromLevel, toLevel);
    var undoDrag = plan.clear
      ? clearLevel(row, plan.clear, date, weekday).then(function () {
          applyOptimisticClear(row, plan.clear, date, weekday);
        })
      : writeLevel(row, fromLevel, wasAt, wasDuration, date, weekday).then(function () {
          applyOptimisticLevel(row, fromLevel, wasAt, wasDuration, date, weekday);
        });

    undoDrag.then(function () {
      // The TARGET level's own duration, read after the undo — never the
      // source level's, and never the resolved one (§4.1).
      var rows = levelRowsFor(row, date);
      var own = g.SlotsCore.levelRow(toLevel, rows.slot, rows.weekdayRow, rows.dayRow);
      var ownDuration = own ? own.duration_min : null;
      return writeLevel(row, toLevel, startMin, ownDuration, date, weekday).then(function () {
        applyOptimisticLevel(row, toLevel, startMin, ownDuration, date, weekday);
        rerenderNow();
        showToast(row.title + " moved to " + g.TimeCore.formatMinutes(startMin, fmt) +
          " — " + scopeWord(toLevel, weekday));
        g.Poll.pollNow();
      });
    }).catch(function () {
      rerenderNow();
      showToast("Couldn't change when that applies — try again.", "warning");
      g.Poll.pollNow();
    });
  }

  // Undo for a move: back to the minute it came from, at the LEVEL it came
  // from, or back to the tray if that is where it came from. Deliberately
  // NOT a call to commitPlacement/unplace — those would offer their own Undo,
  // and an undo that offers to undo itself is a loop, not a safety net.
  //
  // Placement Scopes §7.1 — `level` is what the move wrote, and `wasAt` is
  // that level's own start before it. On an override level, `wasAt` is never
  // null (the level was in force, which is why the drag chose it), so the
  // tray branch below stays what it always was: the standing row, and the
  // chore going back where it came from.
  function revertPlacement(row, level, wasAt, wasDuration, date, weekday, fmt) {
    var id = slotIdent(row);
    var done = function () {
      rerenderNow();
      showToast(
        wasAt == null
          ? row.title + " back in Not scheduled"
          : row.title + " back at " + g.TimeCore.formatMinutes(wasAt, fmt));
      g.Poll.pollNow();
    };
    var failed = function () { showToast("Couldn't undo — try again.", "warning"); };
    if (wasAt == null) {
      g.WallApi.deleteSlot(id.childId, "chore", id.subjectKey, id.instanceKey).then(function () {
        applyOptimisticUnplace(id.childId, id.subjectKey, id.instanceKey);
        done();
      }).catch(failed);
      return;
    }
    writeLevel(row, level, wasAt, wasDuration, date, weekday).then(function () {
      applyOptimisticLevel(row, level, wasAt, wasDuration, date, weekday);
      done();
    }).catch(failed);
  }

  // Placement Scopes §11.6 — un-placing stays STANDING-SCOPED whatever level
  // is in force on the rendered date, and it is no longer destructive: the
  // route deletes the `wall_slots` row and nothing else, so a tray drag on a
  // Friday cannot take a year of per-weekday times with it. Undo therefore
  // restores the standing row alone, which is now the whole of what was lost
  // — before this slice the same Undo was offered over a server-side sweep
  // it could not put back.
  function unplace(row) {
    var date = current.date;
    var id = slotIdent(row);
    var rows = levelRowsFor(row, date);
    var wasAt = rows.slot ? rows.slot.start_min : null;
    var wasDuration = rows.slot ? rows.slot.duration_min : null;
    var fmt = (g.Store.getSettings().timeFormat) || "24h";
    g.WallApi.deleteSlot(id.childId, "chore", id.subjectKey, id.instanceKey).then(function () {
      applyOptimisticUnplace(id.childId, id.subjectKey, id.instanceKey);
      rerenderNow();
      showToast(row.title + " moved to Not scheduled", null, false, wasAt == null ? null : {
        label: "Undo",
        run: function () { revertPlacement(row, "standing", wasAt, wasDuration, date, rows.weekday, fmt); },
      });
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't move “" + row.title + "” — try again.", "warning");
    });
  }

  // ---- the adjust sheet (§16 Phase 5b §3.5.2; Placement Scopes §6.1) -------
  // Opened by a long-press on a placed chip (attachGesture's onLongPress).
  // It began life as a duration editor and is now a PLACEMENT editor: a start
  // stepper above the duration one, and the two-button "this one / this and
  // future" fork replaced by three scope buttons, one per level of §2.1's
  // chain. "This and future" is gone as a label — it was always "standing",
  // and with three scopes on screen it would be the only one of the three
  // describing time rather than recurrence.
  //
  // `sheetState` holds `{row, startMin, durationMin, durationTouched}` —
  // everything else (the three rows, which level is in force, the
  // assigned-time label) is re-derived fresh from `current.state` on every
  // build, so a background poll landing while the sheet is open never shows
  // it stale data. `durationTouched` is load-bearing rather than cosmetic:
  // see `submitPlacement`.
  //
  // The CSS classes stay `.duration-sheet-*`. Three other modals in this app
  // reuse them verbatim (wall.css), so the names are the shared modal's, not
  // this sheet's subject.

  function showAdjustSheet(row) {
    var rows = levelRowsFor(row, current.date);
    if (rows.chip.startMin == null) return; // not placed — the sheet has nothing to adjust
    sheetState = { row: row, startMin: rows.chip.startMin, durationMin: rows.chip.durationMin, durationTouched: false };
    rerenderNow();
  }

  function closeAdjustSheet() {
    sheetState = null;
    rerenderNow();
  }

  // §6.1 — the three scope buttons. `toLevel` is the level the family tapped;
  // the placement moves there and the OVERRIDE level it came from is cleared,
  // so a chore never carries two levels saying different things.
  // `planScopeWrite` is what guarantees the standing row is never the thing
  // cleared — deleting it would un-place the chore on every day of the year,
  // which is the misreading §6.1 spends a paragraph on.
  //
  // What each column carries (§4.1):
  //   startMin     — the time on the stepper, always. The scope button IS the
  //                  act of pinning that time at that scope, so writing the
  //                  level's own (often absent) value would make the button
  //                  do nothing.
  //   durationMin  — the number on the stepper only if the family MOVED it;
  //                  otherwise the target level's own value, verbatim. This
  //                  is test 4b: a chip drawn at 30 minutes because the
  //                  parent authored 30 must write null, or the override is
  //                  frozen against the parent's later change and the §3.5.1
  //                  marker lights on a chip nobody re-timed.
  //
  // A duration adjustment is never a move, so the collision warning the
  // drag/drop path gives is preserved here too (§9): growing a chip can newly
  // overlap a neighbour just as moving one can.
  function submitPlacement(row, toLevel) {
    var s = sheetState;
    var date = current.date;
    var rows = levelRowsFor(row, date);
    var startMin = s.startMin;
    var durationTouched = s.durationTouched;
    var shownDuration = s.durationMin;
    var fmt = (g.Store.getSettings().timeFormat) || "24h";
    sheetState = null;
    rerenderNow();
    if (!rows.slot) return; // un-placed from under us while the sheet was open

    var plan = g.SlotsCore.planScopeWrite(rows.chip.scope || "standing", toLevel);
    var own = g.SlotsCore.levelRow(toLevel, rows.slot, rows.weekdayRow, rows.dayRow);
    var durationMin = durationTouched ? shownDuration : (own ? own.duration_min : null);

    // The clear goes first, for the same reason §7.2's re-homing reverts
    // first: two online-required writes with no outbox behind them, and the
    // half-done state that reads as deliberate is the one where the new,
    // more specific level landed over a stale one underneath it.
    var clear = plan.clear
      ? clearLevel(row, plan.clear, date, rows.weekday).then(function () {
          applyOptimisticClear(row, plan.clear, date, rows.weekday);
        })
      : Promise.resolve();

    clear.then(function () {
      return writeLevel(row, toLevel, startMin, durationMin, date, rows.weekday).then(function () {
        applyOptimisticLevel(row, toLevel, startMin, durationMin, date, rows.weekday);
        rerenderNow();
        var chip = levelRowsFor(row, date).chip;
        var collision = findCollisionForDrop(row, chip.startMin, chip.durationMin);
        if (collision) {
          showToast(
            row.title + " overlaps " + collision.row.title + " at " +
            g.TimeCore.formatMinutes(collision.chip.startMin, fmt), "warning");
          flashCollision(row.id, collision.row.id);
        } else {
          showToast(row.title + " — " + g.TimeCore.formatMinutes(chip.startMin, fmt) + ", " +
            g.TimeCore.formatDurationMin(chip.durationMin) + ", " + scopeWord(toLevel, rows.weekday));
        }
        g.Poll.pollNow();
      });
    }).catch(function () {
      showToast("Couldn't adjust “" + row.title + "” — try again.", "warning");
      g.Poll.pollNow();
    });
  }

  // "Use the assigned time" returns the chip to row 4/5 of the §3.5.1 chain
  // unconditionally — ALL THREE levels may carry a duration override at once,
  // and leaving any of them behind would silently disagree with what the
  // button just promised.
  //
  // Placement Scopes §4.1 — and it clears the duration column only. On an
  // override level that also carries a start override, that is a PUT keeping
  // its own `start_min` with a null duration, NOT a DELETE: the button says
  // "the assigned TIME", meaning how long the thing takes, and throwing away
  // Friday's start time on the way would be a second edit nobody asked for.
  // Where a level carries no start override either, the pair is null/null and
  // `overrideWrite` turns it into the DELETE it actually is — and a DELETE of
  // a level that was never set is a no-op, not an error, which is why all
  // three are called regardless of what exists.
  function submitDurationClear(row) {
    var date = current.date;
    var rows = levelRowsFor(row, date);
    sheetState = null;
    rerenderNow();
    if (!rows.slot) return;

    var levels = [
      { level: "standing", startMin: rows.slot.start_min },
      { level: "weekday", startMin: rows.weekdayRow ? rows.weekdayRow.start_min : null },
      { level: "day", startMin: rows.dayRow ? rows.dayRow.start_min : null },
    ];
    Promise.all(levels.map(function (l) {
      return writeLevel(row, l.level, l.startMin, null, date, rows.weekday);
    })).then(function () {
      levels.forEach(function (l) {
        applyOptimisticLevel(row, l.level, l.startMin, null, date, rows.weekday);
      });
      rerenderNow();
      showToast(row.title + " back to the assigned time");
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't reset “" + row.title + "”'s duration — try again.", "warning");
      g.Poll.pollNow();
    });
  }

  function buildAdjustSheet() {
    var s = sheetState;
    var row = s.row;
    var rows = levelRowsFor(row, current.date);
    if (!rows.slot) { sheetState = null; return; } // un-placed from under us while open — drop silently
    // Placement Scopes §2.1 — three override levels now, so the marker asks
    // all three. Passing only the date row here would light the "Use the
    // assigned time" reset for a chip whose duration comes from a weekday row
    // and leave it dark for one that has only a weekday override.
    var overridden = g.SlotsCore.isOverridden(rows.slot, rows.weekdayRow, rows.dayRow);
    var assigned = g.SlotsCore.assignedDurationMin(row);
    var inForce = rows.chip.scope || "standing";
    var fmt = (g.Store.getSettings().timeFormat) || "24h";

    var scopeBtns = ["day", "weekday", "standing"].map(function (level) {
      // The level in force is the only one NOT ghosted — accent fill is this
      // app's mark for a chosen option, and §6.1 asks for the current level
      // to be marked.
      return '<button class="btn dur-scope' + (level === inForce ? "" : " ghost") +
        '" data-level="' + level + '" type="button"></button>';
    }).join("");

    var overlay = el(
      '<div class="duration-sheet-overlay">' +
        '<div class="duration-sheet-card">' +
          "<h2>Adjust</h2>" +
          '<div class="duration-sheet-title"></div>' +
          '<div class="duration-sheet-stepper">' +
            '<span class="duration-sheet-label">Starts</span>' +
            '<button class="btn ghost start-step" data-step="-15" type="button">&minus;</button>' +
            '<div class="duration-sheet-value" id="startValue"></div>' +
            '<button class="btn ghost start-step" data-step="15" type="button">+</button>' +
          "</div>" +
          '<div class="duration-sheet-stepper">' +
            '<span class="duration-sheet-label">Takes</span>' +
            '<button class="btn ghost dur-step" data-step="-15" type="button">&minus;</button>' +
            '<div class="duration-sheet-value" id="durValue"></div>' +
            '<button class="btn ghost dur-step" data-step="15" type="button">+</button>' +
          "</div>" +
          (overridden ? '<button class="btn ghost duration-sheet-reset" id="durUseAssigned"></button>' : "") +
          '<div class="duration-sheet-scopes">' + scopeBtns + "</div>" +
          '<div class="duration-sheet-actions">' +
            '<button class="btn ghost" id="durCancel">Cancel</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
    overlay.querySelector(".duration-sheet-title").textContent = row.title;
    overlay.querySelector("#startValue").textContent = g.TimeCore.formatMinutes(s.startMin, fmt);
    overlay.querySelector("#durValue").textContent = g.TimeCore.formatDurationMin(s.durationMin);
    overlay.querySelectorAll(".dur-scope").forEach(function (btn) {
      btn.textContent = scopeButtonLabel(btn.dataset.level, rows.weekday);
    });
    var resetBtn = overlay.querySelector("#durUseAssigned");
    if (resetBtn) resetBtn.textContent = "Use the assigned time (" + g.TimeCore.formatDurationMin(assigned) + ")";

    // The start stepper stays on the 15-minute grid and inside the day, which
    // is what `isValidStartMin` accepts (0-1425). The chip may still be
    // clamped at render if the composed pair runs past midnight (§2.1) —
    // that check belongs to the resolver, not to a stepper that can only see
    // one of the two numbers.
    overlay.querySelectorAll(".start-step").forEach(function (btn) {
      btn.addEventListener("click", function () {
        s.startMin = Math.max(0, Math.min(1440 - ROW_MIN, s.startMin + Number(btn.dataset.step)));
        rerenderNow();
      });
    });
    overlay.querySelectorAll(".dur-step").forEach(function (btn) {
      btn.addEventListener("click", function () {
        s.durationMin = Math.max(ROW_MIN, Math.min(MAX_ADJUST_MIN, s.durationMin + Number(btn.dataset.step)));
        s.durationTouched = true;
        rerenderNow();
      });
    });
    // `pointerdown`, NOT `click`: the tap that OPENS a sheet dispatches its
    // click after the overlay is already in the DOM, so a click listener
    // here closed the sheet in the same gesture that opened it — unless the
    // tap happened to land where the card ended up. That is what made a
    // chip feel like it had a "sweet spot": the sheet was opening every
    // time and dismissing itself before it could be seen. A pointerdown
    // that began before this overlay existed can never reach it.
    overlay.addEventListener("pointerdown", function (ev) {
      if (ev.target === overlay) closeAdjustSheet(); // backdrop tap cancels
    });
    overlay.querySelector("#durCancel").addEventListener("click", closeAdjustSheet);
    if (resetBtn) resetBtn.addEventListener("click", function () { submitDurationClear(row); });
    overlay.querySelectorAll(".dur-scope").forEach(function (btn) {
      btn.addEventListener("click", function () { submitPlacement(row, btn.dataset.level); });
    });

    currentRoot.appendChild(overlay);
  }

  // `label` is what the tray chip reads (title, plus the block badge when
  // the grid tray is showing one) — the toast has to name the same thing
  // the finger just touched, or arming one of three same-titled instances
  // gives no clue which one is armed.
  function tryToggleSelection(row, child, label) {
    if (selectedForPlacement && selectedForPlacement.row.id === row.id) {
      selectedForPlacement = null;
      rerenderNow();
      return;
    }
    selectedForPlacement = { row: row, child: child };
    rerenderNow();
    showToast("Tap a time to place “" + (label || row.title) + "” — tap it again to cancel.", "placing", true);
  }

  // A tap anywhere in the grid body while a tray item is armed places it
  // there; a tap on a chip is left to the chip's own gesture handler.
  function attachGridTapToPlace(bodyEl, rangeStart, rangeEnd) {
    bodyEl.addEventListener("click", function (ev) {
      // `.day-chip-hit` counts as the chip: it IS the chip's tap target, and
      // a tap that lands on its padding must not place an armed tray chore
      // there instead.
      if (!selectedForPlacement || ev.target.closest(".day-chip, .day-chip-hit")) return;
      var virtual = startMinFromPointer(ev.clientY, bodyEl, rangeStart, rangeEnd);
      var row = selectedForPlacement.row;
      selectedForPlacement = null;
      commitPlacement(row, virtual % 1440);
    });
  }

  // Pointer-down+move+up, unified for the gestures a chip or a tray item
  // supports: a small movement is a TAP (`onTap`); past `DRAG_THRESHOLD_PX`
  // it's a DRAG, tracked with a floating ghost and resolved on release by
  // where the pointer let go — the grid body calls `onDrop(startMin)`, the
  // tray row calls `onTrayDrop()` (either may be omitted: a school block has
  // no tray to drop onto, §16 Phase 7 — un-placing one goes through its own
  // sheet instead, §5.4), or neither (cancel, nothing written, §3.6). A
  // stationary hold past `LONG_PRESS_MS` is a fourth gesture, `onLongPress`
  // (§16 Phase 5b) — passed only for already-placed items, since it opens an
  // adjust sheet and an unplaced chore has nothing to adjust yet. Firing it
  // tears down the same listeners a drag or tap would have used, so a
  // long-press can never also resolve as either.
  //
  // `title` is a plain string (not a row/block object) so this stays generic
  // over whatever the caller is dragging — a chore row and a school block
  // carry the title in different places.
  function attachGesture(itemEl, title, onTap, onLongPress, onDrop, onTrayDrop, originMin) {
    itemEl.addEventListener("pointerdown", function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      var startX = ev.clientX, startY = ev.clientY;
      var lastX = startX, lastY = startY;
      var pointerId = ev.pointerId;
      // A finger, or something precise? Pen counts as precise: it has a tip.
      var touch = ev.pointerType === "touch";
      var dragSlop = touch ? touchDragSlopPx() : DRAG_THRESHOLD_PX;
      var tapRoll = touch ? TOUCH_TAP_ROLL_PX : DRAG_THRESHOLD_PX;
      var moved = false;
      var ghost = null;
      var longPressTimer = null;
      var armTimer = null; // while this is pending, no drag may begin (touch only)
      var bodyEl = currentRoot.querySelector(".day-grid-body");
      var trayRowEl = currentRoot.querySelector(".day-tray-row");

      function clearLongPress() {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        itemEl.classList.remove("pressing");
      }

      function distanceFromStart(x, y) {
        var dx = x - startX, dy = y - startY;
        return Math.sqrt(dx * dx + dy * dy);
      }

      function beginDrag(x, y) {
        clearLongPress();
        moved = true;
        ghost = buildGhost(title);
        currentRoot.appendChild(ghost);
        itemEl.classList.add("drag-source");
        if (bodyEl) bodyEl.classList.add("drop-armed");
        trackDrag(x, y);
      }

      function trackDrag(x, y) {
        positionGhost(ghost, x, y);
        var overBody = pointInRect(x, y, bodyEl && bodyEl.getBoundingClientRect());
        var overTray = pointInRect(x, y, trayRowEl && trayRowEl.getBoundingClientRect());
        if (bodyEl) bodyEl.classList.toggle("drop-hover", overBody);
        if (trayRowEl) trayRowEl.classList.toggle("drop-hover", overTray && !overBody);
      }

      function onMove(mv) {
        lastX = mv.clientX;
        lastY = mv.clientY;
        if (!moved) {
          if (distanceFromStart(lastX, lastY) < dragSlop) return;
          // Past the slop but still inside the arm delay: hold the gesture
          // open rather than committing to a drag. If the finger is still
          // down when armTimer fires, it starts dragging from wherever it
          // has got to; if it lifts first, onUp decides tap or nothing.
          if (armTimer) return;
          beginDrag(lastX, lastY);
          return;
        }
        trackDrag(lastX, lastY);
      }

      function cleanup() {
        clearLongPress();
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        if (itemEl.releasePointerCapture) { try { itemEl.releasePointerCapture(pointerId); } catch (e) {} }
        if (bodyEl) bodyEl.classList.remove("drop-armed", "drop-hover");
        if (trayRowEl) trayRowEl.classList.remove("drop-hover");
      }

      function onUp(up) {
        var wasDragging = moved;
        cleanup();
        itemEl.classList.remove("drag-source");
        if (ghost) ghost.remove();

        if (!wasDragging) {
          // Never armed a drag. A tap out to `tapRoll`; past that the
          // finger was travelling with intent but lifted too early to have
          // meant a move, so nothing happens — the one thing this must not
          // do is guess at a placement nobody asked for (§3.6).
          if (onTap && distanceFromStart(up.clientX, up.clientY) <= tapRoll) onTap();
          return;
        }

        var overTray = trayRowEl && pointInRect(up.clientX, up.clientY, trayRowEl.getBoundingClientRect());
        var overBody = !overTray && bodyEl && pointInRect(up.clientX, up.clientY, bodyEl.getBoundingClientRect());

        if (overTray) {
          if (onTrayDrop) onTrayDrop();
          return;
        }
        if (!overBody || !current.range) return; // dropped nowhere valid — cancel, nothing written (§3.6)

        var virtual = startMinFromPointer(up.clientY, bodyEl, current.range.start, current.range.end);
        var startMin = virtual % 1440;
        // Landed back in the slot it started in: a drag that changed
        // nothing writes nothing, rather than reporting a "move" to the
        // time the thing was already at.
        if (originMin != null && startMin === originMin) return;
        if (onDrop) onDrop(startMin);
      }

      ev.preventDefault();
      if (itemEl.setPointerCapture) { try { itemEl.setPointerCapture(pointerId); } catch (e) {} }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);

      if (touch) {
        armTimer = setTimeout(function () {
          armTimer = null;
          if (!moved && distanceFromStart(lastX, lastY) >= dragSlop) beginDrag(lastX, lastY);
        }, DRAG_ARM_MS);
      }

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

  // `showBlockHint` is true for the full-day grid's tray and false for a
  // single expanded block's, where every item in the tray is by definition
  // this block's and the header above it says so already.
  function buildTrayItem(row, child, showBlockHint) {
    var li = el("<li></li>");
    var hint = g.ChoresCore.blockHintLabel(row);
    var label = showBlockHint ? row.title + " · " + hint : row.title;
    var titleEl = el('<span class="day-tray-title"></span>');
    titleEl.textContent = row.title;
    li.appendChild(titleEl);
    if (showBlockHint) {
      var badge = el('<span class="day-tray-block"></span>');
      badge.textContent = hint;
      li.appendChild(badge);
    }
    if (selectedForPlacement && selectedForPlacement.row.id === row.id) li.classList.add("selected");
    attachGesture(li, label, function () { tryToggleSelection(row, child, label); }, null,
      function (startMin) { commitPlacement(row, startMin); },
      function () {
        // Dragged from the tray back onto the tray itself — already
        // unplaced, so this is a no-op rather than an error.
        if (g.SlotsCore.placementFor(g.SlotsCore.indexSlots(current.state.slots), row)) unplace(row);
      });
    return li;
  }

  // §5.4 — "+ School", alongside the unscheduled-chore strip, so it always
  // shows even when nothing is unscheduled (§16 Phase 7 widens the tray row
  // from "hidden unless something's unplaced" to "always visible" for
  // exactly this reason).
  function buildTrayCell(entry, showBlockHint) {
    var n = entry.unplaced.length;
    var cell = el('<div class="day-tray-cell"></div>');
    var addBtn = el('<button class="day-tray-add-school" type="button">+ School</button>');
    addBtn.addEventListener("click", function () { createSchoolBlock(entry.child); });
    cell.appendChild(addBtn);
    if (!n) return cell;
    var toggle = el('<button class="day-tray-toggle">Not scheduled &middot; ' + n + "</button>");
    var list = el('<ul class="day-tray-list"></ul>');
    // Sorted by block, not by `sort_order` alone, so the badges below run
    // morning -> night down the list instead of interleaving. The sort is
    // on a copy: `entry.unplaced` is layout output, and the placed chips
    // beside it still read in the parent's order.
    entry.unplaced.slice().sort(g.ChoresCore.compareBlockHint).forEach(function (row) {
      list.appendChild(buildTrayItem(row, entry.child, showBlockHint));
    });
    toggle.addEventListener("click", function () { cell.classList.toggle("expanded"); });
    cell.appendChild(toggle);
    cell.appendChild(list);
    return cell;
  }

  function buildTrayRow(perChild, showBlockHint) {
    var wrap = el('<div class="day-tray-row"><div class="day-gutter-spacer"></div></div>');
    perChild.forEach(function (entry) { wrap.appendChild(buildTrayCell(entry, showBlockHint)); });
    return wrap;
  }

  // §5.4 — "a default span (60 minutes, at the next free slot)". Scans this
  // child's OTHER blocks for the first 15-minute-aligned 60-minute gap in
  // the grid range; falls back to the top of the grid if none exists (an
  // edge case — the day is already covered — left to a drag to sort out,
  // rather than refusing to create the block at all, since overlap is
  // allowed everywhere except §9's private-chore case, which blocks never
  // trigger).
  var DEFAULT_BLOCK_DURATION_MIN = 60;

  // Placement Scopes §5.2 — takes the DATE-filtered set. A block created on a
  // Saturday should not dodge the span of one that only happens on Mondays;
  // it would land lower down the grid than it needed to. Harmless and
  // invisible when it happens, and cheap to get right.
  function nextFreeBlockStart(state, childId, durationMin, date) {
    var idx = blockIndexes(state);
    var weekday = g.TimeCore.weekdayOf(date);
    // Resolved spans, not the block rows' own: the gap this looks for is a
    // gap in what will be DRAWN that day (§2.2).
    var existing = blocksForChildOn(state, childId, date).map(function (b) {
      return g.SchoolCore.resolvePlacement(idx.weekdays, idx.dates, b, date, weekday);
    });
    var start = GRID_START_MIN;
    var limit = GRID_END_MIN - durationMin;
    while (start <= limit) {
      var end = start + durationMin;
      var overlaps = existing.some(function (b) { return start < b.endMin && b.startMin < end; });
      if (!overlaps) return start;
      start += ROW_MIN;
    }
    return GRID_START_MIN;
  }

  function createSchoolBlock(child) {
    var startMin = nextFreeBlockStart(current.state, child.id, DEFAULT_BLOCK_DURATION_MIN, current.date);
    g.WallApi.postSchoolBlock(child.id, startMin, DEFAULT_BLOCK_DURATION_MIN, null).then(function (res) {
      current.state.schoolBlocks = (current.state.schoolBlocks || []).concat([{
        id: res.id, child_id: child.id, label: null,
        start_min: startMin, end_min: startMin + DEFAULT_BLOCK_DURATION_MIN,
      }]);
      // Placement Scopes §2.2 — the optimistic append must carry the block's
      // SCHEDULE too, or `blocksForChildOn` filters the new block straight
      // back out and it flickers away until the next poll returns. The slice
      // (§9) predicted this and left it to Phase 5; it costs four lines here
      // because the route already answers with the weekday list it applied,
      // including the Mon-Fri default when the body named none.
      var weekdays = res.weekdays || [1, 2, 3, 4, 5];
      current.state.schoolBlockWeekdays = (current.state.schoolBlockWeekdays || []).concat(
        weekdays.map(function (weekday) {
          return { block_id: res.id, weekday: weekday, start_min: null, end_min: null };
        })
      );
      rerenderNow();
      showToast("School block added to " + child.name);
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't add a school block — try again.", "warning");
    });
  }

  // §5.4 — drag moves a block, setting a new standing start time (§3.3);
  // duration and label are untouched. `block` is a live reference into
  // `current.state.schoolBlocks` (blocksForChild filters, it doesn't clone),
  // so mutating it in place is enough to keep the render in sync —
  // the same optimistic-update shape applyOptimisticSlot uses for chores.
  function moveSchoolBlock(block, startMin, isUndo) {
    var durationMin = block.end_min - block.start_min;
    var wasAt = block.start_min;
    var fmt = (g.Store.getSettings().timeFormat) || "24h";
    g.WallApi.putSchoolBlock(block.id, { startMin: startMin }).then(function () {
      block.start_min = startMin;
      block.end_min = startMin + durationMin;
      rerenderNow();
      showToast(
        blockLabel(block) + (isUndo ? " back at " : " moved to ") + g.TimeCore.formatMinutes(startMin, fmt),
        null, false, isUndo ? null : {
          label: "Undo",
          run: function () { moveSchoolBlock(block, wasAt, true); },
        });
      g.Poll.pollNow();
    }).catch(function () {
      showToast((isUndo ? "Couldn't undo — " : "Couldn't move “" + blockLabel(block) + "” — ") + "try again.", "warning");
    });
  }

  // ---- school block span/label sheet (§5.4 — long-press on a block) --------
  // No precedence chain to display here (§3.5.1 doesn't apply to blocks,
  // §20) — this edits wall_school_blocks.end_min and .label directly, with
  // no "just this one"/"this and future" fork, unlike the chore duration
  // sheet above.

  function showBlockSheet(block) {
    blockSheetState = { block: block, value: block.end_min - block.start_min, label: block.label || "" };
    rerenderNow();
  }

  function closeBlockSheet() {
    blockSheetState = null;
    rerenderNow();
  }

  function removeSchoolBlock(block) {
    blockSheetState = null;
    rerenderNow();
    g.WallApi.deleteSchoolBlock(block.id).then(function () {
      current.state.schoolBlocks = (current.state.schoolBlocks || []).filter(function (b) { return b.id !== block.id; });
      current.state.schoolBlockCourses = (current.state.schoolBlockCourses || [])
        .filter(function (c) { return c.block_id !== block.id; });
      rerenderNow();
      showToast(blockLabel(block) + " removed");
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't remove “" + blockLabel(block) + "” — try again.", "warning");
    });
  }

  function submitBlockSheet() {
    var s = blockSheetState;
    var block = s.block;
    var newLabel = s.label.trim() || null;
    var newDuration = s.value;
    blockSheetState = null;
    rerenderNow();
    g.WallApi.putSchoolBlock(block.id, { durationMin: newDuration, label: newLabel }).then(function () {
      block.end_min = block.start_min + newDuration;
      block.label = newLabel;
      rerenderNow();
      showToast(blockLabel(block) + " updated");
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't update “" + blockLabel(block) + "” — try again.", "warning");
    });
  }

  function buildBlockSheet() {
    var s = blockSheetState;
    var overlay = el(
      '<div class="duration-sheet-overlay school-block-sheet-overlay">' +
        '<div class="duration-sheet-card">' +
          "<h2>Edit school block</h2>" +
          '<input class="school-block-label-input" type="text" placeholder="School" maxlength="60">' +
          '<div class="duration-sheet-stepper">' +
            '<button class="btn ghost dur-step" data-step="-15" type="button">&minus;</button>' +
            '<div class="duration-sheet-value"></div>' +
            '<button class="btn ghost dur-step" data-step="15" type="button">+</button>' +
          "</div>" +
          '<div class="duration-sheet-actions">' +
            '<button class="btn" id="blockSave">Save</button>' +
            '<button class="btn ghost" id="blockRemove">Remove block</button>' +
            '<button class="btn ghost" id="blockCancel">Cancel</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
    var labelInput = overlay.querySelector(".school-block-label-input");
    labelInput.value = s.label;
    labelInput.addEventListener("input", function () { s.label = labelInput.value; });
    overlay.querySelector(".duration-sheet-value").textContent = g.TimeCore.formatDurationMin(s.value);

    overlay.querySelectorAll(".dur-step").forEach(function (btn) {
      btn.addEventListener("click", function () {
        s.value = Math.max(ROW_MIN, Math.min(MAX_ADJUST_MIN, s.value + Number(btn.dataset.step)));
        rerenderNow();
      });
    });
    // `pointerdown`, NOT `click`: the tap that OPENS a sheet dispatches its
    // click after the overlay is already in the DOM, so a click listener
    // here closed the sheet in the same gesture that opened it — unless the
    // tap happened to land where the card ended up. That is what made a
    // chip feel like it had a "sweet spot": the sheet was opening every
    // time and dismissing itself before it could be seen. A pointerdown
    // that began before this overlay existed can never reach it.
    overlay.addEventListener("pointerdown", function (ev) {
      if (ev.target === overlay) closeBlockSheet();
    });
    overlay.querySelector("#blockCancel").addEventListener("click", closeBlockSheet);
    overlay.querySelector("#blockRemove").addEventListener("click", function () { removeSchoolBlock(s.block); });
    overlay.querySelector("#blockSave").addEventListener("click", submitBlockSheet);

    currentRoot.appendChild(overlay);
    labelInput.focus();
  }

  // ---- school block membership picker (§5.2 — a plain tap on a block) ------

  function showMembershipSheet(block) {
    membershipSheetState = { block: block };
    rerenderNow();
  }

  function closeMembershipSheet() {
    membershipSheetState = null;
    rerenderNow();
  }

  // ---- overlap overflow sheet (§9 display correction) -----------------------
  // What the "+N" tile (buildOverflowTile, above) opens: the same-slot
  // chips beyond the first two, in a plain tappable list. Tapping a row
  // acts exactly like tapping the chip itself would (`opts.onChipTap`) —
  // this is a visibility affordance, not a separate interaction surface.

  function showOverflowSheet(items, child, opts) {
    overflowSheetState = { items: items, child: child, opts: opts };
    rerenderNow();
  }

  function closeOverflowSheet() {
    overflowSheetState = null;
    rerenderNow();
  }

  function buildOverflowSheet() {
    var s = overflowSheetState;
    var fmt = (g.Store.getSettings().timeFormat) || "24h";
    var overlay = el(
      '<div class="duration-sheet-overlay school-picker-overlay">' +
        '<div class="duration-sheet-card">' +
          "<h2></h2>" +
          '<ul class="school-picker-list"></ul>' +
          '<div class="duration-sheet-actions">' +
            '<button class="btn" id="overflowDone">Done</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
    overlay.querySelector("h2").textContent = s.child.name + " — also in this slot";
    var list = overlay.querySelector(".school-picker-list");
    s.items.forEach(function (placed) {
      var row = placed.row;
      var li = el(
        '<li class="overflow-sheet-row">' +
          '<span class="strip-time"></span>' +
          '<span class="strip-title"></span>' +
        "</li>"
      );
      li.querySelector(".strip-time").textContent = g.TimeCore.formatMinutes(placed.chip.startMin, fmt);
      li.querySelector(".strip-title").textContent = row.title;
      li.addEventListener("click", function () {
        closeOverflowSheet();
        if (s.opts.onChipTap) s.opts.onChipTap(row, s.child);
      });
      list.appendChild(li);
    });
    // `pointerdown`, NOT `click`: the tap that OPENS a sheet dispatches its
    // click after the overlay is already in the DOM, so a click listener
    // here closed the sheet in the same gesture that opened it — unless the
    // tap happened to land where the card ended up. That is what made a
    // chip feel like it had a "sweet spot": the sheet was opening every
    // time and dismissing itself before it could be seen. A pointerdown
    // that began before this overlay existed can never reach it.
    overlay.addEventListener("pointerdown", function (ev) {
      if (ev.target === overlay) closeOverflowSheet();
    });
    overlay.querySelector("#overflowDone").addEventListener("click", closeOverflowSheet);
    currentRoot.appendChild(overlay);
  }

  function toggleMembership(block, courseName, checked) {
    var write = checked
      ? g.WallApi.putSchoolBlockCourse(block.id, courseName)
      : g.WallApi.deleteSchoolBlockCourse(block.id, courseName);
    write.then(function () {
      if (checked) {
        current.state.schoolBlockCourses = (current.state.schoolBlockCourses || [])
          .concat([{ block_id: block.id, course_name: courseName }]);
      } else {
        current.state.schoolBlockCourses = (current.state.schoolBlockCourses || [])
          .filter(function (c) { return !(c.block_id === block.id && c.course_name === courseName); });
      }
      rerenderNow();
      g.Poll.pollNow();
    }).catch(function () {
      showToast("Couldn't update that course — try again.", "warning");
      rerenderNow();
    });
  }

  function buildMembershipSheet() {
    var s = membershipSheetState;
    var block = s.block;
    var courses = g.SchoolCore.coursesWithActivities(current.state.rows, block.child_id, current.date);
    var memberSet = Object.create(null);
    membersOf(current.state, block.id).forEach(function (name) { memberSet[name] = true; });

    var overlay = el(
      '<div class="duration-sheet-overlay school-picker-overlay">' +
        '<div class="duration-sheet-card">' +
          "<h2></h2>" +
          '<ul class="school-picker-list"></ul>' +
          '<div class="duration-sheet-actions">' +
            '<button class="btn" id="pickerDone">Done</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
    overlay.querySelector("h2").textContent = blockLabel(block) + " courses";
    var list = overlay.querySelector(".school-picker-list");
    if (!courses.length) {
      list.appendChild(el('<li class="school-picker-empty">No courses assigned today.</li>'));
    }
    courses.forEach(function (name) {
      var li = el('<li class="school-picker-row"><label><input type="checkbox"><span></span></label></li>');
      var checkbox = li.querySelector("input");
      checkbox.checked = !!memberSet[name];
      li.querySelector("span").textContent = name;
      checkbox.addEventListener("change", function () { toggleMembership(block, name, checkbox.checked); });
      list.appendChild(li);
    });
    // `pointerdown`, NOT `click`: the tap that OPENS a sheet dispatches its
    // click after the overlay is already in the DOM, so a click listener
    // here closed the sheet in the same gesture that opened it — unless the
    // tap happened to land where the card ended up. That is what made a
    // chip feel like it had a "sweet spot": the sheet was opening every
    // time and dismissing itself before it could be seen. A pointerdown
    // that began before this overlay existed can never reach it.
    overlay.addEventListener("pointerdown", function (ev) {
      if (ev.target === overlay) closeMembershipSheet();
    });
    overlay.querySelector("#pickerDone").addEventListener("click", closeMembershipSheet);

    currentRoot.appendChild(overlay);
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

  // §5.1/§5.3 — a school block chip: its label, its time span, and one row
  // per member course with its own count and checkmark — or, once every
  // member is checked, a single compact collapsed line (§5.3's "the block
  // collapses"). Never tappable in the sense a chore chip is (§8.1 — school
  // blocks are read-only as far as completion goes); a tap here opens the
  // membership picker instead (attachGesture's onTap in buildColumn).
  function schoolBlockChipHtml(be, fmt) {
    var block = be.block;
    // The RESOLVED span (§2.2), not the block row's own — on a date or
    // weekday the block has its own time for, those differ.
    var span = g.TimeCore.formatMinutes(be.startMin, fmt) + "–" + g.TimeCore.formatMinutes(be.endMin, fmt);
    if (be.collapsed) {
      return (
        '<div class="school-block-chip school-block-collapsed" data-block-id="' + escapeHtml(block.id) + '">' +
          '<span class="chip-check">&#10003;</span>' +
          '<span class="school-block-label">' + escapeHtml(blockLabel(block)) + "</span>" +
          '<span class="chip-time">' + span + "</span>" +
        "</div>"
      );
    }
    var rows = be.rollups.map(function (r) {
      var done = r.checked === true;
      var count = r.total ? '<span class="school-block-course-count">' + r.resolved + " of " + r.total + "</span>" : "";
      return (
        '<li class="school-block-course' + (done ? " school-block-course-done" : "") + '">' +
          (done ? '<span class="chip-check">&#10003;</span>' : "") +
          '<span class="school-block-course-name">' + escapeHtml(r.courseName) + "</span>" + count +
        "</li>"
      );
    }).join("");
    return (
      '<div class="school-block-chip" data-block-id="' + escapeHtml(block.id) + '">' +
        '<div class="school-block-header">' +
          '<span class="school-block-label">' + escapeHtml(blockLabel(block)) + "</span>" +
          '<span class="chip-time">' + span + "</span>" +
        "</div>" +
        (rows ? '<ul class="school-block-courses">' + rows + "</ul>"
          : '<div class="school-block-empty">No courses yet — tap to add</div>') +
      "</div>"
    );
  }

  // The block-mode (collapsed) list-row equivalent of the chip above —
  // inline rather than absolutely positioned, matching blockItemHtml's
  // layout for a chore. A single summary line rather than one <li> per
  // member course: block-mode rows are already compact by design (§4.4).
  function schoolBlockListItemHtml(be, fmt) {
    var block = be.block;
    var span = g.TimeCore.formatMinutes(be.startMin, fmt) + "–" + g.TimeCore.formatMinutes(be.endMin, fmt);
    var summary = be.collapsed
      ? "All courses done"
      : be.rollups.map(function (r) {
          return r.courseName + (r.checked === true ? " ✓" : "");
        }).join(", ") || "No courses yet";
    return (
      '<li class="block-item-school' + (be.collapsed ? " block-item-done" : "") + '">' +
        (be.collapsed ? '<span class="chip-check">&#10003;</span>' : "") +
        '<span class="block-item-time">' + span + "</span>" +
        '<span class="block-item-title">' + escapeHtml(blockLabel(block)) + "</span>" +
        '<span class="block-item-school-summary">' + escapeHtml(summary) + "</span>" +
      "</li>"
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

  // ---- same-slot overlap (§9 display correction) ---------------------------
  // findCollisionForDrop/flashCollision above are the WARNING half of §9:
  // scheduling two private chores onto one slot never gets refused. This is
  // the display half of the same rule — it must never get HIDDEN either.
  // Chips that overlap in time share the column side by side instead of
  // stacking on top of one another; a third (or later) collapses into a
  // "+N" tile the same footprint as a chip, tapped to see the rest.
  var MAX_VISIBLE_OVERLAP = 2;
  var NARROW_CHIP_MIN_H = 72; // px — room for the time on its own line plus a wrapped two-line title

  // Chains overlapping chips the way a calendar packs columns: sorted by
  // start, a chip joins the running group as long as it starts before the
  // group's max end so far — so A-B-C where A/B and B/C overlap but A/C
  // don't still share one slot, since B is genuinely double-booked against
  // both.
  function groupOverlappingChips(placed) {
    var sorted = placed.slice().sort(function (a, b) { return a.topMin - b.topMin; });
    var groups = [];
    var group = null, groupEnd = -Infinity;
    sorted.forEach(function (item) {
      var end = item.topMin + item.chip.durationMin;
      if (group && item.topMin < groupEnd) {
        group.push(item);
        groupEnd = Math.max(groupEnd, end);
      } else {
        group = [item];
        groups.push(group);
        groupEnd = end;
      }
    });
    return groups;
  }

  // Splits a column into `total` equal slots, inset so neighbours keep a
  // small gap and the outer edges match a lone chip's usual 4px inset.
  function overlapSlotRect(index, total) {
    var pct = 100 / total;
    return {
      left: "calc(" + (index * pct) + "% + " + (index === 0 ? 4 : 2) + "px)",
      right: "calc(" + (100 - (index + 1) * pct) + "% + " + (index === total - 1 ? 4 : 2) + "px)",
    };
  }

  // The "+N" a cluster's third-and-later chip collapses into. Spans the
  // group's full time range, since it stands in for all of them, not any
  // one chip's own start/duration.
  function buildOverflowTile(group, rangeStart, rh, slots, entry, opts) {
    var groupTop = Math.min.apply(null, group.map(function (p) { return p.topMin; }));
    var groupBottom = Math.max.apply(null, group.map(function (p) { return p.topMin + p.chip.durationMin; }));
    var top = ((groupTop - rangeStart) / ROW_MIN) * rh;
    var height = Math.max(((groupBottom - groupTop) / ROW_MIN) * rh - 2, NARROW_CHIP_MIN_H);
    var rest = group.slice(MAX_VISIBLE_OVERLAP);
    var tile = el(
      '<div class="day-chip day-chip-overflow">' +
        '<span class="chip-overflow-count">+' + rest.length + "</span>" +
      "</div>"
    );
    tile.style.top = top + "px";
    tile.style.height = height + "px";
    var rect = overlapSlotRect(slots - 1, slots);
    tile.style.left = rect.left;
    tile.style.right = rect.right;
    tile.addEventListener("click", function (ev) {
      ev.stopPropagation();
      showOverflowSheet(rest, entry.child, opts);
    });
    return tile;
  }

  // ---- the tap target (§8.1) -------------------------------------------------
  // A chip is drawn at its duration — one 15-minute row is 30px at the
  // default zoom — and a fingertip is wider than that. Ray, on the tablet:
  // "still super hard to find the sweet spot on where to click." So a chip
  // is wrapped in a transparent hit area that reaches into the EMPTY grid
  // above and below it, and the gesture lives on the wrapper: tapping a
  // little high or a little low still lands on the chore.
  //
  // Never at a neighbour's expense. The padding is capped at half the real
  // gap to whatever is next in the column, so no two hit areas can ever
  // overlap and no tap can be stolen by the wrong chore — the failure that
  // would be far worse than the one this fixes.
  var HIT_PAD_MAX_PX = 14;

  function overlapsAnyBlock(spans, top, bottom) {
    return spans.some(function (span) { return top < span.bottom && span.top < bottom; });
  }

  function hitPad(gapPx) {
    if (!(gapPx > 0)) return 0;
    return Math.min(HIT_PAD_MAX_PX, Math.floor(gapPx / 2));
  }

  function buildColumn(entry, rh, rangeStart, opts) {
    var col = el('<div class="day-column"></div>');

    // School blocks go down FIRST, so they sit behind the chore chips: a
    // block spans hours and a chore inside those hours has to be the thing
    // a tap lands on (§8.1 — a block has no completion lifecycle to tap
    // for). Before this, the block was appended last and quietly covered
    // every chip inside its span.
    var blockSpans = [];
    (entry.blocks || []).forEach(function (be) {
      var top = ((be.topMin - rangeStart) / ROW_MIN) * rh;
      var rows = Math.max(1, Math.ceil((be.endMin - be.startMin) / ROW_MIN));
      var chip = el(schoolBlockChipHtml(be, opts.fmt));
      chip.style.top = top + "px";
      chip.style.height = (rows * rh - 2) + "px";
      blockSpans.push({ top: top, bottom: top + rows * rh - 2 });
      // Tap opens the membership picker (§5.2); long-press opens the
      // span/label editor (§5.4); drag moves it, setting a new standing
      // start time (§3.3) — no tray drop, a block is removed from its sheet.
      attachGesture(chip, blockLabel(be.block), function () {
        showMembershipSheet(be.block);
      }, function () {
        showBlockSheet(be.block);
      }, function (startMin) {
        moveSchoolBlock(be.block, startMin);
      }, null, be.startMin);
      col.appendChild(chip);
    });

    // Lay every chip out before appending any of it: the hit padding needs
    // to know where this chip's neighbours ended up.
    var groups = groupOverlappingChips(entry.placed);
    var laid = [];
    groups.forEach(function (group) {
      var narrow = group.length > 1;
      var overflowCount = group.length - MAX_VISIBLE_OVERLAP;
      var slots = overflowCount > 0 ? MAX_VISIBLE_OVERLAP + 1 : group.length;
      var groupTop = Infinity, groupBottom = -Infinity;
      var els = [];
      group.slice(0, MAX_VISIBLE_OVERLAP).forEach(function (placed, i) {
        var top = ((placed.topMin - rangeStart) / ROW_MIN) * rh;
        var rows = Math.max(1, Math.ceil(placed.chip.durationMin / ROW_MIN));
        var height = rows * rh - 2; // 2px gap between chips
        var chip = el(chipHtml(placed, opts.fmt));
        var lane = null;
        if (narrow) {
          chip.classList.add("day-chip-narrow");
          height = Math.max(height, NARROW_CHIP_MIN_H);
          lane = overlapSlotRect(i, slots);
        }
        chip.style.height = height + "px";
        groupTop = Math.min(groupTop, top);
        groupBottom = Math.max(groupBottom, top + height);
        els.push({ chip: chip, placed: placed, top: top, height: height, lane: lane });
      });
      laid.push({ group: group, els: els, top: groupTop, bottom: groupBottom, slots: slots,
                  overflowCount: overflowCount, narrow: narrow });
    });

    var gridBottom = ((GRID_END_MIN - rangeStart) / ROW_MIN) * rh;
    laid.forEach(function (entryGroup, gi) {
      var prev = laid[gi - 1];
      var next = laid[gi + 1];
      // A clustered group shares its span with a neighbour side by side, so
      // only its outer edges have free grid to grow into — which is exactly
      // what these two gaps measure.
      var padTop = hitPad(entryGroup.top - (prev ? prev.bottom : 0));
      var padBottom = hitPad((next ? next.top : gridBottom) - entryGroup.bottom);

      entryGroup.els.forEach(function (item) {
        var placed = item.placed;
        var hit = el('<div class="day-chip-hit"></div>');
        // A chore scheduled DURING a school block sits on top of it (the
        // chore is the thing a tap is for). Indent it so the block's frame
        // still reads continuously down both sides and the chore reads as
        // being inside that sitting rather than as a chip that happens to
        // have landed on one. Lane chips are already narrowed by §9's
        // side-by-side split, so they keep their own geometry.
        if (!item.lane && overlapsAnyBlock(blockSpans, item.top, item.top + item.height)) {
          hit.classList.add("day-chip-in-block");
        }
        hit.style.top = (item.top - padTop) + "px";
        hit.style.height = (item.height + padTop + padBottom) + "px";
        if (item.lane) {
          hit.style.left = item.lane.left;
          hit.style.right = item.lane.right;
        }
        // The chip sits at its true position INSIDE the padded wrapper, so
        // what is drawn still says exactly what the duration says.
        item.chip.style.top = padTop + "px";
        item.chip.style.left = "0";
        item.chip.style.right = "0";
        hit.appendChild(item.chip);
        // One gesture, on the wrapper — the padding and the chip are the
        // same target. wall.css maps the press/drag classes through to the
        // visible chip inside.
        attachGesture(hit, placed.row.title, function () {
          if (opts.onChipTap) opts.onChipTap(placed.row, entry.child);
        }, function () {
          showAdjustSheet(placed.row);
        }, function (startMin) {
          commitPlacement(placed.row, startMin);
        }, function () {
          unplace(placed.row);
        }, placed.chip.startMin);
        col.appendChild(hit);
      });

      if (entryGroup.overflowCount > 0) {
        col.appendChild(buildOverflowTile(entryGroup.group, rangeStart, rh, entryGroup.slots, entry, opts));
      }
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
    var wdIdx = g.SlotsCore.indexWeekdays(state.slotWeekdays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var placed = [], unplaced = [], early = [], late = [];
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, wdIdx, daysIdx, row, date);
        if (chip.startMin == null) { unplaced.push(row); return; }
        if (chip.startMin < GRID_START_MIN) { early.push({ row: row, chip: chip }); return; }
        if (chip.startMin >= GRID_END_MIN) { late.push({ row: row, chip: chip }); return; }
        placed.push({ row: row, chip: chip, topMin: chip.startMin });
      });
      var blocks = [];
      blocksForChildOn(state, child.id, date).forEach(function (block) {
        var be = blockEntry(state, child, block, date);
        if (be.startMin < GRID_START_MIN) { early.push(blockStripItem(be)); return; }
        if (be.startMin >= GRID_END_MIN) { late.push(blockStripItem(be)); return; }
        be.topMin = be.startMin;
        blocks.push(be);
      });
      return { child: child, placed: placed, unplaced: unplaced, early: early, late: late, blocks: blocks };
    });
  }

  function buildGridContent(scroll, state, date, opts, fmt) {
    var perChild = layoutPerChildGrid(state, date);

    scroll.appendChild(buildTrayRow(perChild, true));

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
    var wdIdx = g.SlotsCore.indexWeekdays(state.slotWeekdays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var buckets = { morning: [], afternoon: [], evening: [], night: [] };
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, wdIdx, daysIdx, row, date);
        buckets[g.ChoresCore.blockForChip(row, chip)].push({ kind: "chore", row: row, chip: chip });
      });
      blocksForChildOn(state, child.id, date).forEach(function (block) {
        var be = blockEntry(state, child, block, date);
        buckets[g.ChoresCore.blockFromStartMin(be.startMin)].push({ kind: "school", entry: be });
      });
      g.ChoresCore.CANON_BLOCKS.forEach(function (b) {
        // Placed items first, ordered by time; unplaced last (§6's convention
        // for week view, reused here for the same reason: a time beats no time).
        buckets[b].sort(function (a, bItem) {
          var at = a.kind === "school" ? a.entry.startMin : a.chip.startMin;
          var bt = bItem.kind === "school" ? bItem.entry.startMin : bItem.chip.startMin;
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
    if (item.kind === "school") return schoolBlockListItemHtml(item.entry, fmt);
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
    var label = g.ChoresCore.blockLabel(blockName);
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
            if (item.kind === "school") showMembershipSheet(item.entry.block);
            else if (opts.onChipTap) opts.onChipTap(item.row, entry.child);
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
    var label = g.ChoresCore.blockLabel(blockName);
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
    var wdIdx = g.SlotsCore.indexWeekdays(state.slotWeekdays);
    return (state.children || []).map(function (child) {
      var chores = g.ChoresCore.choresForChild(state.rows, child.id, date, state.today);
      var placed = [], unplaced = [];
      chores.forEach(function (row) {
        var chip = g.SlotsCore.resolveChip(slotsIdx, wdIdx, daysIdx, row, date);
        if (g.ChoresCore.blockForChip(row, chip) !== blockName) return;
        if (chip.startMin == null) { unplaced.push(row); return; }
        placed.push({ row: row, chip: chip, topMin: g.ChoresCore.blockVirtualMin(chip.startMin, blockName) });
      });
      var blocks = [];
      blocksForChildOn(state, child.id, date).forEach(function (block) {
        var be = blockEntry(state, child, block, date);
        if (g.ChoresCore.blockFromStartMin(be.startMin) !== blockName) return;
        be.topMin = g.ChoresCore.blockVirtualMin(be.startMin, blockName);
        blocks.push(be);
      });
      return { child: child, placed: placed, unplaced: unplaced, blocks: blocks };
    });
  }

  function buildSingleBlockContent(scroll, state, date, blockName, opts, fmt, collapseBlock) {
    var hours = g.ChoresCore.BLOCK_HOURS[blockName];
    var perChild = layoutPerChildForBlock(state, date, blockName);

    scroll.appendChild(buildSingleBlockHeader(blockName, collapseBlock));
    scroll.appendChild(buildTrayRow(perChild, false));

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
  var sheetState = null; // adjust sheet: {row, startMin, durationMin, durationTouched} while open, or null (§16 Phase 5b; Placement Scopes §6.1)
  var blockSheetState = null; // school block span/label sheet: {block, value, label} while open, or null (§16 Phase 7)
  var membershipSheetState = null; // school block membership picker: {block} while open, or null (§16 Phase 7)
  var overflowSheetState = null; // same-slot overflow list: {items, child, opts} while open, or null (§9 display correction)

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

    // Before anything measures a row: every top/height below comes from
    // rowHeightPx(), which reads this back off the root element.
    applyRowH();

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
    if ((isNewDate || isNewMode) && blockSheetState) blockSheetState = null;
    if ((isNewDate || isNewMode) && membershipSheetState) membershipSheetState = null;
    if ((isNewDate || isNewMode) && overflowSheetState) overflowSheetState = null;

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
    if (sheetState) buildAdjustSheet();
    if (blockSheetState) buildBlockSheet();
    if (membershipSheetState) buildMembershipSheet();
    if (overflowSheetState) buildOverflowSheet();

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
      // A zoom changed what a pixel means, so the old scrollTop is scaled
      // rather than reused: the reader stays at the same time of day
      // instead of being thrown hours down the grid.
      scroll.scrollTop = zoomScrollScale ? Math.round(prevScrollTop * zoomScrollScale) : prevScrollTop;
    } else if (result.scrollToNowIfToday && date === today && result.body) {
      requestAnimationFrame(function () {
        var nowLine = result.body.querySelector(".day-now-line");
        var target = (nowLine && nowLine.style.display !== "none") ? nowLine.offsetTop : 0;
        scroll.scrollTop = Math.max(0, target - scroll.clientHeight / 3);
      });
    }

    zoomScrollScale = null;

    // The zoom's readout, measured now that the grid is in the document:
    // the band of GRID visible at rest, not the whole scroll container —
    // the header, mode bar, events band and tray all sit above the body
    // and are not day. Measured after the bar was built, so the label is
    // rewritten in place rather than left on its first-paint estimate.
    if (result.body) lastScrollHeightPx = Math.max(120, scroll.clientHeight - result.body.offsetTop);
    else if (scroll.clientHeight) lastScrollHeightPx = scroll.clientHeight;
    var zoomLabel = scroll.querySelector(".day-zoom-label");
    if (zoomLabel) zoomLabel.textContent = hoursOnScreenLabel(rh);

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
    blockSheetState = null;
    membershipSheetState = null;
    overflowSheetState = null;
  }

  g.DayUi = { render: render, stop: stop };
})(typeof window !== "undefined" ? window : globalThis);
