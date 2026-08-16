/* Module: remediation.js — Grading Assistant Phase 7.
 * Per TDS_Slice_Grading_Assistant.md §9 Phase 7: the remediation report over
 * mechanics_findings (worker/index.js's GET /api/grading/remediation). Shows
 * a parent which words a child keeps getting wrong, aggregated by the same
 * (child_id, intended) shape the table's own index is built for (§1.2).
 *
 * Read-only, like reporting.js — nothing here writes an assignment, a
 * finding, or a rubric. §0.4: a finding is recorded whether or not the
 * household's rubric counted it, so a course running `spelling: 'off'` still
 * shows up here; `countedOccurrences` beside the raw count is what lets a
 * parent tell the two apart.
 */

const Remediation = (() => {
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function formatTime(ms) {
    return ms ? new Date(ms).toLocaleDateString() : '—';
  }

  async function render(root) {
    root.innerHTML = `
      <h1>Remediation</h1>
      <p>Words a child's graded worksheets keep flagging, grouped so the ones
         worth practicing rise to the top. A word still appears here even from
         a course whose rubric doesn't mark it down — the "Counted" column
         says whether it affected a grade.</p>
      <p class="report-status" role="status">Loading…</p>
    `;
    const statusEl = root.querySelector('.report-status');

    const { token } = await Sync.getConfig();
    if (!token) {
      statusEl.textContent = 'Set your sync token in Settings first — remediation reads the database directly.';
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
      <label>Kind<select name="kind">
        <option value="">Spelling & grammar</option>
        <option value="spelling">Spelling only</option>
        <option value="grammar">Grammar only</option>
      </select></label>
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
      const kind = form.kind.value;

      results.innerHTML = '<p role="status">Running…</p>';
      try {
        const query = `childId=${encodeURIComponent(childId)}` + (kind ? `&kind=${encodeURIComponent(kind)}` : '');
        const { words, truncated, limit } = await Sync.api(`/api/grading/remediation?${query}`);
        const childName = (children.find((c) => c.id === childId) || {}).name || childId;
        renderResults(results, { childName, words: words || [], truncated, limit });
      } catch (err) {
        results.innerHTML = '';
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    });

    // Run once on arrival for the default child, so the page opens showing
    // something rather than an empty form waiting to be pressed.
    form.requestSubmit();
  }

  function renderResults(root, { childName, words, truncated, limit }) {
    root.innerHTML = '';

    if (truncated) {
      const warning = document.createElement('p');
      warning.className = 'error';
      warning.setAttribute('role', 'status');
      warning.textContent =
        `This child has more than ${limit} distinct words on record and the table below covers ` +
        `only the first ${limit}, ranked by how often each comes up — the ones cut off are the rarest.`;
      root.appendChild(warning);
    }

    if (words.length === 0) {
      const p = document.createElement('p');
      p.textContent = `No mechanics findings for ${escapeHtml(childName)} yet.`;
      root.appendChild(p);
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `${childName} · ${words.length} ${words.length === 1 ? 'word' : 'words'}`;
    root.appendChild(heading);

    const wrapper = document.createElement('div');
    wrapper.className = 'report-table-wrap';
    wrapper.innerHTML = `
      <table class="report-detail">
        <thead>
          <tr>
            <th>Word</th><th>Kind</th><th>Seen</th><th>Counted</th>
            <th>Written as</th><th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          ${words.map((w) => `
            <tr>
              <td>${escapeHtml(w.intended)}</td>
              <td>${escapeHtml(w.kind)}</td>
              <td>${w.occurrences}</td>
              <td>${w.countedOccurrences}</td>
              <td>${w.asWritten.map(escapeHtml).join(', ')}</td>
              <td>${formatTime(w.lastFoundAt)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    root.appendChild(wrapper);
  }

  return { render };
})();
