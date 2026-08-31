// Tests for the Management App's Course Structure Expander (expander-core.js).
// Per docs/TDS_Slice_Course_Structure_Expander.md §2/§3/§7. Pure, DOM-free —
// the same split as chores-csv-core.js, pacing-core.js, recipe-core.js,
// worker/validation.js and the Child App's *-core.js files.
//
// `tests/fixtures/` holds two real artifacts from the upstream chain: a counts
// workbook straight out of the screenshot pass, and a page map from the PDF
// trim. They are here because the .xlsx reader is the one part of this module
// that cannot be exercised by a hand-written string — a synthetic ZIP would
// only prove the reader parses what these tests emit. `tests/` is already
// excluded from the public asset bundle by .assetsignore, so neither file is
// served. Unrelated to the repo-root `fixtures/` deleted in Phase 5, which was
// packet-era interchange data (CLAUDE.md §I.B).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
function loadModule(path, name) {
  const src = readFileSync(new URL(path, repo), 'utf8');
  return vm.runInThisContext(`${src}\n;${name};`, { filename: path });
}
const Core = loadModule('management-app/js/expander-core.js', 'ExpanderCore');

function fixture(name) {
  return readFileSync(new URL(`tests/fixtures/${name}`, repo));
}

// Stands in for a File: readGrid reads .size and .arrayBuffer(). `declared`
// lets a test claim a size larger than what arrives, which is the Android
// short-read case §2.2 guards against.
function fileOf(bytes, declared) {
  return {
    size: declared === undefined ? bytes.length : declared,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const TYPE_KEYS = ['video', 'pdf', 'practice-level', 'quiz', 'online-sim', 'test', 'project'];

function countsRows(...triples) {
  return triples.map(([unit, lesson, type, count], i) => ({ unit, lesson, type, count, rowNumber: i + 2 }));
}

function pageRows(unit, lesson, from, to) {
  const out = [];
  for (let p = from; p <= to; p++) out.push({ unit, lesson, page: p, rowNumber: out.length + 2 });
  return out;
}

// ---- §2.1 CSV lexing ----

test('parseCsv handles quoted commas, escaped quotes, CRLF and a BOM', () => {
  const text = '﻿a,b\r\n"Points, Lines, and Rays","He said ""hi"""\r\n';
  assert.deepEqual(Core.parseCsv(text), [['a', 'b'], ['Points, Lines, and Rays', 'He said "hi"']]);
});

test('toCsv writes the importer header verbatim and quotes only what needs it', () => {
  const csv = Core.toCsv([{
    courseCode: 'X', lessonCode: 'L01', lessonTitle: 'Points, Lines, and Rays', lessonOrder: 1,
    activityType: 'video', title: 'A "quoted" name', required: 'TRUE',
    pageRangeStart: '', pageRangeEnd: '', difficultyTier: 'D01', expectedDurationMin: 5, instructions: '',
  }]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], Core.CSV_COLUMNS.join(','));
  assert.equal(lines[1], 'X,L01,"Points, Lines, and Rays",1,video,"A ""quoted"" name",TRUE,,,D01,5,');
  assert.equal(csv.endsWith('\r\n'), true);
});

// The whole point of the module: what it emits must survive courses.js's
// exact-header check. If that array is ever reordered, this fails first.
test('CSV_COLUMNS still matches the bulk importer in courses.js', () => {
  const src = readFileSync(new URL('management-app/js/courses.js', repo), 'utf8');
  const block = /const CSV_COLUMNS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'courses.js no longer declares CSV_COLUMNS');
  const theirs = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(Core.CSV_COLUMNS, theirs);
});

// ---- §2.2 the .xlsx reader ----

test('readGrid reads a real counts workbook out of the screenshot pass', async () => {
  const grid = await Core.readGrid(fileOf(fixture('counts-general-science.xlsx')));
  assert.deepEqual(grid[0], ['Unit Name', 'Lesson Name', 'Activity Type', 'Activity Count']);
  assert.equal(grid.length, 55); // header + 54
  assert.deepEqual(grid[1], ['Unit 5: Energy', 'What Is Energy?', 'Video', '1']);
  assert.deepEqual(grid[54], ["Unit 7: Earth's Resources", 'Reduce, Reuse, Recycle', 'Quiz', '1']);
});

