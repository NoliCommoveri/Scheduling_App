/* Module: curriculum.js — Module 01, Curriculum Library.
 * Per TDS_Slice_M4_Management_App_Rev3.md §1/§2/§4, SRS Module 01. */

const Curriculum = (() => {
  const CURRICULUM_TYPES = ['Website', 'App', 'Offline'];

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
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="curriculum-name">${escapeHtml(c.name)}</span>
        <span class="curriculum-type">${escapeHtml(c.defaultCurriculumType || '')}</span>
        <button data-action="delete">Delete</button>
        <span class="curriculum-error" hidden></span>
      `;
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
      list.appendChild(item);
    });

    root.appendChild(list);
    root.appendChild(buildCreateForm(root, activityTypes));
  }

  function buildCreateForm(root, activityTypes) {
    const form = document.createElement('form');
    form.className = 'curriculum-form';

    const typeOptions = ['<option value="">(none)</option>']
      .concat(CURRICULUM_TYPES.map((t) => `<option value="${t}">${t}</option>`))
      .join('');

    const typeCheckboxes = activityTypes
      .map(
        (t) => `
        <label class="activity-type-option">
          <input type="checkbox" name="suggestedActivityTypes" value="${t.activityTypeKey}"> ${escapeHtml(t.label)}
        </label>`
      )
      .join('');

    form.innerHTML = `
      <h2>Add Curriculum</h2>
      <label>Name<input type="text" name="name" required></label>
      <label>Publisher note<input type="text" name="publisherNote"></label>
      <label>Curriculum type<select name="defaultCurriculumType">${typeOptions}</select></label>
      <fieldset><legend>Suggested Activity Types</legend>${typeCheckboxes}</fieldset>
      <p class="error" hidden></p>
      <button type="submit">Add Curriculum</button>
    `;

    const errorEl = form.querySelector('.error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const suggestedActivityTypes = Array.from(
        form.querySelectorAll('input[name="suggestedActivityTypes"]:checked')
      ).map((el) => el.value);

      const result = await createCurriculum({
        name: form.name.value,
        publisherNote: form.publisherNote.value.trim(),
        defaultCurriculumType: form.defaultCurriculumType.value,
        suggestedActivityTypes,
      });

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
