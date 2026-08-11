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
    try {
      children = await Storage.getAll('children');
    } catch (err) {
      statusEl.textContent = `Could not load children: ${err.message}`;
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
    container.appendChild(daySection(rows, ctx));
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
    const section = document.createElement('section');
    section.className = 'assign-batches';
    section.innerHTML = '<h3>Batches</h3>';

    const groups = groupByBatch(rows);
    const list = document.createElement('ul');
    list.className = 'batch-list';

    for (const group of groups) {
      const rescindable = group.rows.filter(isRescindable);
      const locked = group.rows.filter((r) => !isRescinded(r) && isResolved(r));
      const already = group.rows.filter(isRescinded);

      const item = document.createElement('li');
      item.innerHTML = `
        <span class="batch-id">${group.batchId ? escapeHtml(group.batchId) : '(no batch)'}</span>
        <span class="batch-when">${escapeHtml(formatTimestamp(group.assignedAt))}</span>
        <span class="batch-counts">
          ${plural(group.rows.length, 'row', 'rows')} ·
          ${rescindable.length} outstanding ·
          ${locked.length} locked ·
          ${already.length} rescinded
        </span>
      `;

      if (group.batchId && rescindable.length > 0) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = `Rescind ${plural(rescindable.length, 'row', 'rows')}`;
        button.addEventListener('click', () => rescindBatch(group, ctx));
        item.appendChild(button);
      }

      list.appendChild(item);
    }

    section.appendChild(list);
    return section;
  }

  // ---- days and rows ----

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
      const dayRows = byDate.get(date).slice().sort((a, b) => {
        const orderA = a.sort_order == null ? Number.MAX_SAFE_INTEGER : a.sort_order;
        const orderB = b.sort_order == null ? Number.MAX_SAFE_INTEGER : b.sort_order;
        return orderA - orderB || String(a.title).localeCompare(String(b.title));
      });

      const day = document.createElement('div');
      day.className = 'day-section';
      const outstanding = dayRows.filter(isRescindable).length;
      day.innerHTML = `<h3>${escapeHtml(date)} <em>${plural(dayRows.length, 'row', 'rows')}, ${outstanding} outstanding</em></h3>`;

      const list = document.createElement('ul');
      for (const row of dayRows) list.appendChild(rowItem(row, ctx));
      day.appendChild(list);
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
      <span class="assign-title">${escapeHtml(row.title)}</span>
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
