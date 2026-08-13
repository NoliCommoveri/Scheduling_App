/* Module: pacing.js — Module 05, Pacing Configuration.
 * Per SRS_Management_Module_05_Pacing_Configuration.md and
 * TDS_Slice_M7_Management_App_Rev1.md §1/§3.
 * Sole writer of `pacingProfiles`. Reads `courses`/`lessons`/`activities`
 * (walk/total) and `generationLog` (FR-8 progress) — writes neither. Never
 * writes the Generation Log (that is packet.js alone, only at Commit). */

const Pacing = (() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const BLOCKS = ['morning', 'afternoon', 'evening', 'night']; // Interchange Contract §1d
  const MODES = ['activityCount', 'minutesBudget'];

  let filterChildId = '';

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function isValidDate(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return false;
    const [y, m, d] = str.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function isPositiveInt(v) {
    return Number.isInteger(v) && v > 0;
  }

  // ---- Instance content reads (walk order + totals — §3 FR-8) ----

  async function instanceActivitiesInWalkOrder(instanceId) {
    const lessons = (await Storage.getAllByIndex('lessons', 'by_courseId', instanceId)).sort(
      (a, b) => a.order - b.order
    );
    const out = [];
    for (const lesson of lessons) {
      const acts = (await Storage.getAllByIndex('activities', 'by_lessonId', lesson.id)).sort(
        (a, b) => a.order - b.order
      );
      for (const a of acts) out.push(a);
    }
    return out;
  }

  // FR-8 — read-only progress off the Generation Log. Writes nothing.
  async function progressFor(instanceId) {
    const [activities, logRows] = await Promise.all([
      instanceActivitiesInWalkOrder(instanceId),
      Storage.getAllByIndex('generationLog', 'by_instance', instanceId),
    ]);
    const total = activities.length;
    const sentIds = new Set(logRows.filter((r) => r.disposition === 'sent').map((r) => r.itemId));
    const sent = activities.filter((a) => sentIds.has(a.id)).length;
    const excluded = activities.filter((a) => a.excludeFromGeneration).length;
    // Pending excludes both sent and permanently-excluded Activities (§2.1).
    const pending = activities.filter((a) => !sentIds.has(a.id) && !a.excludeFromGeneration).length;
    return { total, sent, excluded, pending };
  }

  // ---- Profile CRUD (FR-1/FR-2/FR-7) ----

  async function getProfile(instanceId) {
    return Storage.get('pacingProfiles', instanceId);
  }

  function validate(fields) {
    const days = fields.daysOfWeek || [];
    if (days.length === 0) return 'At least one day of the week is required.';
    const seen = new Set();
    for (const d of days) {
      if (!DAYS.includes(d)) return 'Invalid day of week.';
      if (seen.has(d)) return 'Days of week must not contain duplicates.';
      seen.add(d);
    }
    if (!MODES.includes(fields.pacingMode)) return 'A pacing mode must be selected.';
    if (fields.pacingMode === 'activityCount' && !isPositiveInt(fields.activitiesPerDay)) {
      return 'Activities per day must be a positive whole number.';
    }
    if (fields.pacingMode === 'minutesBudget' && !isPositiveInt(fields.minutesPerDay)) {
      return 'Minutes per day must be a positive whole number.';
    }
    if (!isValidDate(fields.startDate)) return 'A valid start date is required.';
    for (const s of fields.skipDates || []) {
      if (!isValidDate(s)) return `Skip date "${s}" is not a valid calendar date.`;
    }
    for (const b of fields.blockLayout || []) {
      if (!BLOCKS.includes(b)) return `Block layout label "${b}" is not one of the four canonical blocks.`;
    }
    return null;
  }

  // Create and Edit are the same operation — one Profile per Instance, a single
  // put() keyed by instanceId. `id` is PAC- + the Instance's existing token; no
  // counter, no new token minted (TDS §1/§3).
  async function saveProfile(instanceId, fields) {
    const instance = await Storage.get('courses', instanceId);
    if (!instance || instance.state !== 'instance') {
      return { error: 'Pacing applies to a Course Instance only.' };
    }
    const error = validate(fields);
    if (error) return { error };

    const record = {
      id: 'PAC-' + instance.instanceToken,
      instanceId,
      daysOfWeek: fields.daysOfWeek,
      pacingMode: fields.pacingMode,
      startDate: fields.startDate,
    };
    // Mode's budget value only; the other mode's field is omitted, never null.
    if (fields.pacingMode === 'activityCount') record.activitiesPerDay = fields.activitiesPerDay;
    else record.minutesPerDay = fields.minutesPerDay;
    // Optional fields — omitted when empty (M4 precedent).
    const skip = (fields.skipDates || []).filter((s, i, arr) => arr.indexOf(s) === i); // dedupe, not reject
    if (skip.length) record.skipDates = skip;
    if ((fields.blockLayout || []).length) record.blockLayout = fields.blockLayout;
    // `weighting` is reserved and unwritten (FR-5).

    await Storage.put('pacingProfiles', record);
    return { record };
  }

  function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // FR-1's companion: the Profile a freshly-stamped Instance starts with,
  // derived from the source Course's `defaultPacingHint` (PacingCore) with
  // defaults for whatever the hint does not state. Called by children.js at
  // stamp time — the write still happens here, so pacing.js remains the sole
  // writer of `pacingProfiles`. Never overwrites an existing Profile, and a
  // failure here leaves the Instance profile-less, which §2.6 already treats
  // as a valid state.
  async function ensureDefaultProfile(instanceId, options = {}) {
    const existing = await getProfile(instanceId);
    if (existing) return { record: existing, created: false };

    const instance = await Storage.get('courses', instanceId);
    if (!instance || instance.state !== 'instance') {
      return { error: 'Pacing applies to a Course Instance only.' };
    }
    const hint = options.hint !== undefined ? options.hint : instance.defaultPacingHint;
    const { fields, source } = PacingCore.defaultProfileFields(hint, options.startDate || todayISO());
    const result = await saveProfile(instanceId, fields);
    if (result.error) return result;
    return {
      record: result.record,
      created: true,
      source,
      summary: PacingCore.describe(fields),
    };
  }

  // ---- Rendering ----

  async function listInstances(childId) {
    const courses = childId
      ? await Storage.getAllByIndex('courses', 'by_childId', childId)
      : await Storage.getAll('courses');
    return courses.filter((c) => c.state === 'instance');
  }

  async function render(root) {
    root.innerHTML = '';
    const [children, instances] = await Promise.all([
      Storage.getAll('children'),
      listInstances(filterChildId),
    ]);

    const heading = document.createElement('h1');
    heading.textContent = 'Pacing Configuration';
    root.appendChild(heading);

    const filterForm = document.createElement('form');
    const filterOptions = ['<option value="">(all children)</option>']
      .concat(
        children.map(
          (c) => `<option value="${c.id}" ${c.id === filterChildId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
        )
      )
      .join('');
    filterForm.innerHTML = `<label>Filter by child<select name="filterChildId">${filterOptions}</select></label>`;
    filterForm.filterChildId.addEventListener('change', () => {
      filterChildId = filterForm.filterChildId.value;
      render(root);
    });
    root.appendChild(filterForm);

    if (instances.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No Course Instances yet. Stamp a Course to a Child (Children tab) first.';
      root.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'pacing-list';
    for (const inst of instances) {
      list.appendChild(await buildInstanceCard(root, inst, children));
    }
    root.appendChild(list);
  }

  async function buildInstanceCard(root, instance, children) {
    const [profile, progress] = await Promise.all([getProfile(instance.id), progressFor(instance.id)]);
    const child = children.find((c) => c.id === instance.childId);

    const card = document.createElement('section');
    card.className = 'pacing-card';

    const title = document.createElement('h2');
    title.textContent = `${instance.name} — ${child ? child.name : '(unknown child)'}`;
    card.appendChild(title);

    // FR-8 progress (read-only) — "n of N sent", plus excluded tally.
    const prog = document.createElement('p');
    prog.className = 'pacing-progress';
    prog.textContent =
      `${progress.sent} of ${progress.total} Activities sent` +
      ` · ${progress.pending} pending` +
      (progress.excluded ? ` · ${progress.excluded} excluded` : '') +
      (profile ? '' : ' · no Pacing Profile yet');
    card.appendChild(prog);

    const form = document.createElement('form');
    form.className = 'pacing-form';
    const mode = (profile && profile.pacingMode) || 'activityCount';
    // An unconfigured Instance opens on the school week rather than on nothing —
    // the same Mon–Fri fallback FR-1a seeds a stamped Instance with
    // (PacingCore.DEFAULT_DAYS), so the two paths cannot drift apart. Still a
    // starting point: every box is editable before the first save.
    const checkedDays = profile ? profile.daysOfWeek : PacingCore.DEFAULT_DAYS;
    form.innerHTML = `
      <fieldset><legend>Days of week</legend>
        ${DAYS.map(
          (d) => `<label class="day-option"><input type="checkbox" name="daysOfWeek" value="${d}" ${
            checkedDays.includes(d) ? 'checked' : ''
          }> ${d}</label>`
        ).join('')}
      </fieldset>
      <label>Pacing mode
        <select name="pacingMode">
          <option value="activityCount" ${mode === 'activityCount' ? 'selected' : ''}>Activities per day</option>
          <option value="minutesBudget" ${mode === 'minutesBudget' ? 'selected' : ''}>Minutes per day</option>
        </select>
      </label>
      <label class="budget-activityCount">Activities per day
        <input type="number" name="activitiesPerDay" min="1" value="${
          profile && profile.activitiesPerDay != null ? profile.activitiesPerDay : ''
        }">
      </label>
      <label class="budget-minutesBudget">Minutes per day
        <input type="number" name="minutesPerDay" min="1" value="${
          profile && profile.minutesPerDay != null ? profile.minutesPerDay : ''
        }">
      </label>
      <label>Start date<input type="date" name="startDate" value="${profile ? profile.startDate : ''}"></label>
      <label>Skip dates (comma-separated YYYY-MM-DD)
        <input type="text" name="skipDates" value="${profile && profile.skipDates ? profile.skipDates.join(', ') : ''}">
      </label>
      <label>Block layout (ordered, comma-separated: morning/afternoon/evening/night)
        <input type="text" name="blockLayout" value="${
          profile && profile.blockLayout ? profile.blockLayout.join(', ') : ''
        }">
      </label>
      <label class="reserved" title="Reserved — not implemented (FR-5)">Weighting<input type="text" name="weighting" disabled placeholder="(reserved)"></label>
      <p class="error" hidden></p>
      <p class="success" hidden></p>
      <button type="submit">${profile ? 'Save Pacing Profile' : 'Create Pacing Profile'}</button>
    `;

    const errorEl = form.querySelector('.error');
    const okEl = form.querySelector('.success');

    function syncBudgetVisibility() {
      const m = form.pacingMode.value;
      form.querySelector('.budget-activityCount').style.display = m === 'activityCount' ? '' : 'none';
      form.querySelector('.budget-minutesBudget').style.display = m === 'minutesBudget' ? '' : 'none';
    }
    form.pacingMode.addEventListener('change', syncBudgetVisibility);
    syncBudgetVisibility();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pacingMode = form.pacingMode.value;
      const fields = {
        daysOfWeek: Array.from(form.querySelectorAll('input[name="daysOfWeek"]:checked')).map((el) => el.value),
        pacingMode,
        startDate: form.startDate.value,
        skipDates: splitList(form.skipDates.value),
        blockLayout: splitList(form.blockLayout.value),
      };
      if (pacingMode === 'activityCount' && form.activitiesPerDay.value !== '') {
        fields.activitiesPerDay = Number(form.activitiesPerDay.value);
      }
      if (pacingMode === 'minutesBudget' && form.minutesPerDay.value !== '') {
        fields.minutesPerDay = Number(form.minutesPerDay.value);
      }
      const result = await saveProfile(instance.id, fields);
      if (result.error) {
        okEl.hidden = true;
        errorEl.hidden = false;
        errorEl.textContent = result.error;
        return;
      }
      errorEl.hidden = true;
      okEl.hidden = false;
      okEl.textContent = 'Saved.';
      render(root);
    });

    card.appendChild(form);
    return card;
  }

  function splitList(raw) {
    return (raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  return {
    render,
    saveProfile,
    getProfile,
    ensureDefaultProfile,
    progressFor,
    instanceActivitiesInWalkOrder,
  };
})();
