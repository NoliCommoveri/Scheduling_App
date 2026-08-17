/* Module: course-durations-core.js — the arithmetic behind setting
 * `expectedDurationMin` for every Activity of one Activity Type at once.
 * Per SRS_Management_Module_03_Course_Template_Library.md FR-11 and
 * docs/TDS_Slice_Course_Duration_Bulk_Edit.md §3.
 *
 * Pure and DOM-free, no Storage access, so it can be exercised directly — the
 * same split `pacing-core.js`, `recipe-core.js`, `answer-keys-core.js`,
 * `worker/validation.js` and the Child App's *-core.js files already use.
 * `course-durations.js` is the only caller.
 *
 * WHY IT EXISTS. `expectedDurationMin` is the number Packet Generation adds up
 * against a `minutesBudget` Pacing Profile (Mgmt SRS 05 §2.3, packet.js
 * `durationOf`), and it is authored one Activity at a time on a form three
 * clicks down. A course is hundreds of Activities of a handful of types, and
 * the parent's actual knowledge is per-type — "a Practice takes ten minutes, a
 * Quiz takes twenty" — not per-Activity. Retyping that across 300 forms is why
 * the field sits empty and the whole course paces at packet.js's 15-minute
 * fallback.
 *
 * WHAT IT IS NOT. This is a bulk *edit*, not a new field, a default, or an
 * inheritance rule. Nothing is stored on the Course; each Activity keeps its
 * own `expectedDurationMin` exactly as the single-Activity form (FR-4) writes
 * it, and editing one afterward is unaffected. There is no "the type says 20"
 * anywhere — only 40 Activities that were each written 20.
 */

