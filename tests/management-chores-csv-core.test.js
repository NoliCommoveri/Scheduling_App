// Tests for the Management App's Chore bulk-CSV reader (chores-csv-core.js).
// Per SRS_Management_Module_06_Chore_Authoring.md FR-8 (Amendment A1) and
// docs/TDS_Slice_Chore_Bulk_Import.md §4.2/§5. Pure, DOM-free — the same split
// as pacing-core.js, recipe-core.js, worker/validation.js and the Child App's
// *-core.js files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
function loadModule(path, name) {
  const src = readFileSync(new URL(path, repo), 'utf8');
  return vm.runInThisContext(`${src}\n;${name};`, { filename: path });
}
const Core = loadModule('management-app/js/chores-csv-core.js', 'ChoresCsvCore');

const HEADER = Core.CSV_COLUMNS.join(',');

const LOOKUPS = {
  children: [
    { id: 'CHI-aaaaaa', name: 'Ada', active: true },
    { id: 'CHI-bbbbbb', name: 'Ben', active: true },
    { id: 'CHI-cccccc', name: 'Cass', active: false }, // archived
  ],
  tierIds: ['D01', 'D02'],
};

// Two active children sharing a name — the ambiguity case of TDS §1/§5.5.
const AMBIGUOUS = {
  children: [
    { id: 'CHI-aaaaaa', name: 'Sam', active: true },
    { id: 'CHI-dddddd', name: 'Sam', active: true },
  ],
  tierIds: ['D01'],
};

function csv(...rows) {
  return [HEADER, ...rows].join('\n') + '\n';
}

// A valid row: Ada, Tidy Room, Bedroom, Mon|Wed, blank allocation, D01.
const VALID_ROW = 'Ada,Tidy Room,Bedroom,Mon|Wed,,D01,,,';

// --------------------------------------------------------------- parseCsv

test('parses quoted fields, escaped quotes and CRLF line endings', () => {
  const rows = Core.parseCsv('a,"b,c",d\r\ne,"f""g",h\r\n');
  assert.deepEqual(rows, [['a', 'b,c', 'd'], ['e', 'f"g', 'h']]);
});

test('drops blank lines rather than reading them as rows', () => {
  const rows = Core.parseCsv('a,b\n\n\nc,d\n');
  assert.deepEqual(rows, [['a', 'b'], ['c', 'd']]);
});

// ----------------------------------------------------------- header gate

test('the locked header is nine columns in the documented order', () => {
  assert.deepEqual(Core.CSV_COLUMNS, [
    'children', 'title', 'choreType', 'daysOfWeek', 'allocation', 'difficultyTier',
    'instances', 'blockHint', 'notes',
  ]);
});

test('template output matches the locked header byte for byte (§5.3)', () => {
  assert.equal(Core.templateCsv(), HEADER + '\n');
  assert.ok(Core.validateHeader(Core.parseCsv(Core.templateCsv())[0]));
});

test('re-importing the unchanged template is accepted and writes nothing (§5.3)', () => {
  const result = Core.readCsv(Core.templateCsv(), LOOKUPS);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.candidates, []);
});

test('a missing, extra, renamed or reordered column rejects before any row (§5.2)', () => {
  const bad = [
    'children,title,choreType,daysOfWeek,allocation,difficultyTier,instances,blockHint', // missing
    HEADER + ',extra',                                                                    // extra
    HEADER.replace('children', 'childIds'),                                               // renamed
    'title,children,choreType,daysOfWeek,allocation,difficultyTier,instances,blockHint,notes', // reordered
  ];
  for (const header of bad) {
    // A row that would be perfectly valid under the real header.
    const result = Core.readCsv(`${header}\n${VALID_ROW}\n`, LOOKUPS);
    assert.match(result.error, /CSV header must be exactly/, `expected rejection for: ${header}`);
    assert.equal(result.failures, undefined, 'header gate must run before any row is read');
  }
});

