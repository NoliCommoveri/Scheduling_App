/* Module: packet.js — Module 08, Packet Generation & Export (THE SEAM).
 * Per SRS_Management_Module_08_Packet_Generation_Export.md (reconciled by
 * TDS_Slice_M7_Management_App_Rev1.md §4 — cursor retired; Propose/Review/
 * Commit; Generation Log is the source of truth).
 *
 * Sole writer of `generationLog` anywhere in the system. Also sets
 * `excludeFromGeneration` on `activities` at Commit. Reads pacingProfiles/
 * courses/lessons/activities/activityTypes/tiers/chores/familyEvents.
 * Three stages held in one in-memory session; ONLY Commit writes. */

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

  function findItem(kind, date, id) {
    const day = session.days.get(date);
    if (!day) return null;
    const arr = kind === 'activity' ? day.activities : kind === 'chore' ? day.chores : day.events;
    const i = arr.findIndex((it) => it.id === id);
    return i === -1 ? null : { arr, i, item: arr[i] };
  }

  function relocate(kind, fromDate, id, toDate) {
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
    const found = findItem('activity', fromDate, id);
    if (!found) return { error: 'Item not found.' };
    found.arr.splice(found.i, 1);
    session.excluded.add(id); // excludeFromGeneration persisted at Commit
    return { ok: true };
  }

  function deferActivity(fromDate, id) {
    const found = findItem('activity', fromDate, id);
    if (!found) return { error: 'Item not found.' };
    found.arr.splice(found.i, 1); // absence keeps it pending; no write at Commit
    return { ok: true };
  }

  function dropChore(fromDate, id) {
    const found = findItem('chore', fromDate, id);
    if (!found) return { error: 'Item not found.' };
    found.arr.splice(found.i, 1);
    session.droppedChores.set(id, { itemId: id, assignedDate: fromDate }); // 'dropped' row at Commit
    return { ok: true };
  }

  function pullForward(instanceId, activityId, toDate) {
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

  // ---- Projection (§4.5) — onto the closed Interchange allow-lists ----

  function projectPayload(activityTypeKey, stored) {
    if (PAGE_RANGE_KEYS.includes(activityTypeKey)) {
      return { kind: 'pageRange', pageRangeStart: stored.pageRangeStart, pageRangeEnd: stored.pageRangeEnd };
    }
    if (REFERENCE_KEYS.includes(activityTypeKey)) return { kind: 'reference', reference: stored.reference };
    if (activityTypeKey === 'practice-level') return { kind: 'none' };
    return { kind: 'freeText', text: stored.text }; // any parent-added key
  }

  function projectActivity(item) {
    const a = item.record;
    const entry = {
      id: a.id,
      activityType: session.maps.typeLabel.get(a.activityType) || a.activityType, // label, never the key
      title: a.title,
      required: !!a.required,
      payload: projectPayload(a.activityType, a.payload || {}),
      difficultyTier: a.difficultyTier,
      rewardCategoryId: session.maps.rewardCat.get(a.difficultyTier),
      courseName: session.maps.courseName.get(item.instanceId),
      capturesGrade: !!a.capturesGrade,
    };
    if (a.expectedDurationMin != null) entry.expectedDurationMin = a.expectedDurationMin;
    if (item.blockHint) entry.blockHint = item.blockHint;
    if (a.sequenceNumber != null) entry.sequenceNumber = a.sequenceNumber;
    if (a.lessonTitle) entry.lessonTitle = a.lessonTitle;
    if (a.instructions) entry.instructions = a.instructions;
    return entry;
  }

  function projectChore(item) {
    const c = item.record;
    const entry = {
      id: item.id,
      choreType: c.choreType,
      title: c.title,
      date: item.assignedDate,
      difficultyTier: c.difficultyTier,
      rewardCategoryId: session.maps.rewardCat.get(c.difficultyTier),
      required: true,
    };
    if (c.notes) entry.notes = c.notes;
    if (c.blockHint) entry.blockHint = c.blockHint;
    return entry;
  }

  function projectEvent(item) {
    const e = item.record;
    const entry = { id: e.id, title: e.title, startDate: e.startDate, endDate: e.endDate };
    if (e.notes) entry.notes = e.notes;
    if (e.time) entry.time = e.time;
    return entry;
  }

  function buildPacket() {
    const dayList = [...session.days.entries()]
      .filter(([, o]) => o.activities.length || o.chores.length || o.events.length)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, o]) => ({
        date,
        activities: o.activities.map(projectActivity),
        chores: o.chores.map(projectChore),
        events: o.events.map(projectEvent),
      }));
    return {
      schemaVersion: 1,
      childId: session.childId,
      childName: session.childName,
      semesterLabel: session.semesterLabel,
      generatedAt: new Date().toISOString(),
      coversFrom: session.coversFrom,
      coversTo: session.coversTo,
      days: dayList,
    };
  }

  // ---- Validation (§4.6) — packet_schema.json shape + FR-13 structural pass ----

  function only(obj, allowed) {
    return Object.keys(obj).every((k) => allowed.includes(k));
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ACT_ID_RE = /^[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+$/;
  const CHR_ID_RE = /^CHR-[A-Za-z0-9]+-\d{8}$/;
  const EVT_ID_RE = /^EVT-[A-Za-z0-9]+$/;
  const CHORE_TYPES = [
    'Pet Care', 'Car Care', 'Kitchen/Dining', 'Bathroom', 'Living/Main Area',
    'Playroom', 'Bedroom', "Parent's Room", 'Porch', 'Floors', 'Miscellaneous',
  ];

  function validatePayload(p, path, errors) {
    if (typeof p !== 'object' || p === null) return errors.push(`${path}: payload must be an object`);
    switch (p.kind) {
      case 'pageRange':
        if (!only(p, ['kind', 'pageRangeStart', 'pageRangeEnd'])) errors.push(`${path}: payload has unexpected keys`);
        if (!Number.isInteger(p.pageRangeStart) || p.pageRangeStart < 0) errors.push(`${path}: pageRangeStart invalid`);
        if (!Number.isInteger(p.pageRangeEnd) || p.pageRangeEnd < 0) errors.push(`${path}: pageRangeEnd invalid`);
        break;
      case 'reference':
        if (!only(p, ['kind', 'reference'])) errors.push(`${path}: payload has unexpected keys`);
        if (typeof p.reference !== 'string' || p.reference.length < 1) errors.push(`${path}: reference invalid`);
        break;
      case 'none':
        if (!only(p, ['kind'])) errors.push(`${path}: payload has unexpected keys`);
        break;
      case 'freeText':
        if (!only(p, ['kind', 'text'])) errors.push(`${path}: payload has unexpected keys`);
        if (typeof p.text !== 'string' || p.text.length < 1) errors.push(`${path}: text invalid`);
        break;
      default:
        errors.push(`${path}: payload.kind is not one of pageRange|reference|none|freeText`);
    }
  }

  const ACT_ALLOWED = [
    'id', 'activityType', 'title', 'required', 'payload', 'difficultyTier', 'rewardCategoryId',
    'courseName', 'capturesGrade', 'expectedDurationMin', 'blockHint', 'sequenceNumber', 'lessonTitle', 'instructions',
  ];
  const ACT_REQUIRED = ['id', 'activityType', 'title', 'required', 'payload', 'difficultyTier', 'rewardCategoryId', 'courseName', 'capturesGrade'];
  const CHR_ALLOWED = ['id', 'choreType', 'title', 'date', 'difficultyTier', 'rewardCategoryId', 'required', 'notes', 'blockHint'];
  const CHR_REQUIRED = ['id', 'choreType', 'title', 'date', 'difficultyTier', 'rewardCategoryId', 'required'];
  const EVT_ALLOWED = ['id', 'title', 'startDate', 'endDate', 'notes', 'time'];
  const EVT_REQUIRED = ['id', 'title', 'startDate', 'endDate'];

  function validatePacket(packet) {
    const errors = [];

    // ---- top-level schema shape ----
    if (packet.schemaVersion !== 1) errors.push('schemaVersion must be 1');
    for (const k of ['childId', 'childName', 'semesterLabel']) {
      if (typeof packet[k] !== 'string') errors.push(`${k} must be a string`);
    }
    if (typeof packet.generatedAt !== 'string') errors.push('generatedAt must be a string');
    if (!DATE_RE.test(packet.coversFrom)) errors.push('coversFrom must be YYYY-MM-DD');
    if (!DATE_RE.test(packet.coversTo)) errors.push('coversTo must be YYYY-MM-DD');
    if (!only(packet, ['schemaVersion', 'childId', 'childName', 'semesterLabel', 'generatedAt', 'coversFrom', 'coversTo', 'days'])) {
      errors.push('packet has unexpected top-level keys');
    }

    // ---- FR-13 structural (Interchange §1 rules the JSON Schema can't express) ----
    if (packet.coversFrom > packet.coversTo) errors.push('coversFrom must be ≤ coversTo');
    const seenDates = new Set();
    const nonEventIds = new Set(); // activities + chores must be globally unique
    const eventIdsPerDay = new Set();

    for (const day of packet.days) {
      if (!only(day, ['date', 'activities', 'chores', 'events'])) errors.push(`day ${day.date}: unexpected keys`);
      if (!DATE_RE.test(day.date)) errors.push(`day date "${day.date}" is not YYYY-MM-DD`);
      if (day.date < packet.coversFrom || day.date > packet.coversTo) errors.push(`day ${day.date} is outside the covered range`);
      if (seenDates.has(day.date)) errors.push(`duplicate day ${day.date}`);
      seenDates.add(day.date);

      for (const a of day.activities) {
        const path = `activity ${a.id} on ${day.date}`;
        if (!only(a, ACT_ALLOWED)) errors.push(`${path}: has non-allow-list fields`);
        for (const r of ACT_REQUIRED) if (a[r] === undefined || a[r] === null) errors.push(`${path}: missing ${r}`);
        if (typeof a.id !== 'string' || !ACT_ID_RE.test(a.id)) errors.push(`${path}: id fails pattern`);
        if (typeof a.required !== 'boolean') errors.push(`${path}: required must be boolean`);
        if (typeof a.capturesGrade !== 'boolean') errors.push(`${path}: capturesGrade must be boolean`);
        if (typeof a.courseName !== 'string' || !a.courseName) errors.push(`${path}: courseName unresolved`);
        if (typeof a.rewardCategoryId !== 'string' || !a.rewardCategoryId) errors.push(`${path}: rewardCategoryId unresolved`);
        if (a.expectedDurationMin !== undefined && (!Number.isInteger(a.expectedDurationMin) || a.expectedDurationMin < 0)) errors.push(`${path}: expectedDurationMin invalid`);
        if (a.sequenceNumber !== undefined && (!Number.isInteger(a.sequenceNumber) || a.sequenceNumber < 1)) errors.push(`${path}: sequenceNumber invalid`);
        validatePayload(a.payload || {}, path, errors);
        if (a.payload) {
          if (a.payload.kind === 'pageRange' && a.payload.pageRangeEnd < a.payload.pageRangeStart) errors.push(`${path}: pageRangeEnd < pageRangeStart`);
          // sequenceNumber required whenever payload is reference or none (schema-invisible — FR-13).
          if ((a.payload.kind === 'reference' || a.payload.kind === 'none') && a.sequenceNumber === undefined) {
            errors.push(`${path}: sequenceNumber is required for a ${a.payload.kind} payload`);
          }
        }
        if (nonEventIds.has(a.id)) errors.push(`${path}: duplicate id`);
        nonEventIds.add(a.id);
      }

      for (const c of day.chores) {
        const path = `chore ${c.id} on ${day.date}`;
        if (!only(c, CHR_ALLOWED)) errors.push(`${path}: has non-allow-list fields`);
        for (const r of CHR_REQUIRED) if (c[r] === undefined || c[r] === null) errors.push(`${path}: missing ${r}`);
        if (typeof c.id !== 'string' || !CHR_ID_RE.test(c.id)) errors.push(`${path}: id fails pattern`);
        if (!CHORE_TYPES.includes(c.choreType)) errors.push(`${path}: choreType not in enum`);
        if (c.required !== true) errors.push(`${path}: required must be true`);
        if (typeof c.rewardCategoryId !== 'string' || !c.rewardCategoryId) errors.push(`${path}: rewardCategoryId unresolved`);
        if (c.date !== day.date) errors.push(`${path}: chore date must equal its enclosing day`);
        if (nonEventIds.has(c.id)) errors.push(`${path}: duplicate id`);
        nonEventIds.add(c.id);
      }

      for (const e of day.events) {
        const path = `event ${e.id} on ${day.date}`;
        if (!only(e, EVT_ALLOWED)) errors.push(`${path}: has non-allow-list fields`);
        for (const r of EVT_REQUIRED) if (e[r] === undefined || e[r] === null) errors.push(`${path}: missing ${r}`);
        if (typeof e.id !== 'string' || !EVT_ID_RE.test(e.id)) errors.push(`${path}: id fails pattern`);
        // A multi-day event repeats its id once per in-range day — allowed. Only same-day repeat and overlap are checked.
        const dayKey = `${day.date}::${e.id}`;
        if (eventIdsPerDay.has(dayKey)) errors.push(`${path}: duplicate event id on the same day`);
        eventIdsPerDay.add(dayKey);
        if (e.endDate < packet.coversFrom || e.startDate > packet.coversTo) errors.push(`${path}: event does not overlap the covered range`);
      }
    }
    return errors;
  }

  // ---- Commit (FR-8–FR-11) — the only writes ----

  async function commit() {
    if (!session) return { error: 'No active proposal.' };
    const packet = buildPacket();

    const generatedAt = packet.generatedAt;
    const sentRows = [];
    for (const [, o] of session.days) {
      for (const it of o.activities) sentRows.push({ childId: session.childId, itemId: it.id, instanceId: it.instanceId, assignedDate: it.assignedDate, disposition: 'sent', generatedAt });
      for (const it of o.chores) sentRows.push({ childId: session.childId, itemId: it.id, assignedDate: it.assignedDate, disposition: 'sent', generatedAt });
    }
    const droppedRows = [...session.droppedChores.values()].map((x) => ({
      childId: session.childId, itemId: x.itemId, assignedDate: x.assignedDate, disposition: 'dropped', generatedAt,
    }));
    const excludeIds = [...session.excluded];

    // Empty-source (FR-7) only when there is nothing to send AND no review
    // decision to record. A proposal reduced to only drops/excludes still
    // commits those decisions (else re-propose would resurface them) — it
    // just exports no file.
    if (packet.days.length === 0 && !sentRows.length && !droppedRows.length && !excludeIds.length) {
      return { error: 'Nothing to generate for this child and range (empty-source).' };
    }

    const errors = validatePacket(packet); // empty days[] is schema-valid
    if (errors.length) return { error: errors[0], errors, packet };

    // One readwrite transaction. put() over the composite key makes reproduction
    // idempotent and relocation an in-place update (FR-10). Deferred: no write.
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

    // Export AFTER the transaction commits — retriable, outside IDB (§4.4.4).
    // Skip the file only when nothing is being sent (decisions still recorded).
    const exported = packet.days.length > 0;
    if (exported) exportPacket(packet);
    return { ok: true, packet, exported, sentCount: sentRows.length, droppedCount: droppedRows.length, excludedCount: excludeIds.length };
  }

  function exportPacket(packet) {
    const slug = session.childName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'child';
    const filename = `packet_${slug}_${packet.coversFrom}_${packet.coversTo}.json`;
    const blob = new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---- Rendering ----

  async function render(root) {
    root.innerHTML = '';
    const heading = document.createElement('h1');
    heading.textContent = 'Packet Generation & Export';
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
    const children = await Storage.getAll('children');
    const form = document.createElement('form');
    const opts = ['<option value="">(select)</option>']
      .concat(children.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`))
      .join('');
    form.innerHTML = `
      <h2>Generate a packet</h2>
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
    commitBtn.textContent = 'Commit & Export';
    commitBtn.addEventListener('click', async () => {
      const result = await commit();
      if (result.error) {
        lastResult = { error: `Commit blocked — ${result.error}` };
        render(root);
        return;
      }
      lastResult = {
        message: `Committed: ${result.sentCount} sent, ${result.droppedCount} dropped, ${result.excludedCount} excluded. ` +
          (result.exported
            ? 'Packet exported — hand it to the Child App to close the seam.'
            : 'No packet exported (nothing to send); decisions were still recorded.'),
      };
      session = null;
      render(root);
    });

    const abandonBtn = document.createElement('button');
    abandonBtn.className = 'secondary';
    abandonBtn.textContent = 'Abandon (write nothing)';
    abandonBtn.addEventListener('click', () => {
      session = null;
      lastResult = { message: 'Proposal abandoned. Nothing was written.' };
      render(root);
    });
    bar.appendChild(commitBtn);
    bar.appendChild(abandonBtn);
    root.appendChild(bar);

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
    propose, commit, validatePacket, buildPacket,
    relocate, excludeActivity, deferActivity, dropChore, pullForward,
    _getSession: () => session,
    _reset: () => { session = null; lastResult = null; },
  };
})();
