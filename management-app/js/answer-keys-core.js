/* Module: answer-keys-core.js — matching staged PDFs to Lessons for the bulk
 * answer-key screen.
 *
 * Per docs/TDS_Slice_Grading_Assistant.md §4 (answer keys live at
 * `keys/{lessonId}`, one per *instance* Lesson) and §5's three
 * `/api/grading/keys` routes. Adds no route and no stored field: this is the
 * arithmetic behind "I picked twenty PDFs, put them on the right lessons".
 *
 * Pure and DOM-free, no Storage access, no network — the same split
 * `chores-csv-core.js`, `recipe-core.js`, `pacing-core.js` and the Child App's
 * *-core.js files already use, so `tests/management-answer-keys-core.test.js`
 * can exercise every matching rule directly (CLAUDE.md §I.B). `instances.js`
 * is the only caller and remains the only thing that uploads anything.
 *
 * WHY IT REFUSES MORE THAN IT ACCEPTS. A wrongly matched key is worse than an
 * unmatched one: an unmatched file sits visibly in the tray waiting for a
 * parent to place it, while a wrong one silently arms a lesson with another
 * lesson's answers and only shows up as nonsense grades weeks later. So every
 * rule here is boundary-anchored and every ambiguity — two lessons matching
 * one file, or two files matching one lesson — resolves to "leave it for the
 * human", never to a guess.
 */