test('readGrid sniffs content, not the file extension, and reads a CSV page map', async () => {
  const grid = await Core.readGrid(fileOf(fixture('page-map-math-level-e.csv')));
  assert.deepEqual(grid[0], ['trimmed_page', 'original_page', 'Unit Name', 'Lesson Name']);
  assert.equal(grid.length, 169); // header + 168
  // A quoted lesson title with commas survives the lexer intact.
  assert.equal(grid[66][3], 'Points, Lines, and Rays');
});

test('a run-formatted cell joins its text runs instead of losing half the title', () => {
  const xml = '<sheetData><row r="1">'
    + '<c r="A1" t="inlineStr"><is><r><t>Show, Don</t></r><r><t>&#8217;t Tell</t></r></is></c>'
    + '</row></sheetData>';
  assert.deepEqual(Core.parseSheet(xml, []), [['Show, Don’t Tell']]);
});

test('shared strings, inline strings and numbers all read as text', () => {
  const shared = Core.parseSharedStrings(
    '<sst><si><t>Unit 5: Energy</t></si><si><r><t>Types of </t></r><r><t>Energy</t></r></si></sst>'
  );
  assert.deepEqual(shared, ['Unit 5: Energy', 'Types of Energy']);
  const xml = '<sheetData><row r="2">'
    + '<c r="A2" t="s"><v>0</v></c>'
    + '<c r="B2" t="s"><v>1</v></c>'
    + '<c r="D2"><v>4</v></c>'
    + '</row></sheetData>';
  // C2 is absent from the XML entirely — a blank cell must not shift D into
  // its place, or every column after a gap reads one to the left.
  assert.deepEqual(Core.parseSheet(xml, shared), [['Unit 5: Energy', 'Types of Energy', '', '4']]);
});

test('XML entities in a lesson title are unescaped once, not left raw', () => {
  const xml = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Rock &amp; Roll &lt;i&gt;</t></is></c></row></sheetData>';
  assert.deepEqual(Core.parseSheet(xml, []), [['Rock & Roll <i>']]);
});

// ---- §2.2a damaged and truncated workbooks ----
//
// A file picked from a cloud folder on Android can reach the page as a short
// read: the picker reports the real size, the bytes stop early. These three
// cases are what that looks like from inside readGrid.

test('a short read is named as such, not blamed on the file', async () => {
  const full = fixture('counts-math-level-h.xlsx');
  await assert.rejects(
    () => Core.readGrid(fileOf(full.subarray(0, 9000), full.length)),
    /Only 9000 of \d+ bytes could be read/,
  );
});

test('a workbook missing its central directory still reads via local headers', async () => {
  const full = fixture('counts-math-level-h.xlsx');
  // Chop the central directory and EOCD off the end. The sheet XML sits near
  // the front, so the forward walk should still recover every row.
  const truncated = full.subarray(0, full.length - 1000);
  const grid = await Core.readGrid(fileOf(truncated));
  assert.deepEqual(grid[0], ['Unit Name', 'Lesson Name', 'Activity Type', 'Activity Count']);
  assert.equal(grid.length, 190);
});

test('something that is not a workbook says so, with the byte count', async () => {
  const junk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(
    () => Core.readGrid(fileOf(junk)),
    /does not read as a \.xlsx workbook \(12 bytes received\)/,
  );
});

// ---- §2.3 header-addressed reading ----

test('columns are found by name regardless of order or casing', () => {
  const grid = [['activity count', 'LESSON NAME', 'Unit Name', 'Activity_Type']];
  const { index, error } = Core.headerIndex(grid, {
    unit: ['Unit Name'], lesson: ['Lesson Name'], type: ['Activity Type'], count: ['Activity Count'],
  });
  assert.equal(error, undefined);
  assert.deepEqual(index, { unit: 2, lesson: 1, type: 3, count: 0 });
});

