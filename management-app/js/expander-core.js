/* Module: expander-core.js — the Course Structure Expander's pure layer.
 *
 * Per docs/TDS_Slice_Course_Structure_Expander.md §2/§3/§4.
 *
 * Pure and DOM-free, no Storage access — the same split `chores-csv-core.js`,
 * `recipe-core.js`, `pacing-core.js`, `worker/validation.js` and the Child
 * App's *-core.js files already use, so `tests/management-expander-core.test.js`
 * can exercise the workbook reader, the join and every expansion rule directly
 * (CLAUDE.md §I.B). Callers hand in plain lookup data; nothing here reads or
 * writes anything.
 *
 * WHAT THIS PRODUCES. A proposal in the bulk importer's own 12-column format
 * (courses.js §595, FR-5) — not a record, not a write. `expander.js` offers it
 * as a download; the file then goes out to an LLM to have its blank `pdf`
 * titles split into named sub-ranges, and comes back through
 * `Courses.importActivitiesCsv()` like any other import. That importer stays
 * the only gate: everything here exists to fill in what is mechanical, never
 * to be a second definition of a valid Lesson or Activity.
 *
 * TWO INPUTS, BOTH FOREIGN. A *counts* sheet (Unit Name, Lesson Name, Activity
 * Type, Activity Count) and an optional *page map* (trimmed_page,
 * original_page, Unit Name, Lesson Name). Neither is authored here and neither
 * has a stable producer, so both are read by header name rather than column
 * position, and every mismatch between them is reported rather than resolved.
 */

