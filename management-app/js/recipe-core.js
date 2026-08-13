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

  return {
    TOKENS,
    builtInPattern,
    resolvePattern,
    renderTitle,
    validatePatternString,
    sanitizeTitlePatterns,
  };
})();
