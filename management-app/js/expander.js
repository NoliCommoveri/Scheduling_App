/* Module: expander.js — the Course Structure Expander page (#/expander).
 * Per docs/TDS_Slice_Course_Structure_Expander.md §5/§6.
 *
 * The DOM half of the expander. All parsing, joining and expansion lives in
 * `expander-core.js`; this file reads files, reads three stores, and writes a
 * download. Nothing here computes a row.
 *
 * WRITE SCOPE — read this before extending it. THIS MODULE WRITES NOTHING.
 * It reads `courses` (templates, for the code list), `lessons` (existing codes,
 * to continue the numbering), `activityTypes` and `tiers` (to populate the
 * pickers and to warn about a type the app lacks), and produces a file the
 * parent downloads. Lessons and Activities enter the app through exactly one
 * door — `Courses.importActivitiesCsv()` on the Course Templates page — and
 * this page deliberately does not shortcut it. A proposal has to leave for the
 * LLM pass anyway (blank `pdf` titles), so a direct-write path here would only
 * be a second, less-validated importer.
 */

const Expander = (() => {
  // Which per-type defaults the tuning table offers a line for. The order the
  // rows appear in is the order they are emitted in a lesson, so the table
  // doubles as a statement of the sequence (TDS §3.2).
  const TUNABLE_TYPES = ExpanderCore.TYPE_ORDER;

  // Survives a re-render of the page so a Generate → adjust defaults →
  // Generate cycle keeps the parent's tuning.
  let defaults = JSON.parse(JSON.stringify(ExpanderCore.DEFAULTS));

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
  }

  async function courseCodesInUse() {
    const templates = await Courses.listCourseTemplates();
    return templates.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  async function existingLessonCodes(courseId) {
    const lessons = await Storage.getAllByIndex('lessons', 'by_courseId', courseId);
    return lessons.map((l) => l.lessonCode);
  }

  // Same Blob-URL treatment courses.js and reporting.js use for their exports.
  function downloadCsv(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function renderDefaultsTable(tiers) {
    const tierOptions = (selected) => tiers
      .map((t) => `<option value="${escapeHtml(t.tierId)}"${t.tierId === selected ? ' selected' : ''}>${escapeHtml(t.tierId)} — ${escapeHtml(t.label)}</option>`)
      .join('');

    const rows = TUNABLE_TYPES.map((key) => {
      const d = defaults[key] || ExpanderCore.DEFAULTS[key];
      return `
        <tr data-type="${escapeHtml(key)}">
          <td><code>${escapeHtml(key)}</code></td>
          <td><select data-field="difficultyTier">${tierOptions(d.difficultyTier)}</select></td>
          <td><input type="number" data-field="expectedDurationMin" min="1" step="1" value="${escapeHtml(d.expectedDurationMin)}"></td>
        </tr>`;
    }).join('');

    return `
      <table class="expander-defaults">
        <thead><tr><th>Activity Type</th><th>Tier</th><th>Minutes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderPreview(result, courseCode) {
    const { rows, warnings, lessons } = result;
    // A counts sheet whose only Activity Type is PDF, handed in without a page
    // map, expands to nothing at all. Rare, but the summary below indexes
    // rows[0] and would throw rather than explain itself.
    if (rows.length === 0) {
      const list = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
      return `<p class="error">No Activity rows came out of these two files.</p>${list ? `<ul>${list}</ul>` : ''}`;
    }
    const byType = new Map();
    for (const r of rows) byType.set(r.activityType, (byType.get(r.activityType) || 0) + 1);
    const tally = [...byType.entries()]
      .map(([t, n]) => `<li><code>${escapeHtml(t)}</code> × ${n}</li>`).join('');

    const pdfCount = byType.get('pdf') || 0;
    const warningList = warnings.length
      ? `<div class="expander-warnings"><h3>${warnings.length} thing(s) to look at</h3><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
      : '<p class="success">No mismatches between the two files.</p>';

    // First lesson only. The whole file is the download; this is a sanity
    // check that the join landed, not a spreadsheet view.
    const sample = rows.filter((r) => r.lessonCode === rows[0].lessonCode);
    const sampleRows = sample.map((r) => `
      <tr>
        <td>${escapeHtml(r.lessonCode)}</td>
        <td><code>${escapeHtml(r.activityType)}</code></td>
        <td>${r.title ? escapeHtml(r.title) : '<em class="expander-blank">(blank — for the LLM to name)</em>'}</td>
        <td>${r.pageRangeStart === '' ? '' : `${escapeHtml(r.pageRangeStart)}–${escapeHtml(r.pageRangeEnd)}`}</td>
        <td>${escapeHtml(r.difficultyTier)}</td>
        <td>${escapeHtml(r.expectedDurationMin)}</td>
      </tr>`).join('');

    return `
      <div class="expander-summary">
        <p class="success">
          ${lessons.length} Lesson(s), ${rows.length} Activity row(s) for
          <strong>${escapeHtml(courseCode)}</strong> — codes
          <code>${escapeHtml(rows[0].lessonCode)}</code>–<code>${escapeHtml(rows[rows.length - 1].lessonCode)}</code>.
        </p>
        <ul class="expander-tally">${tally}</ul>
        ${pdfCount ? `<p class="expander-next">The ${pdfCount} <code>pdf</code> row(s) carry a whole-lesson page range and a blank title. That is the split for the LLM pass; everything else is ready to import.</p>` : ''}
      </div>
      ${warningList}
      <h3>First Lesson</h3>
      <table class="expander-preview">
        <thead><tr><th>Lesson</th><th>Type</th><th>Title</th><th>Pages</th><th>Tier</th><th>Min</th></tr></thead>
        <tbody>${sampleRows}</tbody>
      </table>
      <div class="expander-actions">
        <button type="button" data-action="download">Download proposal CSV</button>
      </div>`;
  }

  async function render(root) {
    const [templates, tiers] = await Promise.all([
      courseCodesInUse(),
      Storage.getAll('tiers'),
    ]);
    tiers.sort((a, b) => a.order - b.order);

    root.innerHTML = `
      <h1>Course Structure Expander</h1>
      <p class="expander-hint">
        Turns a curriculum counts sheet and a trimmed-PDF page map into a
        proposal in this app's own bulk-import format. Every mechanical column
        is filled here — course code, Lesson codes and order, Activity types,
        titles, tiers and durations. What is left for the LLM pass is the one
        thing it cannot compute: splitting each Lesson's page range into named
        sections. The finished file comes back in through
        <a href="#/courses">Course Templates → Bulk Import</a>.
      </p>

      ${templates.length === 0 ? `
        <p class="error">
          No Course Templates yet. The expander stamps a real course code onto
          every row, and the importer rejects a code that names no template —
          so create the Course first under <a href="#/courses">Course Templates</a>.
        </p>` : `
      <section class="expander-inputs">
        <h2>1. Course</h2>
        <label>Course Template
          <select id="expander-course">
            ${templates.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.courseCode)})</option>`).join('')}
          </select>
        </label>
        <label>First Lesson number
          <input type="number" id="expander-start" min="1" step="1" value="1">
        </label>
        <p class="expander-hint" id="expander-start-hint"></p>

        <h2>2. Files</h2>
        <label>Counts sheet — Unit Name, Lesson Name, Activity Type, Activity Count
          <input type="file" id="expander-counts" accept=".xlsx,.csv,text/csv">
        </label>
        <label>Page map (optional) — trimmed_page, original_page, Unit Name, Lesson Name
          <input type="file" id="expander-pagemap" accept=".xlsx,.csv,text/csv">
        </label>
        <p class="expander-hint">
          Either file may be .xlsx or .csv. Without a page map the proposal
          simply carries no <code>pdf</code> rows.
        </p>

        <h2>3. Defaults</h2>
        <p class="expander-hint">
          Applied to every row of that type. Outliers — a long project PDF, a
          short quiz — are for the LLM pass or a later edit.
        </p>
        ${renderDefaultsTable(tiers)}

        <div class="expander-actions">
          <button type="button" data-action="generate">Generate proposal</button>
        </div>
      </section>
      <section class="expander-result" hidden></section>`}
    `;

    if (templates.length === 0) return;

    const courseSelect = root.querySelector('#expander-course');
    const startInput = root.querySelector('#expander-start');
    const startHint = root.querySelector('#expander-start-hint');
    const resultEl = root.querySelector('.expander-result');

    // The next free code for the chosen Course, recomputed on every change so
    // a second batch appends instead of colliding (TDS §3.4).
    async function syncStart() {
      const course = templates.find((c) => c.id === courseSelect.value);
      const codes = await existingLessonCodes(course.id);
      const next = ExpanderCore.nextLessonNumber(codes);
      startInput.value = next;
      startHint.textContent = codes.length
        ? `${course.courseCode} already has ${codes.length} Lesson(s); numbering continues at ${next}.`
        : `${course.courseCode} has no Lessons yet.`;
    }
    courseSelect.addEventListener('change', syncStart);
    await syncStart();

    root.querySelectorAll('.expander-defaults [data-field]').forEach((el) => {
      el.addEventListener('change', () => {
        const type = el.closest('tr').dataset.type;
        const field = el.dataset.field;
        if (!defaults[type]) defaults[type] = { ...ExpanderCore.DEFAULTS[type] };
        defaults[type][field] = field === 'expectedDurationMin' ? Number(el.value) : el.value;
      });
    });

    root.querySelector('[data-action="generate"]').addEventListener('click', async () => {
      const course = templates.find((c) => c.id === courseSelect.value);
      const countsFile = root.querySelector('#expander-counts').files[0];
      const mapFile = root.querySelector('#expander-pagemap').files[0];

      resultEl.hidden = false;
      if (!countsFile) {
        resultEl.innerHTML = '<p class="error">Choose a counts sheet first.</p>';
        return;
      }
      resultEl.innerHTML = '<p>Reading…</p>';

      let counts;
      let pageMap = [];
      const fileErrors = [];
      try {
        const countsRead = ExpanderCore.readCounts(await ExpanderCore.readGrid(countsFile));
        if (countsRead.error) {
          resultEl.innerHTML = `<p class="error">${escapeHtml(countsRead.error)}</p>`;
          return;
        }
        counts = countsRead.rows;
        fileErrors.push(...countsRead.errors);

        if (mapFile) {
          const mapRead = ExpanderCore.readPageMap(await ExpanderCore.readGrid(mapFile));
          if (mapRead.error) {
            resultEl.innerHTML = `<p class="error">${escapeHtml(mapRead.error)}</p>`;
            return;
          }
          pageMap = mapRead.rows;
          fileErrors.push(...mapRead.errors);
        }
      } catch (err) {
        resultEl.innerHTML = `<p class="error">Could not read the file: ${escapeHtml(err.message || err)}</p>`;
        return;
      }

      // A malformed row is fatal for the whole file, the same posture as the
      // importer's all-or-nothing check: a proposal with a row quietly missing
      // is worse than no proposal, because the gap only surfaces months later
      // as a Lesson the child never gets.
      if (fileErrors.length) {
        resultEl.innerHTML = `<p class="error">Nothing was generated — fix these rows and try again.</p><ul>${fileErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
        return;
      }
      if (counts.length === 0) {
        resultEl.innerHTML = '<p class="error">The counts sheet has a header but no rows.</p>';
        return;
      }

      const activityTypes = await Storage.getAll('activityTypes');
      const result = ExpanderCore.expand({
        counts,
        pageMap,
        courseCode: course.courseCode,
        startNumber: Number(startInput.value) || 1,
        defaults,
        knownTypeKeys: activityTypes.map((t) => t.activityTypeKey),
      });

      resultEl.innerHTML = renderPreview(result, course.courseCode);
      resultEl.querySelector('[data-action="download"]').addEventListener('click', () => {
        downloadCsv(
          `${course.courseCode}_lesson_activity_import_proposed.csv`,
          ExpanderCore.toCsv(result.rows)
        );
      });
    });
  }

  return { render };
})();
