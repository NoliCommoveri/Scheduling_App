/* Module: chores.js — Module 06, Chore Authoring.
 * Per SRS_Management_Module_06_Chore_Authoring.md, TDS_Slice_M6_Management_App_Rev2.md §1/§3.
 * Reads `children` (childId reference) and `tiers` (difficultyTier reference) only —
 * no Family Event code, no Course/Lesson/Activity/Curriculum/Category CRUD lives here.
 *
 * FR-8's bulk CSV import (docs/TDS_Slice_Chore_Bulk_Import.md) parses and
 * validates in `chores-csv-core.js`, which is pure; this file keeps the parts
 * that cannot be — the Storage lookups, the last validateFields() gate, the
 * batched write, and the UI. Both entry paths build their record through the
 * one `buildRecord()`, so an imported Chore and a hand-authored one are the
 * same shape. This remains the only writer of the `chores` store. */

const Chores = (() => {
  const CHORE_TYPES = [
    'Pet Care', 'Car Care', 'Kitchen/Dining', 'Bathroom', 'Living/Main Area',
    'Playroom', 'Bedroom', "Parent's Room", 'Porch', 'Floors', 'Miscellaneous',
  ];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const BLOCK_HINTS = ['morning', 'afternoon', 'evening', 'night'];

  // Inline-edit + filter view state, mirrors the module-level pattern used
  // elsewhere (e.g. children.js's viewChildId).
  let editingId = null;
  let filterChildId = '';
  // Which chore-type buckets are expanded (§UX below) — kept outside the DOM
  // so it survives the render() a filter change, edit, or delete triggers.
  const openTypes = new Set();

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

  // ---- Normalizing helpers (Shared Chores §2.3) ----
  //
  // Every call site in this app — listChores, the list row, the edit/create
  // forms, Propose (packet.js) and the child cascade (children.js) — reads a
  // chore's participants/allocation/days/instances through these four
  // functions rather than its raw fields. That is what lets an old-shape
  // record ({childId}, no allocation, no instances) and a new-shape one
  // ({childIds, allocation, childDays?, instances?}) behave identically with
  // no migration and no dual-write window: a chore never edited keeps its old
  // shape and keeps working.

  function participantsOf(chore) {
    return chore.childIds || (chore.childId ? [chore.childId] : []);
  }

  function allocationOf(chore) {
    return chore.allocation || 'each';
  }

  function daysFor(chore, childId) {
    return (chore.childDays && chore.childDays[childId]) || chore.daysOfWeek;
  }

  function instancesOf(chore) {
    return chore.instances || [{ id: '' }];
  }

  // ---- Validation & CRUD (FR-1, FR-2, FR-4, FR-5, FR-7) ----

  async function validateFields(fields) {
    if (!fields.title || !fields.title.trim()) return 'Title is required.';
    const childIds = fields.childIds || [];
    if (childIds.length === 0) return 'At least one participating Child is required.';
    if (new Set(childIds).size !== childIds.length) return 'Participants must not contain duplicates.';
    for (const id of childIds) {
      const child = await Storage.get('children', id);
      if (!child) return 'Every participant must resolve to an existing Child.';
    }
    const allocation = fields.allocation || 'each';
    if (allocation !== 'each' && allocation !== 'claim') return 'Allocation must be "each" or "claim".';
    if (!CHORE_TYPES.includes(fields.choreType)) return 'Chore type must be one of the listed options.';
    const days = fields.daysOfWeek || [];
    if (days.length === 0) return 'At least one day of the week is required.';
    const seen = new Set();
    for (const d of days) {
      if (!DAYS.includes(d)) return 'Invalid day of week.';
      if (seen.has(d)) return 'Days of week must not contain duplicates.';
      seen.add(d);
    }
    // Shared Chores §4.3 — per-child days only mean something for `each`;
    // a `claim` chore with split days would produce a one-row "group" on most
    // days, so the combination is rejected outright rather than defined.
    if (fields.childDays != null) {
      if (allocation === 'claim') return 'A claimed chore cannot have per-child days.';
      for (const childId of Object.keys(fields.childDays)) {
        if (!childIds.includes(childId)) return 'Per-child days may only be set for a participant.';
        const childDays = fields.childDays[childId];
        if (!Array.isArray(childDays) || childDays.length === 0) {
          return 'A participant\'s days, when set, must be a non-empty list.';
        }
        const seenChildDays = new Set();
        for (const d of childDays) {
          if (!days.includes(d)) return 'A participant\'s days must be a subset of the chore\'s days.';
          if (seenChildDays.has(d)) return 'A participant\'s days must not contain duplicates.';
          seenChildDays.add(d);
        }
      }
    }
    if (!fields.difficultyTier) return 'Difficulty Tier is required.';
    const tier = await Storage.get('tiers', fields.difficultyTier);
    if (!tier) return 'Difficulty Tier must resolve to an existing Tier.';
    if (fields.blockHint && !BLOCK_HINTS.includes(fields.blockHint)) return 'Invalid block hint.';
    // §2.8/FR-9 (Amendment A2) — an estimate for the Wall App's chip sizing,
    // not a schedule; optional, and capped at a day (1440) since anything
    // longer is a data-entry error, not a chore.
    if (fields.expectedDurationMin) {
      const n = Number(fields.expectedDurationMin);
      if (!Number.isInteger(n) || n < 1 || n > 1440) {
        return 'Expected duration (min) must be a whole number from 1 to 1440, or left blank.';
      }
    }
    // Shared Chores §2.2 — occurrences per day. Absent means one unlabeled
    // occurrence, today's behavior exactly (§2.4). No '-' in an id: the
    // Generation Log's occurrence id (CHR-{token}-{date}[-{instanceId}])
    // parses on '-', and a hyphen inside the id would break that (§3.2).
    if (fields.instances != null) {
      if (!Array.isArray(fields.instances) || fields.instances.length === 0) {
        return 'Occurrences, when given, must be a non-empty list.';
      }
      const seenIds = new Set();
      for (const inst of fields.instances) {
        if (!inst || typeof inst.id !== 'string' || !inst.id) return 'Every occurrence needs an id.';
        if (inst.id.includes('-')) return 'Occurrence ids may not contain "-".';
        if (seenIds.has(inst.id)) return 'Occurrence ids must be unique within the chore.';
        seenIds.add(inst.id);
        if (inst.blockHint && !BLOCK_HINTS.includes(inst.blockHint)) return 'Invalid occurrence block hint.';
      }
    }
    return null;
  }

  // Optional fields omitted, never null (same rule as curriculum.js). Always
  // written in the new shape (§2.3) — a save through the edit or create form
  // never re-emits the legacy single-`childId` shape, even for a one-child
  // chore (§0.5: `childIds: [x]`, `allocation: 'each'`).
  function buildRecord(id, fields) {
    const record = {
      id,
      childIds: fields.childIds,
      allocation: fields.allocation || 'each',
      title: fields.title.trim(),
      choreType: fields.choreType,
      daysOfWeek: fields.daysOfWeek,
      difficultyTier: fields.difficultyTier,
    };
    if (fields.notes && fields.notes.trim()) record.notes = fields.notes.trim();
    if (fields.blockHint) record.blockHint = fields.blockHint;
    if (fields.expectedDurationMin) record.expectedDurationMin = Number(fields.expectedDurationMin);
    if (fields.childDays && Object.keys(fields.childDays).length) record.childDays = fields.childDays;
    if (fields.instances && fields.instances.length) record.instances = fields.instances;
    return record;
  }

  // Shared Chores §4.4 — called from children.js's cascade when a Child is
  // deleted. Drops the departing child from participants and from
  // `childDays`, leaves `allocation` and everything else alone. Built on
  // `buildRecord` so a pruned record is written in the same normalized shape
  // an edit-form save would produce.
  function pruneParticipant(chore, childId) {
    const childIds = participantsOf(chore).filter((id) => id !== childId);
    const childDays = chore.childDays ? { ...chore.childDays } : undefined;
    if (childDays) delete childDays[childId];
    return buildRecord(chore.id, {
      childIds,
      allocation: allocationOf(chore),
      title: chore.title,
      choreType: chore.choreType,
      daysOfWeek: chore.daysOfWeek,
      difficultyTier: chore.difficultyTier,
      notes: chore.notes,
      blockHint: chore.blockHint,
      expectedDurationMin: chore.expectedDurationMin,
      childDays,
      instances: chore.instances,
    });
  }

  // FR-1 — choreToken minted, uniqueness-checked against existing `chores`
  // rows, and re-rolled on collision, inside the SAME transaction as the
  // insert (TDS §1/§3 — two rapid creates must not both read "free" and both
  // write). No separate `choreToken` field is stored; it's the id's stem
  // (`id.slice(4)`, since the prefix is always exactly "CHR-"). Bounded at
  // 10 attempts; on exhaustion nothing is written and a hard error returns.
  async function createChore(fields) {
    const error = await validateFields(fields);
    if (error) return { error };

    let record;
    let mintFailed = false;
    try {
      await Storage.runTransaction(['chores'], 'readwrite', (t) => {
        const store = t.objectStore('chores');
        const req = store.getAll();
        req.onsuccess = () => {
          const used = new Set(req.result.map((c) => c.id.slice(4)));
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
          record = buildRecord('CHR-' + token, fields);
          store.put(record);
        };
      });
    } catch (err) {
      if (!mintFailed) throw err;
    }
    if (mintFailed) return { error: 'Could not mint a unique Chore token after 10 attempts.' };
    return { record };
  }

  // FR-2 — every field editable, including childIds/allocation/choreType/
  // daysOfWeek/difficultyTier; id (and therefore the choreToken stem) never
  // changes, not even when the participant list changes.
  async function editChore(id, fields) {
    const error = await validateFields(fields);
    if (error) return { error };
    const record = buildRecord(id, fields);
    await Storage.put('chores', record);
    return { record };
  }

  // FR-3 — explicit confirmation is a UI-layer concern (buildDisplayItem);
  // this just deletes. Nothing already delivered is touched.
  async function deleteChore(id) {
    await Storage.del('chores', id);
  }

  // FR-4 — application-level filter over a full scan, no index (TDS §1).
  async function listChores(childId) {
    const all = await Storage.getAll('chores');
    if (!childId) return all;
    return all.filter((c) => participantsOf(c).includes(childId));
  }

  // ---- Bulk CSV Import (FR-8, TDS_Slice_Chore_Bulk_Import.md §4) ----
  //
  // The parse and every per-row rule live in ChoresCsvCore, which is pure. What
  // is left here is the part that cannot be: resolving the lookup data, running
  // the last validation gate, and the batched write.

  // TDS §4.3 — mints a token not already in `used` and not already minted in
  // this batch, bounded at 10 attempts exactly as createChore() is. Adds what
  // it mints to `used`, so the caller's set carries the batch forward.
  function mintChoreToken(used) {
    for (let i = 0; i < 10; i++) {
      const candidate = randomToken();
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    return null;
  }

  // TDS §3 — occurrence ids are minted, never authored, so "unique within the
  // Chore" and "no '-'" (Shared Chores §2.4) hold by construction:
  // randomToken() draws from [a-z0-9] only, and this re-rolls until the row's
  // own ids are distinct.
  function buildInstancesFromLabels(labels) {
    if (!labels || !labels.length) return undefined;
    const seen = new Set();
    return labels.map((label) => {
      let id = randomToken();
      while (seen.has(id)) id = randomToken();
      seen.add(id);
      return { id, label };
    });
  }

  // FR-8 entry point. Every check — the header gate, every per-row rule, and
  // validateFields() on every candidate — runs before any write; one or more
  // failures ⇒ nothing is written and existing Chores are untouched.
  async function importChoresCsv(text) {
    const [children, tiers] = await Promise.all([
      Storage.getAll('children'),
      Storage.getAll('tiers'),
    ]);
    const lookups = {
      // `active` is resolved here rather than in the core so the
      // absent-means-active rule stays in children.js (TDS §1).
      children: children.map((c) => ({ id: c.id, name: c.name, active: Children.isActive(c) })),
      tierIds: tiers.map((t) => t.tierId),
    };

    const read = ChoresCsvCore.readCsv(text, lookups);
    if (read.error) return { error: read.error, failures: read.failures };

    // TDS §1's last gate: nothing reaches the store that the manual create
    // form would have rejected. The core's checks shape the message; this
    // decides. Running it over every candidate (not stopping at the first)
    // keeps the one-pass-fix property the per-row loop already has.
    const failures = [];
    for (const candidate of read.candidates) {
      const fields = {
        ...candidate.fields,
        instances: buildInstancesFromLabels(candidate.instanceLabels),
      };
      const error = await validateFields(fields);
      if (error) failures.push(`Row ${candidate.rowNumber}: ${error}`);
      else candidate.resolvedFields = fields;
    }
    if (failures.length > 0) {
      return { error: 'Import rejected — no Chores were written.', failures };
    }

    // TDS §4.3 — one exclusive transaction: the getAll() that reads the tokens
    // in use and every put() are inside it, so two concurrent imports cannot
    // both observe the same token free. This is what createChore() does for a
    // single record, batched.
    let mintFailed = false;
    const written = [];
    try {
      await Storage.runTransaction(['chores'], 'readwrite', (t) => {
        const store = t.objectStore('chores');
        const req = store.getAll();
        req.onsuccess = () => {
          const used = new Set(req.result.map((c) => c.id.slice(4)));
          for (const candidate of read.candidates) {
            const token = mintChoreToken(used);
            if (!token) {
              mintFailed = true;
              written.length = 0;
              t.abort();
              return;
            }
            const record = buildRecord('CHR-' + token, candidate.resolvedFields);
            store.put(record);
            written.push(record);
          }
        };
      });
    } catch (err) {
      if (!mintFailed) throw err;
    }
    if (mintFailed) return { error: 'Could not mint a unique Chore token after 10 attempts — nothing was written.' };

    const childIds = new Set();
    written.forEach((r) => r.childIds.forEach((id) => childIds.add(id)));
    return { summary: { choresCreated: written.length, childrenTouched: childIds.size } };
  }

  // ---- Rendering ----

  function daysHtml(name, selected) {
    return DAYS.map((d) => `
      <label class="day-option">
        <input type="checkbox" name="${name}" value="${d}" ${selected.includes(d) ? 'checked' : ''}> ${d}
      </label>
    `).join('');
  }

  function readDays(form) {
    return Array.from(form.querySelectorAll('input[name="daysOfWeek"]:checked')).map((el) => el.value);
  }

  // Shared Chores §8 — Occurrences per day. An empty list is the default and
  // renders nothing extra, so a one-a-day chore's form is unchanged. Each row
  // is a label and an optional block hint; ids are minted once, on Add, and
  // never reassigned to a different row (§2.4).
  function buildInstancesFieldset(instances) {
    const rows = (instances || []).map((inst) => ({ id: inst.id, label: inst.label || '', blockHint: inst.blockHint || '' }));

    const fs = document.createElement('fieldset');
    fs.className = 'chore-instances';
    const legend = document.createElement('legend');
    legend.textContent = 'Occurrences per day';
    fs.appendChild(legend);

    const list = document.createElement('div');
    list.className = 'chore-instances-list';
    fs.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Add occurrence';
    fs.appendChild(addBtn);

    function renderRows() {
      list.innerHTML = '';
      rows.forEach((row, idx) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'chore-instance-row';
        rowEl.innerHTML = `
          <input type="text" class="instance-label" placeholder="Label (e.g. Breakfast)" value="${escapeHtml(row.label)}">
          <select class="instance-block-hint">${blockHintOptions(row.blockHint)}</select>
          <button type="button" data-action="remove-instance">Remove</button>
        `;
        rowEl.querySelector('.instance-label').addEventListener('input', (e) => { row.label = e.target.value; });
        rowEl.querySelector('.instance-block-hint').addEventListener('change', (e) => { row.blockHint = e.target.value; });
        rowEl.querySelector('[data-action="remove-instance"]').addEventListener('click', () => {
          const confirmed = window.confirm(
            'Remove this occurrence? Already-committed occurrences on the plan are unaffected — ' +
            'this only stops future generation.'
          );
          if (!confirmed) return;
          rows.splice(idx, 1);
          renderRows();
        });
        list.appendChild(rowEl);
      });
    }
    renderRows();

    addBtn.addEventListener('click', () => {
      rows.push({ id: randomToken(), label: '', blockHint: '' });
      renderRows();
    });

    fs.readInstances = () => {
      if (rows.length === 0) return undefined;
      return rows.map((r) => {
        const out = { id: r.id };
        if (r.label && r.label.trim()) out.label = r.label.trim();
        if (r.blockHint) out.blockHint = r.blockHint;
        return out;
      });
    };
    return fs;
  }

  // Shared Chores §8 — Participants, arrangement, and per-child days, built
  // as one stateful fieldset so checking/unchecking a participant can grow or
  // shrink the arrangement and day-grid controls beneath it. `chore` is `{}`
  // for the create form.
  //
  // Archived children are not offered (§3.2's `active`), except one already a
  // participant on the chore being edited: dropping it would leave the
  // checkbox list showing a different set of participants than the record
  // holds, and silently rewrite `childIds` on the next save. The browse
  // filter above the list is built from the full child list either way, so
  // an archived child's chores stay reachable. (The Propose form's flat
  // exclusion is the *other* case — it generates new work and has no
  // already-selected child to preserve.)
  function buildParticipationFieldset(chore, allChildren) {
    const participants = new Set(participantsOf(chore));
    let allocation = allocationOf(chore);
    const existingChildDays = chore.childDays || {};
    let sameDays = Object.keys(existingChildDays).length === 0;
    const chosenDays = {}; // childId -> days[], seeded lazily on first reveal

    const eligible = allChildren.filter((c) => Children.isActive(c) || participants.has(c.id));

    const fs = document.createElement('fieldset');
    fs.className = 'chore-participation';
    const legend = document.createElement('legend');
    legend.textContent = 'Participants';
    fs.appendChild(legend);

    const checkboxWrap = document.createElement('div');
    checkboxWrap.className = 'participant-checkboxes';
    const arrangementWrap = document.createElement('div');
    arrangementWrap.className = 'chore-arrangement';
    const sameDaysWrap = document.createElement('div');
    sameDaysWrap.className = 'chore-same-days';
    const perChildDaysWrap = document.createElement('div');
    perChildDaysWrap.className = 'chore-per-child-days';
    fs.append(checkboxWrap, arrangementWrap, sameDaysWrap, perChildDaysWrap);

    function currentDaysOfWeek() {
      // Reads the sibling Days-of-week fieldset live, once this fieldset is
      // attached to the form, so a freshly-revealed per-child grid seeds from
      // whatever the parent has checked in this same edit session. Before
      // attachment (the initial render, still building the form) falls back
      // to the chore's own days.
      const form = fs.closest('form');
      return form ? readDays(form) : (chore.daysOfWeek || []);
    }

    function renderCheckboxes() {
      checkboxWrap.innerHTML = eligible.map((c) => `
        <label class="participant-option">
          <input type="checkbox" name="childIds" value="${c.id}" ${participants.has(c.id) ? 'checked' : ''}> ${escapeHtml(c.name)}
        </label>
      `).join('');
      checkboxWrap.querySelectorAll('input[name="childIds"]').forEach((el) => {
        el.addEventListener('change', () => {
          if (el.checked) participants.add(el.value); else participants.delete(el.value);
          renderDerived();
        });
      });
    }

    function renderArrangement() {
      if (participants.size <= 1) { arrangementWrap.innerHTML = ''; return; }
      arrangementWrap.innerHTML = `
        <label><input type="radio" name="allocation" value="each" ${allocation === 'each' ? 'checked' : ''}> Each child does their own</label>
        <label><input type="radio" name="allocation" value="claim" ${allocation === 'claim' ? 'checked' : ''}> Either child can claim it — first one earns the reward</label>
      `;
      arrangementWrap.querySelectorAll('input[name="allocation"]').forEach((el) => {
        el.addEventListener('change', () => { allocation = el.value; renderDerived(); });
      });
    }

    function renderSameDays() {
      if (participants.size <= 1 || allocation !== 'each') { sameDaysWrap.innerHTML = ''; return; }
      sameDaysWrap.innerHTML = `<label><input type="checkbox" name="sameDays" ${sameDays ? 'checked' : ''}> Same days for everyone</label>`;
      sameDaysWrap.querySelector('input[name="sameDays"]').addEventListener('change', (e) => {
        sameDays = e.target.checked;
        renderPerChildDays();
      });
    }

    function renderPerChildDays() {
      if (participants.size <= 1 || allocation !== 'each' || sameDays) { perChildDaysWrap.innerHTML = ''; return; }
      const base = currentDaysOfWeek();
      perChildDaysWrap.innerHTML = '';
      for (const childId of participants) {
        if (!(childId in chosenDays)) {
          const seeded = existingChildDays[childId] || base;
          chosenDays[childId] = seeded.filter((d) => base.includes(d));
        }
        const child = allChildren.find((c) => c.id === childId);
        const wrap = document.createElement('div');
        wrap.className = 'chore-child-days';
        const label = document.createElement('span');
        label.textContent = (child ? child.name : childId) + ':';
        wrap.appendChild(label);
        const grid = document.createElement('span');
        grid.innerHTML = daysHtml(`childDays-${childId}`, chosenDays[childId]);
        wrap.appendChild(grid);
        perChildDaysWrap.appendChild(wrap);
        grid.querySelectorAll(`input[name="childDays-${childId}"]`).forEach((el) => {
          el.addEventListener('change', () => {
            chosenDays[childId] = Array.from(grid.querySelectorAll(`input[name="childDays-${childId}"]:checked`)).map((e2) => e2.value);
          });
        });
      }
    }

    function renderDerived() {
      renderArrangement();
      renderSameDays();
      renderPerChildDays();
    }
    renderCheckboxes();
    renderDerived();

    fs.readParticipation = () => {
      const childIds = Array.from(participants);
      const out = { childIds, allocation: childIds.length > 1 ? allocation : 'each' };
      if (childIds.length > 1 && allocation === 'each' && !sameDays) {
        const childDays = {};
        for (const childId of childIds) {
          if (chosenDays[childId] && chosenDays[childId].length) childDays[childId] = chosenDays[childId];
        }
        if (Object.keys(childDays).length) out.childDays = childDays;
      }
      return out;
    };
    return fs;
  }

  function choreTypeOptions(selected) {
    return ['<option value="">(select)</option>']
      .concat(CHORE_TYPES.map((t) => `<option value="${escapeHtml(t)}" ${t === selected ? 'selected' : ''}>${escapeHtml(t)}</option>`))
      .join('');
  }

  function tierOptions(tiers, selected) {
    return ['<option value="">(select)</option>']
      .concat(tiers.map((t) => `<option value="${t.tierId}" ${t.tierId === selected ? 'selected' : ''}>${escapeHtml(t.label)}</option>`))
      .join('');
  }

  function blockHintOptions(selected) {
    return ['<option value="">(none)</option>']
      .concat(BLOCK_HINTS.map((b) => `<option value="${b}" ${b === selected ? 'selected' : ''}>${b}</option>`))
      .join('');
  }

  async function render(root) {
    root.innerHTML = '';
    const [chores, children, tiers] = await Promise.all([
      listChores(filterChildId),
      Storage.getAll('children'),
      Tiers.listSorted(),
    ]);

    const heading = document.createElement('h1');
    heading.textContent = 'Chores';
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

    // Grouped into collapsed-by-default buckets by chore type — a flat list
    // across every type was one long scroll (§UX, same convention as the
    // Course Template Library's subject grouping in courses.js). Every Chore's
    // type is one of CHORE_TYPES by construction (validateFields rejects any
    // other value), so grouping by that fixed list needs no "other" bucket.
    const byType = new Map();
    for (const chore of chores) {
      if (!byType.has(chore.choreType)) byType.set(chore.choreType, []);
      byType.get(chore.choreType).push(chore);
    }

    const groupsEl = document.createElement('div');
    groupsEl.className = 'chore-type-groups';
    for (const type of CHORE_TYPES.filter((t) => byType.has(t))) {
      const choresOfType = byType.get(type);

      // <details> defaults closed, same as course-subject-group, except a
      // bucket holding the Chore currently being edited — Save/Cancel
      // shouldn't vanish behind a closed summary.
      const details = document.createElement('details');
      details.className = 'chore-type-group';
      details.open = openTypes.has(type) || choresOfType.some((c) => c.id === editingId);
      details.addEventListener('toggle', () => {
        if (details.open) openTypes.add(type); else openTypes.delete(type);
      });
      const summary = document.createElement('summary');
      summary.textContent = `${type} (${choresOfType.length})`;
      details.appendChild(summary);

      const list = document.createElement('ul');
      list.className = 'chore-list';
      for (const chore of choresOfType) {
        list.appendChild(
          chore.id === editingId ? buildEditItem(root, chore, children, tiers) : buildDisplayItem(root, chore, children)
        );
      }
      details.appendChild(list);
      groupsEl.appendChild(details);
    }
    root.appendChild(groupsEl);

    root.appendChild(buildCreateForm(root, children, tiers));
    root.appendChild(buildBulkImportSection(root));
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  // TDS §4.1 — emitted from ChoresCsvCore's own CSV_COLUMNS, so the header a
  // parent downloads cannot drift from the header the gate demands. Header row
  // only: the template is itself a valid import that writes nothing.
  function downloadCsvTemplate() {
    // Same Blob-URL treatment reporting.js and courses.js use; revoked after.
    const url = URL.createObjectURL(
      new Blob([ChoresCsvCore.templateCsv()], { type: 'text/csv;charset=utf-8' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'chore-import-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  // FR-8's UI, mirroring courses.js's bulk-import section: file input, Import,
  // Download blank template, and a result area that reports the outcome of
  // every attempt — reject with a reason per failing row, or the counts.
  function buildBulkImportSection(root) {
    const section = document.createElement('section');
    section.className = 'bulk-import';
    section.innerHTML = `
      <h2>Bulk Import Chores (CSV)</h2>
      <p class="bulk-import-hint">
        One row per Chore. Separate multiple children, days, or occurrences with
        <code>|</code> — e.g. <code>Ada|Ben</code>, <code>Mon|Wed|Fri</code>,
        <code>Breakfast|Dinner</code>. Per-child day splits are not imported; add
        those with Edit afterwards.
      </p>
      <input type="file" name="csvFile" accept=".csv,text/csv">
      <div class="bulk-import-actions">
        <button type="button" data-action="import">Import</button>
        <button type="button" class="secondary" data-action="template">Download blank template</button>
      </div>
      <div class="bulk-import-result" hidden></div>
    `;
    const fileInput = section.querySelector('input[type="file"]');
    const resultEl = section.querySelector('.bulk-import-result');

    section.querySelector('[data-action="template"]').addEventListener('click', downloadCsvTemplate);

    section.querySelector('[data-action="import"]').addEventListener('click', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        resultEl.hidden = false;
        resultEl.innerHTML = `<p class="error">Choose a CSV file first.</p>`;
        return;
      }
      const text = await readFileAsText(file);
      const result = await importChoresCsv(text);
      resultEl.hidden = false;
      if (result.error) {
        const failures = (result.failures || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('');
        resultEl.innerHTML = `<p class="error">${escapeHtml(result.error)}</p>${failures ? `<ul>${failures}</ul>` : ''}`;
        return;
      }
      const { choresCreated, childrenTouched } = result.summary;
      resultEl.innerHTML =
        `<p class="success">Imported: ${choresCreated} Chore(s) across ${childrenTouched} child(ren).</p>`;
      fileInput.value = '';
      render(root);
    });

    return section;
  }

  function buildDisplayItem(root, chore, children) {
    const participantNames = participantsOf(chore)
      .map((id) => {
        const c = children.find((x) => x.id === id);
        return c ? c.name : '(unresolved child)';
      })
      .join(', ');
    const arrangementLabel = participantsOf(chore).length > 1
      ? (allocationOf(chore) === 'claim' ? 'Either can claim' : 'Each own')
      : '';
    const item = document.createElement('li');
    // The four descriptive spans read as one wrapping line of detail under the
    // title, so Edit/Delete keep the same position on every Chore.
    item.className = 'list-row';
    const detail = [
      `<span class="chore-child">${escapeHtml(participantNames || '(no participants)')}</span>`,
      `<span class="chore-type">${escapeHtml(chore.choreType)}</span>`,
      `<span class="chore-days">${chore.daysOfWeek.join(', ')}</span>`,
      chore.instances && chore.instances.length > 1
        ? `<span class="chore-instance-count">${chore.instances.length}×/day</span>` : '',
      arrangementLabel ? `<span class="chore-arrangement-label">${arrangementLabel}</span>` : '',
    ].filter(Boolean).join('');
    item.innerHTML = `
      <div class="row-text">
        <span class="row-title chore-title">${escapeHtml(chore.title)}</span>
        <span class="row-meta row-meta-inline">${detail}</span>
      </div>
      <div class="row-actions">
        <button data-action="edit">Edit</button>
        <button data-action="delete">Delete</button>
      </div>
    `;
    item.querySelector('[data-action="edit"]').addEventListener('click', () => {
      editingId = chore.id;
      render(root);
    });
    item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      const confirmed = window.confirm(
        `Delete Chore "${chore.title}"? This stops all future recurrence generation. ` +
        `Content already delivered to the child's device is unaffected.`
      );
      if (!confirmed) return;
      await deleteChore(chore.id);
      render(root);
    });
    return item;
  }

  function buildEditItem(root, chore, children, tiers) {
    const item = document.createElement('li');
    const form = document.createElement('form');
    form.className = 'chore-edit-form';
    form.innerHTML = `
      <label>Title<input type="text" name="title" value="${escapeHtml(chore.title)}" required></label>
      <label>Chore type<select name="choreType">${choreTypeOptions(chore.choreType)}</select></label>
      <fieldset class="chore-days-of-week"><legend>Days of week</legend>${daysHtml('daysOfWeek', chore.daysOfWeek)}</fieldset>
      <label>Difficulty Tier<select name="difficultyTier">${tierOptions(tiers, chore.difficultyTier)}</select></label>
      <label>Notes<input type="text" name="notes" value="${escapeHtml(chore.notes || '')}"></label>
      <label>Block hint<select name="blockHint">${blockHintOptions(chore.blockHint)}</select></label>
      <label>Expected duration (min)<input type="number" name="expectedDurationMin" min="1" max="1440" step="1" value="${chore.expectedDurationMin || ''}"></label>
      <p class="error" hidden></p>
      <button type="submit">Save</button>
      <button type="button" data-action="cancel">Cancel</button>
    `;
    const participationFieldset = buildParticipationFieldset(chore, children);
    form.insertBefore(participationFieldset, form.firstChild);
    const instancesFieldset = buildInstancesFieldset(chore.instances);
    form.querySelector('.chore-days-of-week').insertAdjacentElement('afterend', instancesFieldset);
    const errorEl = form.querySelector('.error');
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      editingId = null;
      render(root);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await editChore(chore.id, {
        ...participationFieldset.readParticipation(),
        title: form.title.value,
        choreType: form.choreType.value,
        daysOfWeek: readDays(form),
        difficultyTier: form.difficultyTier.value,
        notes: form.notes.value,
        blockHint: form.blockHint.value,
        expectedDurationMin: form.expectedDurationMin.value,
        instances: instancesFieldset.readInstances(),
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

  function buildCreateForm(root, children, tiers) {
    const form = document.createElement('form');
    form.innerHTML = `
      <h2>Add Chore</h2>
      <label>Title<input type="text" name="title" required></label>
      <label>Chore type<select name="choreType">${choreTypeOptions('')}</select></label>
      <fieldset class="chore-days-of-week"><legend>Days of week</legend>${daysHtml('daysOfWeek', [])}</fieldset>
      <label>Difficulty Tier<select name="difficultyTier">${tierOptions(tiers, '')}</select></label>
      <label>Notes<input type="text" name="notes"></label>
      <label>Block hint<select name="blockHint">${blockHintOptions('')}</select></label>
      <label>Expected duration (min)<input type="number" name="expectedDurationMin" min="1" max="1440" step="1"></label>
      <p class="error" hidden></p>
      <button type="submit">Add Chore</button>
    `;
    const participationFieldset = buildParticipationFieldset({}, children);
    form.querySelector('h2').insertAdjacentElement('afterend', participationFieldset);
    const instancesFieldset = buildInstancesFieldset([]);
    form.querySelector('.chore-days-of-week').insertAdjacentElement('afterend', instancesFieldset);
    const errorEl = form.querySelector('.error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = await createChore({
        ...participationFieldset.readParticipation(),
        title: form.title.value,
        choreType: form.choreType.value,
        daysOfWeek: readDays(form),
        difficultyTier: form.difficultyTier.value,
        notes: form.notes.value,
        blockHint: form.blockHint.value,
        expectedDurationMin: form.expectedDurationMin.value,
        instances: instancesFieldset.readInstances(),
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

  return {
    render, createChore, editChore, deleteChore, listChores, importChoresCsv,
    participantsOf, allocationOf, daysFor, instancesOf, pruneParticipant,
    // Exported so any other view grouping Chores by type (weekly.js) uses the
    // same canonical order this page does, rather than a second copy of it.
    CHORE_TYPES,
  };
})();