test('a missing column is named rather than silently read as blank', () => {
  const result = Core.readCounts([['Unit Name', 'Lesson Name', 'Activity Type']]);
  assert.match(result.error, /Activity Count/);
});

test('readCounts rejects a non-positive count and names the sheet row', () => {
  const grid = [
    ['Unit Name', 'Lesson Name', 'Activity Type', 'Activity Count'],
    ['U1', 'Lesson A', 'Video', '0'],
    ['U1', 'Lesson A', 'Quiz', '1'],
  ];
  const { rows, errors } = Core.readCounts(grid);
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Counts row 2/);
});

// ---- §3.1 the join ----

test('pageRanges spans a lesson from its lowest to its highest original page', async () => {
  const grid = await Core.readGrid(fileOf(fixture('page-map-math-level-e.csv')));
  const { rows } = Core.readPageMap(grid);
  const spans = Core.pageRanges(rows);
  const key = Core.lessonKey('Unit 9: Working With Lines and Shapes', 'Polygons');
  assert.deepEqual(
    { start: spans.get(key).start, end: spans.get(key).end },
    { start: 497, end: 501 },
  );
  // Interior gaps are the trimmed divider pages; the span swallows them.
  const wrap = Core.lessonKey('Unit 8: Working With Measurements', 'Customary Measurements Wrap-Up');
  assert.deepEqual({ start: spans.get(wrap).start, end: spans.get(wrap).end }, { start: 423, end: 429 });
});

test('lessonKey cannot collide by concatenation', () => {
  assert.notEqual(Core.lessonKey('Unit 1', '0: Review'), Core.lessonKey('Unit 10', ': Review'));
});

// ---- §3.2 emission order ----

test('a lesson emits video, pdf, practice levels, online sim, then quiz', () => {
  const counts = countsRows(
    ['U1', 'Lesson A', 'Quiz', 1],
    ['U1', 'Lesson A', 'Practice Level', 3],
    ['U1', 'Lesson A', 'Online Sim', 1],
    ['U1', 'Lesson A', 'Video', 1],
  );
  const { rows } = Core.expand({
    counts, pageMap: pageRows('U1', 'Lesson A', 10, 14), courseCode: 'C', startNumber: 1,
    knownTypeKeys: TYPE_KEYS,
  });
  assert.deepEqual(rows.map((r) => r.activityType), [
    'video', 'pdf', 'practice-level', 'practice-level', 'practice-level', 'online-sim', 'quiz',
  ]);
});

test('titles follow the shipped import: lesson name, Level N, Assessment', () => {
  const counts = countsRows(
    ['U1', 'Making Inferences', 'Video', 1],
    ['U1', 'Making Inferences', 'Practice Level', 2],
    ['U1', 'Making Inferences', 'Online Sim', 1],
    ['U1', 'Making Inferences', 'Quiz', 1],
  );
  const { rows } = Core.expand({ counts, pageMap: [], courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS });
  assert.deepEqual(rows.map((r) => [r.activityType, r.title]), [
    ['video', 'Making Inferences'],
    ['practice-level', 'Level 1'],
    ['practice-level', 'Level 2'],
    ['online-sim', 'Making Inferences'],
    ['quiz', 'Assessment'],
  ]);
});

test('a count above one numbers the rows instead of emitting duplicates', () => {
  const counts = countsRows(['U1', 'Lesson A', 'Quiz', 2], ['U1', 'Lesson A', 'Video', 2]);
  const { rows } = Core.expand({ counts, pageMap: [], courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS });
  assert.deepEqual(rows.map((r) => r.title), ['Lesson A 1', 'Lesson A 2', 'Assessment 1', 'Assessment 2']);
});

// ---- §3.3 the PDF row ----

