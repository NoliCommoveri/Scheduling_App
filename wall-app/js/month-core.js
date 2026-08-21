// month-core.js — PURE. The month grid's shape, its fetch window, and the
// search behind §7.1's "+N more" split (TDS_Slice_Wall_Calendar_Redesign.md
// §7.1, §7.2). What a cell can physically draw is measured, not assumed —
// see `largestFit`.
//
// The bucketing itself is NOT re-implemented here: `EventsCore.eventsOn` is
// called per cell, so the month grid's dedupe, its multi-day span handling
// and its timed-before-untimed order are the same code the day band and the
// week rows run — §14.7's "unchanged behaviour, re-asserted against the new
// month window" is a statement about this file calling that one, not about
// two implementations agreeing.
//
// Date math is local rather than `Poll.addDays`, for the reason nav-ui.js
// mirrors the same helpers: a `*-core.js` file is loaded on its own by
// `tests/wall-cores.test.js`, with none of the IO layer in scope. The
// definitions are identical (local calendar arithmetic, no UTC), so the
// grid can never disagree with the poll about which day is which.

(function (g) {
  "use strict";

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function toIso(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseIso(iso) {
    var p = iso.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function addDays(iso, n) {
    var d = parseIso(iso);
    d.setDate(d.getDate() + n);
    return toIso(d);
  }

  // §7.1 — "six week-rows of seven day-cells". Always six, never four or
  // five: a grid that changed height with the month would move every cell
  // under the reader's finger each time the stepper is tapped, and the wall
  // is read at arm's length. A 42-day window is also comfortably inside the
  // route's own 62-day cap (§7.2).
  var WEEKS = 6;
  var CELLS = WEEKS * 7;

  // §7.1/§6 — Sunday-first, the same column order as the week view, because
  // Saturday is the family's Sabbath and belongs at the end of the row.
  var DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];


  function firstOfMonth(iso) {
    var p = iso.split("-").map(Number);
    return toIso(new Date(p[0], p[1] - 1, 1));
  }

  function gridStart(iso) {
    var first = firstOfMonth(iso);
    return addDays(first, -parseIso(first).getDay());
  }

  // The 42 dates the grid draws, in order, for the month containing `iso`.
  function gridDates(iso) {
    var start = gridStart(iso);
    var out = [];
    for (var i = 0; i < CELLS; i++) out.push(addDays(start, i));
    return out;
  }

  // The `from`/`to` for one `GET /api/wall/events` call (§7.2) — the whole
  // drawn grid, leading and trailing days included, so a cell spilling from
  // the previous or next month is not silently eventless.
  function windowFor(iso) {
    var dates = gridDates(iso);
    return { from: dates[0], to: dates[dates.length - 1] };
  }

  // One cell per drawn date, each carrying that date's whole event list.
  // How many of them the cell can actually DRAW is not decided here — see
  // `largestFit` below.
  function buildCells(anchorIso, rows) {
    var month = anchorIso.slice(0, 7);
    return gridDates(anchorIso).map(function (date) {
      var events = g.EventsCore.eventsOn(rows, date);
      return {
        date: date,
        dayNum: Number(date.slice(8, 10)),
        inMonth: date.slice(0, 7) === month,
        events: events,
      };
    });
  }

  // §7.1's "+N more" split, as a search rather than a constant.
  //
  // A constant was tried first and cannot be right: a cell's height is a
  // sixth of whatever the screen gives it (107px at 1280x800, 75px at
  // 1024x600), and an event's height depends on whether it carries a
  // multi-day span label — so the same "3" that fits comfortably on one
  // tablet clips mid-line on another, which is exactly what it did when
  // measured. `fits(n)` is supplied by month-ui.js, which measures the real
  // grid once and then answers by adding heights; this function owns only
  // the search over it, and does no measuring of its own — which is what
  // keeps it pure and testable with an arithmetic `fits` standing in for a
  // browser.
  //
  // It searches DOWN from the whole list, so a cell shows the most it can
  // rather than a safe minimum, and `fits` is defined to account for the
  // "+N more" line itself whenever `n` is short of the total — the
  // affordance cannot be allowed to overflow the box it is announcing.
  function largestFit(total, fits) {
    for (var n = total; n >= 0; n--) {
      if (fits(n)) return n;
    }
    return 0;
  }

  // The same cells, grouped into the six drawn rows.
  function chunkWeeks(cells) {
    var out = [];
    for (var i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }

  g.MonthCore = {
    WEEKS: WEEKS,
    CELLS: CELLS,
    DOW_LABELS: DOW_LABELS,
    gridDates: gridDates,
    windowFor: windowFor,
    buildCells: buildCells,
    largestFit: largestFit,
    chunkWeeks: chunkWeeks,
  };
})(typeof window !== "undefined" ? window : globalThis);