const AnswerKeysCore = (() => {
  // Highest confidence first. A file is judged at the best tier that produces
  // any candidate at all and is never allowed to fall through to a weaker one:
  // if two lessons both match by code, the number in the filename does not get
  // to break the tie, because the tie means the filename is genuinely unclear.
  const TIERS = ['code', 'title', 'number'];

  const MIN_TITLE_CHARS = 3; // "Ch" and "A" are not evidence of anything

  function stripExtension(name) {
    return String(name || '').replace(/\.[^.]*$/, '');
  }

  // Lowercase, and every run of non-alphanumerics becomes one space, so
  // "Math_L01-key.pdf", "math l01 key.PDF" and "Math.L01.Key.pdf" all reduce
  // to the same token sequence.
  function normalize(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function tokens(value) {
    const normalized = normalize(value);
    return normalized ? normalized.split(' ') : [];
  }

  // Every digit run in the text, as integers — "unit-07 of 2026" gives [7, 2026].
  // Leading zeros are dropped by Number, which is the point: L07 and "lesson 7"
  // are the same lesson.
  function numbersIn(value) {
    const matches = String(value || '').match(/\d+/g);
    return matches ? matches.map((m) => Number(m)) : [];
  }

  // The number a Lesson answers to. Its code first ("L03" -> 3), because that
  // is what a parent names a file after; `order + 1` only when the code carries
  // no digits at all ("INTRO"), matching the 1-based numbering the auto-code in
  // instances.js mints.
  function lessonNumber(lesson) {
    const fromCode = numbersIn(lesson.lessonCode);
    if (fromCode.length === 1) return fromCode[0];
    if (fromCode.length > 1) return null; // "L3-B2" names no single number
    return Number.isInteger(lesson.order) ? lesson.order + 1 : null;
  }

  // Whole-token containment: the filename's tokens must contain the phrase's
  // tokens as a contiguous run. Substring matching is deliberately not used —
  // it is what makes "level1.pdf" look like lesson "L1".
  function containsPhrase(fileTokens, phraseTokens) {
    if (phraseTokens.length === 0) return false;
    for (let i = 0; i + phraseTokens.length <= fileTokens.length; i++) {
      let hit = true;
      for (let j = 0; j < phraseTokens.length; j++) {
        if (fileTokens[i + j] !== phraseTokens[j]) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  }

  // Which lessons this filename could mean, at each tier.
  function candidatesFor(fileName, lessons) {
    const fileTokens = tokens(stripExtension(fileName));
    const fileNumbers = numbersIn(stripExtension(fileName));

    const byTier = { code: [], title: [], number: [] };
    for (const lesson of lessons) {
      const codeTokens = tokens(lesson.lessonCode);
      if (codeTokens.length && containsPhrase(fileTokens, codeTokens)) {
        byTier.code.push(lesson);
      }

      const titleTokens = tokens(lesson.title);
      const titleChars = titleTokens.join('').length;
      if (titleChars >= MIN_TITLE_CHARS && containsPhrase(fileTokens, titleTokens)) {
        byTier.title.push(lesson);
      }

      const number = lessonNumber(lesson);
      if (number !== null && fileNumbers.includes(number)) {
        byTier.number.push(lesson);
      }
    }
    return byTier;
  }

  function describe(tier, lesson) {
    if (tier === 'code') return `filename names lesson code ${lesson.lessonCode}`;
    if (tier === 'title') return 'filename contains the lesson title';
    return `filename contains lesson number ${lessonNumber(lesson)}`;
  }

  /* Propose a lesson for each staged file.
   *
   * `files` is [{ id, name }] — ids are the caller's, opaque here. `lessons` is
   * [{ id, lessonCode, title, order }]. `taken` is the set/array of lesson ids
   * that already hold a file the parent placed themselves; a proposal never
   * displaces one of those, it just declines and leaves the file staged.
   *
   * Returns { matches: [{ fileId, lessonId, tier, reason }], unmatched: [{ fileId, reason }] },
   * with `matches` at most one per lesson and at most one per file. Every file
   * handed in appears in exactly one of the two lists, so the caller can render
   * the whole tray from this and nothing goes missing.
   */
  function matchFiles(files, lessons, taken = []) {
    const takenIds = new Set(Array.from(taken));
    const proposals = new Map(); // fileId -> { lessonId, tier, reason }
    const unmatched = new Map(); // fileId -> reason

    for (const file of files) {
      const byTier = candidatesFor(file.name, lessons);
      const tier = TIERS.find((t) => byTier[t].length > 0);
      if (!tier) {
        unmatched.set(file.id, 'no lesson code, title or number in the filename');
        continue;
      }
      const candidates = byTier[tier];
      if (candidates.length > 1) {
        const which = candidates.map((l) => l.lessonCode).join(', ');
        unmatched.set(file.id, `matches ${candidates.length} lessons (${which})`);
        continue;
      }
      const lesson = candidates[0];
      if (takenIds.has(lesson.id)) {
        unmatched.set(file.id, `${lesson.lessonCode} already has a file waiting`);
        continue;
      }
      proposals.set(file.id, { lessonId: lesson.id, tier, reason: describe(tier, lesson) });
    }

    // Two files pointing at one lesson is the same failure as one file pointing
    // at two lessons, and gets the same answer: neither is placed. Picking the
    // first would make the result depend on the order the file picker happened
    // to hand them over.
    const byLesson = new Map();
    for (const [fileId, proposal] of proposals) {
      if (!byLesson.has(proposal.lessonId)) byLesson.set(proposal.lessonId, []);
      byLesson.get(proposal.lessonId).push(fileId);
    }
    for (const [lessonId, fileIds] of byLesson) {
      if (fileIds.length === 1) continue;
      const lesson = lessons.find((l) => l.id === lessonId);
      const code = lesson ? lesson.lessonCode : lessonId;
      for (const fileId of fileIds) {
        proposals.delete(fileId);
        unmatched.set(fileId, `${fileIds.length} files match ${code}`);
      }
    }

    const matches = [];
    for (const file of files) {
      const proposal = proposals.get(file.id);
      if (proposal) matches.push({ fileId: file.id, ...proposal });
    }
    return {
      matches,
      unmatched: files.filter((f) => !proposals.has(f.id)).map((f) => ({
        fileId: f.id,
        reason: unmatched.get(f.id) || 'no match',
      })),
    };
  }

  // Shared by the bulk screen and the single-Lesson panel it grew out of.
  function formatBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  return {
    TIERS,
    stripExtension,
    normalize,
    tokens,
    numbersIn,
    lessonNumber,
    containsPhrase,
    candidatesFor,
    matchFiles,
    formatBytes,
  };
})();

// Node (tests) reads this via vm.runInThisContext, the same as the other
// *-core.js files; the browser gets the global above. No module system, no
// build step (CLAUDE.md §0).