test('the pdf row carries the lesson span, a blank title, and no count of its own', () => {
  const counts = countsRows(['U1', 'Lesson A', 'Video', 1]);
  const { rows } = Core.expand({
    counts, pageMap: pageRows('U1', 'Lesson A', 403, 407), courseCode: 'C', startNumber: 1,
    knownTypeKeys: TYPE_KEYS,
  });
  const pdf = rows.find((r) => r.activityType === 'pdf');
  assert.deepEqual(
    { title: pdf.title, start: pdf.pageRangeStart, end: pdf.pageRangeEnd, dur: pdf.expectedDurationMin },
    { title: '', start: 403, end: 407, dur: 10 },
  );
});

test('page columns are blank on every non-pdf row', () => {
  const counts = countsRows(['U1', 'Lesson A', 'Video', 1], ['U1', 'Lesson A', 'Quiz', 1]);
  const { rows } = Core.expand({
    counts, pageMap: pageRows('U1', 'Lesson A', 1, 3), courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS,
  });
  for (const r of rows.filter((x) => x.activityType !== 'pdf')) {
    assert.equal(r.pageRangeStart, '');
    assert.equal(r.pageRangeEnd, '');
  }
});

test('a lesson with no page-map entry gets no pdf row, and is named', () => {
  const counts = countsRows(['U1', 'Course Introduction', 'Video', 1], ['U1', 'Mapped', 'Video', 1]);
  const { rows, warnings } = Core.expand({
    counts, pageMap: pageRows('U1', 'Mapped', 4, 6), courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS,
  });
  assert.equal(rows.filter((r) => r.activityType === 'pdf').length, 1);
  assert.equal(warnings.some((w) => w.includes('Course Introduction')), true);
});

// A course with no PDF at all is the ordinary case, not a mismatch. Naming
// every lesson there would bury the warnings that matter.
test('no page map at all warns once instead of listing every lesson', () => {
  const counts = countsRows(['U1', 'A', 'Video', 1], ['U1', 'B', 'Video', 1], ['U1', 'C', 'Video', 1]);
  const { warnings } = Core.expand({ counts, pageMap: [], courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS });
  assert.deepEqual(warnings, ['No page map was supplied, so the proposal carries no PDF rows.']);
});

test('a page-map lesson the counts file never names is reported, not dropped in silence', () => {
  const counts = countsRows(['U1', 'Lesson A', 'Video', 1]);
  const { warnings } = Core.expand({
    counts, pageMap: pageRows('U1', 'Lesson Z', 50, 60), courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS,
  });
  assert.equal(warnings.some((w) => w.includes('Lesson Z') && w.includes('50')), true);
});

test('a PDF row in the counts file is ignored in favour of the page map, with a warning', () => {
  const counts = countsRows(['U1', 'Lesson A', 'Video', 1], ['U1', 'Lesson A', 'PDF', 4]);
  const { rows, warnings } = Core.expand({
    counts, pageMap: pageRows('U1', 'Lesson A', 8, 12), courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS,
  });
  assert.equal(rows.filter((r) => r.activityType === 'pdf').length, 1);
  assert.equal(warnings.some((w) => w.includes('counts file lists a PDF row')), true);
});

// ---- §3.3 defaults ----

test('default tier and duration per type, overridable', () => {
  const counts = countsRows(['U1', 'L', 'Video', 1], ['U1', 'L', 'Quiz', 1]);
  const base = Core.expand({ counts, pageMap: [], courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS });
  assert.deepEqual(base.rows.map((r) => [r.difficultyTier, r.expectedDurationMin]), [['D01', 5], ['D02', 20]]);

  const tuned = Core.expand({
    counts, pageMap: [], courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS,
    defaults: { ...Core.DEFAULTS, quiz: { difficultyTier: 'D03', expectedDurationMin: 15 } },
  });
  assert.deepEqual(tuned.rows[1].difficultyTier, 'D03');
  assert.deepEqual(tuned.rows[1].expectedDurationMin, 15);
});

test('required is TRUE and instructions is blank on every row', () => {
  const counts = countsRows(['U1', 'L', 'Video', 1], ['U1', 'L', 'Practice Level', 2], ['U1', 'L', 'Quiz', 1]);
  const { rows } = Core.expand({
    counts, pageMap: pageRows('U1', 'L', 1, 2), courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS,
  });
  for (const r of rows) {
    assert.equal(r.required, 'TRUE');
    assert.equal(r.instructions, '');
  }
});

