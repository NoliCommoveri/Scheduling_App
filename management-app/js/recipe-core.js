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
        split.chunks.forEach((chunk, idx) => {
          const n = idx + 1;
          const pattern = resolvePattern(entry.activityTypeKey, count, ctx.titlePatterns);
          rows.push({
            activityTypeKey: entry.activityTypeKey,
            title: renderTitle(pattern, {
              lesson: ctx.lessonTitle, n, type: type.label, start: chunk.start, end: chunk.end,
            }),
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
  };
})();
