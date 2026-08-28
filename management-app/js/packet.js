/* Module: packet.js — Module 08, Generation & Assignment.
 * Per SRS_Management_Module_08_Packet_Generation_Export.md (reconciled by
 * TDS_Slice_M7_Management_App_Rev1.md §4 — cursor retired; Propose/Review/
 * Commit; Generation Log is the source of truth).
 *
 * Sole writer of `generationLog` anywhere in the system. Also sets
 * `excludeFromGeneration` on `activities` at Commit. Reads pacingProfiles/
 * courses/lessons/activities/activityTypes/tiers/chores/familyEvents.
 * Three stages held in one in-memory session; ONLY Commit writes.
 *
 * ROLE CHANGED 2026-08-11 — Online Revamp Phase 3 (TDS_Slice_Online_Revamp.md
 * §6.1, §12). This file was "THE SEAM": Commit's final act was serializing a
 * packet and triggering a download, and that file was the only way work ever
 * reached a child. Now Commit mints a batchId and POSTs assignment rows to
 * D1 (§5.2), which is the system of record. Propose and Review are untouched
 * — §6.1 is explicit that only Commit's final act changes.
 *
 * EXPORT REMOVED 2026-08-11 — Phase 5 (§11). The packet file was kept beside
 * the D1 rows only until the Child App read /api/plan; it has since Phase 3B,
 * so the file had no reader. Gone with it: buildPacket and the packet-shaped
 * projections, and validatePacket — a validator for a document nobody writes
 * any more, and the last place in the app that still asserted the repealed
 * CHR-{token}-{date} and EVT- id patterns. It never guarded the D1 path: it
 * validated `packet`, not the rows projectAssignments builds. The Worker's
 * column-ownership check (§4.2) is what stands behind those.
 *
 * The name stays `packet.js`, and Generation Log rows still key on the
 * per-occurrence chore id. That is local scheduling history, not interchange.
 *
 * DUPLICATE FIX 2026-08-12 — §6.6. Module 08 FR-10 promises that re-running a
 * covered range never double-assigns, and the packet made that true for free:
 * the file was regenerated identically and the child replaced its plan on
 * import. Phase 3 swapped the transport for insert-only D1 rows and nothing
 * replaced the guarantee, so proposing the same fortnight twice put every chore
 * in it on the plan twice. commit_chunks (§3.8) never covered this — it keys on
 * (batchId, chunkIndex), and a second Propose mints a second batchId.
 * Already-live items are now detected at Propose, shown but frozen, and left
 * out of Commit; the Worker enforces the same rule on the natural key.
 */