test('an empty file is rejected', () => {
  assert.match(Core.readCsv('', LOOKUPS).error, /empty/);
});

// ------------------------------------------------------------- happy path

test('a minimal valid row produces the create-form field shape', () => {
  const { candidates } = Core.readCsv(csv(VALID_ROW), LOOKUPS);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rowNumber, 2); // header is row 1
  assert.deepEqual(candidates[0].fields, {
    childIds: ['CHI-aaaaaa'],
    allocation: 'each',
    title: 'Tidy Room',
    choreType: 'Bedroom',
    daysOfWeek: ['Mon', 'Wed'],
    difficultyTier: 'D01',
  });
  assert.equal(candidates[0].instanceLabels, undefined);
});

test('blank optional cells omit the property entirely, never null or "" (§5.11)', () => {
  const { candidates } = Core.readCsv(csv(VALID_ROW), LOOKUPS);
  const keys = Object.keys(candidates[0].fields);
  assert.ok(!keys.includes('notes'));
  assert.ok(!keys.includes('blockHint'));
  assert.ok(!keys.includes('instances'));
  assert.ok(!keys.includes('childDays'), 'childDays is never importable (§1)');
});

test('every optional column round-trips when populated', () => {
  const { candidates } = Core.readCsv(
    csv('Ada|Ben,Dishes,Kitchen/Dining,Mon|Tue|Wed,claim,D02,Breakfast|Dinner,evening,After supper'),
    LOOKUPS
  );
  const c = candidates[0];
  assert.deepEqual(c.fields.childIds, ['CHI-aaaaaa', 'CHI-bbbbbb']);
  assert.equal(c.fields.allocation, 'claim');
  assert.equal(c.fields.choreType, 'Kitchen/Dining'); // the `/` survives `|` splitting
  assert.equal(c.fields.blockHint, 'evening');
  assert.equal(c.fields.notes, 'After supper');
  assert.deepEqual(c.instanceLabels, ['Breakfast', 'Dinner']);
});

test('whitespace around list elements and fields is trimmed', () => {
  const { candidates } = Core.readCsv(csv(' Ada | Ben , Dishes ,Bathroom, Mon | Fri ,,D01,,,'), LOOKUPS);
  assert.deepEqual(candidates[0].fields.childIds, ['CHI-aaaaaa', 'CHI-bbbbbb']);
  assert.deepEqual(candidates[0].fields.daysOfWeek, ['Mon', 'Fri']);
  assert.equal(candidates[0].fields.title, 'Dishes');
});

// ------------------------------------------------------- child resolution

test('a name matching no active Child is rejected (§5.4)', () => {
  const result = Core.readCsv(csv('Zed,Tidy Room,Bedroom,Mon,,D01,,,'), LOOKUPS);
  assert.equal(result.candidates, undefined);
  assert.match(result.failures[0], /Row 2: child "Zed" does not match any active Child by name\./);
});

test('an ambiguous name is rejected and names both ids to disambiguate with (§5.5)', () => {
  const result = Core.readCsv(csv('Sam,Tidy Room,Bedroom,Mon,,D01,,,'), AMBIGUOUS);
  assert.match(result.failures[0], /matches 2 active Children/);
  assert.match(result.failures[0], /CHI-aaaaaa, CHI-dddddd/);
});

test('the same file with ids substituted for the ambiguous name imports cleanly (§5.5)', () => {
  const result = Core.readCsv(csv('CHI-dddddd,Tidy Room,Bedroom,Mon,,D01,,,'), AMBIGUOUS);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.candidates[0].fields.childIds, ['CHI-dddddd']);
});

test('an archived Child is rejected by name but accepted by id (§5.6)', () => {
  const byName = Core.readCsv(csv('Cass,Tidy Room,Bedroom,Mon,,D01,,,'), LOOKUPS);
  assert.match(byName.failures[0], /does not match any active Child by name/);

  const byId = Core.readCsv(csv('CHI-cccccc,Tidy Room,Bedroom,Mon,,D01,,,'), LOOKUPS);
  assert.equal(byId.error, undefined);
  assert.deepEqual(byId.candidates[0].fields.childIds, ['CHI-cccccc']);
});

