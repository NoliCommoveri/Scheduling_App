/* Module: pacing-core.js — derives a starting Pacing Profile from a Course's
 * `defaultPacingHint`. Pure and DOM-free, no Storage access, so it can be
 * exercised directly (the same split `recipe-core.js`, `worker/validation.js`
 * and the Child App's *-core.js files already use). `pacing.js` is the only
 * caller; it remains the sole writer of `pacingProfiles`.
 *
 * The hint is a free-text field (Mgmt SRS 03 §4) that until now nothing read.
 * Its documented form is one or more labelled clauses:
 *
 *     Activities Per Day - 2
 *     Minutes Per Day - 60; Days - Mon/Wed/Fri
 *
 * Looser phrasings already typed into the field ("45 min a day", "3 lessons
 * per day, Mon-Thu") are recognised too. Anything the hint does not say falls
 * back to the defaults below — the result is a starting point the parent edits
 * in Pacing Configuration, never a commitment.
 */

const PacingCore = (() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Fallbacks for whatever the hint does not say. Mon–Fri is the school week;
  // one Activity a day is the conservative budget — under-pacing shows up as a
  // thin packet at Review, over-pacing shows up as an overwhelmed child.
  const DEFAULT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const DEFAULT_ACTIVITIES_PER_DAY = 1;

  // Sanity bounds. A value outside them is treated as unparsed (fall back)
  // rather than written — `saveProfile`'s validation would take it, but a
  // 90000-minute day is a typo, not an instruction.
  const MAX_MINUTES_PER_DAY = 1440;
  const MAX_ACTIVITIES_PER_DAY = 50;

  // Registrar convention, used for compact and slash-separated day tokens
  // ("MWF", "M/W/F", "TR"): R is Thursday, U is Sunday, so nothing is
  // ambiguous. Only applied to tokens that are uppercase in the source.
  const LETTER_DAYS = { M: 'Mon', T: 'Tue', W: 'Wed', R: 'Thu', F: 'Fri', S: 'Sat', U: 'Sun' };

  const NAMED_DAYS = {
    sunday: 'Sun', sun: 'Sun',
    monday: 'Mon', mon: 'Mon',
    tuesday: 'Tue', tues: 'Tue', tue: 'Tue',
    wednesday: 'Wed', weds: 'Wed', wed: 'Wed',
    thursday: 'Thu', thurs: 'Thu', thur: 'Thu', thu: 'Thu',
    friday: 'Fri', fri: 'Fri',
    saturday: 'Sat', sat: 'Sat',
  };
  // Longest-first so "tuesday" is not consumed as "tue".
  const NAMED_DAY_PATTERN =
    /\b(sunday|saturday|thursday|wednesday|tuesday|monday|friday|thurs|weds|tues|thur|sun|mon|tue|wed|thu|fri|sat)\b/g;

  const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };

  // Label keywords, used both to split a single-line hint into clauses and to
  // read the labelled form. `[-–—:=]` covers the dash the documented form uses
  // plus the colon/equals a parent may reach for instead — and its absence,
  // since "Minutes Per Day 45" is the same instruction.
  const DELIM = '\\s*[-\u2013\u2014:=]?\\s*';
  const LABEL_BOUNDARY = /(minutes?\s*(?:per|a|each|\/)\s*day|activit(?:y|ies)\s*(?:per|a|each|\/)\s*day|days?\s*(?:of\s*week)?\s*[-\u2013\u2014:=])/gi;

  function numberFrom(raw) {
    if (raw == null) return null;
    const text = String(raw).trim().toLowerCase();
    if (/^\d+$/.test(text)) return Number(text);
    return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, text) ? NUMBER_WORDS[text] : null;
  }

  const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  // A label preceded by a value is the tail of a phrase, not a new clause.
  const VALUE_BEFORE = new RegExp(`(?:\\d|\\b(?:${Object.keys(NUMBER_WORDS).join('|')}))$`, 'i');

  // ---- Clause splitting -------------------------------------------------

  // A hint is one line, so `;` and newlines are the explicit separators. A
  // comma cannot be one — "Days - Mon, Wed, Fri" needs it — so a second
  // labelled clause is also treated as a boundary wherever it starts.
  function clausesOf(hint) {
    const text = String(hint || '');
    const marked = text.replace(LABEL_BOUNDARY, (match, _label, offset) => {
      // Only a *label* opens a clause. In "60 minutes per day" the same words
      // are the tail of a phrase whose value sits in front of them, and
      // splitting there would strand the number in its own clause.
      return VALUE_BEFORE.test(text.slice(0, offset).trimEnd()) ? match : `;${match}`;
    });
    return marked
      .split(/[;\n\r]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // "3 lessons per week" is not a per-day budget and must not be read as one.
  // `\bweek\b` does not match "weekdays" or "weekend", which stay readable.
  function isWeeklyClause(clause) {
    return /\bweeks?\b|\bweekly\b/i.test(clause);
  }

  // ---- Days -------------------------------------------------------------

  function expandRange(fromDay, toDay) {
    const start = DAYS.indexOf(fromDay);
    const end = DAYS.indexOf(toDay);
    const out = [];
    for (let i = 0; i < DAYS.length; i += 1) {
      const day = DAYS[(start + i) % DAYS.length];
      out.push(day);
      if (day === toDay) break;
    }
    return end === -1 ? [] : out;
  }

  function daysFromClause(clause) {
    const found = new Set();
    const lower = clause.toLowerCase();

    if (/\bevery\s*day\b|\bdaily\b|\ball\s*week\b|\b7\s*days\b|\bseven\s*days\b/.test(lower)) {
      DAYS.forEach((d) => found.add(d));
    }
    if (/\bweekdays?\b|\bschool\s*days?\b/.test(lower)) DEFAULT_DAYS.forEach((d) => found.add(d));
    if (/\bweekends?\b/.test(lower)) ['Sat', 'Sun'].forEach((d) => found.add(d));

    // Ranges first ("Mon-Fri", "Monday through Thursday"), then the loose scan
    // picks up anything they left behind.
    const rangePattern = new RegExp(
      `\\b(${Object.keys(NAMED_DAYS).join('|')})\\b\\s*(?:-|\u2013|\u2014|to|through|thru)\\s*\\b(${Object.keys(NAMED_DAYS).join('|')})\\b`,
      'g'
    );
    let range;
    while ((range = rangePattern.exec(lower)) !== null) {
      expandRange(NAMED_DAYS[range[1]], NAMED_DAYS[range[2]]).forEach((d) => found.add(d));
    }

    NAMED_DAY_PATTERN.lastIndex = 0;
    let named;
    while ((named = NAMED_DAY_PATTERN.exec(lower)) !== null) found.add(NAMED_DAYS[named[1]]);

    // Compact/slash letter tokens, only where no day name was spelled out —
    // "MWF", "M/W/F", "TR". Uppercase in the source is required so an ordinary
    // lowercase word can never be read as a day list.
    if (found.size === 0) {
      const tokens = clause
        .split(/[^A-Za-z]+/)
        .filter((t) => t && t.length <= 7 && t === t.toUpperCase() && /^[MTWRFSU]+$/.test(t));
      // A lone single letter is too weak to read as a day ("M" could be
      // anything); "M/W/F" is a list, and "MWF" carries its own structure.
      if (tokens.length > 1 || (tokens.length === 1 && tokens[0].length > 1)) {
        for (const token of tokens) for (const letter of token) found.add(LETTER_DAYS[letter]);
      }
    }

    return DAYS.filter((d) => found.has(d));
  }

  // ---- Budget -----------------------------------------------------------

  function minutesFromClause(clause) {
    const labelled = clause.match(new RegExp(`minutes?\\s*(?:per|a|each|\\/)\\s*day${DELIM}${NUM}`, 'i'));
    if (labelled) return { value: numberFrom(labelled[1]), text: labelled[0] };
    const valueFirst = clause.match(new RegExp(`${NUM}\\s*(?:minutes|minute|mins|min)\\b`, 'i'));
    if (valueFirst) return { value: numberFrom(valueFirst[1]), text: valueFirst[0] };
    return null;
  }

  function activitiesFromClause(clause) {
    const labelled = clause.match(
      new RegExp(`activit(?:y|ies)\\s*(?:per|a|each|\\/)\\s*day${DELIM}${NUM}`, 'i')
    );
    if (labelled) return numberFrom(labelled[1]);
    const counted = clause.match(
      new RegExp(`${NUM}\\s*(?:activities|activity|lessons|lesson|items|item|tasks|task|assignments|assignment)\\b`, 'i')
    );
    if (counted) return numberFrom(counted[1]);
    // Bare "2 per day" / "2/day", once the minutes reading has been ruled out.
    const bare = clause.match(new RegExp(`${NUM}\\s*(?:\\/|per|a|each)\\s*day\\b`, 'i'));
    if (bare) return numberFrom(bare[1]);
    return null;
  }

  // Both readings from one clause. The minutes phrase is lifted out before the
  // count is read, so "60 minutes per day" can never also satisfy the bare
  // "N per day" count pattern, while "3 lessons per day, about 30 minutes"
  // still yields both.
  function budgetFromClause(clause) {
    const minutes = minutesFromClause(clause);
    const rest = minutes ? clause.replace(minutes.text, ' ') : clause;
    return { minutes: minutes ? minutes.value : null, activities: activitiesFromClause(rest) };
  }

  function inRange(value, max) {
    return Number.isInteger(value) && value > 0 && value <= max;
  }

  // ---- Public -----------------------------------------------------------

  /* Reads a hint into whatever pacing fields it actually states. Returns only
   * what was found: `{ daysOfWeek?, pacingMode?, activitiesPerDay?,
   * minutesPerDay? }`. Never throws, never guesses a mode it did not see. */
  function parseHint(hint) {
    const out = {};
    const days = new Set();
    let minutes = null;
    let activities = null;

    for (const clause of clausesOf(hint)) {
      daysFromClause(clause).forEach((d) => days.add(d));
      if (isWeeklyClause(clause)) continue;
      const budget = budgetFromClause(clause);
      if (minutes === null && inRange(budget.minutes, MAX_MINUTES_PER_DAY)) minutes = budget.minutes;
      if (activities === null && inRange(budget.activities, MAX_ACTIVITIES_PER_DAY)) {
        activities = budget.activities;
      }
    }

    if (days.size) out.daysOfWeek = DAYS.filter((d) => days.has(d));
    // A hint naming both ("3 lessons per day, about 30 minutes") is stating a
    // count with commentary attached — the count is the instruction.
    if (activities !== null) {
      out.pacingMode = 'activityCount';
      out.activitiesPerDay = activities;
    } else if (minutes !== null) {
      out.pacingMode = 'minutesBudget';
      out.minutesPerDay = minutes;
    }
    return out;
  }

  /* The complete field set for a starting Profile: whatever the hint stated,
   * with the defaults above filling the rest. `startDate` is the caller's (the
   * day the Course was stamped) — the hint never carries one.
   * Returns `{ fields, source: { days, budget } }`, each source `'hint'` or
   * `'default'`, so the caller can tell the parent where the values came from. */
  function defaultProfileFields(hint, startDate) {
    const parsed = parseHint(hint);
    const fields = { startDate };
    const source = { days: 'default', budget: 'default' };

    if (parsed.daysOfWeek && parsed.daysOfWeek.length) {
      fields.daysOfWeek = parsed.daysOfWeek;
      source.days = 'hint';
    } else {
      fields.daysOfWeek = DEFAULT_DAYS.slice();
    }

    if (parsed.pacingMode === 'minutesBudget') {
      fields.pacingMode = 'minutesBudget';
      fields.minutesPerDay = parsed.minutesPerDay;
      source.budget = 'hint';
    } else if (parsed.pacingMode === 'activityCount') {
      fields.pacingMode = 'activityCount';
      fields.activitiesPerDay = parsed.activitiesPerDay;
      source.budget = 'hint';
    } else {
      fields.pacingMode = 'activityCount';
      fields.activitiesPerDay = DEFAULT_ACTIVITIES_PER_DAY;
    }

    return { fields, source };
  }

  /* One-line, parent-facing summary of a field set — "Mon/Wed/Fri · 2
   * activities/day". Used in the stamp confirmation. */
  function describe(fields) {
    const days = (fields.daysOfWeek || []).join('/');
    const budget =
      fields.pacingMode === 'minutesBudget'
        ? `${fields.minutesPerDay} min/day`
        : `${fields.activitiesPerDay} ${fields.activitiesPerDay === 1 ? 'activity' : 'activities'}/day`;
    return `${days} · ${budget}`;
  }

  return {
    DAYS,
    DEFAULT_DAYS,
    DEFAULT_ACTIVITIES_PER_DAY,
    parseHint,
    defaultProfileFields,
    describe,
  };
})();
