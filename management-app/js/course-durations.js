/* Module: course-durations.js — the bulk duration panel, one line per Activity
 * Type present beneath a Course. Per SRS_Management_Module_03_Course_Template_
 * Library.md FR-11 (templates) / SRS_Management_Module_04_Child_Management.md
 * FR-15 (assigned courses) and docs/TDS_Slice_Course_Duration_Bulk_Edit.md.
 *
 * Renders into a Course page rather than owning a page of its own — the same
 * arrangement as `pacing.js` (`Pacing.renderInto`), and for the same reason:
 * what it edits belongs to the Course you are already looking at, so a
 * standalone page could only ever be a second index of the Course list.
 *
 * ONE PANEL, BOTH COURSE STATES. courses.js (`state: 'template'`) and
 * instances.js (`state: 'instance'`) both call it. Nothing in here reads or
 * branches on `state`: an Activity's `expectedDurationMin` means the same
 * thing under either, and a stamped Instance's Activities are a byte copy of
 * the template's (Mgmt SRS 04 FR-4 step 4). Setting durations on the template
 * before stamping and fixing them on the Instance afterward are the same
 * action against different rows.
 *
 * WRITE SCOPE — read this before extending it. This is a third writer to the
 * `activities` store, alongside courses.js and instances.js, and it is bounded
 * to exactly one optional field: `expectedDurationMin`, set or removed. It
 * never mints an id, never advances `nextActivitySeq`, never deletes a row,
 * never touches `order`, `activityType`, `difficultyTier`, `title`,
 * `required`, the page range, or `excludeFromGeneration`. Records are written
 * back spread from the row that was read, so a field this module has never
 * heard of survives a save untouched. Structural writes stay with the two
 * owners; anything beyond the one field belongs there, not here.
 */

