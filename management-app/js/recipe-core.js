/* Module: recipe-core.js — Lesson Recipe title-pattern engine.
 * Per TDS_Slice_Lesson_Recipe.md §5.6/§5.6.1. Pure and DOM-free, so it can be
 * exercised directly (same split worker/validation.js and the Child App's
 * *-core.js files already use) — courses.js is the only caller.
 */

const RecipeCore = (() => {
  const TOKENS = ['lesson', 'n', 'type', 'start', 'end'];
  const TOKEN_PATTERN = /\{([a-zA-Z]+)\}/g;

  // Built-in defaults (§5.6). Every type but video is a fixed string; video's
  // count-1 collapse ("Part 1" of a single part says nothing) makes it a
  // function of count instead.
  const DEFAULT_PATTERNS = {
    quiz: 'Assessment {n}',
    test: '{type} {n}',
    project: '{type} {n}',
    report: '{type} {n}',
    drill: '{type} {n}',
    'online-sim': '{lesson}',
    'practice-level': 'Level {n}',
    workbook: 'Pages {start}–{end}',
    pdf: 'Pages {start}–{end}',
    'reading-pages': 'Pages {start}–{end}',
  };

  function builtInPattern(typeKey, count) {
    if (typeKey === 'video') return count === 1 ? '{lesson}' : '{lesson}: Part {n}';
    return DEFAULT_PATTERNS[typeKey] || '{type} {n}';
  }

  // §5.6.1: overriding a type takes ownership of it at every count — the
  // count-1 collapse is a property of the *default*, not a per-course toggle.
  function resolvePattern(typeKey, count, titlePatterns) {
    if (titlePatterns && typeof titlePatterns[typeKey] === 'string') return titlePatterns[typeKey];
    return builtInPattern(typeKey, count);
  }

  function renderTitle(pattern, ctx) {
    return pattern.replace(TOKEN_PATTERN, (whole, name) => {
      if (ctx[name] === undefined || ctx[name] === null) return whole;
      return String(ctx[name]);
    });
  }

  function validatePatternString(pattern, structurePattern) {
    TOKEN_PATTERN.lastIndex = 0;
    let match;
    while ((match = TOKEN_PATTERN.exec(pattern))) {
      const name = match[1];
      if (!TOKENS.includes(name)) return { error: `Unknown token "{${name}}".` };
      if ((name === 'start' || name === 'end') && structurePattern !== 'page-range') {
        return { error: `"{${name}}" is only valid on page-range Activity Types.` };
      }
    }
    return { ok: true };
  }

  // §5.6.1 "Validation, at save". `raw` is a plain { activityTypeKey: string }
  // map off the form. Blank values are dropped — blank means absent, never an
  // empty string on the record. Returns { error } or { titlePatterns }, where
  // titlePatterns is undefined when every entry was blank (buildCourseRecord's
  // `if (fields.x) record.x = x` convention).
  function sanitizeTitlePatterns(raw, activityTypesByKey) {
    const out = {};
    for (const key of Object.keys(raw || {})) {
      const value = (raw[key] || '').trim();
      if (!value) continue;
      const type = activityTypesByKey.get(key);
      if (!type) return { error: `Unknown Activity Type "${key}".` };
      const result = validatePatternString(value, type.structurePattern);
      if (result.error) return { error: `${type.label}: ${result.error}` };
      out[key] = value;
    }
    return { titlePatterns: Object.keys(out).length ? out : undefined };
  }

  // §5.3 — split rule. `numbers` are the split points the parent typed;
  // `mode` is 'first' (each number is the first page of its chunk) or 'last'
  // (each number is the last page). Ascending/no-duplicates is a hard error —
  // the chunk formulas are undefined otherwise. Being outside the Lesson's
  // budget, or leaving a gap at either edge, only warns: "the budget has
  // always been a suggestion" (§5.3).
  function computeSplitChunks({ numbers, mode, budgetStart, budgetEnd }) {
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return { error: 'At least one split number is required.' };
    }
    if (mode !== 'first' && mode !== 'last') {
      return { error: 'Split mode must be "first" or "last".' };
    }
    for (const n of numbers) {
      if (!Number.isInteger(n)) return { error: 'Split numbers must be whole numbers.' };
    }
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] <= numbers[i - 1]) {
        return { error: 'Split numbers must be strictly increasing, with no duplicates.' };
      }
    }

    const warnings = [];
    for (const n of numbers) {
      if (n < budgetStart || n > budgetEnd) {
        warnings.push(`Split point ${n} falls outside the Lesson's page budget [${budgetStart}, ${budgetEnd}].`);
      }
    }

    const chunks = [];
    if (mode === 'first') {
      for (let i = 0; i < numbers.length; i++) {
        chunks.push({
          start: numbers[i],
          end: i + 1 < numbers.length ? numbers[i + 1] - 1 : budgetEnd,
        });
      }
      if (numbers[0] > budgetStart) {
        warnings.push(`Front gap: pages ${budgetStart}–${numbers[0] - 1} are not covered by any chunk.`);
      }
    } else {
      for (let i = 0; i < numbers.length; i++) {
        chunks.push({
          start: i === 0 ? budgetStart : numbers[i - 1] + 1,
          end: numbers[i],
        });
      }
      const last = numbers[numbers.length - 1];
      if (last < budgetEnd) {
        warnings.push(`Back gap: pages ${last + 1}–${budgetEnd} are not covered by any chunk.`);
      }
    }
    return { chunks, warnings };
  }

  // §5.2/§5.5/§6.1 — Stage 1 recipe -> Stage 2 proposal rows, with titles
  // pre-filled from §5.6's pattern resolution. `recipe.entries` is the order
  // the parent added types in (§5.5: "each type's instances consecutive");
  // at most one entry may carry `pageRange` (D11 — enforced here too, not
  // just by the Stage 1 UI's single slot, so a malformed caller is still
  // caught "before the transaction opens", per acceptance check 10).
  // A zero-count entry drops silently (§6.1). Rows carry no `order` yet —
  // Stage 2 reordering happens on this array directly, order is assigned by
  // finalizeProposal once the parent is done reordering.
  function buildProposalRows(recipe, ctx) {
    const entries = (recipe && recipe.entries) || [];
    if (entries.filter((e) => e.pageRange).length > 1) {
      return { error: 'At most one page-range Activity Type per Lesson (D11).' };
    }

    const rows = [];
    const warnings = [];

    for (const entry of entries) {
      const type = ctx.activityTypesByKey.get(entry.activityTypeKey);
      if (!type) return { error: `Unknown Activity Type "${entry.activityTypeKey}".` };

      if (entry.pageRange) {
        if (type.structurePattern !== 'page-range') {
          return { error: `${type.label} is not a page-range Activity Type.` };
        }
        if (!Number.isInteger(ctx.budgetStart) || !Number.isInteger(ctx.budgetEnd)) {
          return { error: 'The Lesson has no page-range budget set.' };
        }
        const split = computeSplitChunks({
          numbers: entry.pageRange.numbers,
          mode: entry.pageRange.mode,
          budgetStart: ctx.budgetStart,
          budgetEnd: ctx.budgetEnd,
        });
        if (split.error) return { error: split.error };
        warnings.push(...split.warnings);

        const count = split.chunks.length;
        // §5.4 — a copy-from-lesson seed's hand-typed chunk titles apply only
        // when the new split produces the same chunk count; otherwise there is
        // no positional correspondence to carry, so it falls back to the
        // pattern default like any other page-range chunk.
        const titleOverrides = entry.pageRange.titleOverrides;
        const useOverrides = Array.isArray(titleOverrides) && titleOverrides.length === count;
        split.chunks.forEach((chunk, idx) => {
          const n = idx + 1;
          const pattern = resolvePattern(entry.activityTypeKey, count, ctx.titlePatterns);
          rows.push({
            activityTypeKey: entry.activityTypeKey,
            title: useOverrides
              ? titleOverrides[idx]
              : renderTitle(pattern, { lesson: ctx.lessonTitle, n, type: type.label, start: chunk.start, end: chunk.end }),
            pageRangeStart: chunk.start,
            pageRangeEnd: chunk.end,
          });
        });
      } else {
        const count = entry.count;
        if (!Number.isInteger(count) || count < 0) {
          return { error: `${type.label}: count must be a non-negative whole number.` };
        }
        for (let i = 0; i < count; i++) {
          const n = i + 1;
          const pattern = resolvePattern(entry.activityTypeKey, count, ctx.titlePatterns);
          rows.push({
            activityTypeKey: entry.activityTypeKey,
            title: renderTitle(pattern, { lesson: ctx.lessonTitle, n, type: type.label }),
          });
        }
      }
    }

    if (rows.length === 0) return { error: 'The recipe generates no Activities.' };
    return { rows, warnings };
  }

  // §6.2 step 2 — the reordered Stage 2 proposal, immediately before the
  // write. Assigns contiguous `order` 0..N-1 in the array's current order
  // (the caller has already applied any Stage 2 reordering) and catches a
  // title blanked out by an inline Stage 2 edit — the one thing Stage 2 can
  // still break after buildProposalRows pre-filled every title.
  function finalizeProposal(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { error: 'The recipe generates no Activities.' };
    }
    for (const row of rows) {
      if (!row.title || !String(row.title).trim()) {
        return { error: 'Every generated Activity must have a non-empty title.' };
      }
    }
    return { rows: rows.map((row, i) => ({ ...row, title: String(row.title).trim(), order: i })) };
  }

  // §5.4 — turn another Lesson's already-committed Activities into a Stage 1
  // seed. `sourceActivities` must already be sorted by `order` — that order
  // is "the point" (§5.4), carried through as the entries' add-order (§5.5).
  // Copies types, counts, and the page-range type's chunk titles (D9 —
  // hand-typed, no derivable pattern). Never copies page ranges or split
  // numbers — the target Lesson has its own budget — and never copies a
  // pattern-driven title, since buildProposalRows regenerates those fresh
  // against the target Lesson's own title.
  function buildCopyFromLessonSeed(sourceActivities) {
    const order = [];
    const counts = new Map();
    let pageRangeTypeKey = null;
    const pageRangeTitles = [];
    for (const a of sourceActivities || []) {
      if (!counts.has(a.activityType)) {
        counts.set(a.activityType, 0);
        order.push(a.activityType);
      }
      counts.set(a.activityType, counts.get(a.activityType) + 1);
      if (a.pageRangeStart !== undefined && a.pageRangeStart !== null) {
        pageRangeTypeKey = a.activityType;
        pageRangeTitles.push(a.title);
      }
    }
    const entries = order.map((key) =>
      key === pageRangeTypeKey ? { activityTypeKey: key, pageRange: true } : { activityTypeKey: key, count: counts.get(key) },
    );
    return { entries, pageRangeTypeKey, pageRangeTitles };
  }

  // FR-P2's opening row set. A Lesson's count targets should not start from a
  // blank slate when the Course and its Curriculum have already said which
  // types this material uses: a Course-level `titlePatterns` key is an
  // explicit statement ("this Course generates Practice levels"), and the
  // Curriculum's `suggestedActivityTypes[]` is the publisher-level equivalent
  // — soft, never a whitelist (Module 01 FR-3), which is exactly what a
  // pre-filled row is. Union, walked in the `activityTypes` table's own
  // display order so the row order is stable and independent of which source
  // named a type first.
  function suggestedTargetTypeKeys({ titlePatterns, suggestedActivityTypes, activityTypes }) {
    const named = new Set([...Object.keys(titlePatterns || {}), ...(suggestedActivityTypes || [])]);
    return (activityTypes || []).map((t) => t.activityTypeKey).filter((key) => named.has(key));
  }

  // First page of each of `chunks` even chunks of [start, end] — the split
  // points a page-range count target implies. Returns [] when there is no
  // budget to divide, or it cannot hold one page per chunk; the caller still
  // pre-selects the type and lets the parent type the split themselves.
  function evenSplitStarts(start, end, chunks) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    const pages = end - start + 1;
    if (!Number.isInteger(chunks) || chunks < 1 || pages < chunks) return [];
    const out = [];
    for (let i = 0; i < chunks; i++) out.push(start + Math.floor((i * pages) / chunks));
    return out;
  }

  // §5.2 — the Lesson's own content plan as the recipe's opening position.
  // `activityCountTargets[]` (FR-P2) already carries the types and the counts;
  // re-typing them into Stage 1 is the same data entered twice. A count-
  // structured target seeds a count row verbatim; a page-range-structured one
  // seeds the single page-range slot (D11) with its splits spread evenly over
  // the Lesson's budget. Every seeded value stays editable, and the target
  // itself is unchanged — FR-P4 keeps it display-only, so this pre-fills the
  // form without the target ever becoming a constraint.
  function buildCountTargetSeed(targets, ctx) {
    const countRows = [];
    let pageRangeTypeKey = null;
    let splitNumbers = [];
    for (const target of targets || []) {
      const type = ctx.activityTypesByKey.get(target.activityTypeKey);
      if (!type) continue; // a target naming a since-deleted type seeds nothing
      const count = Number(target.targetCount);
      if (!Number.isInteger(count) || count < 1) continue; // a 0 target generates nothing
      if (type.structurePattern === 'page-range') {
        if (pageRangeTypeKey) continue; // D11 — one page-range type; the first target wins
        pageRangeTypeKey = target.activityTypeKey;
        splitNumbers = evenSplitStarts(ctx.budgetStart, ctx.budgetEnd, count);
      } else {
        countRows.push({ activityTypeKey: target.activityTypeKey, count });
      }
    }
    return { countRows, pageRangeTypeKey, splitNumbers, splitMode: 'first' };
  }

  // §5.7 — the fields "Copy settings from" pre-fills on the Course create
  // form. Configuration only, never Lessons/Activities/id/state — a form
  // pre-fill the parent can still edit before saving, not a link to the
  // source (editing the source afterward changes nothing on the copy).
  function pickCourseSettingsToCopy(course) {
    const out = {};
    for (const key of ['subject', 'coreElective', 'description', 'defaultPacingHint', 'curriculumId', 'titlePatterns', 'gradingRubric', 'gradingModel']) {
      if (course[key] !== undefined) out[key] = course[key];
    }
    return out;
  }

  return {
    TOKENS,
    builtInPattern,
    resolvePattern,
    renderTitle,
    validatePatternString,
    sanitizeTitlePatterns,
    computeSplitChunks,
    buildProposalRows,
    finalizeProposal,
    buildCopyFromLessonSeed,
    suggestedTargetTypeKeys,
    evenSplitStarts,
    buildCountTargetSeed,
    pickCourseSettingsToCopy,
  };
})();
