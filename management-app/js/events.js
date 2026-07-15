/* Module: events.js — Module 07, Family Event Authoring.
 * Per SRS_Management_Module_07_Family_Event_Authoring.md, TDS_Slice_M6_Management_App_Rev2.md §1/§4.
 * Reads `children` (childIds[] reference) only — no Chore code, no
 * Course/Lesson/Activity/Curriculum/Tier/Category CRUD lives here. */

const Events = (() => {
  // Inline-edit + filter view state, mirrors chores.js's pattern.
  let editingId = null;
  let filterChildId = '';

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

  // ---- Validation & CRUD (FR-1, FR-2, FR-4, FR-6) ----

  async function validateFields(fields) {
    if (!fields.title || !fields.title.trim()) return 'Title is required.';
    if (!fields.startDate) return 'Start date is required.';
    if (!fields.endDate) return 'End date is required.';
    if (fields.startDate > fields.endDate) return 'Start date must not be after end date.';
    const childIds = fields.childIds || [];
    if (childIds.length === 0) return 'At least one Child is required.';
    const children = await Storage.getAll('children');
    const validIds = new Set(children.map((c) => c.id));
    for (const id of childIds) {
      if (!validIds.has(id)) return 'Every selected Child must resolve to an existing Child.';
    }
    return null;
  }

  // Optional fields omitted, never null. No separate single-day path:
  // startDate === endDate takes the identical code path as a date range.
  function buildRecord(id, fields) {
    const record = {
      id,
      title: fields.title.trim(),
      startDate: fields.startDate,
      endDate: fields.endDate,
      childIds: fields.childIds,
    };
    if (fields.notes && fields.notes.trim()) record.notes = fields.notes.trim();
    if (fields.time && fields.time.trim()) record.time = fields.time.trim();
    return record;
  }

  // FR-1 — eventToken minted, uniqueness-checked against existing
  // `familyEvents` rows, and re-rolled on collision, inside the same
  // transaction as the insert — mirrors chores.js's choreToken mint exactly
  // (TDS §1/§4). No separate `eventToken` field is stored; it's the id's
  // stem (`id.slice(4)`, prefix is always exactly "EVT-").
  async function createEvent(fields) {
    const error = await validateFields(fields);
    if (error) return { error };

    let record;
    let mintFailed = false;
    try {
      await Storage.runTransaction(['familyEvents'], 'readwrite', (t) => {
        const store = t.objectStore('familyEvents');
        const req = store.getAll();
        req.onsuccess = () => {
          const used = new Set(req.result.map((e) => e.id.slice(4)));
          let token = null;
          for (let i = 0; i < 10; i++) {
            const candidate = randomToken();
            if (!used.has(candidate)) {
              token = candidate;
              break;
            }
          }
          if (!token) {
            mintFailed = true;
            t.abort();
            return;
          }
          record = buildRecord('EVT-' + token, fields);
          store.put(record);
        };
      });
    } catch (err) {
      if (!mintFailed) throw err;
    }
    if (mintFailed) return { error: 'Could not mint a unique Family Event token after 10 attempts.' };
    return { record };
  }

  // FR-2 — every field editable; id never changes. Affects only future
  // packet generation — a copy already delivered is unaffected.
  async function editEvent(id, fields) {
    const error = await validateFields(fields);
    if (error) return { error };
    const record = buildRecord(id, fields);
    await Storage.put('familyEvents', record);
    return { record };
  }

  // FR-3 — lightweight confirmation is a UI-layer concern (buildDisplayItem);
  // no dependent-data check of any kind — nothing else ever references a
  // Family Event's id.
  async function deleteEvent(id) {
    await Storage.del('familyEvents', id);
  }

  // FR-4 — application-level filter over a full scan, no index (TDS §1).
  async function listEvents(childId) {
    const all = await Storage.getAll('familyEvents');
    if (!childId) return all;
    return all.filter((e) => (e.childIds || []).includes(childId));
  }

  // ---- Rendering ----

  function readChildIds(form) {
    return Array.from(form.querySelectorAll('input[name="childIds"]:checked')).map((el) => el.value);
  }

  function childCheckboxesHtml(children, selected) {
    return children.map((c) => `
      <label class="child-option">
        <input type="checkbox" name="childIds" value="${c.id}" ${selected.includes(c.id) ? 'checked' : ''}> ${escapeHtml(c.name)}
      </label>
    `).join('');
  }

  async function render(root) {
    root.innerHTML = '';
    const [events, children] = await Promise.all([
      listEvents(filterChildId),
      Storage.getAll('children'),
    ]);

    const heading = document.createElement('h1');
    heading.textContent = 'Family Events';
    root.appendChild(heading);

    const filterForm = document.createElement('form');
    const filterOptions = ['<option value="">(all children)</option>']
      .concat(children.map((c) => `<option value="${c.id}" ${c.id === filterChildId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`))
      .join('');
    filterForm.innerHTML = `<label>Filter by child<select name="filterChildId">${filterOptions}</select></label>`;
    filterForm.filterChildId.addEventListener('change', () => {
      filterChildId = filterForm.filterChildId.value;
      render(root);
    });
    root.appendChild(filterForm);

    const list = document.createElement('ul');
    list.className = 'event-list';
    for (const ev of events) {
      list.appendChild(ev.id === editingId ? buildEditItem(root, ev, children) : buildDisplayItem(root, ev, children));
    }
    root.appendChild(list);

    root.appendChild(buildCreateForm(root, children));
  }

  function buildDisplayItem(root, ev, children) {
    const names = (ev.childIds || [])
      .map((id) => (children.find((c) => c.id === id) || {}).name || '(unresolved child)')
      .join(', ');
    const item = document.createElement('li');
    item.innerHTML = `
      <span class="event-title">${escapeHtml(ev.title)}</span>
      <span class="event-dates">${ev.startDate} – ${ev.endDate}</span>
      <span class="event-children">${escapeHtml(names)}</span>
      <button data-action="edit">Edit</button>
      <button data-action="delete">Delete</button>
    `;
    item.querySelector('[data-action="edit"]').addEventListener('click', () => {
      editingId = ev.id;
      render(root);
    });
    item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      const confirmed = window.confirm(`Delete Family Event "${ev.title}"?`);
      if (!confirmed) return;
      await deleteEvent(ev.id);
      render(root);
    });
    return item;
  }

  function buildEditItem(root, ev, children) {
    const item = document.createElement('li');
    const form = document.createElement('form');
    form.className = 'event-edit-form';
    form.innerHTML = `
      <label>Title<input type="text" name="title" value="${escapeHtml(ev.title)}" required></label>
      <label>Start date<input type="date" name="startDate" value="${ev.startDate}" required></label>
      <label>End date<input type="date" name="endDate" value="${ev.endDate}" required></label>
      <fieldset><legend>Children</legend>${childCheckboxesHtml(children, ev.childIds || [])}</fieldset>
      <label>Notes<input type="text" name="notes" value="${escapeHtml(ev.notes || '')}"></label>
      <label>Time<input type="text" name="time" value="${escapeHtml(ev.time || '')}"></label>
      <p class="error" hidden></p>
      <button type="submit">Save</button>
      <button type="button" data-action="cancel">Cancel</button>
    `;
    const errorEl = form.querySelector('.error');
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      editingId = null;
      render(root);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await editEvent(ev.id, {
        title: form.title.value,
        startDate: form.startDate.value,
        endDate: form.endDate.value,
        childIds: readChildIds(form),
        notes: form.notes.value,
        time: form.time.value,
      });
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

  function buildCreateForm(root, children) {
    const form = document.createElement('form');
    form.innerHTML = `
      <h2>Add Family Event</h2>
      <label>Title<input type="text" name="title" required></label>
      <label>Start date<input type="date" name="startDate" required></label>
      <label>End date<input type="date" name="endDate" required></label>
      <fieldset><legend>Children</legend>${childCheckboxesHtml(children, [])}</fieldset>
      <label>Notes<input type="text" name="notes"></label>
      <label>Time<input type="text" name="time"></label>
      <p class="error" hidden></p>
      <button type="submit">Add Family Event</button>
    `;
    const errorEl = form.querySelector('.error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await createEvent({
        title: form.title.value,
        startDate: form.startDate.value,
        endDate: form.endDate.value,
        childIds: readChildIds(form),
        notes: form.notes.value,
        time: form.time.value,
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

  return { render, createEvent, editEvent, deleteEvent, listEvents };
})();
