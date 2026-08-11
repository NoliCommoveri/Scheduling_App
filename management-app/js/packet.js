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
 */

const Packet = (() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DEFAULT_MINUTES = 15; // Module 05 §2.3 fallback for missing expectedDurationMin

  // §4.5 payload projection map — keyed by canonical activityTypeKey.
  const PAGE_RANGE_KEYS = ['pdf', 'reading-pages'];
  const REFERENCE_KEYS = ['video', 'quiz', 'test', 'report', 'workbook', 'project', 'drill'];
  // 'practice-level' → none; anything else (parent-added AT-… keys) → freeText.

  let session = null; // the in-memory proposal; null between runs
  let lastResult = null; // {ok, message} | {error} for the result banner

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

  // ---- Propose (FR-1–FR-6) — writes nothing ----

  async function propose(childId, semesterLabel, coversFrom, coversTo) {
    if (!isValidDate(coversFrom) || !isValidDate(coversTo)) return { error: 'Both dates must be valid calendar dates.' };
    if (coversFrom > coversTo) return { error: 'coversFrom must be on or before coversTo.' };
    const child = await Storage.get('children', childId);
    if (!child) return { error: 'Select an existing child.' };

    const [activityTypes, tiers, allCourses, allChores, allEvents] = await Promise.all([
      Storage.getAll('activityTypes'),
      Storage.getAll('tiers'),
      Storage.getAll('courses'),
      Storage.getAll('chores'),
      Storage.getAll('familyEvents'),
    ]);

    const maps = {
      typeLabel: new Map(activityTypes.map((t) => [t.activityTypeKey, t.label])),
      rewardCat: new Map(tiers.map((t) => [t.tierId, t.rewardCategoryId])),
      courseName: new Map(allCourses.map((c) => [c.id, c.name])),
    };

    const instances = allCourses.filter((c) => c.state === 'instance' && c.childId === childId);
    const coursesById = new Map(allCourses.map((c) => [c.id, c]));

    // Per-instance walk order + walk-index map (stable blockHint round-robin).
    const walkByInstance = new Map(); // instanceId -> [activity, …] in walk order
    const walkIndex = new Map(); // instanceId -> Map(activityId -> index)
    const blockLayoutByInstance = new Map();
    const instancesWithProfiles = [];
    for (const inst of instances) {
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
    for (const row of logRows) {
      if (row.assignedDate < coversFrom || row.assignedDate > coversTo) continue;
      if (row.disposition !== 'sent') continue; // in-range dropped chore rows are suppressions — not re-proposed
      if (row.instanceId) {
        const record = await Storage.get('activities', row.itemId);
        if (!record) continue; // deleted since — cannot reproduce content
        placeActivity(ensureDay(row.assignedDate), record, row.instanceId, row.assignedDate, 'reproduced');
      } else {
        // Chore occurrence id: CHR-{token}-{YYYYMMDD}.
        const parts = row.itemId.split('-');
        const chore = allChores.find((c) => c.id === 'CHR-' + parts[1]);
        if (!chore) continue;
        ensureDay(row.assignedDate).chores.push({
          kind: 'chore', id: row.itemId, choreId: chore.id, assignedDate: row.assignedDate, disposition: 'sent', record: chore,
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
          placeActivity(dayObj, a, instance.id, d, 'walked');
          load += cost;
          idx++;
        }
      }
      pendingByInstance.set(instance.id, pending.slice(idx)); // remainder available for Pull-forward
    }

    // Step 4 — Chores (FR-3): occurrences with no prior decision.
    for (const chore of allChores.filter((c) => c.childId === childId)) {
      const token = chore.id.slice(4);
      for (const d of rangeDates) {
        if (!(chore.daysOfWeek || []).includes(weekday(d))) continue;
        const occId = `CHR-${token}-${d.replace(/-/g, '')}`;
        if (decisionItemIds.has(occId)) continue; // already reproduced/suppressed
        ensureDay(d).chores.push({ kind: 'chore', id: occId, choreId: chore.id, assignedDate: d, disposition: 'sent', record: chore });
      }
    }

    // Step 5 — Family Events (FR-4): overlap + childIds membership, per covered day.
    for (const ev of allEvents) {
      if (!(ev.childIds || []).includes(childId)) continue;
      if (ev.endDate < coversFrom || ev.startDate > coversTo) continue; // no overlap
      for (const d of rangeDates) {
        if (d >= ev.startDate && d <= ev.endDate) ensureDay(d).events.push({ kind: 'event', id: ev.id, record: ev });
      }
    }

    session = {
      childId, childName: child.name, semesterLabel: (semesterLabel || '').trim(),
      coversFrom, coversTo, days, maps, coursesById,
      droppedChores: new Map(), excluded: new Set(), pendingByInstance,
      // Commit bookkeeping (see the [DECISION] above commit()). batchId is
      // minted on the first Commit attempt and reused by every retry of this
      // same proposal; partial records that some of it reached D1.
      batchId: null, postedRows: 0, partial: false,
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
    const [item] = found.arr.splice(found.i, 1);
    item.assignedDate = toDate;
    if (!session.days.has(toDate)) session.days.set(toDate, { activities: [], chores: [], events: [] });
    (kind === 'activity' ? session.days.get(toDate).activities : session.days.get(toDate).chores).push(item);
    return { ok: true };
  }

  function excludeActivity(fromDate, id) {
    const blocked = reviewGuard();
    if (blocked) return blocked;
    const found = findItem('activity', fromDate, id);
    if (!found) return { error: 'Item not found.' };
    found.arr.splice(found.i, 1);
    session.excluded.add(id); // excludeFromGeneration persisted at Commit
    return { ok: true };
  }

  function deferActivity(fromDate, id) {
    const blocked = reviewGuard();
    if (blocked) return blocked;
    const found = findItem('activity', fromDate, id);
    if (!found) return { error: 'Item not found.' };
    found.arr.splice(found.i, 1); // absence keeps it pending; no write at Commit
    return { ok: true };
  }

  function dropChore(fromDate, id) {
    const blocked = reviewGuard();
    if (blocked) return blocked;
    const found = findItem('chore', fromDate, id);
    if (!found) return { error: 'Item not found.' };
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
    return { ok: true };
  }

  // ---- Payload projection (§4.5) ----
  //
  // All that survives of the packet projections: the kind-specific half of an
  // activity's payload, which assignmentFromActivity still builds on. It maps
  // an activity type to a payload shape and has nothing to do with the
  // interchange allow-lists the rest of §4.5 described.

  function projectPayload(activityTypeKey, stored) {
    if (PAGE_RANGE_KEYS.includes(activityTypeKey)) {
      return { kind: 'pageRange', pageRangeStart: stored.pageRangeStart, pageRangeEnd: stored.pageRangeEnd };
    }
    if (REFERENCE_KEYS.includes(activityTypeKey)) return { kind: 'reference', reference: stored.reference };
    if (activityTypeKey === 'practice-level') return { kind: 'none' };
    return { kind: 'freeText', text: stored.text }; // any parent-added key
  }

  // ---- Assignment projection (Revamp §3.3) — the Phase 3 write path ----

  // The Worker enforces a closed allow-list of writable columns and rejects an
  // entire batch with 400 if a row carries anything else (§4.2). So this
  // projection is deliberately strict, and every field that has no column of
  // its own goes inside `payload` — which §3.3 types as "JSON: pageRange,
  // instructions, etc." Nothing but this function enforces that shape, so per
  // §3.7.1's rule for JSON-in-TEXT it is written down here:
  //
  //   activity → { kind, …kind-specific, required, capturesGrade,
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
    const payload = Object.assign(projectPayload(a.activityType, a.payload || {}), {
      required: !!a.required,
      capturesGrade: !!a.capturesGrade,
      difficultyTier: a.difficultyTier,
    });
    if (a.lessonTitle) payload.lessonTitle = a.lessonTitle;
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
    if (a.sequenceNumber != null) row.sequenceNo = a.sequenceNumber;
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
      title: c.title,
      rewardCategory: session.maps.rewardCat.get(c.difficultyTier),
      payload,
      sortOrder,
    };
    if (c.blockHint) row.blockHint = c.blockHint;
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
      let sortOrder = 0;
      for (const it of o.activities) rows.push(assignmentFromActivity(it, sortOrder++));
      for (const it of o.chores) rows.push(assignmentFromChore(it, sortOrder++));
      for (const it of o.events) rows.push(assignmentFromEvent(it, date, sortOrder++));
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
      if (onChunk) onChunk(posted);
    }
    return posted;
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
    if (!rows.length && !sentRows.length && !droppedRows.length && !excludeIds.length) {
      return { error: 'Nothing to generate for this child and range (empty-source).' };
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

    if (rows.length) {
      const { enabled } = await Sync.getConfig();
      if (!enabled) {
        return { error: 'Commit needs the parent sync token — set it in Settings → Sync, then Commit again. Nothing was written.' };
      }
      try {
        assignedCount = await postAssignments(batchId, rows, (posted) => {
          session.postedRows = posted;
          session.partial = true;
        });
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
    form.innerHTML = `
      <h2>Propose assignments</h2>
      <label>Child<select name="childId">${opts}</select></label>
      <label>Semester label<input type="text" name="semesterLabel" placeholder="e.g. Fall 2026"></label>
      <label>Covers from<input type="date" name="coversFrom" required></label>
      <label>Covers to<input type="date" name="coversTo" required></label>
      <p class="error" hidden></p>
      <button type="submit">Propose</button>
    `;
    const errorEl = form.querySelector('.error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      lastResult = null;
      const result = await propose(form.childId.value, form.semesterLabel.value, form.coversFrom.value, form.coversTo.value);
      if (result.error) {
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }
      render(root);
    });
    root.appendChild(form);
  }

  function renderProposal(root) {
    const bar = document.createElement('div');
    bar.className = 'propose-bar';
    bar.innerHTML = `<h2>Proposal — ${escapeHtml(session.childName)} · ${session.coversFrom} → ${session.coversTo}</h2>`;

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
      lastResult = {
        message: `Committed: ${result.assignedCount} assigned to D1, ${result.droppedCount} dropped, ` +
          `${result.excludedCount} excluded (batch ${result.batchId}). ` +
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
    root.appendChild(bar);

    if (session.partial) {
      const warning = document.createElement('p');
      warning.className = 'error';
      warning.textContent =
        `${session.postedRows} rows from this proposal are already live under batch ${session.batchId}. ` +
        'Commit again to send the rest, or Abandon to pull them back. Editing is locked until then.';
      root.appendChild(warning);
    }

    // Pending remainder (Pull-forward source) per instance.
    for (const [instanceId, remainder] of session.pendingByInstance) {
      if (!remainder.length) continue;
      const inst = session.coursesById.get(instanceId);
      const box = document.createElement('div');
      box.className = 'pending-box';
      box.innerHTML = `<h3>Pending remainder — ${escapeHtml(inst ? inst.name : instanceId)} (${remainder.length})</h3>`;
      remainder.forEach((a) => {
        const row = document.createElement('div');
        row.innerHTML = `<span>${escapeHtml(a.title)} <code>${escapeHtml(a.id)}</code></span> `;
        const btn = document.createElement('button');
        btn.textContent = 'Pull forward →';
        btn.addEventListener('click', () => {
          const toDate = window.prompt(`Pull "${a.title}" forward onto which in-range date (YYYY-MM-DD)?`, session.coversFrom);
          if (!toDate) return;
          const r = pullForward(instanceId, a.id, toDate.trim());
          if (r.error) window.alert(r.error);
          render(root);
        });
        row.appendChild(btn);
        box.appendChild(row);
      });
      root.appendChild(box);
    }

    const dates = [...session.days.keys()].filter((d) => {
      const o = session.days.get(d);
      return o.activities.length || o.chores.length || o.events.length;
    }).sort();

    if (dates.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Proposal is empty — nothing to commit for this child and range.';
      root.appendChild(empty);
      return;
    }

    for (const date of dates) {
      const o = session.days.get(date);
      const section = document.createElement('section');
      section.className = 'day-section';
      section.innerHTML = `<h3>${date} <em>(${weekday(date)})</em></h3>`;

      // Fixed merge order: activities, then chores, then events (FR-6).
      const ul = document.createElement('ul');
      o.activities.forEach((it) => ul.appendChild(activityRow(root, date, it)));
      o.chores.forEach((it) => ul.appendChild(choreRow(root, date, it)));
      o.events.forEach((it) => ul.appendChild(eventRow(it)));
      section.appendChild(ul);
      root.appendChild(section);
    }
  }

  function activityRow(root, date, it) {
    const li = document.createElement('li');
    li.className = 'item-activity';
    li.innerHTML = `<span>📘 ${escapeHtml(it.record.title)} <code>${escapeHtml(it.id)}</code> <em>${it.origin}${it.blockHint ? ' · ' + it.blockHint : ''}</em></span> `;
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
    li.className = 'item-chore';
    li.innerHTML = `<span>🧹 ${escapeHtml(it.record.title)} <code>${escapeHtml(it.id)}</code></span> `;
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
    li.className = 'item-event';
    li.innerHTML = `<span>📅 ${escapeHtml(it.record.title)} <code>${escapeHtml(it.id)}</code> <em>informational</em></span>`;
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
