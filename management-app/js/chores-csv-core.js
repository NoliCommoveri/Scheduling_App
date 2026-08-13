/* Module: chores-csv-core.js — the Chore bulk-CSV reader.
 *
 * Per SRS_Management_Module_06_Chore_Authoring.md FR-8 (Amendment A1) and
 * docs/TDS_Slice_Chore_Bulk_Import.md §1/§3/§4.2.
 *
 * Pure and DOM-free, no Storage access — the same split `recipe-core.js`,
 * `pacing-core.js`, `worker/validation.js` and the Child App's *-core.js files
 * already use, so `tests/management-chores-csv-core.test.js` can exercise the
 * lexing, the cell splitting and every per-row rule directly (CLAUDE.md §I.B).
 * Callers hand in plain lookup data; nothing here reads or writes anything.
 *
 * `chores.js` is the only caller and remains the only writer of the `chores`
 * store. What this file produces is a *candidate field object* — the same
 * shape the create form hands `createChore()` — which `chores.js` then runs
 * through its existing `validateFields()` before writing. That last gate is
 * deliberate (TDS §1): these checks exist to give a good per-row message and
 * to fail the file early, not to be a second definition of a valid Chore.
 */

const ChoresCsvCore = (() => {
  // Locked column order (TDS §1) — exact header match required, whole file
  // rejected before any row is read if it deviates. Participants -> identity
  // -> schedule -> tier -> optional, mirroring FR-1's own prose order.
  const CSV_COLUMNS = [
    'children', 'title', 'choreType', 'daysOfWeek', 'allocation', 'difficultyTier',
    'instances', 'blockHint', 'notes',
  ];

  // Mirrors chores.js's three enums. Mirrored, not shared: chores.js owns the
  // record and these are read-only copies for validation messages — if they
  // ever drift, chores.js's validateFields() rejects the import anyway (TDS §1).
  const CHORE_TYPES = [
    'Pet Care', 'Car Care', 'Kitchen/Dining', 'Bathroom', 'Living/Main Area',
    'Playroom', 'Bedroom', "Parent's Room", 'Porch', 'Floors', 'Miscellaneous',
  ];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const BLOCK_HINTS = ['morning', 'afternoon', 'evening', 'night'];

  // TDS §1 — one list separator, everywhere. `,` is the field delimiter, `/`
  // occurs inside a canonical choreType (Kitchen/Dining), `;` reads as a
  // clause separator in the pacing hint. `|` collides with nothing here.
  const LIST_SEP = '|';

  // Hand-rolled RFC4180-ish parser: comma-delimited, double-quote escaping
  // ("" -> "), accepts \n or \r\n line endings. No external CSV library
  // (locked: vanilla JS, no build step). Deliberately a re-implementation of
  // the one in courses.js rather than a shared import — TDS §4.1: a ~20-line
  // lexer is the cheaper side of the trade against a dependency between two
  // SRS modules.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ',') { row.push(field); field = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === '')); // drop blank lines
  }

  function validateHeader(headerRow) {
    return !!headerRow
      && headerRow.length === CSV_COLUMNS.length
      && CSV_COLUMNS.every((col, i) => headerRow[i] === col);
  }

  function rowToObject(row) {
    const obj = {};
    CSV_COLUMNS.forEach((col, i) => { obj[col] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  }

  function isBlank(value) {
    return !value || !String(value).trim();
  }

  // Splits a multi-valued cell on LIST_SEP, trimming each element. Empty
  // elements are preserved so the caller can reject a stray separator
  // ("Breakfast||Dinner") rather than silently swallowing it (TDS §3).
  function splitList(value) {
    return String(value == null ? '' : value).split(LIST_SEP).map((s) => s.trim());
  }

  // TDS §1 — a `CHI-` element is a record id; anything else is a name matched
  // case-insensitively against ACTIVE children only, exactly as the create
  // form's participant list is built. Zero matches and two-or-more matches are
  // both failures; ambiguity is reported with the ids to disambiguate with,
  // never guessed at. `children` is [{ id, name, active }] — `active` already
  // resolved by the caller through Children.isActive, so the absent-means-
  // active rule stays in children.js where it belongs.
  function resolveChild(element, children) {
    if (/^CHI-/.test(element)) {
      const byId = children.find((c) => c.id === element);
      if (!byId) return { error: `child "${element}" does not match any Child record.` };
      return { id: byId.id };
    }
    const wanted = element.toLocaleLowerCase();
    const matches = children.filter((c) => c.active && String(c.name).trim().toLocaleLowerCase() === wanted);
    if (matches.length === 0) {
      return { error: `child "${element}" does not match any active Child by name.` };
    }
    if (matches.length > 1) {
      return {
        error: `child "${element}" matches ${matches.length} active Children `
          + `(${matches.map((c) => c.id).join(', ')}) — name one by id instead.`,
      };
    }
    return { id: matches[0].id };
  }

  function resolveChildren(cell, children) {
    if (isBlank(cell)) return { error: 'children is required.' };
    const elements = splitList(cell);
    const ids = [];
    for (const element of elements) {
      if (!element) return { error: 'children contains an empty entry — check for a stray "|".' };
      const resolved = resolveChild(element, children);
      if (resolved.error) return { error: resolved.error };
      if (ids.includes(resolved.id)) {
        return { error: `child "${element}" is named more than once in this row.` };
      }
      ids.push(resolved.id);
    }
    return { ids };
  }

  function resolveDays(cell) {
    if (isBlank(cell)) return { error: 'daysOfWeek is required.' };
    const elements = splitList(cell);
    const days = [];
    for (const element of elements) {
      if (!element) return { error: 'daysOfWeek contains an empty entry — check for a stray "|".' };
      if (!DAYS.includes(element)) {
        return { error: `daysOfWeek entry "${element}" is not one of ${DAYS.join(', ')}.` };
      }
      if (days.includes(element)) return { error: `daysOfWeek names "${element}" more than once.` };
      days.push(element);
    }
    return { days };
  }

  // TDS §3 — labels only; ids are minted by the caller, never authored, which
  // is what makes the "unique" and "no -" rules of Shared Chores §2.4
  // unfailable from this path rather than merely checked. Blank cell => the
  // property is omitted entirely (one unlabeled occurrence, today's behaviour).
  function resolveInstanceLabels(cell) {
    if (isBlank(cell)) return { labels: undefined };
    const elements = splitList(cell);
    const labels = [];
    for (const element of elements) {
      if (!element) return { error: 'instances contains an empty entry — check for a stray "|".' };
      if (labels.includes(element)) {
        return { error: `instances names "${element}" more than once — occurrence labels must be distinct.` };
      }
      labels.push(element);
    }
    return { labels };
  }

  // Per-row validation (TDS §4.2), in the documented order, first failure
  // reported. Returns { error } or { candidate }. `lookups` is
  // { children: [{ id, name, active }], tierIds: [string] } — resolved once by
  // chores.js before any row is read, so this stays IO-free.
  function validateRow(rowObj, rowNumber, lookups) {
    const fail = (message) => ({ error: `Row ${rowNumber}: ${message}` });

    const childResult = resolveChildren(rowObj.children, lookups.children || []);
    if (childResult.error) return fail(childResult.error);

    const title = String(rowObj.title || '').trim();
    if (!title) return fail('title is required.');

    const choreType = String(rowObj.choreType || '').trim();
    if (!CHORE_TYPES.includes(choreType)) {
      return fail(`choreType "${rowObj.choreType}" is not one of the eleven canonical values (exact spelling and case).`);
    }

    const dayResult = resolveDays(rowObj.daysOfWeek);
    if (dayResult.error) return fail(dayResult.error);

    const allocationRaw = String(rowObj.allocation || '').trim();
    const allocation = allocationRaw === '' ? 'each' : allocationRaw;
    if (allocation !== 'each' && allocation !== 'claim') {
      return fail(`allocation "${rowObj.allocation}" must be "each", "claim", or blank.`);
    }

    const difficultyTier = String(rowObj.difficultyTier || '').trim();
    if (!difficultyTier) return fail('difficultyTier is required.');
    if (!(lookups.tierIds || []).includes(difficultyTier)) {
      return fail(`difficultyTier "${difficultyTier}" does not resolve to an existing Tier.`);
    }

    const instanceResult = resolveInstanceLabels(rowObj.instances);
    if (instanceResult.error) return fail(instanceResult.error);

    const blockHint = String(rowObj.blockHint || '').trim();
    if (blockHint && !BLOCK_HINTS.includes(blockHint)) {
      return fail(`blockHint "${blockHint}" must be one of ${BLOCK_HINTS.join(', ')}, or blank.`);
    }

    const notes = String(rowObj.notes || '').trim();

    // The candidate is the same field shape the create form hands
    // createChore(), so chores.js can run it through validateFields() and
    // buildRecord() unchanged. Optional fields are omitted, never null
    // (buildRecord's own rule); `instanceLabels` is carried separately from
    // `instances` because the ids are minted at write time, not here.
    const candidate = {
      rowNumber,
      fields: {
        childIds: childResult.ids,
        allocation,
        title,
        choreType,
        daysOfWeek: dayResult.days,
        difficultyTier,
      },
      instanceLabels: instanceResult.labels,
    };
    if (notes) candidate.fields.notes = notes;
    if (blockHint) candidate.fields.blockHint = blockHint;
    return { candidate };
  }

  // Whole-file read (TDS §4.1/§4.2). Header gate first — any deviation rejects
  // before a data row is read. Every failing row is collected, not just the
  // first, so a parent fixes a spreadsheet in one pass; the outcome is still
  // binary, and the caller writes nothing unless `failures` is empty.
  //
  // There is no whole-file consistency check by design (TDS §1): Chore rows do
  // not group the way the Activity CSV's rows group under a lessonCode — each
  // row is one whole, independent record with no shared parent.
  function readCsv(text, lookups) {
    const rows = parseCsv(text);
    if (rows.length === 0) return { error: 'CSV file is empty.' };
    if (!validateHeader(rows[0])) {
      return { error: `CSV header must be exactly: ${CSV_COLUMNS.join(', ')}` };
    }

    const dataRows = rows.slice(1);
    const failures = [];
    const candidates = [];
    for (let i = 0; i < dataRows.length; i++) {
      const result = validateRow(rowToObject(dataRows[i]), i + 2, lookups); // +2: header is row 1
      if (result.error) failures.push(result.error);
      else candidates.push(result.candidate);
    }
    if (failures.length > 0) {
      return { error: 'Import rejected — no Chores were written.', failures };
    }
    return { candidates };
  }

  // The template is emitted from this same constant, so the header a parent
  // downloads cannot drift from the header the gate demands (TDS §4.1).
  function templateCsv() {
    return CSV_COLUMNS.join(',') + '\n';
  }

  return {
    CSV_COLUMNS,
    CHORE_TYPES,
    DAYS,
    BLOCK_HINTS,
    LIST_SEP,
    parseCsv,
    validateHeader,
    rowToObject,
    splitList,
    resolveChild,
    resolveChildren,
    resolveDays,
    resolveInstanceLabels,
    validateRow,
    readCsv,
    templateCsv,
  };
})();

// Node (tests) reads this via vm.runInThisContext, the same as the other
// *-core.js files; the browser gets the global above. No module system, no
// build step (CLAUDE.md §0).
