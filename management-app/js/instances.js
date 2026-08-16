/* Module: instances.js — Assigned Courses (Course Instances).
 * Per SRS_Management_Module_04_Child_Management.md FR-4/FR-6/FR-9..FR-14 and
 * TDS_Slice_M5_Management_App_Rev7.md §1/§5 — the same requirements this code
 * has always served. Extracted from children.js 2026-08-14; the CRUD below is
 * moved verbatim, not rewritten.
 *
 * WHY IT MOVED. A Course Instance is the most frequently edited record in the
 * app and it had no route: it was reachable only as a section of a child's
 * detail page, three clicks in, while the Course *Template* Library — the
 * thing you almost never want mid-term — was one click away on the nav. That
 * asymmetry made mis-navigation the default. Instances now get a top-level
 * page of their own; templates keep theirs; the two live under different nav
 * hubs so the wrong one is no longer the easier one to reach.
 *
 * SCOPE. This module owns Course *Instances* and everything beneath them —
 * their Lessons and Activities. children.js keeps the child record itself.
 * Both write the courses/lessons/activities stores, partitioned by `state`
 * (courses.js holds 'template', this file holds 'instance') — the same
 * accepted, D-noted split as before, with one fewer file in it than when
 * children.js was also an instance editor.
 *
 * Reads `pacingProfiles` through Pacing only; `pacingProfiles` still has
 * exactly one writer (pacing.js), including the embedded profile form. */

