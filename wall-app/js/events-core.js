// events-core.js — PURE. Union, dedupe, and span labels for the events strip
// (TDS_Slice_Wall_Display_App.md §7). Mirrors `planner-core.js:172`
// (`eventKey`) — re-implemented, not shared, per CLAUDE.md §I.A.
//
// Events are the one thing on the wall that is not scoped to a child: `rows`
// here is the whole merged day map (every active child's rows, `child_id`
// still on each), and this file unions `kind='event'` rows across all of
// them, deduped per date by `source_id || id` — the same key an event
// committed as one row per in-range day shares across every day it touches
// and across every child it was assigned to.

(function (g) {
  "use strict";

  function parsePayload(raw) {
    if (raw == null) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  // planner-core.js:172 — collapses the one-row-per-day rows a multi-day
  // event was committed as onto the proposal row they came from.
  function eventKey(row) {
    return row.source_id || row.id;
  }

  // A family event's true span lives in `payload.startDate`/`endDate`
  // (assignment-core.js's decoration promotes these for the child app; the
  // wall reads `payload` directly instead, per §I.A). `date` is a single
  // in-range day, so a single-day event's span is just that day.
  function eventSpan(row) {
    var p = parsePayload(row.payload);
    return { start: p.startDate || row.date, end: p.endDate || row.date };
  }

  function eventTouches(row, date) {
    var span = eventSpan(row);
    return span.start <= date && date <= span.end;
  }

  // Every event touching `date`, unioned across whichever children `rows`
  // covers and deduped one line per event. `payload.time` is freeform,
  // unvalidated display text (SRS_Management_Module_07 §2.7 — "3:00 PM" is
  // as structured as it gets), so it cannot be sorted chronologically as a
  // string. Events carrying a time sort before untimed ones; within each
  // group the order is just eventKey, for a stable and repeatable render.
  function eventsOn(rows, date) {
    var seen = Object.create(null);
    var out = [];
    (rows || []).forEach(function (row) {
      if (row.kind !== "event") return;
      if (!eventTouches(row, date)) return;
      var key = eventKey(row);
      if (seen[key]) return;
      seen[key] = true;
      out.push(row);
    });
    return out.sort(function (a, b) {
      var ta = !!parsePayload(a.payload).time;
      var tb = !!parsePayload(b.payload).time;
      if (ta !== tb) return ta ? -1 : 1;
      var ka = eventKey(a), kb = eventKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  }

  // "Day 2 of 4" — null for a single-day event, which is most of them.
  function spanLabel(row, date) {
    var span = eventSpan(row);
    if (span.start === span.end) return null;
    var total = daysBetween(span.start, span.end) + 1;
    var dayNum = daysBetween(span.start, date) + 1;
    return "Day " + dayNum + " of " + total;
  }

  // The "Coming up" strip: one entry per date in `dates` (caller supplies the
  // ordered list — the rest of the 7-day window, per §7), each carrying that
  // day's union. Days with nothing on them are omitted, not shown empty.
  function upcoming(rows, dates) {
    return (dates || [])
      .map(function (date) { return { date: date, events: eventsOn(rows, date) }; })
      .filter(function (day) { return day.events.length > 0; });
  }

  g.EventsCore = {
    eventKey: eventKey,
    eventSpan: eventSpan,
    eventTouches: eventTouches,
    eventsOn: eventsOn,
    spanLabel: spanLabel,
    upcoming: upcoming,
  };
})(typeof window !== "undefined" ? window : globalThis);