const ExpanderCore = (() => {
  // Mirrored from courses.js's CSV_COLUMNS, not shared — that array lives
  // inside the Courses IIFE and is the importer's own contract. Mirroring is
  // the same arrangement chores-csv-core.js uses for chores.js's enums: if the
  // two ever drift, the importer rejects the file on its exact-header check
  // and says so, which is a better failure than a silent column shift.
  const CSV_COLUMNS = [
    'courseCode', 'lessonCode', 'lessonTitle', 'lessonOrder', 'activityType', 'title', 'required',
    'pageRangeStart', 'pageRangeEnd',
    'difficultyTier', 'expectedDurationMin', 'instructions',
  ];

  // Counts-sheet labels -> the seeded activityTypeKeys in storage.js:14-24.
  // Keyed on a squashed form of the label (lowercased, non-alphanumerics
  // dropped) so "Practice Level", "practice-level" and "PracticeLevel" all
  // land on the same key — the sheet comes from an LLM reading screenshots,
  // and its capitalisation is not a contract.
  const TYPE_ALIASES = new Map([
    ['video', 'video'],
    ['pdf', 'pdf'],
    ['practicelevel', 'practice-level'],
    ['practice', 'practice-level'],
    ['practicelevels', 'practice-level'],
    ['quiz', 'quiz'],
    ['onlinesim', 'online-sim'],
    ['onlinesimulation', 'online-sim'],
    ['sim', 'online-sim'],
    ['test', 'test'],
    ['project', 'project'],
    ['report', 'report'],
    ['drill', 'drill'],
    ['workbook', 'workbook'],
    ['readingpages', 'reading-pages'],
  ]);

  // Emission order within a Lesson (TDS §3.2). Video opens, the PDF carries
  // the lesson's page budget, practice levels climb, and the Quiz closes —
  // with the Online Sim ahead of it, on the reading that a sim is practice and
  // the assessment always comes last. A type absent from this list is emitted
  // after these, in the order the counts sheet listed it.
  const TYPE_ORDER = ['video', 'pdf', 'practice-level', 'online-sim', 'quiz'];

  // Per-type defaults for the two columns the counts sheet cannot know
  // (TDS §3.3). Measured off the shipped MIALANGARTSE import: every video 5,
  // every practice level 5, pdf 10, quiz 20 at tier D02 while everything else
  // sits at D01. They are a starting point, not a rule — `expander.js` shows
  // them in an editable table and the outliers (a 25-minute project PDF, a
  // 15-minute quiz) are exactly what the LLM pass is for.
  const DEFAULTS = {
    video: { difficultyTier: 'D01', expectedDurationMin: 5 },
    pdf: { difficultyTier: 'D01', expectedDurationMin: 10 },
    'practice-level': { difficultyTier: 'D01', expectedDurationMin: 5 },
    'online-sim': { difficultyTier: 'D01', expectedDurationMin: 10 },
    quiz: { difficultyTier: 'D02', expectedDurationMin: 20 },
  };

  const FALLBACK_DEFAULT = { difficultyTier: 'D01', expectedDurationMin: 10 };

  // ---- CSV (§2.1) ----

  // Hand-rolled RFC4180-ish parser: comma-delimited, double-quote escaping
  // ("" -> "), accepts \n or \r\n line endings. No external CSV library
  // (locked: vanilla JS, no build step — CLAUDE.md §0). Mirrors the lexer in
  // chores-csv-core.js and courses.js; each app-internal copy is deliberate.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    // A UTF-8 BOM survives a round trip through Excel and would otherwise
    // become part of the first header cell, breaking the by-name lookup.
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
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
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
  }

  function csvCell(value) {
    const s = value === undefined || value === null ? '' : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // Trailing newline, CRLF line endings: what Excel and Sheets both emit, and
  // what the importer's lexer already tolerates either way.
  function toCsv(rowObjects) {
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of rowObjects) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  // ---- XLSX (§2.2) ----
  //
  // A .xlsx is a ZIP of XML. Reading one needs an inflate, and the browser has
  // had one natively since DecompressionStream shipped — so this stays inside
  // the no-build-step rule with no library and no vendored code. Node has the
  // same global from 18 on, which is what lets the tests read a real workbook.

  function u16(bytes, at) { return bytes[at] | (bytes[at + 1] << 8); }
  function u32(bytes, at) {
    return ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000);
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Walks the central directory rather than scanning local headers forward:
  // a local header may declare zero sizes and defer them to a data descriptor
  // after the payload, which cannot be parsed without already knowing where
  // the payload ends. The central directory always carries the real sizes.
  async function readZipEntries(buffer) {
    const bytes = new Uint8Array(buffer);
    let eocd = -1;
    const floor = Math.max(0, bytes.length - 0xffff - 22);
    for (let i = bytes.length - 22; i >= floor; i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a .xlsx file — no ZIP end-of-central-directory record found.');

    const count = u16(bytes, eocd + 10);
    let at = u32(bytes, eocd + 16);
    const entries = new Map();
    const decoder = new TextDecoder();

    for (let i = 0; i < count; i++) {
      if (u32(bytes, at) !== 0x02014b50) break;
      const method = u16(bytes, at + 10);
      const compSize = u32(bytes, at + 20);
      const nameLen = u16(bytes, at + 28);
      const extraLen = u16(bytes, at + 30);
      const commentLen = u16(bytes, at + 32);
      const localAt = u32(bytes, at + 42);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));

      // The local header's own name/extra lengths are the ones that locate the
      // payload; the central copy of extra is frequently a different length.
      const localNameLen = u16(bytes, localAt + 26);
      const localExtraLen = u16(bytes, localAt + 28);
      const dataAt = localAt + 30 + localNameLen + localExtraLen;
      entries.set(name, { method, raw: bytes.subarray(dataAt, dataAt + compSize) });

      at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function readZipText(entries, name) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.method === 0) return new TextDecoder().decode(entry.raw);
    if (entry.method === 8) return new TextDecoder().decode(await inflateRaw(entry.raw));
    throw new Error(`Unsupported ZIP compression method ${entry.method} for "${name}".`);
  }

  function unescapeXml(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent) => {
      if (ent === 'amp') return '&';
      if (ent === 'lt') return '<';
      if (ent === 'gt') return '>';
      if (ent === 'quot') return '"';
      if (ent === 'apos') return "'";
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
  }

  // Concatenates every <t> in the fragment. A run-formatted cell splits one
  // visible string across several <r><t> children, and a lesson title that
  // lost its second half to a stray italic would join against nothing.
  function textOf(fragment) {
    let out = '';
    for (const m of fragment.matchAll(/<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
      out += m[1] ? unescapeXml(m[1]) : '';
    }
    return out;
  }

  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  }

  function parseSheet(xml, shared) {
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const body = rowMatch[1] || '';
      const cells = [];
      for (const cm of body.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const inner = cm[2] || '';
        const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
        const typeMatch = /t="([^"]+)"/.exec(attrs);
        const type = typeMatch ? typeMatch[1] : 'n';
        let value = '';
        if (type === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          const idx = v ? Number(v[1]) : NaN;
          value = Number.isInteger(idx) && shared[idx] !== undefined ? shared[idx] : '';
        } else if (type === 'inlineStr') {
          value = textOf(inner);
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          value = v ? unescapeXml(v[1]) : '';
        }
        const at = refMatch ? colIndex(refMatch[1]) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      rows.push(cells);
    }
    // Blank rows are dropped rather than preserved: the header-by-name lookup
    // only needs row 0 to be the header and the rest to be data.
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  // Resolves the *first* sheet through workbook.xml and its rels rather than
  // assuming worksheets/sheet1.xml — a workbook whose first tab was deleted
  // and remade keeps the old file name and points rId1 somewhere else.
  async function firstSheetPath(entries) {
    const workbook = await readZipText(entries, 'xl/workbook.xml');
    const rels = await readZipText(entries, 'xl/_rels/workbook.xml.rels');
    if (workbook && rels) {
      const sheet = /<sheet\s[^>]*?r:id="([^"]+)"/.exec(workbook);
      if (sheet) {
        const rel = new RegExp(`<Relationship[^>]*Id="${sheet[1]}"[^>]*Target="([^"]+)"`).exec(rels);
        if (rel) {
          const target = rel[1].replace(/^\/xl\//, '').replace(/^\//, '');
          return target.startsWith('xl/') ? target : `xl/${target}`;
        }
      }
    }
    return 'xl/worksheets/sheet1.xml';
  }

  async function readXlsxGrid(buffer) {
    const entries = await readZipEntries(buffer);
    const shared = parseSharedStrings(await readZipText(entries, 'xl/sharedStrings.xml'));
    const path = await firstSheetPath(entries);
    const xml = await readZipText(entries, path);
    if (!xml) throw new Error('Workbook contains no readable worksheet.');
    return parseSheet(xml, shared);
  }

  // A .xlsx always begins with the ZIP local-header signature. Sniffing the
  // bytes rather than the file extension means a sheet saved as .csv but
  // exported as a workbook (or the reverse) still reads, which matters because
  // neither input file is authored here and both arrive by hand.
  async function readGrid(file) {
    const buffer = await file.arrayBuffer();
    const head = new Uint8Array(buffer.slice(0, 4));
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    if (isZip) return readXlsxGrid(buffer);
    return parseCsv(new TextDecoder().decode(buffer));
  }

  // ---- Header-addressed reading (§2.3) ----

  function squash(s) {
    return String(s === undefined || s === null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Returns a column index per requested name, or null naming what is missing.
  // By name, never by position: the counts sheet and the page map are produced
  // by an LLM from screenshots and a PDF, and column order is not a contract.
  function headerIndex(grid, wanted) {
    const header = grid[0] || [];
    const seen = new Map();
    header.forEach((cell, i) => {
      const key = squash(cell);
      if (key && !seen.has(key)) seen.set(key, i);
    });
    const index = {};
    const missing = [];
    for (const [field, aliases] of Object.entries(wanted)) {
      const hit = aliases.map(squash).find((a) => seen.has(a));
      if (hit === undefined) missing.push(aliases[0]);
      else index[field] = seen.get(hit);
    }
    return missing.length ? { error: `Missing column(s): ${missing.join(', ')}.` } : { index };
  }

  const COUNTS_COLUMNS = {
    unit: ['Unit Name', 'Unit'],
    lesson: ['Lesson Name', 'Lesson'],
    type: ['Activity Type', 'Type'],
    count: ['Activity Count', 'Count'],
  };

  const PAGE_MAP_COLUMNS = {
    original: ['original_page', 'Original Page'],
    unit: ['Unit Name', 'Unit'],
    lesson: ['Lesson Name', 'Lesson'],
  };

  function cell(row, at) {
    return at === undefined ? '' : String(row[at] === undefined ? '' : row[at]).trim();
  }

  function readCounts(grid) {
    if (!grid || grid.length === 0) return { error: 'The counts file is empty.' };
    const head = headerIndex(grid, COUNTS_COLUMNS);
    if (head.error) return { error: `Counts file — ${head.error}` };
    const { index } = head;

    const rows = [];
    const errors = [];
    for (let i = 1; i < grid.length; i++) {
      const lesson = cell(grid[i], index.lesson);
      const type = cell(grid[i], index.type);
      const rawCount = cell(grid[i], index.count);
      if (!lesson && !type && !rawCount) continue;

      const rowNumber = i + 1;
      if (!lesson) { errors.push(`Counts row ${rowNumber}: Lesson Name is blank.`); continue; }
      if (!type) { errors.push(`Counts row ${rowNumber}: Activity Type is blank.`); continue; }

      // A blank count reads as one — the sheets in hand always state it, but a
      // one-off activity with an empty cell is a likelier authoring slip than
      // an intended zero, and zero would silently drop the row.
      const count = rawCount === '' ? 1 : Number(rawCount);
      if (!Number.isInteger(count) || count < 1) {
        errors.push(`Counts row ${rowNumber}: Activity Count must be a whole number of 1 or more (found "${rawCount}").`);
        continue;
      }
      rows.push({ unit: cell(grid[i], index.unit), lesson, type, count, rowNumber });
    }
    return { rows, errors };
  }

  function readPageMap(grid) {
    if (!grid || grid.length === 0) return { rows: [], errors: [] };
    const head = headerIndex(grid, PAGE_MAP_COLUMNS);
    if (head.error) return { error: `Page map — ${head.error}` };
    const { index } = head;

    const rows = [];
    const errors = [];
    for (let i = 1; i < grid.length; i++) {
      const lesson = cell(grid[i], index.lesson);
      const rawPage = cell(grid[i], index.original);
      if (!lesson && !rawPage) continue;

      const rowNumber = i + 1;
      const page = Number(rawPage);
      if (!Number.isInteger(page) || page < 1) {
        errors.push(`Page map row ${rowNumber}: original_page must be a whole number of 1 or more (found "${rawPage}").`);
        continue;
      }
      if (!lesson) { errors.push(`Page map row ${rowNumber}: Lesson Name is blank.`); continue; }
      rows.push({ unit: cell(grid[i], index.unit), lesson, page, rowNumber });
    }
    return { rows, errors };
  }

  // ---- The join (§3.1) ----

  // Unit + Lesson, exactly as written. Deliberately not normalised: the two
  // files come from the same source material and carry the same curly
  // apostrophes and en dashes ("Show, Don't Tell", "Context Clues - Synonyms"
  // with a real en dash). Matching loosely would paper over a genuine
  // disagreement between them; an unmatched lesson is reported instead — see
  // `expand`'s warnings.
  // A NUL separator, so no pair of real values can collide by naive
  // concatenation ("Unit 1" + "0: Review" vs "Unit 10" + ": Review").
  function lessonKey(unit, lesson) { return `${unit}\u0000${lesson}`; }

  // One page span per lesson: the lowest and highest ORIGINAL page it covers.
  // Interior gaps are dropped on purpose — they are the divider pages the trim
  // removed, and the span is a budget for the LLM to subdivide, not a page list.
  function pageRanges(pageMapRows) {
    const spans = new Map();
    for (const r of pageMapRows) {
      const key = lessonKey(r.unit, r.lesson);
      const span = spans.get(key);
      if (!span) spans.set(key, { start: r.page, end: r.page, unit: r.unit, lesson: r.lesson });
      else {
        if (r.page < span.start) span.start = r.page;
        if (r.page > span.end) span.end = r.page;
      }
    }
    return spans;
  }

  // ---- Lesson codes (§3.4) ----

  // The next free L-number for a Course, so a second batch appends rather than
  // colliding with the Lessons already under it. Codes that are not L-numbers
  // are ignored rather than guessed at.
  function nextLessonNumber(existingLessonCodes) {
    let max = 0;
    for (const code of existingLessonCodes || []) {
      const m = /^L0*(\d+)$/i.exec(String(code).trim());
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  // Two digits until the course outgrows them, then three — L01..L99, L100.
  // Width is chosen from the highest number this batch will emit so every code
  // in one file sorts as text the way it sorts as a number.
  function lessonCode(n, width) {
    return `L${String(n).padStart(width, '0')}`;
  }

  function codeWidth(highest) {
    return Math.max(2, String(highest).length);
  }

  // ---- Expansion (§3.2/§3.3) ----

  function typeKeyFor(label) {
    const squashed = squash(label);
    if (TYPE_ALIASES.has(squashed)) return TYPE_ALIASES.get(squashed);
    // Unrecognised labels pass through kebab-cased rather than failing here.
    // The importer validates activityType against the live store and names the
    // offender; this layer's job is to say so in a warning, not to decide which
    // Activity Types exist.
    return String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Title per type (§3.3), measured off the shipped MIALANGARTSE import: a
  // video carries the lesson's own name, a practice level its level number, a
  // quiz the word Assessment. A count above one — which none of the sample
  // courses has for these types — numbers them rather than emitting duplicates.
  function titleFor(typeKey, lessonTitle, ordinal, total) {
    if (typeKey === 'practice-level') return `Level ${ordinal}`;
    if (typeKey === 'pdf') return '';
    const base = typeKey === 'quiz' ? 'Assessment' : lessonTitle;
    return total > 1 ? `${base} ${ordinal}` : base;
  }

  function defaultsFor(typeKey, overrides) {
    const table = overrides || DEFAULTS;
    return table[typeKey] || DEFAULTS[typeKey] || FALLBACK_DEFAULT;
  }

  /**
   * Builds the 12-column proposal.
   *
   * @param {object} opts
   * @param {Array}  opts.counts        rows from readCounts()
   * @param {Array}  opts.pageMap       rows from readPageMap() (may be empty)
   * @param {string} opts.courseCode    the target Course Template's code
   * @param {number} opts.startNumber   first L-number to mint
   * @param {object} opts.defaults      per-typeKey { difficultyTier, expectedDurationMin }
   * @param {Array}  opts.knownTypeKeys activityTypeKeys the app actually has
   * @returns {{ rows, warnings, lessons }}
   */
  function expand(opts) {
    const counts = opts.counts || [];
    const spans = pageRanges(opts.pageMap || []);
    const courseCode = opts.courseCode;
    const startNumber = Number.isInteger(opts.startNumber) && opts.startNumber > 0 ? opts.startNumber : 1;
    const known = opts.knownTypeKeys ? new Set(opts.knownTypeKeys) : null;
    const warnings = [];

    // Lessons in first-appearance order — the counts sheet is already in
    // curriculum order, which is the one order that matters and is not
    // recoverable by sorting (unit numbers are text, lessons are not ordered
    // at all). Types accumulate per lesson so a sheet that splits one lesson
    // across non-adjacent rows still sums correctly.
    const lessons = new Map();
    for (const row of counts) {
      const key = lessonKey(row.unit, row.lesson);
      let lesson = lessons.get(key);
      if (!lesson) {
        lesson = { key, unit: row.unit, title: row.lesson, types: new Map(), seen: [] };
        lessons.set(key, lesson);
      }
      const typeKey = typeKeyFor(row.type);
      if (!lesson.types.has(typeKey)) { lesson.types.set(typeKey, 0); lesson.seen.push(typeKey); }
      lesson.types.set(typeKey, lesson.types.get(typeKey) + row.count);
    }

    const width = codeWidth(startNumber + lessons.size - 1);
    const rows = [];
    const unknownTypes = new Set();
    const withoutPages = [];
    let n = startNumber;

    for (const lesson of lessons.values()) {
      const code = lessonCode(n, width);
      const span = spans.get(lesson.key);

      // A PDF row is injected from the page map, never taken from the counts
      // sheet — the sheet has no page numbers and one lesson gets exactly one
      // span. A counts sheet that names PDF anyway would otherwise emit a
      // second, page-less row the importer would reject.
      if (lesson.types.has('pdf')) {
        warnings.push(`"${lesson.title}": the counts file lists a PDF row. Page ranges come from the page map, so it was ignored.`);
        lesson.types.delete('pdf');
      }

      const ordered = [
        ...TYPE_ORDER.filter((t) => t === 'pdf' || lesson.types.has(t)),
        ...lesson.seen.filter((t) => !TYPE_ORDER.includes(t)),
      ];

      for (const typeKey of ordered) {
        if (typeKey === 'pdf') {
          if (!span) continue;
          const d = defaultsFor('pdf', opts.defaults);
          rows.push({
            courseCode, lessonCode: code, lessonTitle: lesson.title, lessonOrder: n,
            activityType: 'pdf', title: '', required: 'TRUE',
            pageRangeStart: span.start, pageRangeEnd: span.end,
            difficultyTier: d.difficultyTier, expectedDurationMin: d.expectedDurationMin,
            instructions: '',
          });
          continue;
        }
        if (known && !known.has(typeKey)) unknownTypes.add(typeKey);
        const total = lesson.types.get(typeKey);
        const d = defaultsFor(typeKey, opts.defaults);
        for (let i = 1; i <= total; i++) {
          rows.push({
            courseCode, lessonCode: code, lessonTitle: lesson.title, lessonOrder: n,
            activityType: typeKey, title: titleFor(typeKey, lesson.title, i, total), required: 'TRUE',
            pageRangeStart: '', pageRangeEnd: '',
            difficultyTier: d.difficultyTier, expectedDurationMin: d.expectedDurationMin,
            instructions: '',
          });
        }
      }

      if (!span) withoutPages.push(lesson.title);
      lesson.code = code;
      lesson.lessonOrder = n;
      lesson.span = span || null;
      n++;
    }

    // Every mismatch between the two files is surfaced, never resolved. A
    // lesson the page map names and the counts sheet does not is the one that
    // actually loses work — its pages reach no Activity at all.
    for (const [key, span] of spans) {
      if (!lessons.has(key)) {
        warnings.push(`Page map lesson "${span.lesson}" (pages ${span.start}-${span.end}) matches no lesson in the counts file — no rows were written for it.`);
      }
    }
    // No page map at all is a choice, not a mismatch — say it once. Naming
    // every lesson there would bury the warnings that matter under a wall of
    // text on the most ordinary run of all (a course with no PDF).
    if (spans.size === 0 && withoutPages.length) {
      warnings.push(`No page map was supplied, so the proposal carries no PDF rows.`);
    } else if (withoutPages.length) {
      const shown = withoutPages.slice(0, 10).map((t) => `"${t}"`).join(', ');
      const rest = withoutPages.length > 10 ? ` and ${withoutPages.length - 10} more` : '';
      warnings.push(`No page-map entry, so no PDF row: ${shown}${rest}.`);
    }
    for (const t of unknownTypes) {
      warnings.push(`Activity Type "${t}" is not in this app's Activity Types — add it under Library → Activity Types, or the import will reject those rows.`);
    }

    return { rows, warnings, lessons: [...lessons.values()] };
  }

  return {
    CSV_COLUMNS,
    TYPE_ORDER,
    TYPE_ALIASES,
    DEFAULTS,
    parseCsv,
    toCsv,
    csvCell,
    readGrid,
    readXlsxGrid,
    parseSheet,
    parseSharedStrings,
    headerIndex,
    readCounts,
    readPageMap,
    pageRanges,
    lessonKey,
    nextLessonNumber,
    lessonCode,
    codeWidth,
    typeKeyFor,
    titleFor,
    expand,
  };
})();

// Node (tests) reads this via vm.runInThisContext, the same as the other
// *-core.js files; the browser gets the global above. No module system, no
// build step (CLAUDE.md §0).