// ---- §3.4 lesson codes ----

test('lesson codes continue from what the course already has', () => {
  assert.equal(Core.nextLessonNumber([]), 1);
  assert.equal(Core.nextLessonNumber(['L01', 'L02']), 3);
  assert.equal(Core.nextLessonNumber(['l7', 'L003', 'REVIEW']), 8);
});

test('codes are minted in curriculum order, padded to the batch width', () => {
  const counts = countsRows(
    ['U1', 'First', 'Video', 1],
    ['U1', 'Second', 'Video', 1],
    ['U2', 'Third', 'Video', 1],
  );
  const { rows } = Core.expand({ counts, pageMap: [], courseCode: 'C', startNumber: 3, knownTypeKeys: TYPE_KEYS });
  assert.deepEqual(rows.map((r) => [r.lessonCode, r.lessonOrder, r.lessonTitle]), [
    ['L03', 3, 'First'], ['L04', 4, 'Second'], ['L05', 5, 'Third'],
  ]);
});

test('the code width grows past ninety-nine lessons', () => {
  assert.equal(Core.codeWidth(95), 2);
  assert.equal(Core.codeWidth(100), 3);
  assert.equal(Core.lessonCode(7, 3), 'L007');
});

test('lessons keep curriculum order, never alphabetical or unit-sorted', () => {
  const counts = countsRows(
    ['Unit 9: Late', 'Zebra', 'Video', 1],
    ['Unit 2: Early', 'Apple', 'Video', 1],
  );
  const { rows } = Core.expand({ counts, pageMap: [], courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS });
  assert.deepEqual(rows.map((r) => r.lessonTitle), ['Zebra', 'Apple']);
});

test('one lesson split across non-adjacent rows sums rather than splitting in two', () => {
  const counts = countsRows(
    ['U1', 'Lesson A', 'Practice Level', 2],
    ['U1', 'Lesson B', 'Video', 1],
    ['U1', 'Lesson A', 'Practice Level', 2],
  );
  const { rows } = Core.expand({ counts, pageMap: [], courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS });
  const a = rows.filter((r) => r.lessonTitle === 'Lesson A');
  assert.equal(a.length, 4);
  assert.deepEqual(a.map((r) => r.title), ['Level 1', 'Level 2', 'Level 3', 'Level 4']);
  assert.deepEqual([...new Set(rows.map((r) => r.lessonCode))], ['L01', 'L02']);
});

// ---- §3.5 activity types ----

test('type labels squash to the seeded activityTypeKeys', () => {
  assert.equal(Core.typeKeyFor('Practice Level'), 'practice-level');
  assert.equal(Core.typeKeyFor('practice_level'), 'practice-level');
  assert.equal(Core.typeKeyFor('Online Sim'), 'online-sim');
  assert.equal(Core.typeKeyFor('PDF'), 'pdf');
  assert.equal(Core.typeKeyFor('Lab Report'), 'lab-report');
});

test('a type the app does not have is warned about, not silently emitted', () => {
  const counts = countsRows(['U1', 'L', 'Lab Report', 1]);
  const { rows, warnings } = Core.expand({ counts, pageMap: [], courseCode: 'C', startNumber: 1, knownTypeKeys: TYPE_KEYS });
  assert.equal(rows[0].activityType, 'lab-report');
  assert.equal(warnings.some((w) => w.includes('lab-report') && w.includes('Activity Types')), true);
});

// ---- End to end (§7) ----