test('an unknown CHI- id is rejected as an id, not retried as a name', () => {
  const result = Core.readCsv(csv('CHI-zzzzzz,Tidy Room,Bedroom,Mon,,D01,,,'), LOOKUPS);
  assert.match(result.failures[0], /child "CHI-zzzzzz" does not match any Child record\./);
});

test('name matching is case-insensitive', () => {
  const result = Core.readCsv(csv('ADA,Tidy Room,Bedroom,Mon,,D01,,,'), LOOKUPS);
  assert.deepEqual(result.candidates[0].fields.childIds, ['CHI-aaaaaa']);
});

test('naming the same Child twice in one row is rejected', () => {
  const result = Core.readCsv(csv('Ada|Ada,Tidy Room,Bedroom,Mon,,D01,,,'), LOOKUPS);
  assert.match(result.failures[0], /named more than once/);
});

test('a stray separator in children is rejected rather than swallowed', () => {
  const result = Core.readCsv(csv('Ada||Ben,Tidy Room,Bedroom,Mon,,D01,,,'), LOOKUPS);
  assert.match(result.failures[0], /empty entry/);
});

test('a blank children cell is rejected', () => {
  const result = Core.readCsv(csv(',Tidy Room,Bedroom,Mon,,D01,,,'), LOOKUPS);
  assert.match(result.failures[0], /children is required/);
});

// ------------------------------------------------------------ enum checks

test('choreType is compared exactly — wrong case is rejected (§5.7)', () => {
  const result = Core.readCsv(csv('Ada,Tidy Room,kitchen/dining,Mon,,D01,,,'), LOOKUPS);
  assert.match(result.failures[0], /is not one of the eleven canonical values/);
});

test('every one of the eleven canonical choreTypes is accepted verbatim', () => {
  for (const choreType of Core.CHORE_TYPES) {
    const result = Core.readCsv(csv(`Ada,Tidy Room,"${choreType}",Mon,,D01,,,`), LOOKUPS);
    assert.equal(result.error, undefined, `rejected canonical type: ${choreType}`);
    assert.equal(result.candidates[0].fields.choreType, choreType);
  }
});

test('an unknown or duplicated day is rejected, and a blank daysOfWeek cell too', () => {
  assert.match(Core.readCsv(csv('Ada,T,Bedroom,Munday,,D01,,,'), LOOKUPS).failures[0], /is not one of Sun/);
  assert.match(Core.readCsv(csv('Ada,T,Bedroom,Mon|Mon,,D01,,,'), LOOKUPS).failures[0], /more than once/);
  assert.match(Core.readCsv(csv('Ada,T,Bedroom,,,D01,,,'), LOOKUPS).failures[0], /daysOfWeek is required/);
});

test('all seven days and a single day are both ordinary, with no special case', () => {
  const seven = Core.readCsv(csv('Ada,T,Bedroom,Sun|Mon|Tue|Wed|Thu|Fri|Sat,,D01,,,'), LOOKUPS);
  assert.equal(seven.candidates[0].fields.daysOfWeek.length, 7);
  const one = Core.readCsv(csv('Ada,T,Bedroom,Sat,,D01,,,'), LOOKUPS);
  assert.deepEqual(one.candidates[0].fields.daysOfWeek, ['Sat']);
});

test('allocation defaults to each when blank and rejects anything else (§5.8)', () => {
  assert.equal(Core.readCsv(csv(VALID_ROW), LOOKUPS).candidates[0].fields.allocation, 'each');
  assert.equal(
    Core.readCsv(csv('Ada|Ben,T,Bedroom,Mon,claim,D01,,,'), LOOKUPS).candidates[0].fields.allocation,
    'claim'
  );
  assert.match(Core.readCsv(csv('Ada,T,Bedroom,Mon,shared,D01,,,'), LOOKUPS).failures[0], /must be "each", "claim", or blank/);
});

