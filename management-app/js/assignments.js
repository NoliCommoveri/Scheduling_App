/* Module: assignments.js — the Assignments view.
 * Per TDS_Slice_Online_Revamp.md §9 ("browse by child and date range, rescind a
 * batch, edit or move a single assignment"), driving §5.2's three parent routes:
 * GET /api/assignments, PATCH /api/assignments/:id, POST /api/assignments/rescind.
 *
 * This closes a no-CLI gap, not just a convenience one. Rescind and PATCH have
 * existed in the Worker since Phase 1, and until now nothing in any browser
 * called them — which under CLAUDE.md's "Ray has no CLI" non-negotiable means
 * they may as well not have existed. packet.js's Commit failure path used to
 * end with "write down batch <id>"; it now points here instead.
 *
 * Reads and writes parent-owned columns only. Everything the child owns —
 * status, completed_at, grade, deferred_to, and the child_* override pair —
 * is rendered as read-only context. That is §4.2 observed on the client side:
 * the Worker would reject those writes anyway (400), and showing them as
 * uneditable is how the UI tells the truth about who owns what.
 */

const Assignments = (() => {
  const WINDOW_BACK_DAYS = 7;
  const WINDOW_FORWARD_DAYS = 21;

  // How many batches the collapsed Batches panel shows before "Show N older"
  // lifts the cap — the same shape REMAINDER_PREVIEW has in packet.js, for the
  // same reason (§3.1).
  const BATCH_PREVIEW = 10;

  // ---- view state that must survive reload() ----
  //
  // `reload()` rebuilds the whole results container on every action — an edit,
  // a single rescind, a batch rescind (`:217-249`). So none of this can live on
  // the DOM: a parent who opened the Batches panel, pressed Rescind inside it
  // and watched it slam shut has been given a worse screen than the flat list
  // it replaced. Module-level rather than per-render for the same reason
  // packet.js keeps its group state on `session`.
  //
  // Default CLOSED here, the opposite of the Generate view's default (§7.2).
  // Review is "look at all of it before committing"; this page is "find the one
  // thing I am looking for", and Ray's own words for it were "hide them behind"
  // and "I rarely need to interact with them". Expand all / Collapse all makes
  // either default cheap to overrule for a session.
  let batchesOpen = false;
  let batchesExpanded = false;
  const openGroups = new Set();

  // Parent-owned columns this view may edit, in form order. Keys are the
  // camelCase names PATCH expects (worker/index.js ASSIGNMENT_PATCH_FIELDS);
  // `column` is the snake_case name a GET row comes back with. The two
  // vocabularies meet here and nowhere else.
  //
  // `sourceId` is deliberately absent though PATCH accepts it: it is the
  // provenance link back to the curriculum item that produced the row, and
  // retyping it by hand can only ever break a trail, never fix one.
  const FIELDS = [
    { key: 'date', column: 'date', label: 'Date', type: 'date', required: true },
    { key: 'title', column: 'title', label: 'Title', type: 'text', required: true },
    { key: 'courseName', column: 'course_name', label: 'Course', type: 'text' },
    { key: 'activityType', column: 'activity_type', label: 'Activity type', type: 'text' },
    { key: 'sequenceNo', column: 'sequence_no', label: 'Sequence number', type: 'int' },
    { key: 'expectedDurationMin', column: 'expected_duration_min', label: 'Expected minutes', type: 'int' },
    { key: 'rewardAmount', column: 'reward_amount', label: 'Reward amount', type: 'real' },
    { key: 'rewardCategory', column: 'reward_category', label: 'Reward category', type: 'text' },
    { key: 'blockHint', column: 'block_hint', label: 'Suggested block', type: 'text' },
    { key: 'sortOrder', column: 'sort_order', label: 'Sort order', type: 'int' },
  ];

  // ---- small helpers (local by intent — reporting.js keeps its own copies for
  // the same reason: two view modules sharing a date formatter is not worth a
  // shared runtime file) ----

  function isoDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function dayOffset(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return isoDate(d);
  }

  function formatTimestamp(ms) {
    return ms ? new Date(ms).toLocaleString() : '';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  // ---- subject resolution (§3.4) ----
  //
  // A row carries `course_name`, a string snapshotted at assign time, and no
  // subject: there is no `assignments.subject` column and this slice does not
  // add one (§1.4). It does not need one, because this view runs inside the app
  // that OWNS the Course records — so the subject is a local lookup at render
  // time, at the cost of one `Storage.getAll('courses')` per render.
  //
  // Instance records for the child on screen win, because they are the records
  // that actually produced these rows; any other Course record with the same
  // name (a template, or another child's instance) then fills gaps.
  //
  // A RENAMED COURSE SPLITS INTO TWO HEADERS, AND THAT IS CORRECT. `course_name`
  // is snapshotted on purpose (CLAUDE.md §III.B — "a completed assignment
  // records what it *was*"), so a course renamed mid-term genuinely has rows
  // under both names. This view groups what the rows say, never what the
  // current record says. The lookup simply misses for the old name, which puts
  // those rows under `No subject` — visible, honest, and self-explaining the
  // moment the parent sees the old name in the header.
  function subjectMap(courses, childId) {
    const map = new Map();
    const add = (course) => {
      const name = course && course.name;
      if (!name || map.has(name)) return;
      map.set(name, SubjectOrderCore.label(course.subject));
    };
    (courses || []).filter((c) => c.state === 'instance' && c.childId === childId).forEach(add);
    (courses || []).forEach(add);
    return map;
  }

  // The row's course as this view groups it. An activity row with no
  // `course_name` at all lands in an `Uncategorised` course group under
  // `No subject` (§3.2) rather than vanishing or getting a group of its own per
  // row.
  const UNCATEGORISED = 'Uncategorised';

  function courseNameOf(row) {
    const name = (row.course_name || '').trim();
    return name === '' ? UNCATEGORISED : name;
  }

  function subjectOf(row, subjects) {
    const name = (row.course_name || '').trim();
    if (name === '') return SubjectOrderCore.NO_SUBJECT;
    return subjects.get(name) || SubjectOrderCore.NO_SUBJECT;
  }

  // ---- row predicates ----
  //
  // The whole editing model rests on these two. A row is the parent's to change
  // only while the child has not resolved it and the parent has not already
  // pulled it back.

  function status(row) {
    return row.status || 'pending';
  }

  function isRescinded(row) {
    return row.rescinded_at != null;
  }

  function isResolved(row) {
    return status(row) !== 'pending';
  }

  // Editable and rescindable are the same test today, but they are separate
  // functions because they answer different questions and the server treats
  // them differently: rescind's own SQL re-checks `rescinded_at IS NULL AND
  // status = 'pending'` (§6.3), so a stale screen can only ever under-act.
  // PATCH has no such guard — see the note above saveEdit.
  function isEditable(row) {
    return !isRescinded(row) && !isResolved(row);
  }

  function isRescindable(row) {
    return !isRescinded(row) && !isResolved(row);
  }

  // ---- value coercion ----
  //
  // Form fields are strings; the columns are TEXT, INTEGER and REAL. An empty
  // box means NULL, not 0 and not "" — a chore with no reward amount and a
  // chore worth zero are different facts.

  function coerce(field, raw) {
    const text = (raw == null ? '' : String(raw)).trim();
    if (text === '') {
      if (field.required) return { error: `${field.label} cannot be empty.` };
      return { value: null };
    }
    if (field.type === 'int') {
      const n = Number.parseInt(text, 10);
      if (!Number.isFinite(n)) return { error: `${field.label} must be a whole number.` };
      return { value: n };
    }
    if (field.type === 'real') {
      const n = Number.parseFloat(text);
      if (!Number.isFinite(n)) return { error: `${field.label} must be a number.` };
      return { value: n };
    }
    if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return { error: `${field.label} must be a real date.` };
    }
    return { value: text };
  }

  // Only changed fields are sent: PATCH rejects an empty body with 400, and
  // sending untouched columns would restamp updated_at for nothing — which the
  // child's /api/plan?since= delta would then re-download (§8.3).
  function buildPatch(row, form) {
    const patch = {};
    for (const field of FIELDS) {
      const result = coerce(field, form.elements[field.key].value);
      if (result.error) return { error: result.error };
      const current = row[field.column] == null ? null : row[field.column];
      if (result.value !== current) patch[field.key] = result.value;
    }

    // payload is a TEXT column holding JSON. The Worker stringifies whatever
    // object it is handed, so the comparison is parse-then-restringify against
    // the stored text — otherwise reformatting the textarea would read as a
    // change and rewrite an identical value.
    const payloadText = form.elements.payload.value.trim();
    if (payloadText === '') {
      if (row.payload != null) patch.payload = null;
    } else {
      let parsed;
      try {
        parsed = JSON.parse(payloadText);
      } catch (err) {
        return { error: `Details must be valid JSON: ${err.message}` };
      }
      if (JSON.stringify(parsed) !== row.payload) patch.payload = parsed;
    }

    return { patch };
  }

  // ---- render ----

  async function render(root) {
    root.innerHTML = `
      <h1>Assignments</h1>
      <p>Everything committed to a child, straight from the database. Anything
         still outstanding can be edited, moved to another day, or rescinded.
         Work the child has already completed or waived is shown but locked.</p>
      <p class="assign-status" role="status">Loading…</p>
    `;
    const statusEl = root.querySelector('.assign-status');

    const { token } = await Sync.getConfig();
    if (!token) {
      statusEl.textContent = 'Set your sync token in Settings first — this view reads and writes the database directly.';
      return;
    }

    let children;
    let courses;
    let subjectOrder;
    try {
      // `courses` is what resolves a row's snapshotted `course_name` to a
      // subject (§3.4); `meta['subjectOrder']` is the household's standing
      // order (Module 11 FR-9). Both are read once per render and held for
      // every reload, so switching child or date range costs no extra
      // IndexedDB work — and, as on the Generate view, the order cannot shift
      // under the parent mid-session because Settings was edited in another
      // tab.
      const stored = await Promise.all([
        Storage.getAll('children'),
        Storage.getAll('courses'),
        Storage.get('meta', 'subjectOrder'),
      ]);
      children = stored[0];
      courses = stored[1];
      subjectOrder = (stored[2] && stored[2].order) || [];
    } catch (err) {
      statusEl.textContent = `Could not load children, courses or the subject order: ${err.message}`;
      return;
    }
    if (children.length === 0) {
      statusEl.textContent = 'Add a child first.';
      return;
    }
    statusEl.remove();

    const form = document.createElement('form');
    form.className = 'report-controls';
    form.innerHTML = `
      <label>Child<select name="childId">
        ${children.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${Children.isActive(c) ? '' : ' (archived)'}</option>`).join('')}
      </select></label>
      <label>From<input type="date" name="from" value="${dayOffset(-WINDOW_BACK_DAYS)}"></label>
      <label>To<input type="date" name="to" value="${dayOffset(WINDOW_FORWARD_DAYS)}"></label>
      <button type="submit">Show assignments</button>
      <p class="error" hidden></p>
    `;
    root.appendChild(form);

    const results = document.createElement('div');
    results.className = 'assign-results';
    root.appendChild(results);

    const errorEl = form.querySelector('.error');

    // One reload path for every action on the page, so an edit, a single
    // rescind and a batch rescind all land the view in the same state and
    // nothing has to patch the DOM in place from a response body.
    async function reload(notice) {
      const childId = form.childId.value;
      const from = form.from.value;
      const to = form.to.value;
      if (!from || !to || from > to) {
        errorEl.hidden = false;
        errorEl.textContent = 'Pick a date range that starts on or before it ends.';
        return;
      }
      errorEl.hidden = true;
      results.innerHTML = '<p role="status">Loading…</p>';
      try {
        // includeRescinded: a parent looking at a range needs to see what they
        // already pulled back, or they will pull it back again and wonder why
        // nothing changed. Rescinded rows render struck through and inert.
        const query = `childId=${encodeURIComponent(childId)}&from=${from}&to=${to}&includeRescinded=1`;
        const data = await Sync.api(`/api/assignments?${query}`);
        const childName = (children.find((c) => c.id === childId) || {}).name || childId;
        renderResults(results, {
          rows: data.assignments || [],
          childName, from, to, reload,
          // Resolved against the child actually on screen (§3.4) — an instance
          // belonging to some other child must not win the name.
          subjects: subjectMap(courses, childId),
          subjectOrder,
          // A capped answer must never be presented as the whole range — a
          // parent rescinding "everything shown" would leave rows behind.
          notice: data.truncated
            ? { text: `Showing the first ${data.limit} rows of a longer range — narrow the dates to see the rest.`, error: true }
            : notice,
        });
      } catch (err) {
        results.innerHTML = '';
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      reload();
    });

    // Open showing the default child's current window rather than an empty
    // form — same reasoning as the Reporting view.
    reload();
  }

  function renderResults(container, ctx) {
    const { rows, childName, from, to, notice } = ctx;
    container.innerHTML = '';

    // Redraw from the rows already in hand. Every *action* on this page goes
    // through `reload()` so that an edit or a rescind re-reads D1 rather than
    // patching the DOM from a response body — but a presentation toggle
    // (lifting the batch preview cap, Expand all, Collapse all) changes nothing
    // in the database and must not cost a round trip to apply.
    ctx.redraw = () => renderResults(container, ctx);

    if (notice) {
      const banner = document.createElement('p');
      banner.className = notice.error ? 'error' : 'success';
      banner.setAttribute('role', 'status');
      banner.textContent = notice.text;
      container.appendChild(banner);
    }

    const heading = document.createElement('h2');
    heading.textContent = `${childName} · ${from} → ${to}`;
    container.appendChild(heading);

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Nothing assigned in this range.';
      container.appendChild(empty);
      return;
    }

    const live = rows.filter((r) => !isRescinded(r));
    const outstanding = live.filter((r) => !isResolved(r));
    const summary = document.createElement('p');
    summary.className = 'assign-summary';
    summary.textContent =
      `${plural(rows.length, 'row', 'rows')} · ${outstanding.length} outstanding · ` +
      `${live.length - outstanding.length} completed or waived · ` +
      `${rows.length - live.length} rescinded`;
    container.appendChild(summary);

    container.appendChild(batchSection(rows, ctx));

    // Filled by every groupBox drawn below, then read by the two buttons — so
    // they act on exactly the groups this render produced, not on a stale set
    // left over from another child or another date range.
    ctx.groupKeys = [];
    const days = daySection(rows, ctx);

    if (ctx.groupKeys.length) {
      const bar = document.createElement('div');
      bar.className = 'assign-group-bar';
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'secondary';
      expand.textContent = 'Expand all';
      expand.addEventListener('click', () => {
        ctx.groupKeys.forEach((k) => openGroups.add(k));
        ctx.redraw();
      });
      const collapse = document.createElement('button');
      collapse.type = 'button';
      collapse.className = 'secondary';
      collapse.textContent = 'Collapse all';
      collapse.addEventListener('click', () => {
        ctx.groupKeys.forEach((k) => openGroups.delete(k));
        ctx.redraw();
      });
      bar.appendChild(expand);
      bar.appendChild(collapse);
      container.appendChild(bar);
    }

    container.appendChild(days);
  }

  // ---- batches (§6.2) ----
  //
  // The reason batch_id exists: reversing a bad Commit in one statement instead
  // of reconstructing its extent from date-range guesswork. Grouping is done
  // from the rows themselves rather than the local Generation Log, so this
  // works from any parent device, including one that never ran the Commit.

  function groupByBatch(rows) {
    const groups = new Map();
    for (const row of rows) {
      const key = row.batch_id || '';
      if (!groups.has(key)) {
        groups.set(key, { batchId: row.batch_id || null, rows: [], assignedAt: row.assigned_at });
      }
      const group = groups.get(key);
      group.rows.push(row);
      if (row.assigned_at && row.assigned_at < group.assignedAt) group.assignedAt = row.assigned_at;
    }
    return [...groups.values()].sort((a, b) => (b.assignedAt || 0) - (a.assignedAt || 0));
  }

  function batchSection(rows, ctx) {
    const groups = groupByBatch(rows);
    const withOutstanding = groups.filter((g) => g.rows.some(isRescindable)).length;

    // Report 4a: "the batch list is getting long — hide it behind a collapse, I
    // rarely interact with it." The section is hidden, not weakened — every
    // Rescind button below is untouched, and the summary still names how many
    // batches there are and how many still hold something to pull back, so the
    // panel does not have to be opened to know whether it is worth opening.
    const section = document.createElement('details');
    section.className = 'assign-batches';
    section.open = batchesOpen;
    section.addEventListener('toggle', () => { batchesOpen = section.open; });
    const summary = document.createElement('summary');
    summary.textContent = `Batches — ${plural(groups.length, 'batch', 'batches')}` +
      (withOutstanding ? ` · ${withOutstanding} with outstanding rows` : '');
    section.appendChild(summary);

    const list = document.createElement('ul');
    list.className = 'batch-list';

    // Already newest-first out of groupByBatch. The cap and its lifted state
    // are module-level for the same reason `batchesOpen` is: rescinding a batch
    // from inside the panel calls reload(), which rebuilds this whole subtree.
    const shown = batchesExpanded ? groups : groups.slice(0, BATCH_PREVIEW);

    for (const group of shown) {
      const rescindable = group.rows.filter(isRescindable);
      const locked = group.rows.filter((r) => !isRescinded(r) && isResolved(r));
      const already = group.rows.filter(isRescinded);

      const item = document.createElement('li');
      // When and what-it-holds lead; the opaque batch UUID is the last line and
      // never gets to push Rescind out of its column.
      item.className = 'list-row';
      item.innerHTML = `
        <div class="row-text">
          <span class="row-title batch-when">${escapeHtml(formatTimestamp(group.assignedAt))}</span>
          <span class="row-meta batch-counts">
            ${plural(group.rows.length, 'row', 'rows')} ·
            ${rescindable.length} outstanding ·
            ${locked.length} locked ·
            ${already.length} rescinded
          </span>
          <span class="row-id batch-id">${group.batchId ? escapeHtml(group.batchId) : '(no batch)'}</span>
        </div>
        <div class="row-actions"></div>
      `;

      if (group.batchId && rescindable.length > 0) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = `Rescind ${plural(rescindable.length, 'row', 'rows')}`;
        button.addEventListener('click', () => rescindBatch(group, ctx));
        item.querySelector('.row-actions').appendChild(button);
      }

      list.appendChild(item);
    }

    section.appendChild(list);

    if (groups.length > BATCH_PREVIEW) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'secondary';
      more.textContent = batchesExpanded
        ? 'Show fewer'
        : `Show ${groups.length - BATCH_PREVIEW} older`;
      more.addEventListener('click', () => {
        batchesExpanded = !batchesExpanded;
        batchesOpen = true; // the parent is working in here; do not shut it
        ctx.redraw();
      });
      section.appendChild(more);
    }

    return section;
  }

  // ---- days and rows ----

  // Within a course the existing sort is kept verbatim: `sort_order`, then
  // title. This screen shows what D1 actually holds — re-sorting it by anything
  // the parent's local Course records merely imply would be lying about the row.
  function byStoredOrder(a, b) {
    const orderA = a.sort_order == null ? Number.MAX_SAFE_INTEGER : a.sort_order;
    const orderB = b.sort_order == null ? Number.MAX_SAFE_INTEGER : b.sort_order;
    return orderA - orderB || String(a.title).localeCompare(String(b.title));
  }

  // One <details> per group, closed by default (§3.2/§7.2), state in the
  // module-level `openGroups` so `reload()` cannot slam it shut. Keys are
  // date-scoped — the same course appears on fourteen days and they are not one
  // thing (§2.6) — and are recorded in `ctx.groupKeys` on the way past so
  // Expand all / Collapse all reach exactly what is on screen.
  function groupBox(className, key, label, rows, ctx) {
    ctx.groupKeys.push(key);
    const outstanding = rows.filter(isRescindable).length;

    const box = document.createElement('details');
    box.className = className;
    box.open = openGroups.has(key);
    box.addEventListener('toggle', () => {
      if (box.open) openGroups.add(key);
      else openGroups.delete(key);
    });

    const summary = document.createElement('summary');
    summary.textContent = `${label} (${rows.length})` +
      (outstanding ? ` · ${outstanding} outstanding` : '');
    box.appendChild(summary);

    return box;
  }

  function rowList(rows, ctx) {
    const list = document.createElement('ul');
    for (const row of rows.slice().sort(byStoredOrder)) list.appendChild(rowItem(row, ctx));
    return list;
  }

  // Report 4b: a day stops being one flat <ul> and becomes subject → course →
  // rows, with chores and events in groups of their own. Subjects follow the
  // household's standing order; courses are alphabetical within a subject,
  // which is the only order available here — a row carries a course *name*, not
  // an instance id, so there is no walk position to sort by the way the Generate
  // view can (§2.1).
  function activityGroups(dayRows, date, ctx) {
    const { subjects, subjectOrder } = ctx;
    const bySubject = new Map();
    for (const row of dayRows) {
      const subject = subjectOf(row, subjects);
      if (!bySubject.has(subject)) bySubject.set(subject, new Map());
      const byCourse = bySubject.get(subject);
      const course = courseNameOf(row);
      if (!byCourse.has(course)) byCourse.set(course, []);
      byCourse.get(course).push(row);
    }

    const out = [];
    for (const subject of SubjectOrderCore.sortSubjects([...bySubject.keys()], subjectOrder)) {
      const byCourse = bySubject.get(subject);
      const subjectRows = [...byCourse.values()].flat();
      const box = groupBox('assign-subject-group', `${date}::subject::${subject}`, subject, subjectRows, ctx);
      for (const course of [...byCourse.keys()].sort((a, b) => a.localeCompare(b))) {
        const courseRows = byCourse.get(course);
        const courseBox = groupBox('assign-course-group', `${date}::course::${subject}::${course}`, course, courseRows, ctx);
        courseBox.appendChild(rowList(courseRows, ctx));
        box.appendChild(courseBox);
      }
      out.push(box);
    }
    return out;
  }

  function daySection(rows, ctx) {
    const section = document.createElement('section');
    section.className = 'assign-days';

    const byDate = new Map();
    for (const row of rows) {
      if (!byDate.has(row.date)) byDate.set(row.date, []);
      byDate.get(row.date).push(row);
    }

    const dates = [...byDate.keys()].sort();
    for (const date of dates) {
      const dayRows = byDate.get(date);
      // A day with nothing left to show renders no header at all. Nothing
      // filters rows out yet, so this cannot fire today — it is here because
      // §3.7's `Show rescinded` toggle is what will make it fire, and an empty
      // date heading with a count of zero is the failure it has to avoid.
      if (dayRows.length === 0) continue;

      const day = document.createElement('div');
      day.className = 'day-section';
      const outstanding = dayRows.filter(isRescindable).length;
      day.innerHTML = `<h3>${escapeHtml(date)} <em>${plural(dayRows.length, 'row', 'rows')}, ${outstanding} outstanding</em></h3>`;

      // Same fixed order the Generate view and FR-14 use: School, then Chores,
      // then Family events. Grouping happens within the School half only.
      activityGroups(dayRows.filter((r) => r.kind === 'activity'), date, ctx)
        .forEach((box) => day.appendChild(box));

      // One group per day for each, at the bottom (§3.2). A day with twelve
      // chore occurrences on it has the same wall of rows the school half had.
      const chores = dayRows.filter((r) => r.kind === 'chore');
      if (chores.length) {
        const box = groupBox('assign-subject-group', `${date}::chores`, 'Chores', chores, ctx);
        box.appendChild(rowList(chores, ctx));
        day.appendChild(box);
      }
      const events = dayRows.filter((r) => r.kind === 'event');
      if (events.length) {
        const box = groupBox('assign-subject-group', `${date}::events`, 'Family events', events, ctx);
        box.appendChild(rowList(events, ctx));
        day.appendChild(box);
      }

      // Anything whose `kind` is none of the three still has to reach the
      // screen. Ungrouped rather than invented into a group: a kind this view
      // does not know about is a fact worth seeing plainly, not one to file.
      const other = dayRows.filter((r) => !['activity', 'chore', 'event'].includes(r.kind));
      if (other.length) day.appendChild(rowList(other, ctx));

      section.appendChild(day);
    }

    return section;
  }

  function statusLabel(row) {
    if (isRescinded(row) && !isResolved(row)) {
      return '<span class="status-rescinded">rescinded</span>';
    }
    // §6.4's race made visible: the child completed it and keeps the reward,
    // and the parent's pull still happened. Both facts, neither overwritten.
    const suffix = isRescinded(row) ? ' <em>(rescinded after completion)</em>' : '';
    return `<span class="status-${escapeHtml(status(row))}">${escapeHtml(status(row))}</span>${suffix}`;
  }

  // The lesson an activity row belongs to (§3.3). No Worker change is needed
  // for this: `GET /api/assignments` is `SELECT *` (`worker/index.js:1427`), so
  // `payload` already arrives — as a JSON *string*, D1's TEXT column, unparsed.
  // packet.js has written `lessonTitle` into it at Commit since the Lesson
  // Recipe slice; it has simply never been shown here.
  //
  // A malformed or absent payload yields no prefix and no error. That is not
  // defensiveness for its own sake: `payload` is parent-authored TEXT that the
  // edit form below lets a parent type into by hand, so this view has to
  // tolerate what it itself allows to be saved.
  function lessonPrefix(row) {
    if (row.kind !== 'activity' || row.payload == null) return '';
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      return '';
    }
    const title = payload && payload.lessonTitle;
    return title ? `${escapeHtml(title)} &mdash; ` : '';
  }

  function rowItem(row, ctx) {
    const item = document.createElement('li');
    item.className = `item-${escapeHtml(row.kind)} assign-row`;
    if (!isEditable(row)) item.classList.add('assign-locked');

    const detail = [
      row.course_name,
      row.activity_type,
      row.sequence_no == null ? null : `#${row.sequence_no}`,
      row.expected_duration_min == null ? null : `${row.expected_duration_min} min`,
      row.reward_amount == null ? null : `${row.reward_amount} ${row.reward_category || ''}`.trim(),
    ].filter(Boolean).join(' · ');

    const head = document.createElement('div');
    head.className = 'assign-row-head';
    head.innerHTML = `
      <span class="assign-title">${lessonPrefix(row)}${escapeHtml(row.title)}</span>
      <span class="assign-detail">${escapeHtml(detail)}</span>
      <span class="assign-state">${statusLabel(row)}</span>
    `;
    item.appendChild(head);

    // Child-owned columns, read-only by construction (§4.2). Shown because a
    // parent who cannot see that the child moved an item to Thursday will keep
    // wondering why their own sort order looks ignored.
    const childNotes = [];
    if (row.deferred_to) childNotes.push(`child moved it to ${row.deferred_to}`);
    if (row.child_block_hint) childNotes.push(`child's block: ${row.child_block_hint}`);
    if (row.completed_at) childNotes.push(`done ${formatTimestamp(row.completed_at)}`);
    if (row.grade != null) childNotes.push(`grade ${row.grade}`);
    if (childNotes.length > 0) {
      const notes = document.createElement('p');
      notes.className = 'assign-child-notes';
      notes.textContent = childNotes.join(' · ');
      item.appendChild(notes);
    }

    const actions = document.createElement('div');
    actions.className = 'assign-actions';

    if (isEditable(row)) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'secondary';
      editBtn.textContent = 'Edit';
      actions.appendChild(editBtn);

      const rescindBtn = document.createElement('button');
      rescindBtn.type = 'button';
      rescindBtn.className = 'secondary';
      rescindBtn.textContent = 'Rescind';
      rescindBtn.addEventListener('click', () => rescindOne(row, ctx));
      actions.appendChild(rescindBtn);

      const holder = document.createElement('div');
      holder.className = 'assign-edit-holder';
      item.appendChild(actions);
      item.appendChild(holder);

      editBtn.addEventListener('click', () => {
        if (holder.firstChild) {
          holder.innerHTML = '';
          editBtn.textContent = 'Edit';
          return;
        }
        holder.appendChild(editForm(row, ctx, () => {
          holder.innerHTML = '';
          editBtn.textContent = 'Edit';
        }));
        editBtn.textContent = 'Cancel';
      });
    } else {
      const why = document.createElement('p');
      why.className = 'assign-why-locked';
      why.textContent = isRescinded(row)
        ? 'Already rescinded — it is out of the child\'s plan and stays on the record.'
        : `Already ${status(row)} by the child. Completed work is left as it was done.`;
      item.appendChild(actions);
      item.appendChild(why);
    }

    return item;
  }

  // ---- edit (§6.5) ----

  function editForm(row, ctx, close) {
    const form = document.createElement('form');
    form.className = 'assign-edit';

    const fields = FIELDS.map((field) => {
      const value = row[field.column] == null ? '' : row[field.column];
      const type = field.type === 'date' ? 'date' : (field.type === 'int' || field.type === 'real' ? 'number' : 'text');
      const step = field.type === 'real' ? ' step="any"' : (field.type === 'int' ? ' step="1"' : '');
      return `<label>${escapeHtml(field.label)}
        <input type="${type}"${step} name="${field.key}" value="${escapeHtml(value)}"${field.required ? ' required' : ''}>
      </label>`;
    }).join('');

    let payloadText = '';
    if (row.payload != null) {
      try {
        payloadText = JSON.stringify(JSON.parse(row.payload), null, 2);
      } catch {
        // Stored text that is not valid JSON should be shown as-is rather than
        // swallowed — the parent is the only one who can fix it.
        payloadText = row.payload;
      }
    }

    form.innerHTML = `
      ${fields}
      <label>Details (JSON — page ranges, instructions)
        <textarea name="payload" rows="4" spellcheck="false">${escapeHtml(payloadText)}</textarea>
      </label>
      <p class="error" hidden></p>
      <div class="assign-edit-actions">
        <button type="submit">Save changes</button>
        <button type="button" class="secondary" data-action="cancel">Cancel</button>
      </div>
    `;

    const errorEl = form.querySelector('.error');
    form.querySelector('[data-action="cancel"]').addEventListener('click', close);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;

      const built = buildPatch(row, form);
      if (built.error) {
        errorEl.hidden = false;
        errorEl.textContent = built.error;
        return;
      }
      if (Object.keys(built.patch).length === 0) {
        errorEl.hidden = false;
        errorEl.textContent = 'Nothing changed.';
        return;
      }

      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await saveEdit(row, built.patch, ctx);
      } catch (err) {
        submit.disabled = false;
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    });

    return form;
  }

  // The completed-row guard is enforced here, on the client, because it is a
  // UI policy rather than an API rule: PATCH itself will happily edit any row,
  // and §6.5 does not forbid it. What the server does guarantee is the part
  // that matters — a parent cannot touch status, grade or completed_at through
  // this or any other route (§4.2), so the worst a stale screen can do is
  // retitle finished work, never un-finish it.
  async function saveEdit(row, patch, ctx) {
    const result = await Sync.api(`/api/assignments/${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      body: patch,
    });
    const moved = patch.date && patch.date !== row.date;
    await ctx.reload({
      text: moved
        ? `Saved. "${row.title}" moved to ${patch.date}.`
        : `Saved ${plural(Object.keys(patch).length, 'change', 'changes')} to "${row.title}".`,
      error: !result || result.ok === false,
    });
  }

  // ---- rescind (§6.3) ----
  //
  // Never a delete. The server sets rescinded_at and leaves the row, because a
  // row that vanishes can be resurrected by a stale device replaying its
  // outbox. Its SQL also re-checks status = 'pending', so completed work is
  // protected by the server as well as by the buttons above — the confirm text
  // below promises something the client is not the only one enforcing.

  async function rescindOne(row, ctx) {
    const ok = window.confirm(
      `Rescind "${row.title}" on ${row.date}?\n\n` +
      'It comes off the child\'s plan on their next sync. The row stays on the record, ' +
      'and nothing already earned is taken back.'
    );
    if (!ok) return;

    try {
      const result = await Sync.api('/api/assignments/rescind', {
        method: 'POST',
        body: { ids: [row.id] },
      });
      await ctx.reload(
        result.rescinded > 0
          ? { text: `Rescinded "${row.title}".` }
          : { text: `Nothing changed — "${row.title}" was already completed or rescinded.`, error: true }
      );
    } catch (err) {
      await ctx.reload({ text: err.message, error: true });
    }
  }

  async function rescindBatch(group, ctx) {
    const rescindable = group.rows.filter(isRescindable);
    const locked = group.rows.filter((r) => !isRescinded(r) && isResolved(r));

    const lockedNote = locked.length === 0
      ? ''
      : `\n\n${plural(locked.length, 'item', 'items')} in this batch ${locked.length === 1 ? 'has' : 'have'} ` +
        'already been completed or waived. Those are left exactly as they are, and the child keeps everything earned.';

    const ok = window.confirm(
      `Rescind ${plural(rescindable.length, 'outstanding item', 'outstanding items')} from this batch?` +
      lockedNote +
      '\n\nRescinded rows come off the child\'s plan on their next sync and stay on the record.'
    );
    if (!ok) return;

    try {
      const result = await Sync.api('/api/assignments/rescind', {
        method: 'POST',
        body: { batchId: group.batchId },
      });
      const left = locked.length === 0 ? '' : ` ${plural(locked.length, 'completed item', 'completed items')} left alone.`;
      await ctx.reload({ text: `Rescinded ${plural(result.rescinded, 'row', 'rows')}.${left}` });
    } catch (err) {
      await ctx.reload({ text: err.message, error: true });
    }
  }

  return { render, isEditable, isRescindable, buildPatch, groupByBatch };
})();
