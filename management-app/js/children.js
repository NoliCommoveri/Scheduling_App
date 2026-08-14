/* Module: children.js — Module 04, Child Management.
 * Per SRS_Management_Module_04_Child_Management.md,
 * TDS_Slice_M5_Management_App_Rev7.md §1/§5.
 *
 * SCOPE NARROWED 2026-08-14. This file used to be "Child Management, Stamping,
 * Instance Editing" — the child record plus every Course Instance, Lesson and
 * Activity beneath it. All of that moved to instances.js, which gives Course
 * Instances the top-level page they always needed. What remains is the child
 * record itself: create, rename, archive, delete.
 *
 * The delete guards still read Instances (FR-7's Tier 1 block is defined in
 * terms of them), but through Instances.listForChild — a read across a module
 * boundary, the same way this file already reads Chores. It no longer writes
 * the courses/lessons/activities stores at all, which retires the two-writer
 * note this header used to carry. */

const Children = (() => {
  // Drill-down view state, mirrors courses.js's pattern.
  let viewChildId = null;

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

  // `active` is the source for the `children.active` column in D1
  // (TDS_Slice_Online_Revamp.md §3.2), which had no source until now. A child
  // is archived rather than deleted when they finish or take a break: deletion
  // cascades away chores, events and pacing history (see cascadeDeleteChild),
  // and "this kid is done for the year" must not mean losing their record.
  //
  // Stored as an explicit boolean rather than an omit-when-false flag, because
  // the D1 projection needs a value to write and `undefined` is not one.
  function buildChildRecord(id, fields) {
    const record = { id, name: fields.name.trim(), active: fields.active !== false };
    if (fields.gradeLabel) record.gradeLabel = fields.gradeLabel.trim();
    if (fields.notes) record.notes = fields.notes.trim();
    if (fields.themeHint) record.themeHint = fields.themeHint.trim();
    return record;
  }

  // A record written before `active` existed has no such field, and a child
  // authored on an older device is not archived — they are simply older than
  // the flag. Absent therefore reads as active, everywhere, with no migration.
  function isActive(child) {
    return !!child && child.active !== false;
  }

  function activeOnly(children) {
    return (children || []).filter(isActive);
  }

  async function createChild(fields) {
    if (!fields.name || !fields.name.trim()) return { error: 'Name is required.' };
    const record = buildChildRecord('CHI-' + randomToken(), fields);
    await Storage.put('children', record);
    return { record };
  }

  async function editChild(id, fields) {
    if (!fields.name || !fields.name.trim()) return { error: 'Name is required.' };
    // buildChildRecord rebuilds the whole record from the form, and the edit
    // form does not carry `active` — it is set from the list's Archive button.
    // Without threading it through, renaming a child would silently un-archive
    // them.
    const existing = await Storage.get('children', id);
    const record = buildChildRecord(id, { active: isActive(existing), ...fields });
    await Storage.put('children', record);
    return { record };
  }

  async function setChildActive(id, active) {
    const existing = await Storage.get('children', id);
    if (!existing) return { error: 'Child not found.' };
    const record = { ...existing, active: !!active };
    await Storage.put('children', record);
    return { record };
  }

  // FR-7 — Tier 1 hard block. No override path exists.
  async function deleteChildTier1(childId) {
    const instances = await Instances.listForChild(childId);
    if (instances.length === 0) return { blocked: false };
    return { blocked: true, message: `Blocked by assigned Course(s): ${instances.map((i) => i.name).join(', ')}` };
  }

  // FR-8 — Tier 2 cascade, called only after the UI's explicit
  // export/backup confirmation. Cascades Chores, Family Events, Pacing
  // history scoped to this childId.
  async function cascadeDeleteChild(childId) {
    // No pacingProfiles cleanup here: a Pacing Profile is 1:1 with a Course
    // Instance (keyed by instanceId — TDS_Slice_M7 §1), and this path is only
    // reached after the Tier 1 guard (FR-7) has confirmed the child has zero
    // Instances, so it can have no Profiles either.
    const [chores, familyEvents] = await Promise.all([
      Storage.getAll('chores'),
      Storage.getAll('familyEvents'),
    ]);
    await Storage.runTransaction(['children', 'chores', 'familyEvents'], 'readwrite', (t) => {
      // Shared Chores §4.4 — prune the departing child from every chore's
      // participant list; delete a chore only once that list is empty. A flat
      // "delete where I'm a participant" match (Family Events' pattern, and
      // this cascade's own pre-§4.4 behavior) would take a sibling's half of
      // a shared chore down with it.
      for (const c of chores) {
        const rest = Chores.participantsOf(c).filter((id) => id !== childId);
        if (rest.length === 0) {
          t.objectStore('chores').delete(c.id);
        } else if (rest.length !== Chores.participantsOf(c).length) {
          t.objectStore('chores').put(Chores.pruneParticipant(c, childId));
        }
      }
      for (const e of familyEvents.filter((e) => (e.childIds || []).includes(childId))) {
        t.objectStore('familyEvents').delete(e.id);
      }
      t.objectStore('children').delete(childId);
    });
  }

  // ---- Rendering ----

  async function render(root) {
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
    // Active first, then archived, each alphabetical — so the list reads as
    // "who I am teaching" with the finished ones settled underneath.
    const ordered = children.slice().sort((a, b) =>
      (isActive(b) ? 1 : 0) - (isActive(a) ? 1 : 0) || String(a.name).localeCompare(String(b.name)));

    for (const child of ordered) {
      const item = document.createElement('li');
      item.className = 'list-row';
      if (!isActive(child)) item.classList.add('child-archived');
      item.innerHTML = `
        <div class="row-text">
          <span class="row-title child-name">${escapeHtml(child.name)}</span>
          ${isActive(child) ? '' : '<span class="child-archived-tag">archived</span>'}
        </div>
        <div class="row-actions">
          <button data-action="open">Open</button>
          <button data-action="archive">${isActive(child) ? 'Archive' : 'Restore'}</button>
          <button data-action="delete">Delete</button>
        </div>
        <span class="row-error child-error" hidden></span>
      `;
      item.querySelector('[data-action="open"]').addEventListener('click', () => {
        viewChildId = child.id;
        render(root);
      });
      item.querySelector('[data-action="archive"]').addEventListener('click', async () => {
        if (isActive(child)) {
          const warned = window.confirm(
            `Archive "${child.name}"?\n\n` +
            'They stop appearing when you assign work, set pacing, author chores or events, ' +
            'or pair a device. Everything already assigned stays exactly as it is, and they ' +
            'keep showing up in Assignments and Reporting. You can restore them at any time.'
          );
          if (!warned) return;
        }
        await setChildActive(child.id, !isActive(child));
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

    // The Course Instance editor that used to live here is a page of its own
    // now (instances.js). What is left behind is a count and a way through —
    // enough to answer "is this child set up?" without making this the place
    // you edit a syllabus from.
    const instances = await Instances.listForChild(child.id);
    const coursesHeading = document.createElement('h2');
    coursesHeading.textContent = 'Assigned Courses';
    root.appendChild(coursesHeading);

    const count = document.createElement('p');
    count.textContent = instances.length
      ? `${instances.length} Course${instances.length === 1 ? '' : 's'} assigned.`
      : 'No Courses assigned yet.';
    root.appendChild(count);

    const openCourses = document.createElement('button');
    openCourses.textContent = instances.length ? 'Open assigned Courses' : 'Assign a Course';
    openCourses.addEventListener('click', () => Instances.openForChild(child.id));
    root.appendChild(openCourses);
  }

  return {
    render,
    createChild,
    editChild,
    setChildActive,
    // Exported because this module owns the child record's shape: every other
    // view that lists children needs the same "absent means active" reading,
    // and eight copies of `c.active !== false` is eight chances to write one
    // of them as `c.active === true` and quietly hide every legacy record.
    isActive,
    activeOnly,
    deleteChildTier1,
    cascadeDeleteChild,
  };
})();
