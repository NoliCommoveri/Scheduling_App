/* Module: weekly.js — read-only "by day of week" overview.
 * Not a TDS/SRS module of its own: a rollup view over data Pacing and Chores
 * already own — pacingProfiles' daysOfWeek per Course Instance, and Chores'
 * daysFor() per participating Child. No store, no writes, nothing this file
 * is the sole anything of.
 *
 * Deliberately days-of-week, not dates: a Pacing Profile says "this Course
 * runs on these weekdays," not which specific Activity lands on which
 * calendar date — that placement is Propose's job (packet.js), driven by the
 * pacing budget and walk order. This view answers "what's the shape of a
 * normal week," which is a question about profiles and chore schedules, not
 * about any particular week's generated plan.
 *
 * Within a day, Courses are grouped by subject and Chores by choreType, each
 * its own closed-by-default <details> — reusing .course-subject-group
 * (courses.js) and .chore-type-group (chores.js) verbatim, both class and
 * canonical CHORE_TYPES order, so "grouped the same way as their own pages"
 * is literally the same code path, not a second implementation of it.
 */

const Weekly = (() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_LABELS = {
    Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
    Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
  };
  const NO_SUBJECT = 'No subject'; // same fallback courses.js's subject grouping uses

  let filterChildId = '';
  // Open/closed state for the day buckets and the subject/type buckets
  // nested inside them — kept outside the DOM, same convention as openTypes
  // (chores.js) and openCards (pacing.js), so it survives the render() a
  // child-filter change triggers. Nested keys are `${day}::${subject|type}`
  // since the same subject/type can appear under more than one day.
  const openDays = new Set();
  const openSubjectGroups = new Set();
  const openChoreTypeGroups = new Set();

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Same sort as the Course Template Library: alphabetical, "No subject" trailing.
  function sortSubjects(subjects) {
    return subjects.sort((a, b) => {
      if (a === NO_SUBJECT) return 1;
      if (b === NO_SUBJECT) return -1;
      return a.localeCompare(b);
    });
  }

  // One Map entry per weekday, each holding the Course Instances paced for
  // that day (with subject, for grouping) and the Chores due that day for
  // this child (with choreType, for grouping).
  async function buildWeek(childId) {
    const week = new Map(DAYS.map((d) => [d, { courses: [], chores: [] }]));

    const instances = (await Storage.getAllByIndex('courses', 'by_childId', childId))
      .filter((c) => c.state === 'instance');
    for (const inst of instances) {
      const profile = await Pacing.getProfile(inst.id);
      if (!profile) continue; // no Pacing Profile yet — nothing to place on any day
      const subject = (inst.subject && inst.subject.trim()) || NO_SUBJECT;
      for (const d of profile.daysOfWeek) week.get(d).courses.push({ name: inst.name, subject });
    }

    const chores = await Chores.listChores(childId);
    for (const chore of chores) {
      const days = Chores.daysFor(chore, childId) || [];
      const perDay = Chores.instancesOf(chore).length;
      const label = perDay > 1 ? `${chore.title} (${perDay}×/day)` : chore.title;
      for (const d of days) week.get(d).chores.push({ label, choreType: chore.choreType });
    }

    return week;
  }

  function buildCourseGroups(dayKey, courses) {
    const bySubject = new Map();
    for (const c of courses) {
      if (!bySubject.has(c.subject)) bySubject.set(c.subject, []);
      bySubject.get(c.subject).push(c.name);
    }

    const wrap = document.createElement('div');
    const label = document.createElement('h4');
    label.textContent = 'Courses';
    wrap.appendChild(label);

    const groupsEl = document.createElement('div');
    groupsEl.className = 'course-subject-groups';
    for (const subject of sortSubjects([...bySubject.keys()])) {
      const names = bySubject.get(subject);
      const key = `${dayKey}::${subject}`;

      const details = document.createElement('details');
      details.className = 'course-subject-group';
      details.open = openSubjectGroups.has(key);
      details.addEventListener('toggle', () => {
        if (details.open) openSubjectGroups.add(key); else openSubjectGroups.delete(key);
      });
      const summary = document.createElement('summary');
      summary.textContent = `${subject} (${names.length})`;
      details.appendChild(summary);

      const list = document.createElement('ul');
      names.forEach((name) => {
        const li = document.createElement('li');
        li.className = 'item-activity';
        li.innerHTML = `<span>📘 ${escapeHtml(name)}</span>`;
        list.appendChild(li);
      });
      details.appendChild(list);
      groupsEl.appendChild(details);
    }
    wrap.appendChild(groupsEl);
    return wrap;
  }

  function buildChoreGroups(dayKey, chores) {
    const byType = new Map();
    for (const c of chores) {
      if (!byType.has(c.choreType)) byType.set(c.choreType, []);
      byType.get(c.choreType).push(c.label);
    }

    const wrap = document.createElement('div');
    const label = document.createElement('h4');
    label.textContent = 'Chores';
    wrap.appendChild(label);

    const groupsEl = document.createElement('div');
    groupsEl.className = 'chore-type-groups';
    for (const type of Chores.CHORE_TYPES.filter((t) => byType.has(t))) {
      const labels = byType.get(type);
      const key = `${dayKey}::${type}`;

      const details = document.createElement('details');
      details.className = 'chore-type-group';
      details.open = openChoreTypeGroups.has(key);
      details.addEventListener('toggle', () => {
        if (details.open) openChoreTypeGroups.add(key); else openChoreTypeGroups.delete(key);
      });
      const summary = document.createElement('summary');
      summary.textContent = `${type} (${labels.length})`;
      details.appendChild(summary);

      const list = document.createElement('ul');
      labels.forEach((l) => {
        const li = document.createElement('li');
        li.className = 'item-chore';
        li.innerHTML = `<span>🧹 ${escapeHtml(l)}</span>`;
        list.appendChild(li);
      });
      details.appendChild(list);
      groupsEl.appendChild(details);
    }
    wrap.appendChild(groupsEl);
    return wrap;
  }

  async function render(root) {
    root.innerHTML = '';
    const children = Children.activeOnly(await Storage.getAll('children'));

    const heading = document.createElement('h1');
    heading.textContent = 'Weekly Overview';
    root.appendChild(heading);

    const intro = document.createElement('p');
    intro.textContent =
      'What a normal week looks like for one child, from Pacing Profiles and active Chores — ' +
      'not any particular week\'s generated plan. Courses group by subject, Chores by type, ' +
      'the same as their own pages.';
    root.appendChild(intro);

    const filterForm = document.createElement('form');
    const options = ['<option value="">(select a child)</option>']
      .concat(children.map((c) => `<option value="${c.id}" ${c.id === filterChildId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`))
      .join('');
    filterForm.innerHTML = `<label>Child<select name="childId">${options}</select></label>`;
    filterForm.childId.addEventListener('change', () => {
      filterChildId = filterForm.childId.value;
      render(root);
    });
    root.appendChild(filterForm);

    if (!filterChildId) {
      const hint = document.createElement('p');
      hint.textContent = 'Select a child to see their week.';
      root.appendChild(hint);
      return;
    }

    const week = await buildWeek(filterChildId);

    const groupsEl = document.createElement('div');
    groupsEl.className = 'weekday-groups';
    for (const d of DAYS) {
      const { courses, chores } = week.get(d);

      const details = document.createElement('details');
      details.className = 'weekday-group';
      details.open = openDays.has(d);
      details.addEventListener('toggle', () => {
        if (details.open) openDays.add(d); else openDays.delete(d);
      });

      const summary = document.createElement('summary');
      summary.textContent =
        `${DAY_LABELS[d]} — ${courses.length} course${courses.length === 1 ? '' : 's'} · ` +
        `${chores.length} chore${chores.length === 1 ? '' : 's'}`;
      details.appendChild(summary);

      if (courses.length === 0 && chores.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'Nothing scheduled.';
        details.appendChild(empty);
      } else {
        if (courses.length) details.appendChild(buildCourseGroups(d, courses));
        if (chores.length) details.appendChild(buildChoreGroups(d, chores));
      }
      groupsEl.appendChild(details);
    }
    root.appendChild(groupsEl);
  }

  return { render };
})();