const CourseDurationsCore = (() => {
  // Mirrors courses.js / instances.js `normalizeOptionalActivityFields`
  // deliberately, rather than picking its own bound: a value the single-
  // Activity form accepts must not be rejected here, and vice versa. Positive
  // integer only — the 15-minute fallback is generation-time math (Module 05
  // §2.3), never persisted, so 0 is not a valid stored value.
  function normalizeDuration(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return { blank: true };
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      return { error: 'Expected duration (min) must be a positive whole number, or left blank.' };
    }
    return { value: n };
  }

  // One row per Activity Type actually present beneath the Course — never the
  // whole Activity Type table. A type nobody authored is not a line the parent
  // has to skip past, and the panel is about what this Course contains.
  //
  // Row order follows the `activityTypes` array the caller read (IndexedDB
  // returns it in `activityTypeKey` order, which is the same "Activity Type
  // table order" FR-P9's seeded rows use). A key that no longer resolves to a
  // type still gets a row, labelled with the raw key and flagged `known:
  // false`, so a Course whose type was deleted stays repairable rather than
  // silently losing Activities from the panel.
  function summarize(activities, activityTypes) {
    const byKey = new Map();
    for (const a of activities) {
      const key = a.activityType;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(a);
    }

    const ordered = [];
    const seen = new Set();
    for (const type of activityTypes || []) {
      const key = type.activityTypeKey;
      if (!byKey.has(key) || seen.has(key)) continue;
      seen.add(key);
      ordered.push({ key, label: type.label || key, known: true });
    }
    for (const key of [...byKey.keys()].filter((k) => !seen.has(k)).sort()) {
      ordered.push({ key, label: key, known: false });
    }

    return ordered.map(({ key, label, known }) => {
      const rows = byKey.get(key);
      const values = [];
      let unsetCount = 0;
      for (const a of rows) {
        if (a.expectedDurationMin == null) unsetCount += 1;
        else if (!values.includes(a.expectedDurationMin)) values.push(a.expectedDurationMin);
      }
      values.sort((x, y) => x - y);
      return {
        activityTypeKey: key,
        label,
        known,
        count: rows.length,
        values,
        unsetCount,
        // Non-null only when every Activity of the type carries the same
        // number. This is what the input pre-fills from; a mixed row opens
        // blank rather than picking a winner.
        uniformValue: values.length === 1 && unsetCount === 0 ? values[0] : null,
      };
    });
  }

  // The row's current state in one scannable line. Answers "is this type done,
  // partly done, or untouched?" without opening anything.
  function describeRow(row) {
    const count = `${row.count} ${row.count === 1 ? 'Activity' : 'Activities'}`;
    if (row.values.length === 0) return `${count} · no duration set`;
    if (row.uniformValue != null) return `${count} · all ${row.uniformValue} min`;
    const mixed = `${row.values.join(', ')} min`;
    return row.unsetCount ? `${count} · ${mixed} · ${row.unsetCount} with none` : `${count} · ${mixed}`;
  }

  // Turns the panel's edits into the exact Activity records to write.
  //
  // `edits` is [{ activityTypeKey, mode: 'set' | 'clear', value }]. A type the
  // parent left blank is simply not in the list — see §3.2 of the slice for
  // why blank means "leave alone" rather than "clear": the panel saves every
  // row at once, so a blank-clears rule would let one Save wipe the durations
  // on every type the parent had not got to yet. Clearing is its own explicit
  // per-row action.
  //
  // Activities already at the target value are skipped, so re-saving an
  // unchanged panel writes nothing and queues no outbox rows.
  function planUpdates(activities, edits) {
    const updates = [];
    const changedByType = {};

    for (const edit of edits || []) {
      const rows = activities.filter((a) => a.activityType === edit.activityTypeKey);
      if (edit.mode === 'set') {
        const norm = normalizeDuration(edit.value);
        if (norm.error) return { error: norm.error, activityTypeKey: edit.activityTypeKey };
        if (norm.blank) return { error: 'A duration is required to set one.', activityTypeKey: edit.activityTypeKey };
        for (const a of rows) {
          if (a.expectedDurationMin === norm.value) continue;
          updates.push({ ...a, expectedDurationMin: norm.value });
          changedByType[edit.activityTypeKey] = (changedByType[edit.activityTypeKey] || 0) + 1;
        }
      } else if (edit.mode === 'clear') {
        for (const a of rows) {
          if (a.expectedDurationMin == null) continue;
          // Absent, never null/0 — the optional-field convention this record
          // has always used (SRS Module 03 §4, `applyOptionalActivityFields`).
          const next = { ...a };
          delete next.expectedDurationMin;
          updates.push(next);
          changedByType[edit.activityTypeKey] = (changedByType[edit.activityTypeKey] || 0) + 1;
        }
      } else {
        return { error: `Unknown edit mode "${edit.mode}".`, activityTypeKey: edit.activityTypeKey };
      }
    }

    return { updates, changedByType };
  }

  // "Updated 14 Activities across 2 types." — the one line the panel reports.
  // Named types are listed while there are few enough to read. `mode` is the
  // run's own mode ('set' or 'clear'), because "Updated 2 Activities" after a
  // Clear reads as though a number had been written to them.
  function describeResult(changedByType, labels, mode) {
    const clearing = mode === 'clear';
    const keys = Object.keys(changedByType);
    const total = keys.reduce((sum, k) => sum + changedByType[k], 0);
    if (total === 0) {
      return clearing
        ? 'No changes — no Activity of that type had a duration to clear.'
        : 'No changes — every Activity already had that duration.';
    }
    const noun = total === 1 ? 'Activity' : 'Activities';
    const verb = clearing ? 'Cleared the duration on' : 'Updated';
    if (keys.length === 1) {
      return `${verb} ${total} ${noun} — ${(labels && labels[keys[0]]) || keys[0]}.`;
    }
    return `${verb} ${total} ${noun} across ${keys.length} types.`;
  }

  return { normalizeDuration, summarize, describeRow, planUpdates, describeResult };
})();

// Node (tests) reads this via vm.runInThisContext, the same as the other
// *-core.js files; the browser gets the global above. No module system, no
// build step (CLAUDE.md §0).
