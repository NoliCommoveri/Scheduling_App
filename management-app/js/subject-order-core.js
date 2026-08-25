/* Module: subject-order-core.js — the household's standing subject order, and
 * the one comparator every subject-grouped view sorts with.
 * Per SRS_Management_Module_11_Settings_Backup.md FR-9,
 * SRS_Management_Module_08_Packet_Generation_Export.md FR-17, and
 * docs/TDS_Slice_Subject_Order_Grouped_Review.md §1.
 *
 * Pure and DOM-free, no Storage access, so it can be exercised directly — the
 * same split `pacing-core.js`, `recipe-core.js`, `course-durations-core.js`,
 * `answer-keys-core.js`, `worker/validation.js` and the Child App's *-core.js
 * files already use.
 *
 * WHY IT EXISTS. Five views group Courses by subject and all five sorted those
 * groups alphabetically, which is an order nobody chose: a household that does
 * Bible first and History last reads its own day backwards on every screen.
 * The order is a property of the household, not of any one screen, so it lives
 * as one record (`meta['subjectOrder']`, §1.1) and every consumer resolves it
 * through `compare` here rather than deciding for itself.
 *
 * WHAT IT IS NOT. It is not a subject *entity* (§7.6). `subject` stays free
 * text on the Course record, this file writes nothing, and the stored order is
 * only ever consulted as a rank — never as a display source, so a casing
 * difference between the list and the Course cannot rename anything.
 */

const SubjectOrderCore = (() => {
  // The label a blank/absent subject renders under, and the one label that is
  // never a real subject. Matches the string courses.js, instances.js and
  // weekly.js already use, so adopting this comparator changes no display text.
  const NO_SUBJECT = 'No subject';

  function label(subject) {
    const text = subject == null ? '' : String(subject).trim();
    return text === '' ? NO_SUBJECT : text;
  }

  // Matching is deliberately forgiving and deliberately shallow (§1.2):
  // "math", "Math" and " Math " are one subject; "Maths" is a different one.
  function key(subject) {
    return String(subject == null ? '' : subject).trim().toLowerCase();
  }

  // The stored array, cleaned: trimmed, blanks dropped, duplicates collapsed
  // case-insensitively with the first spelling winning, and NO_SUBJECT removed
  // — it is a display fallback, not a subject, and it sorts last by rule
  // rather than by position (see `compare`).
  function normalize(order) {
    const seen = new Set();
    const out = [];
    (Array.isArray(order) ? order : []).forEach((entry) => {
      const k = key(entry);
      if (k === '' || k === key(NO_SUBJECT) || seen.has(k)) return;
      seen.add(k);
      out.push(String(entry).trim());
    });
    return out;
  }

  function rank(order) {
    const map = new Map();
    normalize(order).forEach((subject, i) => map.set(key(subject), i));
    return map;
  }

  // The whole contract, and the only thing a consumer needs: listed before
  // unlisted, stored index within the listed, alphabetical within the unlisted,
  // NO_SUBJECT last always. Takes *labels* — what a view already has in hand —
  // not Course records.
  //
  // Unlisted-sorts-after-listed is what lets a brand-new subject appear on every
  // screen immediately, at the bottom, without a visit to Settings first. An
  // empty or absent order therefore falls all the way through to alphabetical
  // with NO_SUBJECT trailing: exactly what these views did before this file.
  function compare(order) {
    const ranks = rank(order);
    return (a, b) => {
      const la = label(a);
      const lb = label(b);
      if (la === lb) return 0;
      if (la === NO_SUBJECT) return 1;
      if (lb === NO_SUBJECT) return -1;
      const ra = ranks.has(key(la)) ? ranks.get(key(la)) : Infinity;
      const rb = ranks.has(key(lb)) ? ranks.get(key(lb)) : Infinity;
      if (ra !== rb) return ra - rb;
      return la.localeCompare(lb);
    };
  }

  // Sorts a copy. A view that has gathered its groups already owns that array
  // and should not have it reordered underneath it.
  function sortSubjects(list, order) {
    return (list || []).slice().sort(compare(order));
  }

  // The editor's effective list (§1.3): stored entries first, in their stored
  // positions, then every subject in use on a Course that the stored list does
  // not mention, alphabetically and flagged so the UI can mark them.
  //
  // `inUse` is raw subject text off Course records — blanks and NO_SUBJECT are
  // dropped, because "no subject" is not something a parent can rank.
  function merge(stored, inUse) {
    const order = normalize(stored);
    const listedKeys = new Set(order.map(key));
    const usedKeys = new Set();

    const unlisted = [];
    (inUse || []).forEach((raw) => {
      const k = key(raw);
      if (k === '' || k === key(NO_SUBJECT)) return;
      usedKeys.add(k);
      if (listedKeys.has(k) || unlisted.some((s) => key(s) === k)) return;
      unlisted.push(String(raw).trim());
    });
    unlisted.sort((a, b) => a.localeCompare(b));

    // `inUse: false` on a stored entry is what the Remove button keys off; it
    // is never an error, only clutter (§1.3).
    return [
      ...order.map((subject) => ({ subject, listed: true, inUse: usedKeys.has(key(subject)) })),
      ...unlisted.map((subject) => ({ subject, listed: false, inUse: true })),
    ];
  }

  // Stored entries no Course uses any more. They match nothing and cost
  // nothing; the editor offers to remove them so the list stays readable.
  function unused(stored, inUse) {
    return merge(stored, inUse).filter((row) => row.listed && !row.inUse).map((row) => row.subject);
  }

  // Moves the entry at `index` one step toward the front (-1) or back (+1),
  // returning a new array. Out-of-range moves are no-ops rather than errors:
  // the ↑ on the first row and the ↓ on the last are disabled in the UI, and a
  // comparator that threw on a double-click would be worse than one that did
  // nothing.
  function move(order, index, delta) {
    const out = normalize(order);
    const to = index + delta;
    if (index < 0 || index >= out.length || to < 0 || to >= out.length) return out;
    const [entry] = out.splice(index, 1);
    out.splice(to, 0, entry);
    return out;
  }

  return { NO_SUBJECT, label, key, normalize, rank, compare, sortSubjects, merge, unused, move };
})();

// Node (tests) reads this via vm.runInThisContext, the same as the other
// *-core.js files; the browser gets the global above. No module system, no
// build step (CLAUDE.md §0).
