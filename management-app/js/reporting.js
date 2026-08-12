/* Module: reporting.js — Master Reporting (Module 10), online.
 * Per TDS_Slice_Online_Revamp.md §5.2 (GET /api/assignments), §5.3 (GET
 * /api/rewards), §9 and §11.
 *
 * Online Revamp Phase 4 (§12). Module 10's analysis is unchanged in substance;
 * only its input changed. It used to read whatever a Completion CSV import had
 * managed to reconcile into local stores — Module 09, now deleted (§11). It now
 * asks the database what was assigned and what came back, which is acceptance
 * check §13.9: "assigned-vs-completed for a child over a date range … with no
 * CSV involved anywhere."
 *
 * Reads only. Nothing here writes an assignment, a completion, or a reward
 * entry: assignments are the parent's to write from Commit (§6.1), and
 * everything else on the page is child-owned (§4.2). A parent who wants to
 * correct a balance does it through Settings' reward adjustment (§5.3), which
 * appends a compensating row rather than editing one.
 *
 * CSV survives here in the role §11 leaves it: a spreadsheet a parent asked
 * for, downloaded from a report that is already complete on screen. It is not
 * transport, and nothing reads it back in. The writer is local to this file
 * rather than shared with the Child App's export-core.js — CLAUDE.md §I.A
 * forbids runtime code shared across the two apps, and this one has a different
 * shape anyway.
 */

