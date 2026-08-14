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

  // Which per-course pacing cards are expanded — kept outside the DOM so it
  // survives the full re-render a form submit triggers. Keyed by instance id
  // even though only one card is on screen at a time now: the state is what
  // makes "I opened Pacing, saved, and it stayed open" true.
  const openCards = new Set();

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

  // Appends this Course's pacing card to `container`, and calls `onSaved`
  // after a successful save so the caller can re-render its own page (the
  // summary line carries progress counts that a save can move).
  //
  // There is no Pacing page any more. A Pacing Profile is 1:1 with a Course
  // Instance and keyed by its id, so the standalone page was a list of every
  // instance with a child filter bolted on — a second, worse index of the
  // Assigned Courses page. The form now sits on the course it paces.
  async function renderInto(container, instance, onSaved) {
    container.appendChild(await buildInstanceCard(instance, onSaved));
  }

  async function buildInstanceCard(instance, onSaved) {
    const [profile, progress] = await Promise.all([getProfile(instance.id), progressFor(instance.id)]);

    // Collapsed <details> bucket, same convention as .course-subject-group in
    // courses.js. Open/closed state lives in openCards, not on the element,
    // so it survives the re-render a form submit does. Closed by default: one
    // full pacing form open on every visit was a scroll past to reach the
    // Lessons beneath it.
    const card = document.createElement('details');
    card.className = 'pacing-card';
    card.open = openCards.has(instance.id);
    card.addEventListener('toggle', () => {
      if (card.open) openCards.add(instance.id);
      else openCards.delete(instance.id);
    });

    // FR-8 progress (read-only) folded into the summary line — "n of N sent" —
    // so the course's status reads without opening the form. The course and
    // child names are not repeated here: the page this card sits on is that
    // course's own, and both are already in its header.
    const summary = document.createElement('summary');
    summary.textContent =
      `Pacing — ${progress.sent} of ${progress.total} Activities sent` +
      ` · ${progress.pending} pending` +
      (progress.excluded ? ` · ${progress.excluded} excluded` : '') +
      (profile ? '' : ' · no Pacing set yet');
    card.appendChild(summary);

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
      if (onSaved) onSaved();
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
    renderInto,
    saveProfile,
    getProfile,
    ensureDefaultProfile,
    progressFor,
    instanceActivitiesInWalkOrder,
  };
})();