const Packet = (() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DEFAULT_MINUTES = 15; // Module 05 §2.3 fallback for missing expectedDurationMin

  let session = null; // the in-memory proposal; null between runs
  let lastResult = null; // {ok, message} | {error} for the result banner

  // ---- Generation scope (Module 08 FR-1a) ----
  //
  // FR-1 made the generation unit "one child, one range". A fortnight of one
  // child's school walk, chores and events arrives as several hundred rows on
  // one screen, and reviewing it is one long sitting that cannot be broken up:
  // the proposal lives in memory and Abandon is the only way to put it down.
  // The unit is now "one child, one range, one or more **kinds**", so School and
  // Chores can be proposed, reviewed and committed on separate passes.
  //
  // This is a filter on what Propose *places*, and nothing else. Every step it
  // gates was already independent of the others — the school walk reads pacing
  // profiles, the chore expansion reads chore recurrence, events read overlap —
  // so a narrowed run is the same code walking a subset, never a different
  // algorithm. What makes the passes safe to run separately is machinery that
  // already exists: §6.6 marks anything a previous pass made live as
  // `committed`, shows it frozen, and leaves it out of Commit. So the second
  // pass over the same range sees the first pass's work and declines to re-send
  // it, exactly as a re-Propose of the same range always has.
  const KINDS = ['school', 'chores', 'events'];
  const KIND_LABEL = { school: 'School', chores: 'Chores', events: 'Family events' };

  // Remembered between runs so proposing chores-only for one child and then the
  // next does not mean re-unchecking School each time. Session-lifetime only —
  // nothing about generation scope is persisted, because it is a property of
  // how the parent chose to work today, not of the child or the range.
  let lastInclude = { school: true, chores: true, events: true };

  function normalizeInclude(include) {
    // Absent means everything, which is what every call site before FR-1a
    // meant. A run must place something.
    if (!include) return { school: true, chores: true, events: true };
    const out = {};
    for (const k of KINDS) out[k] = !!include[k];
    return out;
  }

  function includedKinds(include) {
    return KINDS.filter((k) => include[k]);
  }

  // "School and Chores" / "Chores only" / "everything" — used in the proposal
  // header and in Commit's empty-source messages, where the scope is the
  // difference between "there is nothing here" and "there is nothing here
  // *that you asked for*".
  function scopeLabel(include) {
    const on = includedKinds(include);
    if (on.length === KINDS.length) return 'School, chores and events';
    return on.map((k) => KIND_LABEL[k]).join(' and ') + ' only';
  }

  // ---- date helpers (calendar dates as strings — no timezone, ever) ----

  function isValidDate(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return false;
    const [y, m, d] = str.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function weekday(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return DAYS[new Date(y, m - 1, d).getDay()];
  }

  function fmt(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function eachDate(from, to) {
    const out = [];
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const cur = new Date(fy, fm - 1, fd);
    const end = new Date(ty, tm - 1, td);
    while (cur <= end) {
      out.push(fmt(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // ---- Already-assigned detection (Revamp §6.6) ----
  //
  // Propose reproduces prior 'sent' decisions so the parent sees the whole
  // range (§4.2.2), and under the packet model re-committing one cost nothing:
  // the packet was regenerated byte-identical and the child *replaced* its plan
  // on import (M7 acceptance check 9). D1 is insert-only, so the identical act
  // now mints a second row — propose the same fortnight twice and Tuesday's
  // "Empty the dishwasher" is on the plan twice.
  //
  // An item already live in D1 is therefore not proposal content any more. It is
  // shown, it counts against the day's pacing budget, and it is neither re-sent
  // nor editable here: §6.5 puts moving and editing a live row in the
  // Assignments view, where it is a PATCH of the row that exists rather than a
  // second copy of it.

  // Matches the Worker's natural key (worker/index.js `naturalKey`). Both ends
  // have to agree on what "the same thing on the same day" means, so if one
  // changes the other has to move with it.
  function keyOf(date, kind, sourceId, instanceKey) {
    return `${date} ${kind} ${sourceId} ${instanceKey}`;
  }

  // Every projection sends the underlying record's id as `sourceId`, chores
  // included — the per-occurrence CHR-{token}-{date} key stayed behind in the
  // Generation Log when §3.3.1 repealed derived ids.
  function sourceIdOf(item) {
    return item.record.id;
  }

  // The natural key of a prior decision, from its Generation Log row — the same
  // key `loadCommittedKeys` builds from a D1 row, so the two can be compared.
  // Used twice: by the log fallback below, and by Step 2 to recognise a
  // decision the parent has since pulled back (Rescind_Regeneration §2.3).
  // CHR-{token}-{YYYYMMDD}[-{instanceId}] (§2.4) — the fourth segment, when
  // present, recovers the chore-occurrence instance.
  function keyOfLogRow(row, allChores) {
    if (row.instanceId) return keyOf(row.assignedDate, 'activity', row.itemId, '');
    const parts = row.itemId.split('-');
    const chore = allChores.find((c) => c.id === 'CHR-' + parts[1]);
    return chore ? keyOf(row.assignedDate, 'chore', chore.id, parts[3] || '') : null;
  }

  // D1 is asked first because it is the system of record and the only source
  // that knows about a **rescind**: pulling a batch back leaves its 'sent' log
  // rows behind, and those items must become assignable again. The Generation
  // Log is the fallback for a device with no token or no network — it is
  // conservative in the right direction (it can believe something is still
  // assigned after a rescind, never the reverse), and it cannot see events,
  // which are re-derived each Propose rather than logged. The Worker's own
  // check is what stands behind both readings; this one exists so the screen
  // tells the truth before the parent presses Commit.
  //
  // "Must become assignable again" was written here and never wired to
  // anything: this read answered one question (what is already live in the
  // range) and the walk went on trusting the log. `loadReassignableActivities`
  // below is the other half — TDS_Slice_Rescind_Regeneration.md §0.3.
  async function loadCommittedKeys(childId, from, to, logRows, allChores) {
    try {
      const { enabled } = await Sync.getConfig();
      if (enabled) {
        // `includeRescinded=1` (Rescind_Regeneration §5): the rescinded rows are
        // not live and must not join `keys`, but Step 2 needs to know they
        // exist — a prior decision the parent pulled back is a hole in the
        // range, and reproducing it would put it back on the day it was
        // pulled from and re-commit it there.
        const result = await Sync.api(
          `/api/assignments?childId=${encodeURIComponent(childId)}&from=${from}&to=${to}&includeRescinded=1`
        );
        const keys = new Set();
        const rescindedKeys = new Set();
        for (const row of (result && result.assignments) || []) {
          if (row.source_id == null) continue;
          const key = keyOf(row.date, row.kind, row.source_id, row.instance_key);
          if (row.rescinded_at != null) rescindedKeys.add(key);
          else keys.add(key);
        }
        return { keys, rescindedKeys, source: 'plan' };
      }
    } catch {
      // Unreachable or rejected — fall through to the log rather than fail a
      // Propose, which still writes nothing either way.
    }

    const keys = new Set();
    for (const row of logRows) {
      if (row.assignedDate < from || row.assignedDate > to) continue;
      if (row.disposition !== 'sent') continue;
      const key = keyOfLogRow(row, allChores);
      if (key) keys.add(key);
    }
    // Empty on purpose: the log cannot see a rescind at all (§2.4), so the
    // offline reading is "nothing was pulled back" — conservative in the same
    // direction as `keys` itself.
    return { keys, rescindedKeys: new Set(), source: 'log' };
  }

  // Which of this child's school activities were pulled back and never
  // re-assigned (Rescind_Regeneration §2.1, §4). Returns null — not an empty
  // Set — when the answer is unknown, so a caller cannot mistake "D1 says
  // nothing came back" for "D1 was not asked". `source` is
  // `loadCommittedKeys`'s: when that already fell back to the log there is no
  // token or no network, and this read would fail the same way.
  async function loadReassignableActivities(childId, source) {
    if (source !== 'plan') return null;
    try {
      const result = await Sync.api(
        `/api/assignments/reassignable?childId=${encodeURIComponent(childId)}`
      );
      return new Set((result && result.activityIds) || []);
    } catch {
      return null;
    }
  }

  // ---- The canonical order of a day's activities (§2.1) ----
  //
  // The order a day's `activities` array is in IS the order the review screen
  // shows it in, and IS the order `projectAssignments` numbers `sort_order`
  // from. Nothing ever defined that order: Propose builds the array in three
  // appends — reproduced log rows first, in log order and therefore mixed
  // across courses; then the school walk, per instance; then anything pulled
  // forward — so the display order was whatever the build sequence happened
  // to produce, and a pulled-forward item landed at the bottom of the day
  // instead of with the rest of its course. Both symptoms are the same defect
  // (§0.1 reports 1 and 2), and defining the order in one place is the fix
  // for both.
  //
  // Sorting the array itself rather than a render-time copy is deliberate:
  // `projectAssignments` derives `sortOrder` from array position
  // (`:672-684`), so this way the parent's screen and the child's plan agree
  // with no change to the projection at all.
  //
  // `ctx` is `{ coursesById, walkIndex, subjectOrder }`. Propose passes a
  // local one because `session` does not exist yet at the point it sorts;
  // every Review action passes `session` itself, which carries all three for
  // exactly this reason — `relocate` and `pullForward` hold no other handle
  // on the proposal, and a sort that only worked inside Propose's closure
  // would silently mis-sort on precisely the two actions report 2 is about.
  function sortDayActivities(dayObj, ctx) {
    if (!dayObj || !dayObj.activities || dayObj.activities.length < 2) return;
    const bySubject = SubjectOrderCore.compare(ctx.subjectOrder || []);
    const courseOf = (it) => ctx.coursesById.get(it.instanceId);
    const subjectOf = (it) => {
      const inst = courseOf(it);
      return SubjectOrderCore.label(inst && inst.subject);
    };
    // An activity the walk does not know — its lesson was deleted since the
    // log row that reproduced it was written — sorts after every known one.
    // An absent index would otherwise read as 0 and put it first.
    const walkPos = (it) => {
      const m = ctx.walkIndex && ctx.walkIndex.get(it.instanceId);
      const i = m && m.get(it.id);
      return i == null ? Infinity : i;
    };
    dayObj.activities.sort((a, b) => {
      const s = bySubject(subjectOf(a), subjectOf(b));
      if (s !== 0) return s;
      // Course by name, tie-broken on instanceId: two instances stamped from
      // one template for one child legitimately share a name
      // (`storage.js:116-119`), and the tie-break is what keeps their
      // activities from interleaving under one heading.
      const na = (courseOf(a) && courseOf(a).name) || '';
      const nb = (courseOf(b) && courseOf(b).name) || '';
      if (na !== nb) return na.localeCompare(nb);
      if (a.instanceId !== b.instanceId) return String(a.instanceId).localeCompare(String(b.instanceId));
      // Walk index within the course — lesson `order` then activity `order`
      // (`pacing.js:38-50`). Compared rather than subtracted so two unknowns
      // (Infinity - Infinity) fall through to the id tie-break instead of NaN.
      const wa = walkPos(a);
      const wb = walkPos(b);
      if (wa !== wb) return wa < wb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  // Chores and events keep the order they are built in. Their bands and their
  // numbering are unchanged (§2.1), and nothing about them was reported.
  function sortDay(date) {
    sortDayActivities(session.days.get(date), session);
  }

  // ---- Propose (FR-1–FR-6) — writes nothing ----

  async function propose(childId, semesterLabel, coversFrom, coversTo, include) {
    if (!isValidDate(coversFrom) || !isValidDate(coversTo)) return { error: 'Both dates must be valid calendar dates.' };
    if (coversFrom > coversTo) return { error: 'coversFrom must be on or before coversTo.' };
    const inc = normalizeInclude(include);
    if (!includedKinds(inc).length) return { error: 'Include at least one of School, Chores or Family events.' };
    const child = await Storage.get('children', childId);
    if (!child) return { error: 'Select an existing child.' };

    const [activityTypes, tiers, allCourses, allChores, allEvents, allLessons, storedSubjectOrder] = await Promise.all([
      Storage.getAll('activityTypes'),
      Storage.getAll('tiers'),
      Storage.getAll('courses'),
      Storage.getAll('chores'),
      Storage.getAll('familyEvents'),
      Storage.getAll('lessons'),
      // The household's standing subject order (Module 11 FR-9), read ONCE per
      // proposal rather than once per render (§2.1). A proposal that re-sorted
      // itself mid-review because the parent edited Settings in another tab
      // would move rows under the parent's hands while they were deciding
      // about them.
      Storage.get('meta', 'subjectOrder'),
    ]);
    const subjectOrder = (storedSubjectOrder && storedSubjectOrder.order) || [];

    const maps = {
      typeLabel: new Map(activityTypes.map((t) => [t.activityTypeKey, t.label])),
      rewardCat: new Map(tiers.map((t) => [t.tierId, t.rewardCategoryId])),
      courseName: new Map(allCourses.map((c) => [c.id, c.name])),
      // §7.2 — replace fields the Activity record no longer stores (§3.1).
      capturesGrade: new Map(activityTypes.map((t) => [t.activityTypeKey, t.capturePattern === 'grade-optional'])),
      lessonTitle: new Map(allLessons.map((l) => [l.id, l.title])),
    };

    const instances = allCourses.filter((c) => c.state === 'instance' && c.childId === childId);
    const coursesById = new Map(allCourses.map((c) => [c.id, c]));

    // Per-instance walk order + walk-index map (stable blockHint round-robin).
    const walkByInstance = new Map(); // instanceId -> [activity, …] in walk order
    const walkIndex = new Map(); // instanceId -> Map(activityId -> index)
    const blockLayoutByInstance = new Map();
    const instancesWithProfiles = [];
    // Skipped wholesale on a chores-only run: this loop is a pacing-profile read
    // and a full activity walk per assigned course, and nothing outside the
    // School steps consults what it builds.
    for (const inst of inc.school ? instances : []) {
      const walk = await Pacing.instanceActivitiesInWalkOrder(inst.id);
      walkByInstance.set(inst.id, walk);
      walkIndex.set(inst.id, new Map(walk.map((a, i) => [a.id, i])));
      const profile = await Pacing.getProfile(inst.id);
      if (profile) {
        if (profile.blockLayout && profile.blockLayout.length) blockLayoutByInstance.set(inst.id, profile.blockLayout);
        instancesWithProfiles.push({ instance: inst, profile, walk });
      }
    }

    const logRows = await Storage.getAllByIndex('generationLog', 'by_child', childId);
    const sentActivityIds = new Set(
      logRows.filter((r) => r.disposition === 'sent' && r.instanceId).map((r) => r.itemId)
    );
    const decisionItemIds = new Set(logRows.map((r) => r.itemId)); // any sent/dropped decision (per-occurrence for chores)

    // What D1 knows and the log cannot (Rescind_Regeneration §2). Read before
    // any placement, because Step 2 and Step 3 both need correcting by it:
    // `committed.keys` is what is already live in the range (§6.6, unchanged),
    // `committed.rescindedKeys` is what was pulled back inside it, and
    // `reassignable` is the school work pulled back anywhere in the child's
    // history and never re-assigned — normally OUTSIDE this range, because the
    // parent rescinds yesterday and proposes today.
    const committed = await loadCommittedKeys(childId, coversFrom, coversTo, logRows, allChores);
    const reassignable = await loadReassignableActivities(childId, committed.source);
    // A rescind un-assigns (§2.1). The log still says `sent` — it is written at
    // Commit and never again — so without this the walk steps over the work the
    // parent just pulled back, for good. Deleting from the set rather than
    // testing at the filter keeps Step 3's `pending` line reading as it did,
    // and keeps `excludeFromGeneration` winning over a return (§1).
    if (reassignable) for (const id of reassignable) sentActivityIds.delete(id);
    const returned = (id) => !!(reassignable && reassignable.has(id));

    const rangeDates = eachDate(coversFrom, coversTo);
    const days = new Map();
    const ensureDay = (d) => {
      if (!days.has(d)) days.set(d, { activities: [], chores: [], events: [] });
      return days.get(d);
    };

    function blockHintFor(instanceId, activityId) {
      const bl = blockLayoutByInstance.get(instanceId);
      if (!bl || !bl.length) return undefined;
      const wi = walkIndex.get(instanceId) && walkIndex.get(instanceId).get(activityId);
      if (wi == null) return undefined;
      return bl[wi % bl.length]; // derived from stable walk position → idempotent across runs
    }

    function placeActivity(dayObj, record, instanceId, date, origin) {
      const item = { kind: 'activity', id: record.id, instanceId, assignedDate: date, origin, disposition: 'sent', record };
      const bh = blockHintFor(instanceId, record.id);
      if (bh) item.blockHint = bh;
      dayObj.activities.push(item);
      return item;
    }

    // Step 2 — Reproduce in-range prior decisions from current records (§4.2.2).
    // Reproduction is filtered by the same scope as fresh placement (FR-1a): a
    // chores-only run reproduces prior chore decisions and leaves the school
    // rows out of the proposal entirely. It does not *unmake* them — a decision
    // this run does not reproduce is one it also does not touch at Commit,
    // because Commit's log write is built from what is on screen.
    for (const row of logRows) {
      if (row.assignedDate < coversFrom || row.assignedDate > coversTo) continue;
      if (row.disposition !== 'sent') continue; // in-range dropped chore rows are suppressions — not re-proposed
      if (!(row.instanceId ? inc.school : inc.chores)) continue;
      // A decision the parent has since rescinded is not reproduced
      // (Rescind_Regeneration §2.3). Two tests, because two things can be true:
      // the row was pulled back where the log says it is — which is what keeps
      // a rescinded CHORE day off the screen and out of Commit — or its
      // activity is owed again anywhere, which also catches a row the parent
      // MOVED with PATCH (§6.5) before rescinding it, since a Move leaves the
      // log's date behind.
      const priorKey = keyOfLogRow(row, allChores);
      if (priorKey && committed.rescindedKeys.has(priorKey)) continue;
      if (row.instanceId && returned(row.itemId)) continue; // Step 3 re-places it at its walk position
      if (row.instanceId) {
        const record = await Storage.get('activities', row.itemId);
        if (!record) continue; // deleted since — cannot reproduce content
        placeActivity(ensureDay(row.assignedDate), record, row.instanceId, row.assignedDate, 'reproduced');
      } else {
        // Chore occurrence id: CHR-{token}-{YYYYMMDD}[-{instanceId}] (§2.4).
        const parts = row.itemId.split('-');
        const chore = allChores.find((c) => c.id === 'CHR-' + parts[1]);
        if (!chore) continue;
        const instanceKey = parts[3] || '';
        // Carry the parsed instance onto the reproduced item (Shared Chores
        // §3.2) — otherwise a reproduced occurrence loses its label and
        // blockHint and falls back to the chore's own (usually absent),
        // which is what put every occurrence of a multi-instance chore back
        // on the child's plan as an unlabeled "morning" item.
        const inst = Chores.instancesOf(chore).find((i) => i.id === instanceKey);
        ensureDay(row.assignedDate).chores.push({
          kind: 'chore', id: row.itemId, choreId: chore.id, instanceKey,
          instanceLabel: inst && inst.label, instanceBlockHint: inst && inst.blockHint,
          assignedDate: row.assignedDate, disposition: 'sent', record: chore,
        });
      }
    }

    // Step 3 — Extend School: pending remainder distributed by budget (§4.2.3).
    const pendingByInstance = new Map();
    for (const { instance, profile } of instancesWithProfiles) {
      const schoolDays = rangeDates.filter(
        (d) => profile.daysOfWeek.includes(weekday(d)) && !(profile.skipDates || []).includes(d)
      );
      const walk = walkByInstance.get(instance.id);
      const pending = walk.filter((a) => !sentActivityIds.has(a.id) && !a.excludeFromGeneration);
      let idx = 0;
      for (const d of schoolDays) {
        if (idx >= pending.length) break;
        const dayObj = ensureDay(d);
        let load = loadFor(dayObj, instance.id, profile.pacingMode);
        while (idx < pending.length) {
          const a = pending[idx];
          const cost = profile.pacingMode === 'activityCount' ? 1 : durationOf(a);
          if (profile.pacingMode === 'activityCount' && load + 1 > profile.activitiesPerDay) break;
          if (profile.pacingMode === 'minutesBudget' && load + cost > profile.minutesPerDay) break;
          // `returned` rather than `walked` so the review screen says why an
          // item the parent pulled back is here again (§6). It is the same
          // placement either way — the walk owes it, and it sits at its own
          // position in the course, so work behind it moves later.
          placeActivity(dayObj, a, instance.id, d, returned(a.id) ? 'returned' : 'walked');
          load += cost;
          idx++;
        }
      }
      pendingByInstance.set(instance.id, pending.slice(idx)); // remainder available for Pull-forward
    }

    // Step 4 — Chores (FR-3): occurrences with no prior decision. Shared
    // Chores §4.1 — participation-and-days test in place of the old flat
    // childId match, so a chore whose days are split (§4.3) yields no
    // occurrence on the other participant's days.
    for (const chore of inc.chores ? allChores.filter((c) => Chores.participantsOf(c).includes(childId)) : []) {
      const token = chore.id.slice(4);
      const days = Chores.daysFor(chore, childId) || [];
      for (const d of rangeDates) {
        if (!days.includes(weekday(d))) continue;
        for (const inst of Chores.instancesOf(chore)) {
          // Suffix omitted for a chore with no `instances` (§2.4) — inst.id is
          // '' in that case, matching instance_key's schema default (§3.1).
          const occId = inst.id ? `CHR-${token}-${d.replace(/-/g, '')}-${inst.id}` : `CHR-${token}-${d.replace(/-/g, '')}`;
          if (decisionItemIds.has(occId)) continue; // already reproduced/suppressed
          ensureDay(d).chores.push({
            kind: 'chore', id: occId, choreId: chore.id, instanceKey: inst.id,
            instanceLabel: inst.label, instanceBlockHint: inst.blockHint,
            assignedDate: d, disposition: 'sent', record: chore,
          });
        }
      }
    }

    // Step 5 — Family Events (FR-4): overlap + childIds membership, per covered day.
    for (const ev of inc.events ? allEvents : []) {
      if (!(ev.childIds || []).includes(childId)) continue;
      if (ev.endDate < coversFrom || ev.startDate > coversTo) continue; // no overlap
      for (const d of rangeDates) {
        if (d >= ev.startDate && d <= ev.endDate) ensureDay(d).events.push({ kind: 'event', id: ev.id, record: ev });
      }
    }

    // Step 6 — Mark what is already live (§6.6). After every placement step,
    // so a reproduced item, a freshly walked one and a re-derived event are all
    // measured against the same set.
    // `committed` was loaded above, before Step 2 needed it.
    let committedCount = 0;
    for (const [d, o] of days) {
      for (const list of [o.activities, o.chores, o.events]) {
        for (const it of list) {
          if (!committed.keys.has(keyOf(d, it.kind, sourceIdOf(it), it.instanceKey || ''))) continue;
          it.committed = true;
          committedCount++;
        }
      }
    }

    // Step 7 — put every day into canonical order (§2.1). Last, so it sees
    // reproduced rows, walked rows and re-derived events alike, and so a
    // freshly-marked `committed` flag rides along with the item it belongs to.
    const sortCtx = { coursesById, walkIndex, subjectOrder };
    for (const dayObj of days.values()) sortDayActivities(dayObj, sortCtx);

    session = {
      childId, childName: child.name, semesterLabel: (semesterLabel || '').trim(),
      coversFrom, coversTo, days, maps, coursesById,
      // The two things `sortDayActivities` reads that were not on `session`
      // before (§2.1). `walkIndex` is the Map built above and previously
      // thrown away with Propose's closure — stored rather than rebuilt,
      // because rebuilding it would re-walk every instance on every Review
      // action. `subjectOrder` is the snapshot read at the top of this
      // function. Neither is new state in any meaningful sense: one is a
      // local promoted, the other one more read in a Promise.all.
      walkIndex, subjectOrder,
      // What this pass was asked to place (FR-1a). Read by the proposal heading
      // and by both empty-source messages, which have to say "chores only"
      // rather than imply the range itself is bare. The Pull-forward buckets
      // need no such check — `pendingByInstance` is only filled by the school
      // walk, so it is already empty when School is out.
      include: inc,
      droppedChores: new Map(), excluded: new Set(), pendingByInstance,
      // §6.6 bookkeeping: how many of the items on screen are already on the
      // child's plan, and whether that was read from the plan itself or
      // inferred from local history.
      committedCount, committedSource: committed.source,
      // Which activities are in this proposal because they were rescinded and
      // never re-assigned (§6). Empty on an offline Propose, which cannot know.
      // The set, not a count: Review keeps rearranging the proposal — a
      // returned item can be excluded, relocated or pulled forward — and the
      // notice has to describe what is on screen now, not what Propose placed.
      returnedIds: reassignable || new Set(),
      // Commit bookkeeping (see the [DECISION] above commit()). batchId is
      // minted on the first Commit attempt and reused by every retry of this
      // same proposal; partial records that some of it reached D1.
      batchId: null, postedRows: 0, partial: false,
      // Pending-remainder UI state (§UX below) — which per-course buckets are
      // open and which have had their preview cap lifted. Kept on the session,
      // not the DOM, so it survives the full re-render every Review action
      // triggers.
      openRemainders: new Set(), expandedRemainders: new Set(),
      // Subject/course/chore/event group state (§2.6), on the session for the
      // same reason `openRemainders` is. `knownGroups` is what makes "default
      // open" and "the parent closed this one" distinguishable — see
      // `groupBox`.
      openGroups: new Set(), knownGroups: new Set(),
    };
    return { session };
  }

  function durationOf(activity) {
    return activity.expectedDurationMin != null ? activity.expectedDurationMin : DEFAULT_MINUTES;
  }

  function loadFor(dayObj, instanceId, mode) {
    const items = dayObj.activities.filter((it) => it.instanceId === instanceId);
    if (mode === 'activityCount') return items.length;
    return items.reduce((sum, it) => sum + durationOf(it.record), 0);
  }

  // ---- Review (FR-7) — in-memory mutations only, writes nothing ----

  // Every Review action goes through this first. Once part of a batch is live
  // in D1, editing the proposal underneath it is genuinely ambiguous: the retry
  // resumes by chunk position, so changing which rows sit at those positions
  // would skip some and duplicate others. Two coherent ways out, both offered.
  function reviewGuard() {
    if (!session.partial) return null;
    return {
      error: `${session.postedRows} of this proposal's rows are already live in D1 ` +
        `(batch ${session.batchId}). Press Commit again to finish sending it, or Abandon ` +
        'to pull those rows back — the proposal cannot be edited in between.',
    };
  }

  // An item already live in D1 cannot be edited from here (§6.6). Every Review
  // action is a local rearrangement that Commit realises by *inserting* rows, so
  // "relocate" on a live item would leave Monday's row exactly where it is and
  // add a second one on Tuesday — which is the duplicate this whole section
  // exists to prevent, wearing the parent's own intent as a disguise.
  function committedGuard(item) {
    if (!item || !item.committed) return null;
    return {
      error: 'That is already assigned and live on the child\'s plan. Move, edit or ' +
        'rescind it in the Assignments view — changing it here would leave the live row ' +
        'where it is and add a second copy.',
    };
  }

  // How many of the activities on screen are here because they were rescinded
  // and never re-assigned (Rescind_Regeneration §6). Counted from the proposal
  // rather than from placement, so excluding one, relocating it or pulling
  // another forward all keep the notice honest.
  function countReturned() {
    if (!session || !session.returnedIds || !session.returnedIds.size) return 0;
    let n = 0;
    for (const day of session.days.values()) {
      for (const it of day.activities) if (session.returnedIds.has(it.id)) n++;
    }
    return n;
  }

  function findItem(kind, date, id) {
    const day = session.days.get(date);
    if (!day) return null;
    const arr = kind === 'activity' ? day.activities : kind === 'chore' ? day.chores : day.events;
    const i = arr.findIndex((it) => it.id === id);
    return i === -1 ? null : { arr, i, item: arr[i] };
  }

  function relocate(kind, fromDate, id, toDate) {
    const blocked = reviewGuard();
    if (blocked) return blocked;
    if (!isValidDate(toDate)) return { error: 'Enter a valid YYYY-MM-DD date.' };
    if (toDate < session.coversFrom || toDate > session.coversTo) return { error: 'Target date is outside the covered range.' };
    const found = findItem(kind, fromDate, id);
    if (!found) return { error: 'Item not found.' };
    const live = committedGuard(found.item);
    if (live) return live;
    const [item] = found.arr.splice(found.i, 1);
    item.assignedDate = toDate;
    if (!session.days.has(toDate)) session.days.set(toDate, { activities: [], chores: [], events: [] });
    (kind === 'activity' ? session.days.get(toDate).activities : session.days.get(toDate).chores).push(item);
    // The item still appends; the sort then puts it at its walk position
    // inside its own course group, which is where the parent expected it
    // (§2.4). Both days: the source cannot have been disturbed by a removal,
    // but re-running it there costs nothing and means no caller has to know
    // which of the two mutated.
    sortDay(fromDate);
    sortDay(toDate);
    return { ok: true };
  }

  function excludeActivity(fromDate, id) {
    const blocked = reviewGuard();
    if (blocked) return blocked;
    const found = findItem('activity', fromDate, id);
    if (!found) return { error: 'Item not found.' };
    const live = committedGuard(found.item);
    if (live) return live;
    found.arr.splice(found.i, 1);
    sortDay(fromDate); // a removal cannot disturb the order; re-running costs nothing (§2.1)
    session.excluded.add(id); // excludeFromGeneration persisted at Commit
    return { ok: true };
  }

  function deferActivity(fromDate, id) {
    const blocked = reviewGuard();
    if (blocked) return blocked;
    const found = findItem('activity', fromDate, id);
    if (!found) return { error: 'Item not found.' };
    const live = committedGuard(found.item);
    if (live) return live;
    found.arr.splice(found.i, 1); // absence keeps it pending; no write at Commit
    sortDay(fromDate);
    return { ok: true };
  }

  function dropChore(fromDate, id) {
    const blocked = reviewGuard();
    if (blocked) return blocked;
    const found = findItem('chore', fromDate, id);
    if (!found) return { error: 'Item not found.' };
    const live = committedGuard(found.item);
    if (live) return live;
    found.arr.splice(found.i, 1);
    session.droppedChores.set(id, { itemId: id, assignedDate: fromDate }); // 'dropped' row at Commit
    return { ok: true };
  }

  function pullForward(instanceId, activityId, toDate) {
    const blocked = reviewGuard();
    if (blocked) return blocked;
    if (!isValidDate(toDate)) return { error: 'Enter a valid YYYY-MM-DD date.' };
    if (toDate < session.coversFrom || toDate > session.coversTo) return { error: 'Target date is outside the covered range.' };
    const remainder = session.pendingByInstance.get(instanceId) || [];
    const i = remainder.findIndex((a) => a.id === activityId);
    if (i === -1) return { error: 'Activity is not in the pending remainder.' };
    const [record] = remainder.splice(i, 1);
    if (!session.days.has(toDate)) session.days.set(toDate, { activities: [], chores: [], events: [] });
    const item = { kind: 'activity', id: record.id, instanceId, assignedDate: toDate, origin: 'pulled', disposition: 'sent', record };
    const inst = session.coursesById.get(instanceId);
    void inst;
    session.days.get(toDate).activities.push(item);
    // Report 2, exactly: "append" was "bottom of the day" because array
    // position IS display order. Same one-line fix `relocate` gets (§2.4).
    sortDay(toDate);
    return { ok: true };
  }

  // ---- Payload projection (TDS_Slice_Lesson_Recipe.md §7.1) ----
  //
  // One content shape survives D5: pageRangeStart/pageRangeEnd, present or
  // not. The `kind` discriminator that used to distinguish pageRange /
  // reference / freeText / none goes with `reference`/`text` — it named
  // nothing once there was only one shape left, and the Child App tests for
  // `pageRangeStart` directly (§9.1 in the Lesson Recipe slice).

  function projectPayload(a) {
    if (typeof a.pageRangeStart !== 'number') return {};
    return { pageRangeStart: a.pageRangeStart, pageRangeEnd: a.pageRangeEnd };
  }

  // ---- Assignment projection (Revamp §3.3) — the Phase 3 write path ----

  // The Worker enforces a closed allow-list of writable columns and rejects an
  // entire batch with 400 if a row carries anything else (§4.2). So this
  // projection is deliberately strict, and every field that has no column of
  // its own goes inside `payload` — which §3.3 types as "JSON: pageRange,
  // instructions, etc." Nothing but this function enforces that shape, so per
  // §3.7.1's rule for JSON-in-TEXT it is written down here:
  //
  //   activity → { pageRangeStart?, pageRangeEnd?, required, capturesGrade,
  //                difficultyTier, lessonTitle?, instructions? }
  //   chore    → { choreType, difficultyTier, required, notes? }
  //   event    → { startDate, endDate, notes?, time? }
  //
  // `rewardAmount` is deliberately left unset. The Management App has no such
  // number to snapshot: tiers carry { tierId, label, order, rewardCategoryId }
  // and the earned amount is computed on the child's device. Guessing a value
  // here would bake a Child App constant into parent-authored rows across the
  // app boundary. §7 wants the column populated, but that belongs to Phase 4,
  // where the earning path is actually built. A null column can be backfilled
  // by a migration; a wrong value in thousands of rows cannot.

  function assignmentFromActivity(item, sortOrder) {
    const a = item.record;
    const payload = Object.assign(projectPayload(a), {
      required: !!a.required,
      capturesGrade: session.maps.capturesGrade.get(a.activityType) === true,
      difficultyTier: a.difficultyTier,
    });
    const lessonTitle = session.maps.lessonTitle.get(a.lessonId);
    if (lessonTitle) payload.lessonTitle = lessonTitle;
    if (a.instructions) payload.instructions = a.instructions;

    const row = {
      date: item.assignedDate,
      kind: 'activity',
      sourceId: a.id, // the curriculum activity this came from (§3.3)
      title: a.title,
      courseName: session.maps.courseName.get(item.instanceId),
      activityType: session.maps.typeLabel.get(a.activityType) || a.activityType, // label, never the key
      rewardCategory: session.maps.rewardCat.get(a.difficultyTier),
      payload,
      sortOrder,
    };
    if (a.expectedDurationMin != null) row.expectedDurationMin = a.expectedDurationMin;
    if (item.blockHint) row.blockHint = item.blockHint;
    return row;
  }

  function assignmentFromChore(item, sortOrder) {
    const c = item.record;
    // sourceId is the chore's curriculum id, NOT the per-occurrence
    // CHR-{token}-{YYYYMMDD} key. §3.3.1 repealed derived occurrence ids: the
    // occurrence *is* the server-minted row now. The occurrence key survives
    // only inside generationLog, which is local scheduling history.
    const payload = { choreType: c.choreType, difficultyTier: c.difficultyTier, required: true };
    if (c.notes) payload.notes = c.notes;

    const row = {
      date: item.assignedDate,
      kind: 'chore',
      sourceId: c.id,
      title: item.instanceLabel ? `${c.title} — ${item.instanceLabel}` : c.title,
      rewardCategory: session.maps.rewardCat.get(c.difficultyTier),
      payload,
      instanceKey: item.instanceKey || '',
      sortOrder,
    };
    // An instance's own blockHint overrides the chore's (§2.4) — what puts
    // three dishes in three different parts of the kid's day.
    const blockHint = item.instanceBlockHint || c.blockHint;
    if (blockHint) row.blockHint = blockHint;
    if (c.expectedDurationMin != null) row.expectedDurationMin = c.expectedDurationMin;
    // Shared Chores §5.3 — a `claim` chore's rows carry `shared: true` so the
    // Worker links every participant's row for this occurrence into one
    // `claim_groups` entry. `each` chores, including multi-child `each`,
    // never set this: their rows are independent by design (§0.9).
    if (Chores.allocationOf(c) === 'claim') row.shared = true;
    return row;
  }

  function assignmentFromEvent(item, date, sortOrder) {
    const e = item.record;
    // A multi-day event becomes one row per in-range day, matching how Propose
    // already places it (§4 step 5) and how the child renders a day at a time.
    // The true span stays in the payload so nothing is lost.
    const payload = { startDate: e.startDate, endDate: e.endDate };
    if (e.notes) payload.notes = e.notes;
    if (e.time) payload.time = e.time;
    return { date, kind: 'event', sourceId: e.id, title: e.title, payload, sortOrder };
  }

  function projectAssignments() {
    const rows = [];
    for (const date of [...session.days.keys()].sort()) {
      const o = session.days.get(date);
      // Fixed merge order — activities, then chores, then events (FR-6) — now
      // carried as an explicit sort_order value rather than left to array
      // position. The child renders on COALESCE(child_sort_order, sort_order)
      // (§3.3.3), so the parent's intended order has to survive as data.
      //
      // Already-live items (§6.6) are counted but not emitted: sort_order is a
      // position within the day, and the row holding that position is already
      // in D1 with that number on it. Skipping the slot as well would renumber
      // the new rows on top of the existing ones and scramble the day.
      //
      // Each kind numbers within its own band (FR-1a). One counter across all
      // three made a slot's number depend on how many items of the *other*
      // kinds this proposal happened to place — harmless while every run placed
      // all three, because the count was then the same every time. A narrowed
      // run breaks that: propose chores-only over a day whose five activities
      // are already live and the chores start at 0 instead of 5, so a chore
      // added on a later pass sorts above chores committed on an earlier one.
      // Banding makes a kind's numbering depend only on that kind, so a
      // narrowed pass and a full pass give the same item the same slot.
      //
      // Nothing compares across bands: every consumer sorts within one kind
      // (planner-core's `filterView` splits School from Chores, and its day view
      // builds `school`/`chores` as separate arrays), and the child's reorder
      // math is midpoint-relative, so the gaps cost nothing. Rows committed
      // before this change keep their old numbers and stay correctly ordered
      // among themselves — the bands only ever push newer rows later.
      const BAND = 1000;
      let sortOrder = 0;
      for (const it of o.activities) { const n = sortOrder++; if (!it.committed) rows.push(assignmentFromActivity(it, n)); }
      sortOrder = BAND;
      for (const it of o.chores) { const n = sortOrder++; if (!it.committed) rows.push(assignmentFromChore(it, n)); }
      sortOrder = BAND * 2;
      for (const it of o.events) { const n = sortOrder++; if (!it.committed) rows.push(assignmentFromEvent(it, date, n)); }
    }
    return rows;
  }

  function mintBatchId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'batch-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // The Worker's MAX_BATCH; anything larger is a 413 (§5.6). A full-semester
  // Commit for one child runs to roughly 1,800 rows, so chunking is the normal
  // path, not an edge case.
  const POST_CHUNK = 500;

  // Every chunk carries the SAME batchId and its own chunkIndex. The pair is
  // what the Worker's commit_chunks table (migration 0003) keys idempotency on,
  // which is what finally makes §6.1's "replay-safe" claim true: re-posting a
  // chunk that already landed inserts nothing and reports what the first
  // attempt applied. So a run that dies on chunk three of four is resumed by
  // pressing Commit again — chunks one and two are recognised and skipped —
  // rather than duplicated, and a batch that is abandoned instead still
  // reverses in one statement (§6.2).
  //
  // Reports progress through onChunk after every accepted chunk, so a failure
  // partway leaves the caller knowing exactly how much is live.
  async function postAssignments(batchId, rows, onChunk) {
    let posted = 0;
    let skipped = 0;
    for (let i = 0; i < rows.length; i += POST_CHUNK) {
      const chunk = rows.slice(i, i + POST_CHUNK);
      const result = await Sync.api('/api/assignments', {
        method: 'POST',
        body: {
          batchId,
          chunkIndex: i / POST_CHUNK,
          childId: session.childId,
          assignments: chunk,
        },
      });
      // `applied` covers both cases: rows this request inserted, or — when the
      // Worker recognised a replay — rows the first attempt inserted. Falling
      // back to ids.length keeps this working against a Worker deployed before
      // 0003 landed.
      posted += result && typeof result.applied === 'number'
        ? result.applied
        : (result && Array.isArray(result.ids) ? result.ids.length : chunk.length);
      // Rows the Worker recognised as already live (§6.6). Normally zero — the
      // proposal filtered those out before they were ever sent — so a non-zero
      // count means this device's picture of the plan was behind, and the
      // parent is told rather than left to infer it from a short total.
      skipped += result && typeof result.skipped === 'number' ? result.skipped : 0;
      if (onChunk) onChunk(posted);
    }
    return { posted, skipped };
  }

  // Pull back a batch that only partly landed. Used by Abandon, which is the
  // parent's way out of a half-committed proposal they no longer want to finish.
  async function rescindBatch(batchId) {
    return Sync.api('/api/assignments/rescind', { method: 'POST', body: { batchId } });
  }

  // ---- Commit (FR-8–FR-11) — the only writes ----

  async function commit() {
    if (!session) return { error: 'No active proposal.' };

    // The rows are now built first rather than beside a packet: they are the
    // only output, and the empty-source test below reads their count.
    const rows = projectAssignments();

    // [DECISION] What a retry of a partly-sent Commit does
    // Decided: reuse the proposal's batchId, and re-post from chunk zero. The
    //   Worker recognises the chunks that already landed and inserts nothing
    //   for them, so the retry resumes rather than duplicating. reviewGuard()
    //   freezes the proposal while a batch is partly live, because resumption
    //   is by chunk position and editing the rows underneath it would move
    //   which rows sit at those positions.
    // Rationale: the alternative — mint a fresh batchId each attempt — is what
    //   the code did, and it meant a POST that failed on chunk three left 1,000
    //   rows live with no handle on them and no warning, then assigned all
    //   1,800 again on the retry. A full-semester Commit is four chunks, so
    //   that was the ordinary path, not a corner.
    // Consequence: Abandon has to rescind a partial batch rather than merely
    //   dropping the session, or the orphan survives.
    // Locked for: this remediation. Revisit if Commit ever streams.
    //
    // Minted before the log rows are built so both the D1 batch and the local
    // decisions that produced it carry the same id. A 'dropped' row has no D1
    // counterpart — nothing was assigned — but recording which Commit decided
    // it is what makes the log auditable against the batch.
    const batchId = session.batchId || mintBatchId();
    session.batchId = batchId;
    const generatedAt = new Date().toISOString();
    const sentRows = [];
    for (const [, o] of session.days) {
      for (const it of o.activities) sentRows.push({ childId: session.childId, itemId: it.id, instanceId: it.instanceId, assignedDate: it.assignedDate, disposition: 'sent', generatedAt, batchId });
      for (const it of o.chores) sentRows.push({ childId: session.childId, itemId: it.id, assignedDate: it.assignedDate, disposition: 'sent', generatedAt, batchId });
    }
    const droppedRows = [...session.droppedChores.values()].map((x) => ({
      childId: session.childId, itemId: x.itemId, assignedDate: x.assignedDate, disposition: 'dropped', generatedAt, batchId,
    }));
    const excludeIds = [...session.excluded];

    // Empty-source (FR-7) only when there is nothing to send AND no review
    // decision to record. A proposal reduced to only drops/excludes still
    // commits those decisions (else re-propose would resurface them) — it
    // just assigns nothing. `rows.length` replaces the old `packet.days.length`
    // and tests the same thing: buildPacket dropped days that had no items, so
    // a day survived it exactly when it contributed at least one row here.
    // Both empty-source messages name the scope when it is narrowed (FR-1a).
    // "Nothing to generate for this range" is actively misleading after a
    // chores-only run over a fortnight with a full school walk in it — the
    // parent's next move should be to re-propose with School ticked, not to go
    // looking for why their courses produced nothing.
    const scopeNote = includedKinds(session.include).length === KINDS.length
      ? ''
      : ` This run covered ${scopeLabel(session.include).toLowerCase()} — the other kinds were not proposed and are unaffected.`;

    if (!rows.length && !sentRows.length && !droppedRows.length && !excludeIds.length) {
      return { error: `Nothing to generate for this child and range (empty-source).${scopeNote}` };
    }

    // The re-Propose of an already-covered range (§6.6): there is content on
    // screen, but all of it is live already and no review decision was made.
    // Said plainly, because the honest alternative — committing zero rows and
    // reporting success — is what let the duplicate go unnoticed for so long.
    if (!rows.length && !droppedRows.length && !excludeIds.length && session.committedCount) {
      return {
        error: `Every item in ${session.coversFrom} → ${session.coversTo} is already assigned to ` +
          `${session.childName} (${session.committedCount} of them). There is nothing new to send. ` +
          `To change what is already there, use the Assignments view.${scopeNote}`,
      };
    }

    // ---- D1 first, IndexedDB second (Revamp §6.1) ----
    //
    // The ordering is deliberate and is the one thing in this function worth
    // reading twice. The network is the failure-prone step, so it goes first:
    // a failed POST leaves no local trace at all, the proposal is still in
    // memory, and Commit is simply retriable. The reverse order would write a
    // generationLog full of 'sent' rows for work that never reached D1 — and
    // because Propose reproduces prior 'sent' decisions rather than re-walking
    // them (§4.2.2), those items would silently never be assigned to anyone.
    //
    // The residual risk is the mirror image: the POST lands and the local write
    // fails, leaving live rows in D1 with no local record. That one is
    // recoverable precisely because every row carries batchId — the error below
    // surfaces it so the batch can be rescinded in a single statement (§6.2).
    let assignedCount = 0;
    let skippedCount = 0;

    if (rows.length) {
      const { enabled } = await Sync.getConfig();
      if (!enabled) {
        return { error: 'Commit needs the parent sync token — set it in Settings → Sync, then Commit again. Nothing was written.' };
      }
      try {
        const sent = await postAssignments(batchId, rows, (posted) => {
          session.postedRows = posted;
          session.partial = true;
        });
        assignedCount = sent.posted;
        skippedCount = sent.skipped;
        session.partial = false;
      } catch (err) {
        const reason = (err && err.message) || err;
        // Two genuinely different failures, and telling the parent the wrong
        // one is how a semester gets assigned twice. Nothing sent at all is
        // simply retriable; a partial send has live rows on the child's plan
        // right now, and the message has to say so and name the batch.
        if (session.postedRows > 0) {
          return {
            error: `Sending stopped partway — ${reason}. ${session.postedRows} of ${rows.length} rows ` +
              `are already live for ${session.childName} under batch ${batchId}. Nothing was recorded ` +
              'locally. Press Commit again to send the rest (the rows already there are recognised and ' +
              'not duplicated), or Abandon to pull them back.',
            batchId,
            postedRows: session.postedRows,
            partial: true,
          };
        }
        return {
          error: `Assignments were not written to D1 — ${reason}. ` +
            'Nothing was recorded locally or sent; press Commit again to retry.',
        };
      }
    }

    // One readwrite transaction. put() over the composite key makes reproduction
    // idempotent and relocation an in-place update (FR-10). Deferred: no write.
    try {
      await Storage.runTransaction(['generationLog', 'activities'], 'readwrite', (t) => {
        const glog = t.objectStore('generationLog');
        for (const r of sentRows) glog.put(r);
        for (const r of droppedRows) glog.put(r);
        const acts = t.objectStore('activities');
        for (const id of excludeIds) {
          const g = acts.get(id);
          g.onsuccess = () => {
            if (g.result) acts.put({ ...g.result, excludeFromGeneration: true });
          };
        }
      });
    } catch (err) {
      return {
        // Names the batch because it is the only handle on those rows. The
        // Assignments view (§9) lists batches newest-first and rescinds one in
        // a single press, so this is a self-service recovery path now rather
        // than a note-it-down-and-report-it one.
        error: `${assignedCount} assignments reached D1, but the local Generation Log write failed — ` +
          `${(err && err.message) || err}. Those rows are live for the child and must be rescinded before ` +
          `this range is committed again, or it will be assigned twice. Go to Assignments, find batch ` +
          `${batchId} at the top of the Batches list, and rescind it.`,
        batchId,
      };
    }

    return {
      ok: true, batchId, assignedCount,
      sentCount: sentRows.length, droppedCount: droppedRows.length, excludedCount: excludeIds.length,
      // Two different ways an item can already be on the plan: this device knew
      // before it sent anything (§6.6's proposal filter), or the Worker caught
      // it. They are reported separately because they mean different things.
      alreadyCount: session.committedCount, skippedCount,
    };
  }

  // ---- Rendering ----

  async function render(root) {
    root.innerHTML = '';
    const heading = document.createElement('h1');
    heading.textContent = 'Generation & Assignment';
    root.appendChild(heading);

    if (lastResult) {
      const banner = document.createElement('p');
      banner.className = lastResult.error ? 'error' : 'success';
      banner.hidden = false;
      banner.textContent = lastResult.error || lastResult.message;
      root.appendChild(banner);
    }

    if (!session) return renderProposeForm(root);
    return renderProposal(root);
  }

  async function renderProposeForm(root) {
    // Archived children are not offered here at all (§3.2's `active`): this is
    // the form that generates new work, and there is no already-selected child
    // to preserve the way the Chores and Events pickers have.
    const children = Children.activeOnly(await Storage.getAll('children'));
    const form = document.createElement('form');
    const opts = ['<option value="">(select)</option>']
      .concat(children.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`))
      .join('');
    // The Include fieldset (FR-1a). All three ticked is the pre-FR-1a run, so
    // the default path through this form is unchanged; unticking is what makes
    // a fortnight reviewable in one sitting.
    const includeBoxes = KINDS.map((k) => `
      <label><input type="checkbox" name="include" value="${k}" ${lastInclude[k] ? 'checked' : ''}> ${KIND_LABEL[k]}</label>
    `).join('');
    form.innerHTML = `
      <h2>Propose assignments</h2>
      <label>Child<select name="childId">${opts}</select></label>
      <label>Semester label<input type="text" name="semesterLabel" placeholder="e.g. Fall 2026"></label>
      <label>Covers from<input type="date" name="coversFrom" required></label>
      <label>Covers to<input type="date" name="coversTo" required></label>
      <fieldset class="include-kinds">
        <legend>Include</legend>
        ${includeBoxes}
        <p class="hint">
          Propose one kind at a time to keep a run reviewable. Kinds you leave out are
          untouched — propose the same range again with them ticked, and anything this
          run assigned is recognised and never sent twice.
        </p>
      </fieldset>
      <p class="error" hidden></p>
      <button type="submit">Propose</button>
    `;
    const errorEl = form.querySelector('.error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      lastResult = null;
      const include = {};
      for (const el of form.querySelectorAll('input[name="include"]')) include[el.value] = el.checked;
      const result = await propose(
        form.childId.value, form.semesterLabel.value, form.coversFrom.value, form.coversTo.value, include
      );
      if (result.error) {
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }
      lastInclude = normalizeInclude(include); // carried to the next run, not persisted
      render(root);
    });
    root.appendChild(form);
  }

  function renderProposal(root) {
    const bar = document.createElement('div');
    bar.className = 'propose-bar';
    // The scope rides in the heading rather than a note beside it: a chores-only
    // proposal and a full one look identical once the school walk happens to be
    // short, and Commit is one press away.
    bar.innerHTML = `<h2>Proposal — ${escapeHtml(session.childName)} · ${session.coversFrom} → ${session.coversTo} ` +
      `<em class="scope-tag">${escapeHtml(scopeLabel(session.include))}</em></h2>`;

    const commitBtn = document.createElement('button');
    commitBtn.textContent = 'Commit & assign';
    commitBtn.addEventListener('click', async () => {
      commitBtn.disabled = true;
      commitBtn.textContent = 'Assigning…';
      let result;
      try {
        result = await commit();
      } finally {
        commitBtn.disabled = false;
        commitBtn.textContent = 'Commit & assign';
      }
      if (result.error) {
        lastResult = { error: `Commit blocked — ${result.error}` };
        render(root);
        return;
      }
      const already = result.alreadyCount + result.skippedCount;
      lastResult = {
        message: `Committed: ${result.assignedCount} assigned to D1, ${result.droppedCount} dropped, ` +
          `${result.excludedCount} excluded (batch ${result.batchId}). ` +
          (already ? `${already} were already on the plan and were left alone. ` : '') +
          (result.assignedCount
            ? 'Paired devices pick this up on their next check.'
            : 'Nothing to assign; decisions were still recorded.'),
      };
      session = null;
      render(root);
    });

    const abandonBtn = document.createElement('button');
    abandonBtn.className = 'secondary';
    // The label tells the truth about which of the two situations this is.
    // Dropping a partly-sent proposal without rescinding would strand live rows
    // on the child's plan that no local record mentions.
    abandonBtn.textContent = session.partial
      ? `Abandon (pull back ${session.postedRows} sent rows)`
      : 'Abandon (write nothing)';
    abandonBtn.addEventListener('click', async () => {
      if (!session.partial) {
        session = null;
        lastResult = { message: 'Proposal abandoned. Nothing was written.' };
        render(root);
        return;
      }

      const partialBatchId = session.batchId;
      const sent = session.postedRows;
      if (!window.confirm(
        `${sent} rows from this proposal are already live for ${session.childName}. ` +
        'Abandoning rescinds them, so they come off the plan on the child\'s next sync. ' +
        'Anything the child has already completed is left alone and keeps its reward.'
      )) return;

      abandonBtn.disabled = true;
      abandonBtn.textContent = 'Pulling back…';
      try {
        const result = await rescindBatch(partialBatchId);
        session = null;
        lastResult = { message: `Proposal abandoned. Rescinded ${result.rescinded} of ${sent} sent rows; nothing was recorded locally.` };
      } catch (err) {
        abandonBtn.disabled = false;
        abandonBtn.textContent = `Abandon (pull back ${sent} sent rows)`;
        lastResult = {
          error: `Could not pull the sent rows back — ${(err && err.message) || err}. ` +
            `Batch ${partialBatchId} is still live. Try Abandon again, or rescind it from the Assignments view.`,
        };
      }
      render(root);
    });
    bar.appendChild(commitBtn);
    bar.appendChild(abandonBtn);

    // What actually makes a 300-row fortnight workable, more than the
    // individual toggles do (§2.2). Both act on `knownGroups`, which the day
    // loop below fills on every render — so they reach exactly the groups that
    // are on screen, including ones created since the last press.
    const expandBtn = document.createElement('button');
    expandBtn.className = 'secondary';
    expandBtn.textContent = 'Expand all';
    expandBtn.addEventListener('click', () => {
      session.knownGroups.forEach((k) => session.openGroups.add(k));
      render(root);
    });
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'secondary';
    collapseBtn.textContent = 'Collapse all';
    collapseBtn.addEventListener('click', () => {
      session.openGroups.clear();
      render(root);
    });
    bar.appendChild(expandBtn);
    bar.appendChild(collapseBtn);
    root.appendChild(bar);

    // Discoverability for the setting that motivated the grouping, from the
    // screen it shows up on, without duplicating the editor here (§1.3).
    const orderHint = document.createElement('p');
    orderHint.className = 'review-order-hint';
    orderHint.textContent = 'Subjects follow your standing order (Settings → Subject order).';
    root.appendChild(orderHint);

    if (session.committedCount) {
      const note = document.createElement('p');
      note.className = 'notice';
      note.textContent =
        `${session.committedCount} of the items below are already assigned and live on ` +
        `${session.childName}'s plan` +
        (session.committedSource === 'log'
          ? ' (read from this device\'s Generation Log — the live plan could not be reached, so the count may be stale).'
          : '.') +
        ' They are shown for context, are not editable here, and Commit will not send them again.';
      root.appendChild(note);
    }

    // Rescind_Regeneration §6 — the parent decided this when they pressed
    // Rescind; this is the proposal telling them it landed. Below the
    // already-live notice on purpose: one says what Commit will leave alone,
    // the other what it will send again.
    const returnedCount = countReturned();
    if (returnedCount) {
      const note = document.createElement('p');
      note.className = 'notice';
      note.textContent =
        `${returnedCount} ${returnedCount === 1 ? 'item is' : 'items are'} back in this proposal because ` +
        `${returnedCount === 1 ? 'it was' : 'they were'} rescinded and never re-assigned. ` +
        'They are placed at their position in the course, so work behind them moves later.';
      root.appendChild(note);
    }

    if (session.partial) {
      const warning = document.createElement('p');
      warning.className = 'error';
      warning.textContent =
        `${session.postedRows} rows from this proposal are already live under batch ${session.batchId}. ` +
        'Commit again to send the rest, or Abandon to pull them back. Editing is locked until then.';
      root.appendChild(warning);
    }

    // Pending remainder (Pull-forward source) per instance — one collapsed
    // <details> bucket per course (closed by default, same convention as
    // .course-subject-group in courses.js) so a multi-course proposal doesn't
    // dump every course's full remainder onto the screen at once. Each bucket
    // previews only the first REMAINDER_PREVIEW items; "Show N more" lifts the
    // cap for that course. Both the open/closed state and the cap-lifted state
    // live on the session (not the DOM) so a Pull-forward click — which
    // re-renders the whole proposal — doesn't collapse the bucket the parent
    // is actively working in.
    const REMAINDER_PREVIEW = 5;
    // Same comparator as the day groups, instead of `pendingByInstance`'s Map
    // insertion order — which is the school walk's order, i.e. arbitrary to
    // the parent reading it (§2.3).
    const remainderSubject = SubjectOrderCore.compare(session.subjectOrder || []);
    const remainderBoxes = [...session.pendingByInstance.entries()]
      .filter(([, remainder]) => remainder.length)
      .sort(([aId], [bId]) => {
        const ca = session.coursesById.get(aId);
        const cb = session.coursesById.get(bId);
        const s = remainderSubject(SubjectOrderCore.label(ca && ca.subject), SubjectOrderCore.label(cb && cb.subject));
        if (s !== 0) return s;
        return String((ca && ca.name) || aId).localeCompare(String((cb && cb.name) || bId));
      });
    for (const [instanceId, remainder] of remainderBoxes) {
      const inst = session.coursesById.get(instanceId);
      const expanded = session.expandedRemainders.has(instanceId);
      const shown = expanded ? remainder : remainder.slice(0, REMAINDER_PREVIEW);

      const box = document.createElement('details');
      box.className = 'pending-box';
      box.open = session.openRemainders.has(instanceId);
      box.addEventListener('toggle', () => {
        if (box.open) session.openRemainders.add(instanceId);
        else session.openRemainders.delete(instanceId);
      });

      const summary = document.createElement('summary');
      summary.textContent = `Pending remainder — ${inst ? inst.name : instanceId} (${remainder.length})`;
      box.appendChild(summary);

      shown.forEach((a) => {
        const row = document.createElement('div');
        const typeLabel = session.maps.typeLabel.get(a.activityType) || a.activityType;
        // The more important of the two rows the lesson title reaches (§2.3):
        // this is where Pull-forward is actually chosen, and "Practice level 3"
        // appearing four times in a bucket of thirty is unusable when the
        // parent is being asked to pick one of them by name.
        row.innerHTML = `<span>${lessonPrefix(a)}${escapeHtml(a.title)} <code>${escapeHtml(a.id)}</code> <em>${escapeHtml(typeLabel)}</em></span> `;
        const btn = document.createElement('button');
        btn.textContent = 'Pull forward →';
        btn.addEventListener('click', () => {
          const toDate = window.prompt(`Pull "${a.title}" forward onto which in-range date (YYYY-MM-DD)?`, session.coversFrom);
          if (!toDate) return;
          const r = pullForward(instanceId, a.id, toDate.trim());
          if (r.error) window.alert(r.error);
          session.openRemainders.add(instanceId); // stay open — likely pulling more than one
          render(root);
        });
        row.appendChild(btn);
        box.appendChild(row);
      });

      if (remainder.length > REMAINDER_PREVIEW) {
        const toggleRow = document.createElement('div');
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'secondary';
        toggleBtn.textContent = expanded ? 'Show fewer' : `Show ${remainder.length - REMAINDER_PREVIEW} more`;
        toggleBtn.addEventListener('click', () => {
          if (expanded) session.expandedRemainders.delete(instanceId);
          else session.expandedRemainders.add(instanceId);
          session.openRemainders.add(instanceId);
          render(root);
        });
        toggleRow.appendChild(toggleBtn);
        box.appendChild(toggleRow);
      }

      root.appendChild(box);
    }

    const dates = [...session.days.keys()].filter((d) => {
      const o = session.days.get(d);
      return o.activities.length || o.chores.length || o.events.length;
    }).sort();

    if (dates.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Proposal is empty — nothing to commit for this child and range' +
        (includedKinds(session.include).length === KINDS.length
          ? '.'
          : ` within ${scopeLabel(session.include).toLowerCase()}. Abandon and propose again with the other kinds ticked to see them.`);
      root.appendChild(empty);
      return;
    }

    for (const date of dates) {
      const o = session.days.get(date);
      const section = document.createElement('section');
      section.className = 'day-section';

      const total = o.activities.length + o.chores.length + o.events.length;
      const live = [o.activities, o.chores, o.events]
        .reduce((n, list) => n + list.filter((it) => it.committed).length, 0);
      section.innerHTML = `<h3>${escapeHtml(date)} <em>(${weekday(date)})</em> ` +
        `<span class="day-count">${total} item${total === 1 ? '' : 's'}` +
        `${live ? ` &middot; ${live} already assigned` : ''}</span></h3>`;

      // Fixed merge order — School, then Chores, then Family events (FR-14) —
      // unchanged. Grouping happens *within* the School band; the bands
      // themselves and the 0/1000/2000 numbering are untouched (§0).
      for (const group of subjectGroups(o.activities)) {
        const subjectBox = groupBox(
          'review-subject-group', `${date}::subject::${group.subject}`, `${group.subject} (${group.count})`
        );
        for (const course of group.courses) {
          const courseBox = groupBox(
            'review-course-group', `${date}::course::${course.instanceId}`, `${course.name} (${course.items.length})`
          );
          const ul = document.createElement('ul');
          course.items.forEach((it) => ul.appendChild(activityRow(root, date, it)));
          courseBox.appendChild(ul);
          subjectBox.appendChild(courseBox);
        }
        section.appendChild(subjectBox);
      }

      // One group each, at the bottom. Not reported as a problem, but a day
      // with twelve chore occurrences on it has the same wall of rows the
      // school half had, and the group costs one <details> (§2.2).
      if (o.chores.length) {
        const box = groupBox('review-subject-group', `${date}::chores`, `Chores (${o.chores.length})`);
        const ul = document.createElement('ul');
        o.chores.forEach((it) => ul.appendChild(choreRow(root, date, it)));
        box.appendChild(ul);
        section.appendChild(box);
      }
      if (o.events.length) {
        const box = groupBox('review-subject-group', `${date}::events`, `Family events (${o.events.length})`);
        const ul = document.createElement('ul');
        o.events.forEach((it) => ul.appendChild(eventRow(it)));
        box.appendChild(ul);
        section.appendChild(box);
      }

      root.appendChild(section);
    }
  }

  // Group open/closed state lives on the session, not the DOM, for the reason
  // `openRemainders` already does: every Review action re-renders the whole
  // proposal, and a group that collapsed itself under the parent mid-edit is
  // worse than no collapse at all. Keys are date-scoped — the same course
  // appears on fourteen days and they are not one thing (§2.6).
  //
  // Default is OPEN on this screen (§7.2): review is "look at all of it before
  // committing", so nothing hides itself and collapsing is how the parent marks
  // a part as cleared. `knownGroups` is what tells the two states apart — a key
  // drawn for the first time is opened; one drawn before and absent from
  // `openGroups` was closed on purpose and stays closed across the re-render.
  // (Contrast the Assignments view, §3.2, which defaults closed for the
  // opposite reason. One constant in each file if either reads wrong.)
  function groupBox(className, key, summaryText) {
    const details = document.createElement('details');
    details.className = className;
    if (!session.knownGroups.has(key)) {
      session.knownGroups.add(key);
      session.openGroups.add(key);
    }
    details.open = session.openGroups.has(key);
    details.addEventListener('toggle', () => {
      if (details.open) session.openGroups.add(key);
      else session.openGroups.delete(key);
    });
    const summary = document.createElement('summary');
    summary.textContent = summaryText;
    details.appendChild(summary);
    return details;
  }

  // The array is already in canonical order (§2.1), so each subject and each
  // course is a contiguous run and gathering them is a walk, not a second
  // sort. That is the point of sorting the array rather than a render-time
  // copy: one definition of the order, read by both this screen and
  // `projectAssignments`.
  function subjectGroups(activities) {
    const groups = [];
    for (const it of activities) {
      const inst = session.coursesById.get(it.instanceId);
      const subject = SubjectOrderCore.label(inst && inst.subject);
      let group = groups[groups.length - 1];
      if (!group || group.subject !== subject) {
        group = { subject, count: 0, courses: [] };
        groups.push(group);
      }
      let course = group.courses[group.courses.length - 1];
      if (!course || course.instanceId !== it.instanceId) {
        course = { instanceId: it.instanceId, name: (inst && inst.name) || it.instanceId, items: [] };
        group.courses.push(course);
      }
      course.items.push(it);
      group.count++;
    }
    return groups;
  }

  // The lesson an activity belongs to, for the row prefix (§2.3). Already in
  // hand — `maps.lessonTitle` is built at Propose and rides into
  // `payload.lessonTitle` at Commit; it simply was never shown to the parent
  // who is deciding. An activity whose `lessonId` resolves to nothing gets no
  // prefix, exactly as before.
  function lessonPrefix(activity) {
    const title = activity && session.maps.lessonTitle.get(activity.lessonId);
    return title ? `${escapeHtml(title)} &mdash; ` : '';
  }

  // An item already live in D1 renders without its action buttons rather than
  // with disabled ones: the actions are not merely unavailable, they belong
  // somewhere else (§6.5's Assignments view), and the tag says where.
  function committedTag(it) {
    return it.committed ? ' <em class="already-assigned">already assigned</em>' : '';
  }

  function activityRow(root, date, it) {
    const li = document.createElement('li');
    li.className = it.committed ? 'item-activity is-committed' : 'item-activity';
    const typeLabel = session.maps.typeLabel.get(it.record.activityType) || it.record.activityType;
    // Lesson title first, then the activity title, then the type label and the
    // existing tags (§2.3). "Practice level 3" on its own was what Ray
    // reported as not enough to decide on; the lesson is the context that
    // makes it a decision.
    li.innerHTML = `<span>📘 ${lessonPrefix(it.record)}${escapeHtml(it.record.title)} <code>${escapeHtml(it.id)}</code> <em>${escapeHtml(typeLabel)} · ${it.origin}${it.blockHint ? ' · ' + it.blockHint : ''}</em>${committedTag(it)}</span> `;
    if (it.committed) return li;
    li.appendChild(makeBtn('Relocate', () => {
      const to = window.prompt('Relocate to date (YYYY-MM-DD):', date);
      if (!to) return;
      const r = relocate('activity', date, it.id, to.trim());
      if (r.error) window.alert(r.error);
      render(root);
    }));
    li.appendChild(makeBtn('Exclude', () => { excludeActivity(date, it.id); render(root); }));
    li.appendChild(makeBtn('Defer', () => { deferActivity(date, it.id); render(root); }));
    return li;
  }

  function choreRow(root, date, it) {
    const li = document.createElement('li');
    li.className = it.committed ? 'item-chore is-committed' : 'item-chore';
    li.innerHTML = `<span>🧹 ${escapeHtml(it.record.title)} <code>${escapeHtml(it.id)}</code>${committedTag(it)}</span> `;
    if (it.committed) return li;
    li.appendChild(makeBtn('Relocate', () => {
      const to = window.prompt('Relocate to date (YYYY-MM-DD):', date);
      if (!to) return;
      const r = relocate('chore', date, it.id, to.trim());
      if (r.error) window.alert(r.error);
      render(root);
    }));
    li.appendChild(makeBtn('Drop', () => { dropChore(date, it.id); render(root); }));
    return li;
  }

  function eventRow(it) {
    const li = document.createElement('li');
    li.className = it.committed ? 'item-event is-committed' : 'item-event';
    li.innerHTML = `<span>📅 ${escapeHtml(it.record.title)} <code>${escapeHtml(it.id)}</code> <em>informational</em>${committedTag(it)}</span>`;
    return li;
  }

  function makeBtn(label, handler) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', handler);
    return b;
  }

  return {
    render,
    // exposed for build-session acceptance checks (§5):
    propose, commit, projectAssignments,
    relocate, excludeActivity, deferActivity, dropChore, pullForward,
    _getSession: () => session,
    _reset: () => { session = null; lastResult = null; },
  };
})();