const Reporting = (() => {
  const DEFAULT_WINDOW_DAYS = 30;

  // ---- small date helpers (no dependency; the Child App's date-util.js is
  // the other app's file and stays there) ----

  function isoDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function today() {
    return isoDate(new Date());
  }

  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return isoDate(d);
  }

  function formatTimestamp(ms) {
    return ms ? new Date(ms).toLocaleDateString() : '';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  // ---- analysis ----
  //
  // §6.4's visibility rule read from the parent's side. A rescinded row is
  // still a fact — it was assigned once, and a parent looking at a month wants
  // to see that it was pulled — so it is counted separately rather than
  // dropped. A rescinded row the child had already completed counts as
  // completed, because it was: the work happened and the reward stands (§6.3).

  function isRescinded(row) {
    return row.rescinded_at != null && (row.status || 'pending') === 'pending';
  }

  // An event is a row on the plan, not a task: the Child App gives it no
  // completion controls and no child-owned columns at all (assignment-core's
  // eventFrom), so it sits at 'pending' for the rest of time. Counting one in
  // a completion rate would mean a family holiday made a kid look behind.
  function isScorable(row) {
    return row.kind !== 'event';
  }

  function summarize(rows) {
    const totals = {
      assigned: 0, complete: 0, waived: 0, pending: 0, rescinded: 0,
      events: 0, graded: 0, gradeSum: 0, deferred: 0,
    };

    for (const row of rows) {
      if (isRescinded(row)) { totals.rescinded++; continue; }
      totals.assigned++;
      if (!isScorable(row)) { totals.events++; continue; }
      const status = row.status || 'pending';
      if (status === 'complete') totals.complete++;
      else if (status === 'waived') totals.waived++;
      else totals.pending++;
      if (typeof row.grade === 'number') { totals.graded++; totals.gradeSum += row.grade; }
      if (row.deferred_to) totals.deferred++;
    }

    const scorable = totals.assigned - totals.events;
    totals.scorable = scorable;
    totals.completionRate = scorable === 0 ? null : totals.complete / scorable;
    totals.averageGrade = totals.graded === 0 ? null : totals.gradeSum / totals.graded;
    return totals;
  }

  // Per-course rollup for activities, plus a synthetic bucket for chores and
  // events, which have no course. Events carry no completion lifecycle (the
  // Child App's assignment-core never gives them one), so they are listed for
  // completeness and never scored.
  function byCourse(rows) {
    const groups = new Map();
    for (const row of rows) {
      if (isRescinded(row)) continue;
      const key = row.kind === 'activity' ? (row.course_name || '(no course)') : `(${row.kind}s)`;
      if (!groups.has(key)) {
          groups.set(key, {
          name: key, assigned: 0, complete: 0, waived: 0, pending: 0,
          graded: 0, gradeSum: 0, scorable: true,
        });
      }
      const g = groups.get(key);
      g.assigned++;
      g.scorable = isScorable(row);
      if (!isScorable(row)) continue;
      const status = row.status || 'pending';
      if (status === 'complete') g.complete++;
      else if (status === 'waived') g.waived++;
      else g.pending++;
      if (typeof row.grade === 'number') { g.graded++; g.gradeSum += row.grade; }
    }
    return [...groups.values()]
      .map((g) => ({
        ...g,
        averageGrade: g.graded === 0 ? null : g.gradeSum / g.graded,
        completionRate: !g.scorable || g.assigned === 0 ? null : g.complete / g.assigned,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function percent(value) {
    return value == null ? '—' : `${Math.round(value * 100)}%`;
  }

  function grade(value) {
    return value == null ? '—' : value.toFixed(1);
  }

  // ---- CSV (§11 — a report export, not transport) ----

  function csvCell(value) {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(rows) {
    const header = [
      'date', 'kind', 'title', 'course', 'activity_type', 'status',
      'completed_on', 'grade', 'completion_note', 'deferred_to', 'rescinded_on',
      'reward_category', 'assignment_id',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([
        row.date, row.kind, row.title, row.course_name, row.activity_type,
        isRescinded(row) ? 'rescinded' : (row.status || 'pending'),
        formatTimestamp(row.completed_at), row.grade, row.completion_note, row.deferred_to,
        formatTimestamp(row.rescinded_at), row.reward_category, row.id,
      ].map(csvCell).join(','));
    }
    return lines.join('\n');
  }

  function downloadCsv(filename, text) {
    // A Blob URL rather than a data: URI — a full semester's detail table runs
    // past what some browsers accept in a URL, and this one is revoked after.
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  // ---- render ----

  async function render(root) {
    root.innerHTML = `
      <h1>Reporting</h1>
      <p>Assigned versus completed, straight from the database. Completions
         arrive from the child's device as it uploads them — there is no file to
         import.</p>
      <p class="report-status" role="status">Loading…</p>
    `;
    const statusEl = root.querySelector('.report-status');

    const { token } = await Sync.getConfig();
    if (!token) {
      statusEl.textContent = 'Set your sync token in Settings first — reporting reads the database directly.';
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
      <label>From<input type="date" name="from" value="${daysAgo(DEFAULT_WINDOW_DAYS)}"></label>
      <label>To<input type="date" name="to" value="${today()}"></label>
      <button type="submit">Run report</button>
      <p class="error" hidden></p>
    `;
    root.appendChild(form);

    const results = document.createElement('div');
    results.className = 'report-results';
    root.appendChild(results);

    const errorEl = form.querySelector('.error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const childId = form.childId.value;
      const from = form.from.value;
      const to = form.to.value;
      if (!from || !to || from > to) {
        errorEl.hidden = false;
        errorEl.textContent = 'Pick a date range that starts on or before it ends.';
        return;
      }

      results.innerHTML = '<p role="status">Running…</p>';
      try {
        // includeRescinded: the report is a record of what happened, and a
        // batch the parent pulled back is part of that. The summary counts it
        // in its own column rather than folding it into "not done".
        const query = `childId=${encodeURIComponent(childId)}&from=${from}&to=${to}&includeRescinded=1`;
        const [assignments, rewards] = await Promise.all([
          Sync.api(`/api/assignments?${query}`),
          Sync.api(`/api/rewards?childId=${encodeURIComponent(childId)}`),
        ]);
        const childName = (children.find((c) => c.id === childId) || {}).name || childId;
        renderResults(results, {
          childName, from, to,
          rows: assignments.assignments || [],
          balances: rewards.balances || [],
          entries: rewards.entries || [],
          // A report built on a capped query is a wrong report, not a short
          // one: every rate and average below would be computed over a subset
          // and presented as the range's answer.
          truncated: assignments.truncated ? assignments.limit : null,
        });
      } catch (err) {
        results.innerHTML = '';
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    });

    // Run once on arrival for the default child and window, so the page opens
    // showing something rather than an empty form waiting to be pressed.
    form.requestSubmit();
  }

  function renderResults(root, report) {
    const { childName, from, to, rows, balances, entries, truncated } = report;
    root.innerHTML = '';

    if (rows.length === 0) {
      root.innerHTML = `<p>Nothing assigned to ${escapeHtml(childName)} between ${from} and ${to}.</p>`;
      return;
    }

    if (truncated) {
      const warning = document.createElement('p');
      warning.className = 'error';
      warning.setAttribute('role', 'status');
      warning.textContent =
        `This range holds more than ${truncated} rows and the report below covers only the first ` +
        `${truncated}. Every figure on it is therefore partial — narrow the dates and run it again.`;
      root.appendChild(warning);
    }

    const totals = summarize(rows);

    const summary = document.createElement('section');
    summary.className = 'report-summary';
    summary.innerHTML = `
      <h2>${escapeHtml(childName)} · ${from} → ${to}</h2>
      <ul class="report-tiles">
        <li><span class="tile-value">${totals.scorable}</span><span class="tile-label">tasks assigned</span></li>
        <li><span class="tile-value">${totals.complete}</span><span class="tile-label">complete</span></li>
        <li><span class="tile-value">${totals.waived}</span><span class="tile-label">waived</span></li>
        <li><span class="tile-value">${totals.pending}</span><span class="tile-label">outstanding</span></li>
        <li><span class="tile-value">${percent(totals.completionRate)}</span><span class="tile-label">completed</span></li>
        <li><span class="tile-value">${totals.events}</span><span class="tile-label">events (not scored)</span></li>
        <li><span class="tile-value">${grade(totals.averageGrade)}</span><span class="tile-label">avg grade (${totals.graded})</span></li>
        <li><span class="tile-value">${totals.deferred}</span><span class="tile-label">moved by child</span></li>
        <li><span class="tile-value">${totals.rescinded}</span><span class="tile-label">rescinded</span></li>
      </ul>
    `;
    root.appendChild(summary);

    root.appendChild(courseTable(byCourse(rows)));
    root.appendChild(rewardSection(balances, entries, from, to));
    root.appendChild(detailTable(rows));

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'secondary';
    download.textContent = 'Download CSV';
    download.addEventListener('click', () => {
      downloadCsv(`report-${childName.replace(/\W+/g, '-').toLowerCase()}-${from}-to-${to}.csv`, toCsv(rows));
    });
    root.appendChild(download);
  }

  function table(className, headers, bodyRows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'report-table-wrap';
    wrapper.innerHTML = `
      <table class="${className}">
        <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${bodyRows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    `;
    return wrapper;
  }

  function courseTable(groups) {
    const section = document.createElement('section');
    section.innerHTML = '<h3>By course</h3>';
    section.appendChild(table(
      'report-courses',
      ['Course', 'Assigned', 'Complete', 'Waived', 'Outstanding', 'Completed', 'Avg grade'],
      groups.map((g) => [
        escapeHtml(g.name), g.assigned,
        g.scorable ? g.complete : '—', g.scorable ? g.waived : '—', g.scorable ? g.pending : '—',
        percent(g.completionRate), grade(g.averageGrade),
      ])
    ));
    return section;
  }

  // Balances are all-time by design: §3.4 makes the balance a SUM over the
  // whole ledger, and a "balance as of a date range" would be a different
  // number that nobody has asked for and that the child's own screen would
  // contradict. The entries list is what respects the range.
  function rewardSection(balances, entries, from, to) {
    const section = document.createElement('section');
    section.innerHTML = '<h3>Rewards</h3>';

    if (balances.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'Nothing earned yet.';
      section.appendChild(p);
      return section;
    }

    section.appendChild(table(
      'report-balances',
      ['Category', 'Balance (all time)'],
      balances.map((b) => [escapeHtml(b.category), b.balance])
    ));

    const fromMs = new Date(`${from}T00:00:00`).getTime();
    const toMs = new Date(`${to}T23:59:59.999`).getTime();
    const inRange = entries.filter((e) => e.earned_at >= fromMs && e.earned_at <= toMs);

    const caption = document.createElement('p');
    caption.textContent = inRange.length === 0
      ? 'No ledger entries in this range.'
      : `${inRange.length} ledger ${inRange.length === 1 ? 'entry' : 'entries'} in this range:`;
    section.appendChild(caption);

    if (inRange.length > 0) {
      section.appendChild(table(
        'report-entries',
        ['Date', 'Category', 'Amount', 'Reason', 'Recorded by'],
        inRange.map((e) => [
          escapeHtml(formatTimestamp(e.earned_at)), escapeHtml(e.category),
          e.amount, escapeHtml(e.reason), escapeHtml(e.created_by),
        ])
      ));
    }
    return section;
  }

  function statusCell(row) {
    if (isRescinded(row)) return '<span class="status-rescinded">rescinded</span>';
    const status = row.status || 'pending';
    // A completed row that was also rescinded is §6.4's race, and it is worth
    // showing as such: the child did the work and keeps the reward, while the
    // parent's pull still happened.
    const suffix = row.rescinded_at != null ? ' <em>(rescinded after)</em>' : '';
    return `<span class="status-${escapeHtml(status)}">${escapeHtml(status)}</span>${suffix}`;
  }

  function detailTable(rows) {
    const section = document.createElement('section');
    section.innerHTML = `<h3>Detail (${rows.length} ${rows.length === 1 ? 'row' : 'rows'})</h3>`;
    section.appendChild(table(
      'report-detail',
      ['Date', 'Kind', 'Title', 'Course', 'Status', 'Done', 'Grade', 'Note', 'Moved to'],
      rows.map((row) => [
        escapeHtml(row.date), escapeHtml(row.kind), escapeHtml(row.title),
        escapeHtml(row.course_name || ''), statusCell(row),
        escapeHtml(formatTimestamp(row.completed_at)),
        row.grade == null ? '' : escapeHtml(row.grade),
        // Child Feedback Loop §5.4 — read-only, wherever a completed item's
        // grade already shows.
        escapeHtml(row.completion_note || ''),
        escapeHtml(row.deferred_to || ''),
      ])
    ));
    return section;
  }

  return { render, summarize, byCourse, toCsv };
})();