test('an unresolved tier is rejected, and a blank one too', () => {
  assert.match(Core.readCsv(csv('Ada,T,Bedroom,Mon,,D99,,,'), LOOKUPS).failures[0], /does not resolve to an existing Tier/);
  assert.match(Core.readCsv(csv('Ada,T,Bedroom,Mon,,,,,'), LOOKUPS).failures[0], /difficultyTier is required/);
});

test('an unknown blockHint is rejected; a canonical one is kept', () => {
  assert.match(Core.readCsv(csv('Ada,T,Bedroom,Mon,,D01,,teatime,'), LOOKUPS).failures[0], /must be one of morning/);
  assert.equal(
    Core.readCsv(csv('Ada,T,Bedroom,Mon,,D01,,night,'), LOOKUPS).candidates[0].fields.blockHint,
    'night'
  );
});

test('a blank title is rejected', () => {
  assert.match(Core.readCsv(csv('Ada,   ,Bedroom,Mon,,D01,,,'), LOOKUPS).failures[0], /title is required/);
});

// -------------------------------------------------------------- instances

test('instance labels are read in cell order (§5.9)', () => {
  const { candidates } = Core.readCsv(
    csv('Ada,Dishes,Kitchen/Dining,Mon,,D01,Breakfast|Lunch|Dinner,,'),
    LOOKUPS
  );
  assert.deepEqual(candidates[0].instanceLabels, ['Breakfast', 'Lunch', 'Dinner']);
});

test('a blank instances cell yields undefined, not an empty list (§5.9)', () => {
  const { candidates } = Core.readCsv(csv(VALID_ROW), LOOKUPS);
  assert.equal(candidates[0].instanceLabels, undefined);
});

test('a stray separator or a duplicate label in instances is rejected (§5.10)', () => {
  assert.match(
    Core.readCsv(csv('Ada,Dishes,Kitchen/Dining,Mon,,D01,Breakfast||Dinner,,'), LOOKUPS).failures[0],
    /empty entry/
  );
  assert.match(
    Core.readCsv(csv('Ada,Dishes,Kitchen/Dining,Mon,,D01,Dishes|Dishes,,'), LOOKUPS).failures[0],
    /must be distinct/
  );
});

// ------------------------------------------------------ whole-file outcome

test('one bad row among good ones rejects the whole file (§5.14)', () => {
  const result = Core.readCsv(csv(VALID_ROW, 'Zed,Trash,Porch,Fri,,D01,,,'), LOOKUPS);
  assert.equal(result.candidates, undefined, 'no candidates are handed back for a rejected file');
  assert.match(result.error, /no Chores were written/);
});

test('every failing row is reported, not just the first', () => {
  const result = Core.readCsv(
    csv('Zed,Trash,Porch,Fri,,D01,,,', VALID_ROW, 'Ada,Trash,Porch,Fri,,D99,,,'),
    LOOKUPS
  );
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0], /^Row 2:/);
  assert.match(result.failures[1], /^Row 4:/); // row 3 is the valid one
});

test('two rows that are byte-identical are both accepted — no dedup is claimed (§5.13)', () => {
  const result = Core.readCsv(csv(VALID_ROW, VALID_ROW), LOOKUPS);
  assert.equal(result.error, undefined);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0].fields, result.candidates[1].fields);
});

test('a quoted field carrying a comma survives into the record', () => {
  const { candidates } = Core.readCsv(
    csv('Ada,"Feed the dog, then the cat",Pet Care,Mon,,D01,,,"Morning, before school"'),
    LOOKUPS
  );
  assert.equal(candidates[0].fields.title, 'Feed the dog, then the cat');
  assert.equal(candidates[0].fields.notes, 'Morning, before school');
});
