/* Module: activityTypes.js — Module 12, Activity Type Management.
 * Per SRS_Management_Module_12_Activity_Type.md, TDS_Slice_M5_Management_App_Rev7.md §1a/§3. */

const ActivityTypes = (() => {
  const CAPTURE_PATTERNS = ['grade-optional', 'no-capture'];
  const STRUCTURE_PATTERNS = ['page-range', 'count'];

  function randomToken(len = 6) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  // FR-2/§6 — case-insensitive uniqueness, trimmed, excluding self on edit.
  async function labelExists(label, excludeKey) {
    const all = await Storage.getAll('activityTypes');
    const norm = label.trim().toLocaleLowerCase();
    return all.some((t) => t.activityTypeKey !== excludeKey && t.label.trim().toLocaleLowerCase() === norm);
  }

  // FR-1 — create. capturePattern/structurePattern chosen once, immutable
  // thereafter (§2.2/FR-3 — there is no edit path for either, not here, not
  // anywhere). Canonical keys are seeded in storage.js; a parent-added type
  // always mints AT-{token}, never a label-derived slug (§4).
  async function createType(fields) {
    const label = fields.label.trim();
    if (!label) return { error: 'Label is required.' };
    if (await labelExists(label, undefined)) return { error: 'An Activity Type with this label already exists.' };
    if (!CAPTURE_PATTERNS.includes(fields.capturePattern)) return { error: 'Invalid capture pattern.' };
    if (!STRUCTURE_PATTERNS.includes(fields.structurePattern)) return { error: 'Invalid structure pattern.' };

    const record = {
      activityTypeKey: 'AT-' + randomToken(),
      label,
      capturePattern: fields.capturePattern,
      structurePattern: fields.structurePattern,
    };
    await Storage.put('activityTypes', record);
    return { record };
  }

  // FR-2 — rename only. capturePattern/structurePattern are never accepted
  // here, by design (§2.2) — this function has no parameters for them.
  async function renameType(activityTypeKey, newLabel) {
    const label = newLabel.trim();
    if (!label) return { error: 'Label is required.' };
    if (await labelExists(label, activityTypeKey)) return { error: 'An Activity Type with this label already exists.' };
    const type = await Storage.get('activityTypes', activityTypeKey);
    await Storage.put('activityTypes', { ...type, label });
    return { record: { ...type, label } };
  }

  // FR-4 — reference-guarded against Activity only, template and instance
  // alike (§2.3/Domain Model — this table has no Child App visibility at
  // all, so there is no ledger/completion concern here the way Tier has one).
  async function deleteGuardCount(activityTypeKey) {
    const activities = await Storage.getAllByIndex('activities', 'by_activityType', activityTypeKey);
    return activities.length;
  }

  // Delete cascade: none (§2.6). A Lesson's activityCountTargets[] entry
  // referencing this key is left inert on purpose — never cleaned up here.
  async function deleteType(activityTypeKey) {
    const count = await deleteGuardCount(activityTypeKey);
    if (count > 0) return { blocked: true, message: `Used by ${count} Activities` };
    await Storage.del('activityTypes', activityTypeKey);
    return { blocked: false };
  }

  async function render(root) {
    root.innerHTML = '';
    const types = await Storage.getAll('activityTypes');

    const heading = document.createElement('h1');
    heading.textContent = 'Activity Types';
    root.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'activity-type-list';

    types.forEach((type) => {
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="activity-type-label">${escapeHtml(type.label)}</span>
        <span class="activity-type-patterns">${type.capturePattern} / ${type.structurePattern}</span>
        <button data-action="rename">Rename</button>
        <button data-action="delete">Delete</button>
        <span class="activity-type-error" hidden></span>
      `;

      item.querySelector('[data-action="rename"]').addEventListener('click', async () => {
        const newLabel = window.prompt('New label:', type.label);
        if (newLabel === null) return;
        const result = await renameType(type.activityTypeKey, newLabel);
        const errEl = item.querySelector('.activity-type-error');
        if (result.error) {
          errEl.hidden = false;
          errEl.textContent = result.error;
        } else {
          render(root);
        }
      });
      item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const result = await deleteType(type.activityTypeKey);
        if (result.blocked) {
          const errEl = item.querySelector('.activity-type-error');
          errEl.hidden = false;
          errEl.textContent = result.message;
        } else {
          render(root);
        }
      });

      list.appendChild(item);
    });

    root.appendChild(list);

    const form = document.createElement('form');
    const captureOptions = CAPTURE_PATTERNS.map((p) => `<option value="${p}">${p}</option>`).join('');
    const structureOptions = STRUCTURE_PATTERNS.map((p) => `<option value="${p}">${p}</option>`).join('');
    form.innerHTML = `
      <h2>Add Activity Type</h2>
      <label>Label<input type="text" name="label" required></label>
      <label>Capture pattern<select name="capturePattern">${captureOptions}</select></label>
      <label>Structure pattern<select name="structurePattern">${structureOptions}</select></label>
      <p class="error" hidden></p>
      <button type="submit">Add Activity Type</button>
    `;
    const errorEl = form.querySelector('.error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await createType({
        label: form.label.value,
        capturePattern: form.capturePattern.value,
        structurePattern: form.structurePattern.value,
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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { render, createType, renameType, deleteType };
})();