const CourseDurations = (() => {
  // Which courses' panels are expanded, kept outside the DOM so it survives
  // the full page re-render every action on the host page triggers — the same
  // convention as pacing.js's openCards and courses.js's openSubjectGroups.
  const openCards = new Set();

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Every Activity beneath a Course, across all its Lessons. The same two-step
  // walk `hasActivitiesBeneathCourse` makes, kept here rather than shared so
  // this module reads its own data (courses.js's helper answers a different
  // question and short-circuits).
  async function loadActivities(courseId) {
    const lessons = await Storage.getAllByIndex('lessons', 'by_courseId', courseId);
    const perLesson = await Promise.all(
      lessons.map((l) => Storage.getAllByIndex('activities', 'by_lessonId', l.id))
    );
    return perLesson.flat();
  }

  // One transaction for the whole run: a bulk edit either lands or does not,
  // and its outbox rows commit atomically with it (storage.js §1.6), so the
  // D1 mirror can never hear about half a save.
  async function applyUpdates(updates) {
    if (updates.length === 0) return;
    await Storage.runTransaction(['activities'], 'readwrite', (t) => {
      const store = t.objectStore('activities');
      for (const record of updates) store.put(record);
    });
  }

  // ---- Rendering ----

  // Appends this Course's duration panel to `container`. Appends nothing at
  // all when the Course has no Activities yet: there would be no rows in it,
  // and an empty panel on a freshly created Course is one more thing to scroll
  // past before reaching the Lessons form.
  async function renderInto(container, course) {
    const activities = await loadActivities(course.id);
    if (activities.length === 0) return;
    container.appendChild(await buildCard(course, activities));
  }

  async function buildCard(course, initialActivities) {
    const activityTypes = await Storage.getAll('activityTypes');

    // Collapsed <details>, sharing .pacing-card's disclosure chrome. Closed by
    // default: this is a periodic tuning job, not something a parent needs
    // open on every visit to the course.
    const card = document.createElement('details');
    card.className = 'duration-card';
    card.open = openCards.has(course.id);
    card.addEventListener('toggle', () => {
      if (card.open) openCards.add(course.id);
      else openCards.delete(course.id);
    });

    const summary = document.createElement('summary');
    card.appendChild(summary);

    const help = document.createElement('p');
    help.className = 'field-help';
    help.textContent =
      'Sets the expected minutes on every Activity of a type in this Course at once — the number ' +
      'Packet Generation adds up against a minutes-per-day pace (an Activity with none counts as 15). ' +
      'A blank row is left alone; use Clear to remove a type\'s durations. Each Activity keeps its own ' +
      'value afterward and can still be edited on its own form.';
    card.appendChild(help);

    const form = document.createElement('form');
    form.className = 'duration-form';
    card.appendChild(form);

    const list = document.createElement('ul');
    list.className = 'duration-list';
    form.appendChild(list);

    const errorEl = document.createElement('p');
    errorEl.className = 'error';
    errorEl.hidden = true;
    form.appendChild(errorEl);

    const okEl = document.createElement('p');
    okEl.className = 'success';
    okEl.hidden = true;
    form.appendChild(okEl);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = 'Save durations';
    form.appendChild(saveBtn);

    // The panel's own view of the Course's Activities. Re-read after every
    // write rather than patched, so the row summaries below are always what
    // the store actually holds.
    let activities = initialActivities;

    function labelsByKey(rows) {
      return rows.reduce((map, row) => Object.assign(map, { [row.activityTypeKey]: row.label }), {});
    }

    function paint() {
      const rows = CourseDurationsCore.summarize(activities, activityTypes);
      const typeCount = rows.length;
      summary.textContent =
        `Activity durations — ${activities.length} ${activities.length === 1 ? 'Activity' : 'Activities'}` +
        ` across ${typeCount} ${typeCount === 1 ? 'type' : 'types'}`;

      list.innerHTML = '';
      for (const row of rows) {
        const item = document.createElement('li');
        item.className = 'list-row duration-row';
        item.innerHTML = `
          <div class="row-text">
            <span class="row-title">${escapeHtml(row.label)}${
              row.known ? '' : ' <span class="row-meta">(type no longer exists)</span>'
            }</span>
            <span class="row-meta duration-row-state">${escapeHtml(CourseDurationsCore.describeRow(row))}</span>
          </div>
          <div class="row-actions">
            <label class="row-extra duration-input">
              <span>Minutes</span>
              <input type="number" min="1" step="1" inputmode="numeric"
                     data-type="${escapeHtml(row.activityTypeKey)}"
                     value="${row.uniformValue == null ? '' : row.uniformValue}"
                     placeholder="${row.uniformValue == null && row.values.length ? 'mixed' : ''}"
                     aria-label="Expected duration in minutes for ${escapeHtml(row.label)}">
            </label>
            <button type="button" class="secondary" data-action="clear" ${
              row.values.length === 0 ? 'disabled' : ''
            }>Clear</button>
          </div>
        `;
        // Clearing is its own action rather than "save a blank row" — see the
        // core module's planUpdates comment for why blank cannot mean clear on
        // a panel that saves every row at once. Confirmed because it is the
        // only destructive thing in here.
        item.querySelector('[data-action="clear"]').addEventListener('click', async () => {
          const warned = window.confirm(
            `Remove the expected duration from all ${row.count} ${row.label} ` +
            `${row.count === 1 ? 'Activity' : 'Activities'} in this Course? ` +
            'They will pace at the 15-minute fallback until one is set again.'
          );
          if (!warned) return;
          await run([{ activityTypeKey: row.activityTypeKey, mode: 'clear' }], labelsByKey(rows), 'clear');
        });
        list.appendChild(item);
      }
    }

    // The one write path — both Save and a row's Clear come through here, so
    // there is a single place that validates, writes, re-reads and reports.
    async function run(edits, labels, mode = 'set') {
      const plan = CourseDurationsCore.planUpdates(activities, edits);
      if (plan.error) {
        errorEl.hidden = false;
        errorEl.textContent = plan.error;
        okEl.hidden = true;
        return;
      }
      saveBtn.disabled = true;
      try {
        await applyUpdates(plan.updates);
        activities = await loadActivities(course.id);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Could not save: ${String((err && err.message) || err)}`;
        okEl.hidden = true;
        return;
      } finally {
        saveBtn.disabled = false;
      }
      errorEl.hidden = true;
      okEl.hidden = false;
      okEl.textContent = CourseDurationsCore.describeResult(plan.changedByType, labels, mode);
      // Repaint in place rather than re-rendering the host page: nothing else
      // on a Course page shows a duration, and a full re-render would take the
      // verdict above away with it.
      paint();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rows = CourseDurationsCore.summarize(activities, activityTypes);
      const labels = labelsByKey(rows);
      const edits = [];
      for (const input of list.querySelectorAll('input[data-type]')) {
        if (input.value.trim() === '') continue; // blank row — leave this type alone
        edits.push({ activityTypeKey: input.dataset.type, mode: 'set', value: input.value });
      }
      if (edits.length === 0) {
        errorEl.hidden = false;
        errorEl.textContent = 'Type a number of minutes on at least one row first.';
        okEl.hidden = true;
        return;
      }
      await run(edits, labels);
    });

    paint();
    return card;
  }

  return { renderInto };
})();
