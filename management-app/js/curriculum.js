/* Module: curriculum.js — Module 01, Curriculum Library.
 * Per TDS_Slice_M4_Management_App_Rev3.md §1/§2/§4, SRS Module 01. */

const Curriculum = (() => {
  const CURRICULUM_TYPES = ['Website', 'App', 'Offline'];

  // Which row is open for editing, if any. Same single-row-at-a-time inline
  // edit `chores.js` uses: render() reads it, the row's Edit/Cancel set it.
  let editingId = null;

  function randomToken(len = 6) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  // FR-1/§5 — case-insensitive uniqueness, trimmed, excluding self on edit.
  async function nameExists(name, excludeId) {
    const all = await Storage.getAll('curricula');
    const norm = name.trim().toLocaleLowerCase();
    return all.some((c) => c.id !== excludeId && c.name.trim().toLocaleLowerCase() === norm);
  }

  function buildRecord(id, { name, publisherNote, defaultCurriculumType, suggestedActivityTypes }) {
    // Optional fields omitted, never null (TDS §2 — keeps backup/packet JSON honest).
    const record = { id, name: name.trim() };
    if (publisherNote) record.publisherNote = publisherNote;
    if (defaultCurriculumType) record.defaultCurriculumType = defaultCurriculumType;
    if (suggestedActivityTypes && suggestedActivityTypes.length) {
      record.suggestedActivityTypes = suggestedActivityTypes;
    }
    return record;
  }

  async function validate(fields, excludeId) {
    const trimmed = fields.name.trim();
    if (!trimmed) return 'Name is required.';
    if (await nameExists(trimmed, excludeId)) return 'A Curriculum with this name already exists.';
    return null;
  }

  // FR-1 — create.
  async function createCurriculum(fields) {
    const error = await validate(fields, undefined);
    if (error) return { error };
    const record = buildRecord('CUR-' + randomToken(), fields);
    await Storage.put('curricula', record);
    return { record };
  }

  // FR-2 — edit; any field editable at any time, no propagation to desync.
  async function editCurriculum(id, fields) {
    const error = await validate(fields, id);
    if (error) return { error };
    const record = buildRecord(id, fields);
    await Storage.put('curricula', record);
    return { record };
  }

  // FR-4 — delete guard against Course (template + instance) references.
  async function deleteGuardNames(id) {
    const courses = await Storage.getAll('courses');
    const blocking = courses.filter((c) => c.curriculumId === id);
    if (blocking.length === 0) return null;
    return blocking.map((c) => c.name).join(', ');
  }

  async function deleteCurriculum(id) {
    const blockingNames = await deleteGuardNames(id);
    if (blockingNames) return { blocked: true, message: `Blocked by Course(s): ${blockingNames}` };
    await Storage.del('curricula', id);
    return { blocked: false };
  }

  async function render(root) {
    root.innerHTML = '';
    const [curricula, activityTypes] = await Promise.all([
      Storage.getAll('curricula'),
      Storage.getAll('activityTypes'),
    ]);

    const heading = document.createElement('h1');
    heading.textContent = 'Curriculum Library';
    root.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'curriculum-list';

    curricula.forEach((c) => {
      list.appendChild(
        editingId === c.id
          ? buildEditItem(root, c, activityTypes)
          : buildListItem(root, c, activityTypes)
      );
    });

    root.appendChild(list);
    root.appendChild(buildCreateForm(root, activityTypes));
  }

  function typeLabels(activityTypes, keys) {
    // A key naming a since-deleted Activity Type is shown as the raw key
    // rather than dropped — Module 12 §2.6's inert-historical-reference
    // treatment, so an edit never silently discards one.
    return (keys || []).map((key) => {
      const type = activityTypes.find((t) => t.activityTypeKey === key);
      return type ? type.label : key;
    });
  }

  function buildListItem(root, c, activityTypes) {
    const item = document.createElement('li');
    // Same .list-row/.row-text/.row-actions split as Activity Types and
    // Chores — two buttons on a row need a fixed controls track, or Edit and
    // Delete land somewhere different on every row.
    item.className = 'list-row';
    const suggested = typeLabels(activityTypes, c.suggestedActivityTypes);
    item.innerHTML = `
      <div class="row-text">
        <span class="row-title curriculum-name">${escapeHtml(c.name)}</span>
        <span class="row-meta row-meta-inline">
          ${c.defaultCurriculumType ? `<span class="curriculum-type">${escapeHtml(c.defaultCurriculumType)}</span>` : ''}
          ${suggested.length ? `<span class="curriculum-suggested">${escapeHtml(suggested.join(', '))}</span>` : ''}
        </span>
      </div>
      <div class="row-actions">
        <button data-action="edit">Edit</button>
        <button data-action="delete">Delete</button>
      </div>
      <span class="row-error curriculum-error" hidden></span>
    `;
    item.querySelector('[data-action="edit"]').addEventListener('click', () => {
      editingId = c.id;
      render(root);
    });
    item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      const result = await deleteCurriculum(c.id);
      if (result.blocked) {
        const errEl = item.querySelector('.curriculum-error');
        errEl.hidden = false;
        errEl.textContent = result.message;
      } else {
        render(root);
      }
    });
    return item;
  }

  // FR-2 — "any field on an existing Curriculum can be edited at any time",
  // and acceptance check 3 turns on editing `suggestedActivityTypes` while
  // Courses reference the record. Nothing here is reference-guarded: only
  // FR-4's delete is, because Curriculum is never stamped or duplicated, so
  // an edit has no instances to desync — it is the one sanctioned live
  // propagation in the system. The delete guard is not evidence to the
  // contrary; a live Course is a reason to keep the record, not to freeze it.
  function buildEditItem(root, c, activityTypes) {
    const item = document.createElement('li');
    const form = buildFields({
      heading: null,
      submitLabel: 'Save',
      activityTypes,
      values: c,
      withCancel: true,
    });
    form.className = 'curriculum-form curriculum-edit-form';
    const errorEl = form.querySelector('.error');

    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      editingId = null;
      render(root);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await editCurriculum(c.id, readFields(form));
      if (result.error) {
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }
      editingId = null;
      render(root);
    });

    item.appendChild(form);
    return item;
  }

  // One field set, two callers (create and edit) — the create form and the
  // inline edit form differ only in their heading, button label, and starting
  // values, and a second hand-maintained copy would drift the moment a field
  // is added.
  function buildFields({ heading, submitLabel, activityTypes, values, withCancel }) {
    const form = document.createElement('form');
    form.className = 'curriculum-form';
    const current = values || {};
    const selectedTypes = new Set(current.suggestedActivityTypes || []);

    const typeOptions = ['<option value="">(none)</option>']
      .concat(
        CURRICULUM_TYPES.map(
          (t) => `<option value="${t}"${t === current.defaultCurriculumType ? ' selected' : ''}>${t}</option>`
        )
      )
      .join('');

    // A suggestion naming a since-deleted Activity Type keeps its checkbox,
    // checked, at the end of the list — editing another field must not quietly
    // drop it (Module 12 §2.6).
    const keys = activityTypes.map((t) => t.activityTypeKey);
    const orphans = [...selectedTypes].filter((key) => !keys.includes(key));
    const options = activityTypes
      .map((t) => ({ key: t.activityTypeKey, label: t.label }))
      .concat(orphans.map((key) => ({ key, label: key })));

    const typeCheckboxes = options
      .map(
        (t) => `
        <label class="activity-type-option">
          <input type="checkbox" name="suggestedActivityTypes" value="${escapeHtml(t.key)}"${selectedTypes.has(t.key) ? ' checked' : ''}> ${escapeHtml(t.label)}
        </label>`
      )
      .join('');

    form.innerHTML = `
      ${heading ? `<h2>${escapeHtml(heading)}</h2>` : ''}
      <label>Name<input type="text" name="name" value="${escapeHtml(current.name || '')}" required></label>
      <label>Publisher note<input type="text" name="publisherNote" value="${escapeHtml(current.publisherNote || '')}"></label>
      <label>Curriculum type<select name="defaultCurriculumType">${typeOptions}</select></label>
      <fieldset><legend>Suggested Activity Types</legend>${typeCheckboxes}</fieldset>
      <p class="error" hidden></p>
      <button type="submit">${escapeHtml(submitLabel)}</button>
      ${withCancel ? '<button type="button" data-action="cancel">Cancel</button>' : ''}
    `;
    return form;
  }

  function readFields(form) {
    return {
      name: form.name.value,
      publisherNote: form.publisherNote.value.trim(),
      defaultCurriculumType: form.defaultCurriculumType.value,
      suggestedActivityTypes: Array.from(
        form.querySelectorAll('input[name="suggestedActivityTypes"]:checked')
      ).map((el) => el.value),
    };
  }

  function buildCreateForm(root, activityTypes) {
    const form = buildFields({
      heading: 'Add Curriculum',
      submitLabel: 'Add Curriculum',
      activityTypes,
      values: null,
      withCancel: false,
    });
    const errorEl = form.querySelector('.error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await createCurriculum(readFields(form));
      if (result.error) {
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }
      render(root);
    });

    return form;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { render, createCurriculum, editCurriculum, deleteCurriculum };
})();