const Instances = (() => {
  const RESERVED_LOWER = ['chr', 'evt', 'tpl'];
  const NO_SUBJECT = 'No subject';

  // Drill-down + filter view state, mirrors courses.js's and pacing.js's
  // pattern: kept outside the DOM so it survives the full re-render every
  // action triggers.
  let viewInstanceId = null;
  let viewLessonId = null;
  let viewKeysInstanceId = null; // when set, the Course's bulk answer-key page
  let editActivityId = null; // when set, the Lesson detail shows the Activity edit form
  let filterChildId = ''; // '' = every child

  // Which subject buckets are expanded. Keyed by subject text only, never by
  // child: a parent who likes "Math" open tends to like it open for every
  // child — the same reasoning (and the same Set) this state had inside
  // children.js.
  const openSubjectGroups = new Set();

  function randomToken(len = 6) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Answer keys (Grading_Assistant §4) ----
  //
  // An answer key is a PDF in R2 at keys/{lessonId}, reachable only through the
  // Worker: `[assets]` points at the repo root, so a key kept in the tree would
  // be world-downloadable, and the child's own device is never allowed to read
  // one. The route has existed since Phase 1 with nothing calling it — this is
  // the screen §4's "written by: Management App upload" always meant.
  //
  // It hangs off the *instance* Lesson, not the template Lesson, because that
  // is the id the grading route resolves from the activity when it fetches the
  // key. worker/index.js's handleGradingKeyUpload says why that is deliberate.
  //
  // Sync.api serializes its body as JSON, so a PDF cannot go through it. These
  // three use fetch directly with the same Bearer header Sync.api sets — the
  // idiom grading-review.js's photo load already uses for a non-JSON payload.

  const ANSWER_KEY_MAX_BYTES = 20 * 1024 * 1024; // MAX_ANSWER_KEY_BYTES, worker/index.js:50

  async function answerKeyRequest(path, { method = 'GET', body, contentType } = {}) {
    const { token } = await Sync.getConfig();
    if (!token) throw new Error('Set the sync token in Settings before managing answer keys.');

    const response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
    });

    if (response.status === 401) throw new Error('Sync token rejected by the server.');
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = await response.json();
        if (parsed && parsed.error) detail = parsed.error;
      } catch { /* non-JSON error body — keep the status line */ }
      throw new Error(detail);
    }
    return response.json();
  }

  // Answers "which of these lessons has a key?" as { keys, error }.
  //
  // `keys` is null — not an empty Map — when the question could not be put to
  // the server at all, because the two are different answers and must render
  // differently: "no key uploaded" is a prompt to upload one, "couldn't check"
  // must not be, or an offline parent is told every lesson is missing a key
  // that is sitting in R2. `error` carries why, so the panel can say "set the
  // sync token" instead of blaming the network for a local misconfiguration.
  // Chunked because the route caps a probe at MAX_ANSWER_KEY_PROBE (200)
  // lessonIds and answers 413 above it (worker/index.js). One long course is
  // nowhere near that, but the bulk screen below asks about every Lesson of a
  // course at once, which is exactly where a 413 would first appear.
  const ANSWER_KEY_PROBE_CHUNK = 100;

  async function listAnswerKeys(lessonIds) {
    if (lessonIds.length === 0) return { keys: new Map(), error: null };
    const chunks = [];
    for (let i = 0; i < lessonIds.length; i += ANSWER_KEY_PROBE_CHUNK) {
      chunks.push(lessonIds.slice(i, i + ANSWER_KEY_PROBE_CHUNK));
    }
    try {
      const responses = await Promise.all(
        chunks.map((chunk) => {
          const query = chunk.map((id) => `lessonId=${encodeURIComponent(id)}`).join('&');
          return answerKeyRequest(`/api/grading/keys?${query}`);
        })
      );
      const keys = new Map();
      for (const response of responses) {
        for (const key of response.keys) keys.set(key.lessonId, key);
      }
      return { keys, error: null };
    } catch (err) {
      return { keys: null, error: err.message };
    }
  }

  function uploadAnswerKey(lessonId, file) {
    return answerKeyRequest(`/api/grading/keys?lessonId=${encodeURIComponent(lessonId)}`, {
      method: 'POST',
      body: file,
      contentType: 'application/pdf',
    });
  }

  function deleteAnswerKey(lessonId) {
    return answerKeyRequest(`/api/grading/keys?lessonId=${encodeURIComponent(lessonId)}`, {
      method: 'DELETE',
    });
  }

  const formatBytes = AnswerKeysCore.formatBytes;

  // The one place a chosen file is judged before it goes up the wire, shared by
  // the per-Lesson panel and the bulk screen so a 30MB scan is refused with the
  // same words in both. The Worker checks all of this again (§5) — this exists
  // so the parent hears about it now rather than after the upload.
  function answerKeyFileProblem(file) {
    const looksPdf = file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name));
    if (!looksPdf) return 'The answer key must be a PDF.';
    if (file.size === 0) return 'That file is empty.';
    if (file.size > ANSWER_KEY_MAX_BYTES) {
      return `That PDF is ${formatBytes(file.size)}; the limit is ${formatBytes(ANSWER_KEY_MAX_BYTES)}.`;
    }
    return null;
  }

  // ---- Instance reads ----

  async function listForChild(childId) {
    const courses = await Storage.getAllByIndex('courses', 'by_childId', childId);
    return courses.filter((c) => c.state === 'instance');
  }

  async function listAll() {
    const courses = await Storage.getAll('courses');
    return courses.filter((c) => c.state === 'instance');
  }

  // ---- Stamping (FR-4) ----

  async function mintInstanceToken() {
    const allCourses = await Storage.getAll('courses');
    const used = new Set(allCourses.filter((c) => c.state === 'instance').map((c) => c.instanceToken));
    let token;
    do {
      token = randomToken();
    } while (used.has(token) || RESERVED_LOWER.includes(token.toLowerCase()));
    return token;
  }

  async function stampCourse(templateCourseId, childId) {
    const template = await Storage.get('courses', templateCourseId);
    const templateLessons = await Storage.getAllByIndex('lessons', 'by_courseId', templateCourseId);
    const instanceToken = await mintInstanceToken();
    const newCourseId = 'COU-' + randomToken();

    const newCourse = {
      id: newCourseId,
      name: template.name,
      curriculumId: template.curriculumId,
      courseCode: template.courseCode,
      mainCategory: template.mainCategory,
      state: 'instance',
      sourceTemplateId: template.id,
      childId,
      instanceToken,
    };
    if (template.coreElective) newCourse.coreElective = template.coreElective;
    if (template.subject) newCourse.subject = template.subject;
    if (template.description) newCourse.description = template.description;
    if (template.defaultPacingHint) newCourse.defaultPacingHint = template.defaultPacingHint;
    // template.titlePatterns is deliberately not copied here — the recipe is
    // template-only (D4); an instance would carry a field nothing reads.

    const lessonIdMap = new Map(); // templateLessonId -> new instance lesson
    const newLessons = [];
    for (const tl of templateLessons) {
      const newLesson = {
        id: 'LSN-' + randomToken(),
        courseId: newCourseId,
        lessonCode: tl.lessonCode,
        order: tl.order,
        title: tl.title,
        nextActivitySeq: tl.nextActivitySeq, // copied forward, not reset (D4/FR-4 step 3)
      };
      if (tl.objective) newLesson.objective = tl.objective;
      if (tl.estimatedDays !== undefined) newLesson.estimatedDays = tl.estimatedDays;
      lessonIdMap.set(tl.id, newLesson);
      newLessons.push(newLesson);
    }

    const newActivities = [];
    for (const tl of templateLessons) {
      const newLesson = lessonIdMap.get(tl.id);
      const templateActivities = await Storage.getAllByIndex('activities', 'by_lessonId', tl.id);
      for (const ta of templateActivities) {
        // Only segment 2 (TPL -> instanceToken) changes; segments 1/3/4
        // (courseCode/lessonCode/seq) are reused byte-for-byte (FR-4 step 4).
        const segments = ta.id.split('-');
        const newId = [segments[0], instanceToken, segments[2], segments[3]].join('-');
        const newActivity = { ...ta, id: newId, lessonId: newLesson.id };
        delete newActivity.excludeFromGeneration; // absent on the copy, same as on the template
        newActivities.push(newActivity);
      }
    }

    await Storage.runTransaction(['courses', 'lessons', 'activities'], 'readwrite', (t) => {
      t.objectStore('courses').put(newCourse);
      for (const l of newLessons) t.objectStore('lessons').put(l);
      for (const a of newActivities) t.objectStore('activities').put(a);
    });

    // A stamped Instance arrives with a starting Pacing Profile, derived from
    // the Course's `defaultPacingHint` (Mgmt SRS 05 §2.6a). Written by
    // pacing.js, not here — `pacingProfiles` has one writer. Deliberately
    // outside the transaction above: a failure leaves a profile-less Instance,
    // which §2.6 already treats as valid, rather than losing the stamp.
    const pacing = await Pacing.ensureDefaultProfile(newCourse.id);

    return { record: newCourse, pacing };
  }

  // Stamp confirmation copy — says what the starting Profile is and where each
  // half of it came from, so the hint's effect is visible rather than magic.
  function describeStamp(pacing) {
    if (!pacing || pacing.error || !pacing.created) {
      return 'Assigned. Set up Pacing for this course as the required next step.';
    }
    const fromHint = [
      pacing.source.days === 'hint' ? 'days' : null,
      pacing.source.budget === 'hint' ? 'pace' : null,
    ].filter(Boolean);
    let provenance;
    if (fromHint.length === 2) provenance = "from the Course's pacing hint";
    else if (fromHint.length === 1) provenance = `with ${fromHint[0]} from the Course's pacing hint, the rest default`;
    else provenance = 'from the defaults (the Course states no pacing hint)';
    return `Assigned. Pacing created ${provenance} — ${pacing.summary}. Adjust it on the course's own page.`;
  }

  // FR-6 — un-assign/delete a Course Instance. Cascades its own Lessons and
  // Activities, and its Pacing Profile (§2.6 — a Profile has no existence
  // independent of its Instance). Never touches the source template.
  async function deleteInstance(instanceId) {
    const lessons = await Storage.getAllByIndex('lessons', 'by_courseId', instanceId);
    await Storage.runTransaction(
      ['courses', 'lessons', 'activities', 'pacingProfiles'],
      'readwrite',
      (t) => {
        const activitiesStore = t.objectStore('activities');
        for (const lesson of lessons) {
          const req = activitiesStore.index('by_lessonId').getAllKeys(lesson.id);
          req.onsuccess = () => {
            for (const key of req.result) activitiesStore.delete(key);
          };
        }
        const lessonsStore = t.objectStore('lessons');
        for (const lesson of lessons) lessonsStore.delete(lesson.id);
        // The Pacing Profile is keyed by this Instance's own id (TDS_Slice_M7
        // §1/§3) — a single delete by key, no scan.
        t.objectStore('pacingProfiles').delete(instanceId);
        t.objectStore('courses').delete(instanceId);
      }
    );
  }

  // ---- Instance Course-level fields (FR-13) ----

  async function editInstanceCourse(instanceId, fields) {
    if (!fields.name || !fields.name.trim()) return { error: 'Name is required.' };
    const existing = await Storage.get('courses', instanceId);
    // courseCode/mainCategory/sourceTemplateId/childId/instanceToken are
    // never accepted here — no new rule, no new code: the same freeze check
    // as the template path (Courses.hasActivitiesBeneathCourse) already
    // produces the freeze from the Instance's first instant (§2.9/FR-13).
    const record = {
      ...existing,
      name: fields.name.trim(),
    };
    if (fields.subject !== undefined) {
      if (fields.subject) record.subject = fields.subject.trim();
      else delete record.subject;
    }
    if (fields.description !== undefined) {
      if (fields.description) record.description = fields.description.trim();
      else delete record.description;
    }
    if (fields.coreElective !== undefined) {
      if (fields.coreElective) record.coreElective = fields.coreElective;
      else delete record.coreElective;
    }
    if (fields.defaultPacingHint !== undefined) {
      if (fields.defaultPacingHint) record.defaultPacingHint = fields.defaultPacingHint.trim();
      else delete record.defaultPacingHint;
    }
    await Storage.put('courses', record);
    return { record };
  }

  // ---- Instance Lesson (FR-9) ----

  async function createInstanceLesson(instanceId, fields) {
    if (!fields.title || !fields.title.trim()) return { error: 'Title is required.' };
    if (fields.order === undefined || fields.order === '') return { error: 'Order is required.' };

    let code = fields.lessonCode && fields.lessonCode.trim();
    if (!code) code = 'L' + String(Number(fields.order) + 1).padStart(2, '0');
    if (!Courses.isAlphanumeric(code)) return { error: 'Lesson code must be alphanumeric only.' };
    if (Courses.isReserved(code)) return { error: `Lesson code may not be "${code.toUpperCase()}" (reserved).` };
    if (await Courses.lessonCodeExists(code, instanceId, undefined)) {
      return { error: 'A Lesson with this code already exists in this course.' };
    }

    const record = {
      id: 'LSN-' + randomToken(),
      courseId: instanceId,
      lessonCode: code,
      order: Number(fields.order),
      title: fields.title.trim(),
      nextActivitySeq: 1,
    };
    await Storage.put('lessons', record);
    return { record };
  }

  async function editInstanceLesson(id, fields) {
    if (!fields.title || !fields.title.trim()) return { error: 'Title is required.' };
    const existing = await Storage.get('lessons', id);
    let lessonCode = existing.lessonCode;
    const requestedCode = fields.lessonCode && fields.lessonCode.trim();
    if (requestedCode && requestedCode.toLocaleUpperCase() !== existing.lessonCode.toLocaleUpperCase()) {
      if (await Courses.hasActivitiesUnderLesson(id)) {
        return { error: 'Lesson code is frozen: at least one Activity exists under this Lesson.' };
      }
      if (!Courses.isAlphanumeric(requestedCode)) return { error: 'Lesson code must be alphanumeric only.' };
      if (Courses.isReserved(requestedCode)) return { error: 'Lesson code may not be a reserved value.' };
      if (await Courses.lessonCodeExists(requestedCode, existing.courseId, id)) {
        return { error: 'A Lesson with this code already exists in this course.' };
      }
      lessonCode = requestedCode;
    }
    const record = { ...existing, title: fields.title.trim(), lessonCode };
    await Storage.put('lessons', record);
    return { record };
  }

  // Deletes the Lesson's own Activities. The source template is never touched.
  async function deleteInstanceLesson(id) {
    await Storage.runTransaction(['lessons', 'activities'], 'readwrite', (t) => {
      const activitiesStore = t.objectStore('activities');
      const req = activitiesStore.index('by_lessonId').getAllKeys(id);
      req.onsuccess = () => {
        for (const key of req.result) activitiesStore.delete(key);
      };
      t.objectStore('lessons').delete(id);
    });
  }

  // ---- Instance Activity (FR-10, FR-12, FR-14) ----

  // Optional Activity fields (SRS Module 03 §4), authored identically to the
  // template path (courses.js). Both are absent-when-blank: a blank entry
  // stores no property at all — never "", 0, null, or a default.

  function normalizeOptionalActivityFields(input) {
    const out = {};
    if ('expectedDurationMin' in input) {
      const raw = input.expectedDurationMin;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        out.expectedDurationMin = null;
      } else {
        const n = Number(raw);
        // Positive integer only; the 15-min fallback (Module 05 §2.3) is
        // generation-time math, never persisted — so 0 is not a valid stored value.
        if (!Number.isInteger(n) || n < 1) {
          return { error: 'Expected duration (min) must be a positive whole number, or left blank.' };
        }
        out.expectedDurationMin = n;
      }
    }
    if ('instructions' in input) {
      const raw = input.instructions;
      out.instructions =
        raw === undefined || raw === null || String(raw).trim() === '' ? null : String(raw).trim();
    }
    return { fields: out };
  }

  function applyOptionalActivityFields(record, normalized) {
    for (const key of ['expectedDurationMin', 'instructions']) {
      if (key in normalized) {
        if (normalized[key] === null) delete record[key];
        else record[key] = normalized[key];
      }
    }
  }

  // A new Activity mints from THIS Instance's own instanceToken (read off
  // the owning Course record) and the Lesson's current nextActivitySeq —
  // never max(existing)+1, never a number a deleted Activity once held.
  async function createInstanceActivity(lessonId, fields, type, tier) {
    if (!fields.title || !fields.title.trim()) return { error: 'Title is required.' };
    if (!tier) return { error: 'Difficulty Tier must resolve to an existing Tier.' };
    if (!type) return { error: 'Activity Type must resolve to an existing type.' };

    let pageRangeStart;
    let pageRangeEnd;
    if (type.structurePattern === 'page-range') {
      if (!fields.pageRangeStart || !fields.pageRangeEnd) {
        return { error: 'Page range start and end are required for this Activity Type.' };
      }
      pageRangeStart = Number(fields.pageRangeStart);
      pageRangeEnd = Number(fields.pageRangeEnd);
      if (pageRangeStart > pageRangeEnd) return { error: 'Page range start must not exceed end.' };
    }

    const optNorm = normalizeOptionalActivityFields(fields);
    if (optNorm.error) return { error: optNorm.error };

    const lessonBefore = await Storage.get('lessons', lessonId);
    const instance = await Storage.get('courses', lessonBefore.courseId);
    const existingActivities = await Storage.getAllByIndex('activities', 'by_lessonId', lessonId);
    const order = existingActivities.length ? Math.max(...existingActivities.map((a) => a.order)) + 1 : 0;

    let mintedId;
    await Storage.runTransaction(['lessons', 'activities'], 'readwrite', (t) => {
      const lessonsStore = t.objectStore('lessons');
      const getReq = lessonsStore.get(lessonId);
      getReq.onsuccess = () => {
        const lesson = getReq.result;
        const seq = lesson.nextActivitySeq;
        mintedId = `${instance.courseCode}-${instance.instanceToken}-${lesson.lessonCode}-${String(seq).padStart(2, '0')}`;

        const record = {
          id: mintedId,
          lessonId,
          activityType: type.activityTypeKey,
          title: fields.title.trim(),
          required: !!fields.required,
          difficultyTier: tier.tierId,
          order,
        };
        if (pageRangeStart !== undefined) {
          record.pageRangeStart = pageRangeStart;
          record.pageRangeEnd = pageRangeEnd;
        }
        applyOptionalActivityFields(record, optNorm.fields);

        t.objectStore('activities').put(record);
        lessonsStore.put({ ...lesson, nextActivitySeq: seq + 1 });
      };
    });

    return { id: mintedId };
  }

  // FR-12 — editing/deleting never re-mints the id; the caller (UI layer)
  // surfaces the unconditional divergence warning before calling this.
  async function editInstanceActivity(id, fields, tier) {
    const existing = await Storage.get('activities', id);
    if (!fields.title || !fields.title.trim()) return { error: 'Title is required.' };
    if (!tier) return { error: 'Difficulty Tier must resolve to an existing Tier.' };

    const optNorm = normalizeOptionalActivityFields(fields);
    if (optNorm.error) return { error: optNorm.error };

    // Instance edit writes only this instance row (never the template); spread
    // preserves id/seq/order/instanceToken-derived id/page range — editing
    // never re-mints.
    const record = { ...existing, title: fields.title.trim(), required: !!fields.required, difficultyTier: tier.tierId };
    applyOptionalActivityFields(record, optNorm.fields);
    await Storage.put('activities', record);
    return { record };
  }

  async function deleteInstanceActivity(id) {
    await Storage.del('activities', id);
  }

  // FR-14 — bool, default false (represented as an absent key). Writable
  // here at any time, independent of Packet Generation's Propose/Review/
  // Commit cycle. Never available on a template Activity (this function is
  // only ever called from the Instance Activity view).
  async function setExcludeFromGeneration(activityId, value) {
    const activity = await Storage.get('activities', activityId);
    const record = { ...activity };
    if (value) record.excludeFromGeneration = true;
    else delete record.excludeFromGeneration;
    await Storage.put('activities', record);
    return { record };
  }

  // ---- Navigation ----

  // Entry point for "show me this child's courses", called from the Children
  // page. Sets the filter and hands off to the router rather than rendering
  // directly, so the address bar and the nav highlight agree with what is
  // on screen.
  function openForChild(childId) {
    filterChildId = childId || '';
    viewInstanceId = null;
    viewLessonId = null;
    editActivityId = null;
    App.navigate('#/assigned-courses');
  }

  // ---- Rendering ----

  async function render(root) {
    if (viewKeysInstanceId) return renderAnswerKeysPage(root);
    if (viewLessonId) return renderLessonDetail(root);
    if (viewInstanceId) return renderInstanceDetail(root);
    return renderList(root);
  }

  // Subject buckets for one child's instances, the same grouping convention
  // (and the same .course-subject-group classes) as the Course Template
  // Library in courses.js — a stamped Instance carries its template's subject
  // forward verbatim, so the two pages sort identically.
  async function buildSubjectGroups(root, instances) {
    const bySubject = new Map();
    instances.forEach((inst) => {
      const subject = (inst.subject && inst.subject.trim()) || NO_SUBJECT;
      if (!bySubject.has(subject)) bySubject.set(subject, []);
      bySubject.get(subject).push(inst);
    });
    const subjects = Array.from(bySubject.keys()).sort((a, b) => {
      if (a === NO_SUBJECT) return 1;
      if (b === NO_SUBJECT) return -1;
      return a.localeCompare(b);
    });

    const groupsEl = document.createElement('div');
    groupsEl.className = 'course-subject-groups';
    for (const subject of subjects) {
      const instancesInSubject = bySubject.get(subject).sort((a, b) => a.name.localeCompare(b.name));

      const details = document.createElement('details');
      details.className = 'course-subject-group';
      details.open = openSubjectGroups.has(subject);
      details.addEventListener('toggle', () => {
        if (details.open) openSubjectGroups.add(subject); else openSubjectGroups.delete(subject);
      });
      const summary = document.createElement('summary');
      summary.textContent = `${subject} (${instancesInSubject.length})`;
      details.appendChild(summary);

      const list = document.createElement('ul');
      list.className = 'instance-list';
      for (const inst of instancesInSubject) {
        // The instance's own curriculumId (copied from the template at stamp
        // time), not the template's name — the instance's name already IS the
        // template's name (that's how stamping builds it), so showing the
        // template name again on the second line was always just the title
        // twice. The publisher/curriculum it came from is the information
        // that line didn't yet carry.
        const curriculum = inst.curriculumId ? await Storage.get('curricula', inst.curriculumId) : null;
        const item = document.createElement('li');
        item.className = 'list-row';
        item.innerHTML = `
          <div class="row-text">
            <span class="row-title instance-name">${escapeHtml(inst.name)}</span>
            <span class="row-meta instance-source">${curriculum ? escapeHtml(curriculum.name) : '(no curriculum)'}</span>
          </div>
          <div class="row-actions">
            <button data-action="open">Open</button>
            <button data-action="delete">Un-assign</button>
          </div>
        `;
        item.querySelector('[data-action="open"]').addEventListener('click', () => {
          viewInstanceId = inst.id;
          render(root);
        });
        item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
          const confirmed = window.confirm(
            `Permanently un-assign "${inst.name}"? This stops all future pacing/generation from it. ` +
            `Content already delivered to the child's device is unaffected.`
          );
          if (!confirmed) return;
          await deleteInstance(inst.id);
          render(root);
        });
        list.appendChild(item);
      }
      details.appendChild(list);
      groupsEl.appendChild(details);
    }
    return groupsEl;
  }

  async function renderList(root) {
    root.innerHTML = '';
    const [children, templates] = await Promise.all([
      Storage.getAll('children'),
      Courses.listCourseTemplates(),
    ]);

    const heading = document.createElement('h1');
    heading.textContent = 'Assigned Courses';
    root.appendChild(heading);

    const intro = document.createElement('p');
    intro.textContent =
      'Every Course assigned to a child — this is what to edit for a mid-term adjustment. ' +
      'Editing here never touches the Course Template it came from.';
    root.appendChild(intro);

    // Archived children are offered in the filter (their instances still
    // exist and stay editable) but never in the assign form below, which
    // matches the archive warning's promise that they stop appearing when you
    // assign work.
    const filterForm = document.createElement('form');
    const filterOptions = ['<option value="">(all children)</option>']
      .concat(
        children.map(
          (c) =>
            `<option value="${escapeHtml(c.id)}"${c.id === filterChildId ? ' selected' : ''}>` +
            `${escapeHtml(c.name)}${Children.isActive(c) ? '' : ' (archived)'}</option>`
        )
      )
      .join('');
    filterForm.innerHTML = `<label>Child<select name="childId">${filterOptions}</select></label>`;
    filterForm.childId.addEventListener('change', () => {
      filterChildId = filterForm.childId.value;
      render(root);
    });
    root.appendChild(filterForm);

    const instances = filterChildId ? await listForChild(filterChildId) : await listAll();

    if (instances.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = filterChildId
        ? 'No Courses assigned to this child yet.'
        : 'No Courses assigned yet. Assign one below.';
      root.appendChild(empty);
    } else if (filterChildId) {
      root.appendChild(await buildSubjectGroups(root, instances));
    } else {
      // Unfiltered: a heading per child, subjects nested beneath. Children in
      // the same order the Children page uses — active first, then archived,
      // each alphabetical — so the two pages read the same way.
      const byChild = new Map();
      for (const inst of instances) {
        if (!byChild.has(inst.childId)) byChild.set(inst.childId, []);
        byChild.get(inst.childId).push(inst);
      }
      const ordered = children
        .filter((c) => byChild.has(c.id))
        .sort(
          (a, b) =>
            (Children.isActive(b) ? 1 : 0) - (Children.isActive(a) ? 1 : 0) ||
            String(a.name).localeCompare(String(b.name))
        );
      for (const child of ordered) {
        const childHeading = document.createElement('h2');
        childHeading.textContent = Children.isActive(child) ? child.name : `${child.name} (archived)`;
        root.appendChild(childHeading);
        root.appendChild(await buildSubjectGroups(root, byChild.get(child.id)));
      }
      // An instance whose child record is gone has no heading to sit under.
      // cascadeDeleteChild cannot produce one (FR-7 blocks the delete while
      // any instance exists), so this is a corruption guard, not a workflow —
      // but silently dropping rows from a list is how corruption stays hidden.
      const orphans = instances.filter((i) => !children.some((c) => c.id === i.childId));
      if (orphans.length) {
        const orphanHeading = document.createElement('h2');
        orphanHeading.textContent = '(no child record)';
        root.appendChild(orphanHeading);
        root.appendChild(await buildSubjectGroups(root, orphans));
      }
    }

    const activeChildren = Children.activeOnly(children);
    const stampForm = document.createElement('form');
    const childOptions = activeChildren
      .map((c) => `<option value="${escapeHtml(c.id)}"${c.id === filterChildId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
    const templateOptions = templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
    stampForm.innerHTML = `
      <h2>Assign a Course</h2>
      <label>Child<select name="childId"><option value="">(select)</option>${childOptions}</select></label>
      <label>Course Template<select name="templateId"><option value="">(select)</option>${templateOptions}</select></label>
      <p class="error" hidden></p>
      <p class="success" hidden></p>
      <button type="submit">Assign</button>
    `;
    const stampErr = stampForm.querySelector('.error');
    const stampOk = stampForm.querySelector('.success');
    stampForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!stampForm.childId.value) {
        stampOk.hidden = true;
        stampErr.hidden = false;
        stampErr.textContent = 'Select a Child.';
        return;
      }
      if (!stampForm.templateId.value) {
        stampOk.hidden = true;
        stampErr.hidden = false;
        stampErr.textContent = 'Select a Course Template.';
        return;
      }
      const stamped = await stampCourse(stampForm.templateId.value, stampForm.childId.value);
      stampErr.hidden = true;
      stampOk.hidden = false;
      stampOk.textContent = describeStamp(stamped.pacing);
      render(root);
    });
    root.appendChild(stampForm);
  }

  async function renderInstanceDetail(root) {
    root.innerHTML = '';
    const instance = await Storage.get('courses', viewInstanceId);
    if (!instance) {
      viewInstanceId = null;
      return render(root);
    }
    const [frozen, child, lessons] = await Promise.all([
      Courses.hasActivitiesBeneathCourse(instance.id),
      Storage.get('children', instance.childId),
      Storage.getAllByIndex('lessons', 'by_courseId', instance.id),
    ]);
    lessons.sort((a, b) => a.order - b.order);

    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back to Assigned Courses';
    backBtn.addEventListener('click', () => {
      viewInstanceId = null;
      render(root);
    });
    root.appendChild(backBtn);

    const heading = document.createElement('h1');
    heading.textContent = instance.name;
    root.appendChild(heading);

    // Whose course this is. On a page that lists every child's courses, the
    // title alone is ambiguous the moment two children study the same book.
    const whose = document.createElement('p');
    whose.className = 'instance-child';
    whose.textContent = child ? `Assigned to ${child.name}` : 'Assigned to (no child record)';
    root.appendChild(whose);

    const editForm = document.createElement('form');
    editForm.innerHTML = `
      <h2>Course details</h2>
      <label>Name<input type="text" name="name" value="${escapeHtml(instance.name)}" required></label>
      <label>Course code (frozen — assigned courses always have Activities beneath them)
        <input type="text" value="${escapeHtml(instance.courseCode)}" disabled>
      </label>
      <label>Subject<input type="text" name="subject" value="${escapeHtml(instance.subject || '')}"></label>
      <label>Description<input type="text" name="description" value="${escapeHtml(instance.description || '')}"></label>
      <p class="error" hidden></p>
      <p class="success" hidden></p>
      <button type="submit">Save</button>
    `;
    const editErr = editForm.querySelector('.error');
    const editOk = editForm.querySelector('.success');
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const renaming = editForm.name.value.trim() !== instance.name;
      if (renaming) {
        const warned = window.confirm(
          'Renaming this Course changes what the child sees on every packet generated ' +
          'afterward — items already delivered keep the old name. Continue?'
        );
        if (!warned) return;
      }
      const result = await editInstanceCourse(instance.id, {
        name: editForm.name.value,
        subject: editForm.subject.value,
        description: editForm.description.value,
      });
      if (result.error) {
        editErr.hidden = false;
        editErr.textContent = result.error;
        return;
      }
      editErr.hidden = true;
      editOk.hidden = false;
      editOk.textContent = 'Saved.';
      render(root);
    });
    root.appendChild(editForm);
    void frozen;

    // Pacing sits on the course it paces rather than on a page of its own —
    // a Profile is 1:1 with a Course Instance and keyed by its id, so a
    // standalone Pacing page could only ever be a second index of this one.
    // pacing.js still owns every write to `pacingProfiles`.
    await Pacing.renderInto(root, instance, () => render(root));

    const lessonHeading = document.createElement('h2');
    lessonHeading.textContent = 'Lessons';
    root.appendChild(lessonHeading);

    // The way in to the bulk answer-key screen. It sits above the Lessons list
    // rather than inside it because it is about all of them at once: a parent
    // starting a term has a folder of PDFs and one course to put them on, and
    // the per-Lesson panel three clicks away made that thirty round trips
    // through this page.
    const keysBar = document.createElement('p');
    keysBar.className = 'course-keys-link';
    const keysBtn = document.createElement('button');
    keysBtn.type = 'button';
    keysBtn.textContent = 'Answer keys for all lessons →';
    keysBtn.addEventListener('click', () => {
      viewKeysInstanceId = instance.id;
      render(root);
    });
    keysBar.appendChild(keysBtn);
    root.appendChild(keysBar);

    const list = document.createElement('ul');
    list.className = 'lesson-list';
    lessons.forEach((l) => {
      const item = document.createElement('li');
      item.className = 'list-row';
      item.dataset.lessonId = l.id;
      item.innerHTML = `
        <div class="row-text">
          <span class="row-title lesson-title">${escapeHtml(l.title)}</span>
          <span class="row-meta lesson-code">${escapeHtml(l.lessonCode)}</span>
          <span class="row-meta answer-key-badge" hidden></span>
        </div>
        <div class="row-actions">
          <button data-action="open">Open</button>
          <button data-action="delete">Delete</button>
        </div>
      `;
      item.querySelector('[data-action="open"]').addEventListener('click', () => {
        viewLessonId = l.id;
        render(root);
      });
      item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        await deleteInstanceLesson(l.id);
        render(root);
      });
      list.appendChild(item);
    });
    root.appendChild(list);

    // Which lessons still need an answer key, answered for the whole course at
    // once. Deliberately not awaited: the Lessons list is useful without it,
    // and a parent who never touches grading should not wait on a request they
    // do not care about. A failure leaves every badge hidden rather than
    // claiming the keys are missing (see listAnswerKeys).
    listAnswerKeys(lessons.map((l) => l.id)).then(({ keys }) => {
      if (!keys) return;
      list.querySelectorAll('.list-row').forEach((row) => {
        const badge = row.querySelector('.answer-key-badge');
        if (!badge) return;
        badge.hidden = false;
        badge.textContent = keys.has(row.dataset.lessonId) ? 'answer key ✓' : 'no answer key';
      });
    });

    const form = document.createElement('form');
    form.innerHTML = `
      <h3>Add Lesson</h3>
      <label>Title<input type="text" name="title" required></label>
      <label>Order<input type="number" name="order" value="${lessons.length}" required></label>
      <label>Lesson code (blank = auto)<input type="text" name="lessonCode"></label>
      <p class="error" hidden></p>
      <button type="submit">Add Lesson</button>
    `;
    const errorEl = form.querySelector('.error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await createInstanceLesson(instance.id, {
        title: form.title.value,
        order: form.order.value,
        lessonCode: form.lessonCode.value,
      });
      if (result.error) {
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }
      render(root);
    });
    root.appendChild(form);
  }

  // ---- The bulk answer-key page (Grading_Assistant §4) ----
  //
  // One page per Course Instance, listing every Lesson with a slot for its
  // answer key. The per-Lesson panel further down still exists and still works;
  // this is the same three routes driven from one screen, because the unit of
  // work is a term's worth of PDFs, not one lesson's.
  //
  // Two ways to fill the slots, both landing in the same place:
  //   1. the file box on a Lesson's own row — for the one key you came to fix;
  //   2. the multi-file picker at the top — pick the whole folder, and
  //      `AnswerKeysCore.matchFiles` places the ones whose filenames are
  //      unambiguous. Whatever it will not guess at waits in the tray with a
  //      dropdown, so an unmatched file is a visible task rather than a
  //      silently mis-filed key (see that module's header for why it refuses
  //      more than it accepts).
  //
  // Nothing uploads until "Upload all" — staging is entirely local, and the
  // parent sees every placement before a byte moves.
  //
  // All of this state lives outside the DOM because every action re-renders
  // the page, the same convention as the drill-down state at the top of this
  // file. `keysPageInstanceId` is what ties the caches to a Course: opening a
  // different one clears them rather than showing another course's pending
  // files.

  let keysPageInstanceId = null;
  const keysPending = new Map(); // lessonId -> File, chosen but not yet uploaded
  let keysStaged = []; // [{ id, file, reason }] — picked, not yet placed on a Lesson
  let keysStatus = null; // { keys: Map|null, error } — null means "not asked yet"
  const keysResults = new Map(); // lessonId -> { ok, message } from the last upload run
  let keysStageErrors = []; // files the picker refused outright (not a PDF, too big, empty)
  let keysSummary = null; // { ok, text } — the last run's one-line verdict
  let keysBusy = false;
  let keysNextStageId = 1;

  function resetKeysPage(instanceId) {
    keysPageInstanceId = instanceId;
    keysPending.clear();
    keysResults.clear();
    keysStaged = [];
    keysStageErrors = [];
    keysStatus = null;
    keysSummary = null;
    keysBusy = false;
  }

  // Accepts what the file picker handed over: PDFs join the tray, anything else
  // is named and refused here rather than failing one at a time mid-upload.
  function stageFiles(fileList, lessons) {
    const rejected = [];
    for (const file of Array.from(fileList)) {
      const problem = answerKeyFileProblem(file);
      if (problem) rejected.push(`${file.name} — ${problem}`);
      else keysStaged.push({ id: `stage-${keysNextStageId++}`, file, reason: '' });
    }
    keysStageErrors = rejected;
    autoPlaceStaged(lessons);
  }

  function autoPlaceStaged(lessons) {
    const { matches, unmatched } = AnswerKeysCore.matchFiles(
      keysStaged.map((s) => ({ id: s.id, name: s.file.name })),
      lessons,
      Array.from(keysPending.keys())
    );
    const byId = new Map(keysStaged.map((s) => [s.id, s]));
    for (const match of matches) {
      const staged = byId.get(match.fileId);
      if (staged) keysPending.set(match.lessonId, staged.file);
    }
    const placed = new Set(matches.map((m) => m.fileId));
    const reasons = new Map(unmatched.map((u) => [u.fileId, u.reason]));
    keysStaged = keysStaged
      .filter((s) => !placed.has(s.id))
      .map((s) => ({ ...s, reason: reasons.get(s.id) || s.reason }));
  }

  function pendingCount() {
    return keysPending.size;
  }

  async function renderAnswerKeysPage(root) {
    const instance = await Storage.get('courses', viewKeysInstanceId);
    if (!instance) {
      viewKeysInstanceId = null;
      return render(root);
    }
    if (keysPageInstanceId !== instance.id) resetKeysPage(instance.id);

    const [child, lessons] = await Promise.all([
      Storage.get('children', instance.childId),
      Storage.getAllByIndex('lessons', 'by_courseId', instance.id),
    ]);
    lessons.sort((a, b) => a.order - b.order);

    root.innerHTML = '';

    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back to Course';
    backBtn.disabled = keysBusy;
    backBtn.addEventListener('click', () => {
      viewKeysInstanceId = null;
      resetKeysPage(null);
      render(root);
    });
    root.appendChild(backBtn);

    const heading = document.createElement('h1');
    heading.textContent = 'Answer keys';
    root.appendChild(heading);

    const whose = document.createElement('p');
    whose.className = 'instance-child';
    whose.textContent = child ? `${instance.name} · ${child.name}` : instance.name;
    root.appendChild(whose);

    const intro = document.createElement('p');
    intro.textContent =
      "One PDF per Lesson, read by the Grading Assistant before it grades a photo of the child's " +
      'page. A Lesson with no key cannot be graded. Keys belong to this assigned Course, not to ' +
      'the Course Template it came from, so a second child studying the same book needs its own ' +
      'copies. Stored outside the app and never sent to a child’s device.';
    root.appendChild(intro);

    if (lessons.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'This Course has no Lessons yet, so there is nothing to key.';
      root.appendChild(empty);
      return;
    }

    root.appendChild(buildStageSection(root, lessons));
    const { list, rowStates } = buildKeyLessonList(root, lessons);
    root.appendChild(list);
    root.appendChild(buildBulkActions(root, lessons, rowStates));

    // One probe for the whole course, and only when the cache is empty — an
    // upload or a removal clears it, so the statuses below are never a stale
    // picture of what is in the bucket.
    if (!keysStatus) {
      listAnswerKeys(lessons.map((l) => l.id)).then((result) => {
        keysStatus = result;
        if (viewKeysInstanceId === instance.id && !keysBusy) render(root);
      });
    }
  }

  function buildStageSection(root, lessons) {
    const section = document.createElement('section');
    section.className = 'key-stage';
    section.innerHTML = `
      <h2>Stage files</h2>
      <p class="row-meta">
        Pick several PDFs at once. Any whose filename clearly names a Lesson — by its code, its
        title, or its number — lands on that Lesson below. The rest wait here for you to place
        them by hand; nothing is guessed at when two Lessons or two files could be meant.
      </p>
      <label>PDFs<input type="file" name="files" accept="application/pdf,.pdf" multiple></label>
      <div class="key-stage-rejects"></div>
      <div class="key-staged"></div>
    `;

    const picker = section.querySelector('[name="files"]');
    picker.disabled = keysBusy;
    picker.addEventListener('change', () => {
      if (!picker.files || picker.files.length === 0) return;
      stageFiles(picker.files, lessons);
      render(root);
    });

    if (keysStageErrors.length) {
      const rejects = section.querySelector('.key-stage-rejects');
      const heading = document.createElement('p');
      heading.className = 'error';
      heading.textContent = `${keysStageErrors.length} file(s) not accepted:`;
      rejects.appendChild(heading);
      const ul = document.createElement('ul');
      ul.className = 'key-reject-list';
      for (const message of keysStageErrors) {
        const li = document.createElement('li');
        li.className = 'row-meta';
        li.textContent = message;
        ul.appendChild(li);
      }
      rejects.appendChild(ul);
    }

    const stagedEl = section.querySelector('.key-staged');
    if (keysStaged.length === 0) {
      if (keysStageErrors.length === 0) {
        const none = document.createElement('p');
        none.className = 'row-meta';
        none.textContent = 'Nothing waiting to be placed.';
        stagedEl.appendChild(none);
      }
      return section;
    }

    const waiting = document.createElement('h3');
    waiting.textContent = `Waiting to be placed (${keysStaged.length})`;
    stagedEl.appendChild(waiting);

    const list = document.createElement('ul');
    list.className = 'key-staged-list';
    for (const staged of keysStaged) {
      // Occupied Lessons stay selectable — assigning to one is a replacement,
      // and the option says whose file it would replace so the choice is made
      // knowing that, rather than discovering it afterwards.
      const options = lessons
        .map((l) => {
          const held = keysPending.get(l.id);
          const suffix = held ? ` — replaces ${held.name}` : '';
          return `<option value="${escapeHtml(l.id)}">${escapeHtml(l.lessonCode)} · ${escapeHtml(l.title)}${escapeHtml(suffix)}</option>`;
        })
        .join('');
      const item = document.createElement('li');
      item.className = 'list-row';
      item.innerHTML = `
        <div class="row-text">
          <span class="row-title">${escapeHtml(staged.file.name)}</span>
          <span class="row-meta">${escapeHtml(formatBytes(staged.file.size))}${staged.reason ? ` · ${escapeHtml(staged.reason)}` : ''}</span>
        </div>
        <div class="row-actions">
          <select aria-label="Lesson for ${escapeHtml(staged.file.name)}"><option value="">(choose a Lesson)</option>${options}</select>
          <button type="button" data-action="assign">Assign</button>
          <button type="button" data-action="discard">Discard</button>
        </div>
      `;
      const select = item.querySelector('select');
      const assignBtn = item.querySelector('[data-action="assign"]');
      const discardBtn = item.querySelector('[data-action="discard"]');
      select.disabled = keysBusy;
      assignBtn.disabled = keysBusy;
      discardBtn.disabled = keysBusy;
      assignBtn.addEventListener('click', () => {
        if (!select.value) return;
        keysPending.set(select.value, staged.file);
        keysStaged = keysStaged.filter((s) => s.id !== staged.id);
        keysResults.delete(select.value);
        render(root);
      });
      discardBtn.addEventListener('click', () => {
        keysStaged = keysStaged.filter((s) => s.id !== staged.id);
        render(root);
      });
      list.appendChild(item);
    }
    stagedEl.appendChild(list);

    const discardAll = document.createElement('button');
    discardAll.type = 'button';
    discardAll.textContent = `Discard all ${keysStaged.length} staged file(s)`;
    discardAll.disabled = keysBusy;
    discardAll.addEventListener('click', () => {
      keysStaged = [];
      keysStageErrors = [];
      render(root);
    });
    stagedEl.appendChild(discardAll);

    return section;
  }

  // What a Lesson's row says about its key, in the order the parent cares
  // about: what just happened to it, then what is about to, then what is
  // already in the bucket.
  function describeKeyRow(lesson) {
    const result = keysResults.get(lesson.id);
    const pending = keysPending.get(lesson.id);
    if (result) {
      // A failure leaves the file pending, so the row says which one it still
      // holds — otherwise the only thing on screen is why the last try failed,
      // and "Upload all (1)" below gives no clue what the 1 is.
      const stillHolding = !result.ok && pending ? ` ${pending.name} is still ready to try again.` : '';
      return { text: `${result.message}${stillHolding}`, className: result.ok ? 'success' : 'error' };
    }

    const existing = keysStatus && keysStatus.keys ? keysStatus.keys.get(lesson.id) : null;
    if (pending) {
      const replaces = existing ? ' · replaces the key already uploaded' : '';
      return {
        text: `Ready to upload: ${pending.name} (${formatBytes(pending.size)})${replaces}`,
        className: 'key-row-pending',
      };
    }
    if (!keysStatus) return { text: 'Checking…', className: 'row-meta' };
    if (!keysStatus.keys) {
      return { text: `Could not check for a key — ${keysStatus.error}`, className: 'error' };
    }
    if (existing) {
      const when = existing.uploadedAt ? new Date(existing.uploadedAt).toLocaleString() : 'unknown date';
      return { text: `Answer key uploaded ${when} · ${formatBytes(existing.size)}`, className: 'row-meta' };
    }
    return { text: 'No answer key yet.', className: 'key-row-missing' };
  }

  function buildKeyLessonList(root, lessons) {
    const list = document.createElement('ul');
    list.className = 'key-lesson-list';
    const rowStates = new Map(); // lessonId -> the <span> the upload run writes progress into

    for (const lesson of lessons) {
      const state = describeKeyRow(lesson);
      const hasKey = Boolean(keysStatus && keysStatus.keys && keysStatus.keys.get(lesson.id));
      const item = document.createElement('li');
      item.className = 'list-row key-lesson-row';
      item.dataset.lessonId = lesson.id;
      item.innerHTML = `
        <div class="row-text">
          <span class="row-title">${escapeHtml(lesson.title)}</span>
          <span class="row-meta lesson-code">${escapeHtml(lesson.lessonCode)}</span>
          <span class="key-row-state ${state.className}">${escapeHtml(state.text)}</span>
        </div>
        <div class="row-actions">
          <input type="file" accept="application/pdf,.pdf" aria-label="Answer key for ${escapeHtml(lesson.title)}">
          <button type="button" data-action="clear" hidden>Clear</button>
          <button type="button" data-action="remove" hidden>Remove key</button>
        </div>
      `;

      const fileInput = item.querySelector('input[type="file"]');
      const clearBtn = item.querySelector('[data-action="clear"]');
      const removeBtn = item.querySelector('[data-action="remove"]');
      rowStates.set(lesson.id, item.querySelector('.key-row-state'));

      fileInput.disabled = keysBusy;
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const problem = answerKeyFileProblem(file);
        if (problem) {
          keysResults.set(lesson.id, { ok: false, message: `${file.name} — ${problem}` });
          keysPending.delete(lesson.id);
        } else {
          keysResults.delete(lesson.id);
          keysPending.set(lesson.id, file);
        }
        render(root);
      });

      if (keysPending.has(lesson.id)) {
        clearBtn.hidden = false;
        clearBtn.disabled = keysBusy;
        clearBtn.addEventListener('click', () => {
          keysPending.delete(lesson.id);
          keysResults.delete(lesson.id);
          render(root);
        });
      }

      if (hasKey) {
        removeBtn.hidden = false;
        removeBtn.disabled = keysBusy;
        removeBtn.addEventListener('click', async () => {
          const warned = window.confirm(
            `Remove the answer key for "${lesson.title}"? Grades already proposed keep their ` +
            'scores and transcriptions — but this lesson cannot be graded again until a key is uploaded.'
          );
          if (!warned) return;
          removeBtn.disabled = true;
          try {
            await deleteAnswerKey(lesson.id);
            keysResults.set(lesson.id, { ok: true, message: 'Answer key removed.' });
          } catch (err) {
            keysResults.set(lesson.id, { ok: false, message: `Not removed — ${err.message}` });
          }
          keysStatus = null;
          render(root);
        });
      }

      list.appendChild(item);
    }

    return { list, rowStates };
  }

  function buildBulkActions(root, lessons, rowStates) {
    const bar = document.createElement('div');
    bar.className = 'key-bulk-actions';
    const count = pendingCount();
    bar.innerHTML = `
      <button type="button" data-action="upload-all">Upload all (${count})</button>
      <button type="button" data-action="clear-all">Clear all pending</button>
      <p class="key-bulk-summary" hidden></p>
    `;

    const uploadBtn = bar.querySelector('[data-action="upload-all"]');
    const clearBtn = bar.querySelector('[data-action="clear-all"]');
    const summaryEl = bar.querySelector('.key-bulk-summary');

    if (keysSummary) {
      summaryEl.hidden = false;
      summaryEl.className = `key-bulk-summary ${keysSummary.ok ? 'success' : 'error'}`;
      summaryEl.textContent = keysSummary.text;
    }

    uploadBtn.disabled = keysBusy || count === 0;
    clearBtn.disabled = keysBusy || count === 0;

    clearBtn.addEventListener('click', () => {
      keysPending.clear();
      keysResults.clear();
      keysSummary = null;
      render(root);
    });

    uploadBtn.addEventListener('click', () => uploadAllPending(root, lessons, rowStates, uploadBtn));

    return bar;
  }

  // The run. Sequential on purpose: these are multi-megabyte PDFs on a home
  // connection, and twenty parallel PUTs would stall each other and make the
  // per-row progress meaningless. Each Lesson's outcome is written to its own
  // row as it happens, so a failure at file 12 of 20 names the file rather than
  // failing the batch.
  //
  // A failure leaves that Lesson's file pending — the batch is not a
  // transaction and nothing here pretends it is; "Upload all" again retries
  // exactly what did not land.
  async function uploadAllPending(root, lessons, rowStates, uploadBtn) {
    const queue = lessons.filter((l) => keysPending.has(l.id));
    if (queue.length === 0) return;

    const replacing = queue.filter((l) => keysStatus && keysStatus.keys && keysStatus.keys.has(l.id));
    if (replacing.length) {
      const which = replacing.map((l) => l.lessonCode).join(', ');
      const warned = window.confirm(
        `${replacing.length} of these Lessons already have an answer key (${which}). ` +
        'Uploading replaces them. Continue?'
      );
      if (!warned) return;
    }

    keysBusy = true;
    keysSummary = null;
    keysResults.clear();
    keysStageErrors = []; // the picker's complaints belong to the pick, not to this run
    uploadBtn.disabled = true;

    let done = 0;
    let failed = 0;
    for (const lesson of queue) {
      const stateEl = rowStates.get(lesson.id);
      const file = keysPending.get(lesson.id);
      if (stateEl) {
        stateEl.className = 'key-row-state row-meta';
        stateEl.textContent = `Uploading ${file.name}…`;
      }
      uploadBtn.textContent = `Uploading ${done + failed + 1} of ${queue.length}…`;
      try {
        await uploadAnswerKey(lesson.id, file);
        keysPending.delete(lesson.id);
        keysResults.set(lesson.id, { ok: true, message: `Uploaded ${file.name}.` });
        done += 1;
        if (stateEl) {
          stateEl.className = 'key-row-state success';
          stateEl.textContent = `Uploaded ${file.name}.`;
        }
      } catch (err) {
        keysResults.set(lesson.id, { ok: false, message: `Not uploaded — ${err.message}` });
        failed += 1;
        if (stateEl) {
          stateEl.className = 'key-row-state error';
          stateEl.textContent = `Not uploaded — ${err.message}`;
        }
      }
    }

    keysSummary = {
      ok: failed === 0,
      text: failed === 0
        ? `${done} answer key(s) uploaded.`
        : `${done} uploaded, ${failed} failed — the failed files are still listed below, ready to try again.`,
    };
    keysBusy = false;
    keysStatus = null; // re-probe: the bucket has changed
    render(root);
  }

  async function renderLessonDetail(root) {
    root.innerHTML = '';
    const lesson = await Storage.get('lessons', viewLessonId);
    if (!lesson) {
      viewLessonId = null;
      return render(root);
    }
    const [activityTypes, tiers] = await Promise.all([Storage.getAll('activityTypes'), Tiers.listSorted()]);
    const activities = (await Storage.getAllByIndex('activities', 'by_lessonId', lesson.id)).sort(
      (a, b) => a.order - b.order
    );

    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back to Course';
    backBtn.addEventListener('click', () => {
      viewLessonId = null;
      render(root);
    });
    root.appendChild(backBtn);

    const heading = document.createElement('h1');
    heading.textContent = lesson.title;
    root.appendChild(heading);

    if (editActivityId) {
      const activity = activities.find((a) => a.id === editActivityId);
      if (!activity) {
        editActivityId = null;
      } else {
        root.appendChild(buildActivityEditForm(root, lesson, activity, activityTypes, tiers));
        return;
      }
    }

    const list = document.createElement('ul');
    list.className = 'activity-list';
    activities.forEach((a, index) => {
      const typeLabel = (activityTypes.find((t) => t.activityTypeKey === a.activityType) || {}).label || a.activityType;
      const item = document.createElement('li');
      item.className = 'list-row has-reorder';
      item.innerHTML = `
        <div class="row-main">
          <div class="row-text">
            <span class="row-title activity-title">${escapeHtml(a.title)}</span>
            <span class="row-meta activity-type">${escapeHtml(typeLabel)}</span>
            <span class="row-id activity-id">${a.id}</span>
          </div>
          <label class="row-extra exclude-toggle">
            <input type="checkbox" data-action="exclude" ${a.excludeFromGeneration ? 'checked' : ''}> Exclude from generation
          </label>
          <div class="row-actions">
            <button data-action="edit">Edit</button>
            <button data-action="delete">Delete</button>
          </div>
        </div>
        <div class="row-reorder">
          <button data-action="up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>&uarr;</button>
          <button data-action="down" aria-label="Move down" ${index === activities.length - 1 ? 'disabled' : ''}>&darr;</button>
        </div>
      `;
      item.querySelector('[data-action="up"]').addEventListener('click', async () => {
        await Courses.moveActivity(lesson.id, a.id, 'up');
        render(root);
      });
      item.querySelector('[data-action="down"]').addEventListener('click', async () => {
        await Courses.moveActivity(lesson.id, a.id, 'down');
        render(root);
      });
      item.querySelector('[data-action="exclude"]').addEventListener('change', async (e) => {
        await setExcludeFromGeneration(a.id, e.target.checked);
      });
      item.querySelector('[data-action="edit"]').addEventListener('click', () => {
        editActivityId = a.id;
        render(root);
      });
      item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const warned = window.confirm(
          'Deleting this Activity: if the child already received it, nothing is recalled from their ' +
          'device. If they already completed it, their eventual completion row will land unmatched at ' +
          'import. Continue?'
        );
        if (!warned) return;
        await deleteInstanceActivity(a.id);
        render(root);
      });
      list.appendChild(item);
    });
    root.appendChild(list);

    // Between the Lesson's contents and the form for adding more: the answer
    // key describes this Lesson, like the Activities above it, rather than
    // being another thing to author into it.
    root.appendChild(buildAnswerKeySection(lesson));
    root.appendChild(buildActivityForm(root, lesson, activityTypes, tiers));
  }

  // The answer key panel on a Lesson. Renders immediately in a "checking"
  // state and fills in from the network, so a slow or absent connection costs
  // the rest of the Lesson page nothing.
  function buildAnswerKeySection(lesson) {
    const section = document.createElement('section');
    section.className = 'answer-key';
    section.innerHTML = `
      <h3>Answer key</h3>
      <p class="row-meta">
        A PDF of this lesson's answers, read by the Grading Assistant before it grades a photo of
        the child's page. Without one, grading this lesson's activities fails with a message asking
        for it. Stored outside the app and never sent to a child's device.
      </p>
      <p class="answer-key-state row-meta">Checking…</p>
      <form class="answer-key-form">
        <label>PDF<input type="file" name="file" accept="application/pdf,.pdf" required></label>
        <div class="answer-key-actions">
          <button type="submit">Upload</button>
          <button type="button" data-action="remove" hidden>Remove</button>
        </div>
      </form>
      <p class="error" hidden></p>
      <p class="success" hidden></p>
    `;

    const stateEl = section.querySelector('.answer-key-state');
    const form = section.querySelector('.answer-key-form');
    const fileInput = form.querySelector('[name="file"]');
    const uploadBtn = form.querySelector('button[type="submit"]');
    const removeBtn = form.querySelector('[data-action="remove"]');
    const errorEl = section.querySelector('.error');
    const okEl = section.querySelector('.success');

    function say(el, message) {
      errorEl.hidden = true;
      okEl.hidden = true;
      if (!el) return;
      el.hidden = false;
      el.textContent = message;
    }

    async function refresh() {
      const { keys, error } = await listAnswerKeys([lesson.id]);
      if (!keys) {
        stateEl.textContent = `Could not check whether a key is uploaded — ${error}`;
        removeBtn.hidden = true;
        return;
      }
      const existing = keys.get(lesson.id);
      if (!existing) {
        stateEl.textContent = 'No answer key uploaded for this lesson yet.';
        uploadBtn.textContent = 'Upload';
        removeBtn.hidden = true;
        return;
      }
      const when = existing.uploadedAt ? new Date(existing.uploadedAt).toLocaleString() : 'unknown date';
      stateEl.textContent = `Answer key uploaded ${when} · ${formatBytes(existing.size)}`;
      uploadBtn.textContent = 'Replace';
      removeBtn.hidden = false;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = fileInput.files && fileInput.files[0];
      if (!file) return say(errorEl, 'Choose a PDF first.');

      const problem = answerKeyFileProblem(file);
      if (problem) return say(errorEl, problem);

      say(null);
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Uploading…';
      try {
        await uploadAnswerKey(lesson.id, file);
        form.reset();
        say(okEl, 'Answer key saved.');
      } catch (err) {
        say(errorEl, err.message);
      } finally {
        uploadBtn.disabled = false;
        await refresh();
      }
    });

    removeBtn.addEventListener('click', async () => {
      const warned = window.confirm(
        'Remove this lesson\'s answer key? Grades already proposed keep their scores and ' +
        'transcriptions — but this lesson cannot be graded again until a key is uploaded.'
      );
      if (!warned) return;
      say(null);
      removeBtn.disabled = true;
      try {
        await deleteAnswerKey(lesson.id);
        say(okEl, 'Answer key removed.');
      } catch (err) {
        say(errorEl, err.message);
      } finally {
        removeBtn.disabled = false;
        await refresh();
      }
    });

    refresh();
    return section;
  }

  function buildActivityForm(root, lesson, activityTypes, tiers) {
    const form = document.createElement('form');
    const typeOptions = activityTypes
      .map((t) => `<option value="${t.activityTypeKey}">${escapeHtml(t.label)}</option>`)
      .join('');
    const tierOptions = tiers.map((t) => `<option value="${t.tierId}">${escapeHtml(t.label)}</option>`).join('');

    form.innerHTML = `
      <h3>Add Activity</h3>
      <label>Activity Type<select name="activityType"><option value="">(select)</option>${typeOptions}</select></label>
      <label>Title<input type="text" name="title" required></label>
      <label>Required<input type="checkbox" name="required"></label>
      <label>Difficulty Tier<select name="difficultyTier"><option value="">(select)</option>${tierOptions}</select></label>
      <div class="payload-fields"></div>
      <label>Expected duration (min)<input type="number" name="expectedDurationMin" min="1" step="1"></label>
      <label>Instructions<input type="text" name="instructions"></label>
      <p class="error" hidden></p>
      <button type="submit">Add Activity</button>
    `;

    const payloadContainer = form.querySelector('.payload-fields');
    const errorEl = form.querySelector('.error');

    // §4.1 — structurePattern now answers one question: does this type take
    // a page range? Reference/text/sequenceNumber are gone; title carries
    // what reference used to, and it is already a top-level required field.
    function renderPayloadFields() {
      const type = activityTypes.find((t) => t.activityTypeKey === form.activityType.value);
      if (!type || type.structurePattern !== 'page-range') {
        payloadContainer.innerHTML = '';
        return;
      }
      payloadContainer.innerHTML = `
        <label>Page range start<input type="number" name="pageRangeStart"></label>
        <label>Page range end<input type="number" name="pageRangeEnd"></label>
      `;
    }

    form.activityType.addEventListener('change', renderPayloadFields);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const type = activityTypes.find((t) => t.activityTypeKey === form.activityType.value);
      const tier = tiers.find((t) => t.tierId === form.difficultyTier.value);
      if (!type) {
        errorEl.hidden = false;
        errorEl.textContent = 'Activity Type must resolve to an existing type.';
        return;
      }
      if (!tier) {
        errorEl.hidden = false;
        errorEl.textContent = 'Difficulty Tier must resolve to an existing Tier.';
        return;
      }
      const result = await createInstanceActivity(
        lesson.id,
        {
          title: form.title.value,
          required: form.required.checked,
          pageRangeStart: type.structurePattern === 'page-range' ? form.pageRangeStart.value : undefined,
          pageRangeEnd: type.structurePattern === 'page-range' ? form.pageRangeEnd.value : undefined,
          expectedDurationMin: form.expectedDurationMin.value,
          instructions: form.instructions.value,
        },
        type,
        tier
      );
      if (result.error) {
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }
      render(root);
    });

    return form;
  }

  // Edit form for an existing Instance Activity. Edits title, required, tier,
  // and the optional trio. Page range untouched. Saving surfaces the FR-12
  // divergence warning, writes only this instance row (never the template),
  // and never re-mints id or touches seq/order.
  function buildActivityEditForm(root, lesson, activity, activityTypes, tiers) {
    const tierOptions = tiers
      .map(
        (t) =>
          `<option value="${t.tierId}"${t.tierId === activity.difficultyTier ? ' selected' : ''}>${escapeHtml(t.label)}</option>`
      )
      .join('');

    const form = document.createElement('form');
    form.innerHTML = `
      <h3>Edit Activity <code>${escapeHtml(activity.id)}</code></h3>
      <label>Title<input type="text" name="title" value="${escapeHtml(activity.title)}" required></label>
      <label>Required<input type="checkbox" name="required" ${activity.required ? 'checked' : ''}></label>
      <label>Difficulty Tier<select name="difficultyTier"><option value="">(select)</option>${tierOptions}</select></label>
      <label>Expected duration (min)<input type="number" name="expectedDurationMin" min="1" step="1" value="${activity.expectedDurationMin ?? ''}"></label>
      <label>Instructions<input type="text" name="instructions" value="${escapeHtml(activity.instructions || '')}"></label>
      <p class="error" hidden></p>
      <button type="submit">Save</button>
      <button type="button" data-action="cancel">Cancel</button>
    `;
    const errorEl = form.querySelector('.error');

    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      editActivityId = null;
      render(root);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const warned = window.confirm(
        'Editing this Activity changes nothing on the child\'s device if it was already received. Continue?'
      );
      if (!warned) return;
      const tier = tiers.find((t) => t.tierId === form.difficultyTier.value);
      const result = await editInstanceActivity(
        activity.id,
        {
          title: form.title.value,
          required: form.required.checked,
          expectedDurationMin: form.expectedDurationMin.value,
          instructions: form.instructions.value,
        },
        tier
      );
      if (result.error) {
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }
      editActivityId = null;
      render(root);
    });

    return form;
  }

  return {
    render,
    openForChild,
    listForChild,
    listAll,
    stampCourse,
    deleteInstance,
  };
})();
