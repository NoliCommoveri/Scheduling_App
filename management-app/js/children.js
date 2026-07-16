/* Module: children.js — Module 04, Child Management, Stamping, Instance Editing.
 * Per SRS_Management_Module_04_Child_Management.md,
 * TDS_Slice_M5_Management_App_Rev7.md §1/§5.
 * This is the first place in either app where two module files (this one and
 * courses.js) both write the courses/lessons/activities stores, partitioned
 * by `state` — accepted, not a defect (D-noted in the TDS). */

const Children = (() => {
  const RESERVED_LOWER = ['chr', 'evt', 'tpl'];

  // Drill-down view state, mirrors courses.js's pattern.
  let viewChildId = null;
  let viewInstanceId = null;
  let viewLessonId = null;

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

  // ---- Child CRUD (FR-1-3) ----

  function buildChildRecord(id, fields) {
    const record = { id, name: fields.name.trim() };
    if (fields.gradeLabel) record.gradeLabel = fields.gradeLabel.trim();
    if (fields.notes) record.notes = fields.notes.trim();
    if (fields.themeHint) record.themeHint = fields.themeHint.trim();
    return record;
  }

  async function createChild(fields) {
    if (!fields.name || !fields.name.trim()) return { error: 'Name is required.' };
    const record = buildChildRecord('CHI-' + randomToken(), fields);
    await Storage.put('children', record);
    return { record };
  }

  async function editChild(id, fields) {
    if (!fields.name || !fields.name.trim()) return { error: 'Name is required.' };
    const record = buildChildRecord(id, fields);
    await Storage.put('children', record);
    return { record };
  }

  async function listChildInstances(childId) {
    const courses = await Storage.getAllByIndex('courses', 'by_childId', childId);
    return courses.filter((c) => c.state === 'instance');
  }

  // FR-7 — Tier 1 hard block. No override path exists.
  async function deleteChildTier1(childId) {
    const instances = await listChildInstances(childId);
    if (instances.length === 0) return { blocked: false };
    return { blocked: true, message: `Blocked by Course Instance(s): ${instances.map((i) => i.name).join(', ')}` };
  }

  // FR-8 — Tier 2 cascade, called only after the UI's explicit
  // export/backup confirmation. Cascades Chores, Family Events, Pacing
  // history scoped to this childId — all empty stores at M5, but real code,
  // not a stub (same reasoning as M4's delete-guards).
  async function cascadeDeleteChild(childId) {
    const [chores, familyEvents, pacingProfiles] = await Promise.all([
      Storage.getAll('chores'),
      Storage.getAll('familyEvents'),
      Storage.getAll('pacingProfiles'),
    ]);
    await Storage.runTransaction(['children', 'chores', 'familyEvents', 'pacingProfiles'], 'readwrite', (t) => {
      for (const c of chores.filter((c) => c.childId === childId)) t.objectStore('chores').delete(c.id);
      for (const e of familyEvents.filter((e) => (e.childIds || []).includes(childId))) {
        t.objectStore('familyEvents').delete(e.id);
      }
      for (const p of pacingProfiles.filter((p) => p.childId === childId)) t.objectStore('pacingProfiles').delete(p.id);
      t.objectStore('children').delete(childId);
    });
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

    return { record: newCourse };
  }

  // FR-6 — un-assign/delete a Course Instance. Cascades its own Lessons and
  // Activities, and its Pacing Profile (§2.6 — a Profile has no existence
  // independent of its Instance). Never touches the source template.
  async function deleteInstance(instanceId) {
    const lessons = await Storage.getAllByIndex('lessons', 'by_courseId', instanceId);
    const pacingProfiles = await Storage.getAll('pacingProfiles');
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
        const pacingStore = t.objectStore('pacingProfiles');
        for (const p of pacingProfiles.filter((p) => p.courseId === instanceId)) pacingStore.delete(p.id);
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
      return { error: 'A Lesson with this code already exists in this Instance.' };
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
        return { error: 'A Lesson with this code already exists in this Instance.' };
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

  function isCustomType(type) {
    return type.activityTypeKey.startsWith('AT-');
  }

  // A new Activity mints from THIS Instance's own instanceToken (read off
  // the owning Course record) and the Lesson's current nextActivitySeq —
  // never max(existing)+1, never a number a deleted Activity once held.
  async function createInstanceActivity(lessonId, fields, type, tier) {
    if (!fields.title || !fields.title.trim()) return { error: 'Title is required.' };
    if (!tier) return { error: 'Difficulty Tier must resolve to an existing Tier.' };
    if (!type) return { error: 'Activity Type must resolve to an existing type.' };

    let sequenceNumber;
    if (type.structurePattern === 'count') {
      if (fields.sequenceNumber === undefined || fields.sequenceNumber === '') {
        return { error: 'Sequence number is required for this Activity Type.' };
      }
      sequenceNumber = Number(fields.sequenceNumber);
    }

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
          payload: fields.payload,
          difficultyTier: tier.tierId,
          capturesGrade: type.capturePattern === 'grade-optional',
          order,
          lessonTitle: lessonBefore.title,
        };
        if (sequenceNumber !== undefined) record.sequenceNumber = sequenceNumber;

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
    const record = { ...existing, title: fields.title.trim(), required: !!fields.required, difficultyTier: tier.tierId };
    if (fields.payload) record.payload = fields.payload;
    if (fields.sequenceNumber !== undefined && fields.sequenceNumber !== '') {
      record.sequenceNumber = Number(fields.sequenceNumber);
    }
    await Storage.put('activities', record);
    return { record };
  }

  async function deleteInstanceActivity(id) {
    await Storage.del('activities', id);
  }

  // FR-14 — bool, default false (represented as an absent key). Writable
  // here at any time, independent of Packet Generation's Propose/Review/
  // Commit cycle (M7, not built yet). Never available on a template Activity
  // (this function is only ever called from the Instance Activity view).
  async function setExcludeFromGeneration(activityId, value) {
    const activity = await Storage.get('activities', activityId);
    const record = { ...activity };
    if (value) record.excludeFromGeneration = true;
    else delete record.excludeFromGeneration;
    await Storage.put('activities', record);
    return { record };
  }

  // ---- Rendering ----

  async function render(root) {
    if (viewLessonId) return renderLessonDetail(root);
    if (viewInstanceId) return renderInstanceDetail(root);
    if (viewChildId) return renderChildDetail(root);
    return renderChildList(root);
  }

  async function renderChildList(root) {
    root.innerHTML = '';
    const children = await Storage.getAll('children');

    const heading = document.createElement('h1');
    heading.textContent = 'Children';
    root.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'child-list';
    for (const child of children) {
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="child-name">${escapeHtml(child.name)}</span>
        <button data-action="open">Open</button>
        <button data-action="delete">Delete</button>
        <span class="child-error" hidden></span>
      `;
      item.querySelector('[data-action="open"]').addEventListener('click', () => {
        viewChildId = child.id;
        render(root);
      });
      item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const tier1 = await deleteChildTier1(child.id);
        const errEl = item.querySelector('.child-error');
        if (tier1.blocked) {
          errEl.hidden = false;
          errEl.textContent = tier1.message;
          return;
        }
        const warned = window.confirm(
          `Deleting "${child.name}" permanently removes the Child record and any remaining Chores, ` +
          `Family Events, and Pacing history for them. Confirm you have already exported/backed up ` +
          `anything you want to keep before continuing.`
        );
        if (!warned) return;
        await cascadeDeleteChild(child.id);
        render(root);
      });
      list.appendChild(item);
    }
    root.appendChild(list);

    const form = document.createElement('form');
    form.innerHTML = `
      <h2>Add Child</h2>
      <label>Name<input type="text" name="name" required></label>
      <label>Grade label<input type="text" name="gradeLabel"></label>
      <label>Notes<input type="text" name="notes"></label>
      <label>Theme hint<input type="text" name="themeHint"></label>
      <p class="error" hidden></p>
      <button type="submit">Add Child</button>
    `;
    const errorEl = form.querySelector('.error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await createChild({
        name: form.name.value,
        gradeLabel: form.gradeLabel.value,
        notes: form.notes.value,
        themeHint: form.themeHint.value,
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

  async function renderChildDetail(root) {
    root.innerHTML = '';
    const child = await Storage.get('children', viewChildId);
    if (!child) {
      viewChildId = null;
      return render(root);
    }

    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back to Children';
    backBtn.addEventListener('click', () => {
      viewChildId = null;
      render(root);
    });
    root.appendChild(backBtn);

    const heading = document.createElement('h1');
    heading.textContent = child.name;
    root.appendChild(heading);

    const editForm = document.createElement('form');
    editForm.innerHTML = `
      <h2>Edit Child</h2>
      <label>Name<input type="text" name="name" value="${escapeHtml(child.name)}" required></label>
      <label>Grade label<input type="text" name="gradeLabel" value="${escapeHtml(child.gradeLabel || '')}"></label>
      <label>Notes<input type="text" name="notes" value="${escapeHtml(child.notes || '')}"></label>
      <label>Theme hint<input type="text" name="themeHint" value="${escapeHtml(child.themeHint || '')}"></label>
      <p class="error" hidden></p>
      <p class="success" hidden></p>
      <button type="submit">Save</button>
    `;
    const editErr = editForm.querySelector('.error');
    const editOk = editForm.querySelector('.success');
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await editChild(child.id, {
        name: editForm.name.value,
        gradeLabel: editForm.gradeLabel.value,
        notes: editForm.notes.value,
        themeHint: editForm.themeHint.value,
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

    const instHeading = document.createElement('h2');
    instHeading.textContent = 'Course Instances';
    root.appendChild(instHeading);

    const instances = await listChildInstances(child.id);
    const list = document.createElement('ul');
    list.className = 'instance-list';
    for (const inst of instances) {
      const template = inst.sourceTemplateId ? await Storage.get('courses', inst.sourceTemplateId) : null;
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="instance-name">${escapeHtml(inst.name)}</span>
        <span class="instance-source">${template ? escapeHtml(template.name) : 'template no longer available'}</span>
        <button data-action="open">Open</button>
        <button data-action="delete">Un-assign</button>
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
    root.appendChild(list);

    const templates = await Courses.listCourseTemplates();
    const stampForm = document.createElement('form');
    const templateOptions = templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    stampForm.innerHTML = `
      <h3>Assign a Course</h3>
      <label>Course Template<select name="templateId"><option value="">(select)</option>${templateOptions}</select></label>
      <p class="error" hidden></p>
      <p class="success" hidden></p>
      <button type="submit">Stamp</button>
    `;
    const stampErr = stampForm.querySelector('.error');
    const stampOk = stampForm.querySelector('.success');
    stampForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!stampForm.templateId.value) {
        stampErr.hidden = false;
        stampErr.textContent = 'Select a Course Template.';
        return;
      }
      await stampCourse(stampForm.templateId.value, child.id);
      stampErr.hidden = true;
      stampOk.hidden = false;
      stampOk.textContent = 'Stamped. Pacing Configuration (not yet available until M7) is the required next step.';
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
    const frozen = await Courses.hasActivitiesBeneathCourse(instance.id);
    const lessons = (await Storage.getAllByIndex('lessons', 'by_courseId', instance.id)).sort(
      (a, b) => a.order - b.order
    );

    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back to Child';
    backBtn.addEventListener('click', () => {
      viewInstanceId = null;
      render(root);
    });
    root.appendChild(backBtn);

    const heading = document.createElement('h1');
    heading.textContent = instance.name;
    root.appendChild(heading);

    const editForm = document.createElement('form');
    editForm.innerHTML = `
      <h2>Edit Instance Course fields</h2>
      <label>Name<input type="text" name="name" value="${escapeHtml(instance.name)}" required></label>
      <label>Course code (frozen — instances always have Activities beneath them)
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
          'Renaming this Instance\'s Course changes what the child sees on every packet generated ' +
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

    const lessonHeading = document.createElement('h2');
    lessonHeading.textContent = 'Lessons';
    root.appendChild(lessonHeading);

    const list = document.createElement('ul');
    list.className = 'lesson-list';
    lessons.forEach((l) => {
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="lesson-title">${escapeHtml(l.title)}</span>
        <span class="lesson-code">${escapeHtml(l.lessonCode)}</span>
        <button data-action="open">Open</button>
        <button data-action="delete">Delete</button>
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
    backBtn.textContent = '← Back to Instance';
    backBtn.addEventListener('click', () => {
      viewLessonId = null;
      render(root);
    });
    root.appendChild(backBtn);

    const heading = document.createElement('h1');
    heading.textContent = lesson.title;
    root.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'activity-list';
    activities.forEach((a, index) => {
      const typeLabel = (activityTypes.find((t) => t.activityTypeKey === a.activityType) || {}).label || a.activityType;
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="activity-title">${escapeHtml(a.title)}</span>
        <span class="activity-type">${escapeHtml(typeLabel)}</span>
        <span class="activity-id">${a.id}</span>
        <label class="exclude-toggle">
          <input type="checkbox" data-action="exclude" ${a.excludeFromGeneration ? 'checked' : ''}> Exclude from generation
        </label>
        <button data-action="up" ${index === 0 ? 'disabled' : ''}>&uarr;</button>
        <button data-action="down" ${index === activities.length - 1 ? 'disabled' : ''}>&darr;</button>
        <button data-action="rename">Rename</button>
        <button data-action="delete">Delete</button>
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
      item.querySelector('[data-action="rename"]').addEventListener('click', async () => {
        const warned = window.confirm(
          'Editing this Activity changes nothing on the child\'s device if it was already received. Continue?'
        );
        if (!warned) return;
        const newTitle = window.prompt('New title:', a.title);
        if (newTitle && newTitle.trim()) {
          const tier = tiers.find((t) => t.tierId === a.difficultyTier);
          await editInstanceActivity(a.id, { title: newTitle.trim(), required: a.required }, tier);
          render(root);
        }
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

    root.appendChild(buildActivityForm(root, lesson, activityTypes, tiers));
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
      <p class="error" hidden></p>
      <button type="submit">Add Activity</button>
    `;

    const payloadContainer = form.querySelector('.payload-fields');
    const errorEl = form.querySelector('.error');

    function renderPayloadFields() {
      const type = activityTypes.find((t) => t.activityTypeKey === form.activityType.value);
      if (!type) {
        payloadContainer.innerHTML = '';
        return;
      }
      const custom = isCustomType(type);
      let html = '';
      if (!custom && type.structurePattern === 'page-range') {
        html += `
          <label>Page range start<input type="number" name="pageRangeStart"></label>
          <label>Page range end<input type="number" name="pageRangeEnd"></label>
        `;
      } else if (!custom && type.activityTypeKey === 'practice-level') {
        html += '';
      } else if (!custom) {
        html += `<label>Reference<input type="text" name="reference"></label>`;
      } else {
        html += `<label>Reference / instructions<input type="text" name="referenceOrInstructions"></label>`;
      }
      if (type.structurePattern === 'count') {
        html += `<label>Sequence number<input type="number" name="sequenceNumber"></label>`;
      }
      payloadContainer.innerHTML = html;
    }

    form.activityType.addEventListener('change', renderPayloadFields);

    function buildPayload(type) {
      if (!isCustomType(type) && type.structurePattern === 'page-range') {
        if (!form.pageRangeStart.value || !form.pageRangeEnd.value) {
          return { error: 'Page range start and end are required.' };
        }
        const start = Number(form.pageRangeStart.value);
        const end = Number(form.pageRangeEnd.value);
        if (start > end) return { error: 'Page range start must not exceed end.' };
        return { payload: { pageRangeStart: start, pageRangeEnd: end } };
      }
      if (!isCustomType(type) && type.activityTypeKey === 'practice-level') return { payload: {} };
      if (!isCustomType(type)) {
        if (!form.reference.value.trim()) return { error: 'Reference is required.' };
        return { payload: { reference: form.reference.value.trim() } };
      }
      if (!form.referenceOrInstructions.value.trim()) return { error: 'This field is required.' };
      return { payload: { referenceOrInstructions: form.referenceOrInstructions.value.trim() } };
    }

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
      const payloadResult = buildPayload(type);
      if (payloadResult.error) {
        errorEl.hidden = false;
        errorEl.textContent = payloadResult.error;
        return;
      }
      const result = await createInstanceActivity(
        lesson.id,
        {
          title: form.title.value,
          required: form.required.checked,
          payload: payloadResult.payload,
          sequenceNumber: type.structurePattern === 'count' ? form.sequenceNumber.value : undefined,
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

  return {
    render,
    createChild,
    editChild,
    deleteChildTier1,
    cascadeDeleteChild,
    stampCourse,
    listChildInstances,
    deleteInstance,
  };
})();