test('the General Science counts sheet expands to the expected shape', async () => {
  const grid = await Core.readGrid(fileOf(fixture('counts-general-science.xlsx')));
  const { rows: counts, errors } = Core.readCounts(grid);
  assert.deepEqual(errors, []);
  assert.equal(counts.length, 54);

  const { rows, lessons } = Core.expand({
    counts, pageMap: [], courseCode: 'MIAGENSCI', startNumber: 1, knownTypeKeys: TYPE_KEYS,
  });

  // 18 lessons, each Video + 4 practice levels + Quiz, no page map so no PDFs.
  assert.equal(lessons.length, 18);
  assert.equal(rows.length, 18 * 6);
  assert.equal(rows.some((r) => r.activityType === 'pdf'), false);
  assert.deepEqual(rows.slice(0, 6).map((r) => [r.lessonCode, r.activityType, r.title]), [
    ['L01', 'video', 'What Is Energy?'],
    ['L01', 'practice-level', 'Level 1'],
    ['L01', 'practice-level', 'Level 2'],
    ['L01', 'practice-level', 'Level 3'],
    ['L01', 'practice-level', 'Level 4'],
    ['L01', 'quiz', 'Assessment'],
  ]);
  assert.equal(rows[rows.length - 1].lessonCode, 'L18');
});

test('counts joined to a real page map produce one pdf row per mapped lesson', async () => {
  const mapGrid = await Core.readGrid(fileOf(fixture('page-map-math-level-e.csv')));
  const { rows: pageMap, errors } = Core.readPageMap(mapGrid);
  assert.deepEqual(errors, []);

  // A counts sheet for the same three units, built from the page map's own
  // lesson list — the shape the upstream screenshot pass would produce.
  const seen = new Map();
  for (const r of pageMap) if (!seen.has(Core.lessonKey(r.unit, r.lesson))) seen.set(Core.lessonKey(r.unit, r.lesson), r);
  const counts = [];
  for (const r of seen.values()) {
    counts.push({ unit: r.unit, lesson: r.lesson, type: 'Video', count: 1 });
    counts.push({ unit: r.unit, lesson: r.lesson, type: 'Practice Level', count: 3 });
    counts.push({ unit: r.unit, lesson: r.lesson, type: 'Quiz', count: 1 });
  }

  const { rows, warnings } = Core.expand({
    counts, pageMap, courseCode: 'MIAMATHE', startNumber: 1, knownTypeKeys: TYPE_KEYS,
  });
  const pdfs = rows.filter((r) => r.activityType === 'pdf');
  assert.equal(pdfs.length, seen.size);
  assert.deepEqual(warnings, []);

  // Every pdf row falls inside the original-page span the map describes, and
  // the first lesson is the one the trim started on.
  assert.equal(pdfs[0].pageRangeStart, 403);
  assert.equal(pdfs[pdfs.length - 1].pageRangeEnd, 592);
  for (const p of pdfs) assert.ok(p.pageRangeStart <= p.pageRangeEnd);

  // The output is a valid file for the importer: exact header, one row per
  // line, and the quoted lesson title survives the round trip.
  const csv = Core.toCsv(rows);
  const parsed = Core.parseCsv(csv);
  assert.deepEqual(parsed[0], Core.CSV_COLUMNS);
  assert.equal(parsed.length, rows.length + 1);
  assert.equal(parsed.some((r) => r[2] === 'Points, Lines, and Rays'), true);
});

test('the Math Level H pair joins, and the missing unit surfaces as a warning', async () => {
  const counts = Core.readCounts(await Core.readGrid(fileOf(fixture('counts-math-level-h.xlsx'))));
  const map = Core.readPageMap(await Core.readGrid(fileOf(fixture('page-map-math-level-h.csv'))));
  assert.deepEqual(counts.errors, []);
  assert.deepEqual(map.errors, []);

  const { rows, warnings, lessons } = Core.expand({
    counts: counts.rows, pageMap: map.rows, courseCode: 'MIAMATHH', startNumber: 1,
    knownTypeKeys: TYPE_KEYS,
  });

  assert.equal(lessons.length, 91);
  assert.equal(rows.filter((r) => r.activityType === 'pdf').length, 87);

  // Unit 12 (Data Analysis) is in the counts sheet but absent from the page
  // map, so its four lessons get every row except a pdf one — and are named.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Measures of Variation/);

  // A single-page lesson repeats the number rather than leaving the end blank.
  const first = rows.find((r) => r.activityType === 'pdf');
  assert.deepEqual([first.pageRangeStart, first.pageRangeEnd], [4, 4]);
});
