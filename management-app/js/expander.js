/* Module: expander.js — the Course Structure Expander page (#/expander).
 * Per docs/TDS_Slice_Course_Structure_Expander.md §5/§6.
 *
 * The DOM half of the expander. All parsing, joining, expansion and file
 * writing live in `expander-core.js`; this file reads files, reads four stores,
 * and offers two downloads. Nothing here computes a row.
 *
 * WRITE SCOPE — read this before extending it. THIS MODULE WRITES NOTHING.
 * It reads `courses` (templates, for the code and the curriculum link),
 * `curricula` (suggested Activity Types), `lessons` (existing codes, to
 * continue the numbering), `activityTypes` and `tiers` (to populate the
 * pickers and to warn about a type the app lacks), and produces downloads.
 * Lessons and Activities enter the app through exactly one door —
 * `Courses.importActivitiesCsv()` on the Course Templates page — and this page
 * deliberately does not shortcut it. A proposal has to leave for the LLM pass
 * anyway (blank `pdf` titles), so a direct-write path here would only be a
 * second, less-validated importer.
 */

const Expander = (() => {
  // The Activity table is both the emission ORDER and the per-type defaults —
  // one row per type, dragged into teaching sequence with the same up/down
  // controls the count-target rows use (courses.js, `buildCountTargetsFieldset`).
  // Two separate lists would have been two places to say the same thing.
  //
  // Rows seed from the Course's own Curriculum rather than from a constant, so
  // a publisher that reads before it watches, or has no videos at all, is
  // expressed rather than worked around. MiAcademy's shape is now just the
  // fallback when a Curriculum names nothing.

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
  }

  async function listTemplates() {
    const templates = await Courses.listCourseTemplates();
    return templates.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  async function existingLessonCodes(courseId) {
    const lessons = await Storage.getAllByIndex('lessons', 'by_courseId', courseId);
    return lessons.map((l) => l.lessonCode);
  }

  // The Course's Curriculum decides which Activity Types open the table, via
  // the same helper the Lesson recipe uses (FR-P9) — so the expander and the
  // recipe agree about what a publisher's Lessons are made of. Order arrives in
  // Activity Type table order, which is an opening position, not a claim about
  // teaching sequence; the arrows are how the parent says otherwise.
  async function seedTypeKeys(course, activityTypes) {
    let suggested = [];
    if (course && course.curriculumId) {
      const curriculum = await Storage.get('curricula', course.curriculumId);
      suggested = (curriculum && curriculum.suggestedActivityTypes) || [];
    }
    let keys = RecipeCore.suggestedTargetTypeKeys({
      titlePatterns: (course && course.titlePatterns) || {},
      suggestedActivityTypes: suggested,
      activityTypes,
    });

    // A Curriculum that names nothing yet falls back to the MiAcademy shape,
    // filtered to types this app actually has.
    if (keys.length === 0) {
      const known = new Set(activityTypes.map((t) => t.activityTypeKey));
      keys = ExpanderCore.TYPE_ORDER.filter((k) => known.has(k));
    }

    // `pdf` is how a page map reaches the proposal at all, so it is offered
    // even when the Curriculum does not name it. Removable like any other row —
    // a curriculum with no printable work simply takes it out.
    if (!keys.includes('pdf') && activityTypes.some((t) => t.activityTypeKey === 'pdf')) {
      keys = [...keys, 'pdf'];
    }
    return keys;
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  // ---- The Activity table ----

  function buildActivityTable(activityTypes, tiers, seedKeys) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <table class="expander-defaults">
        <thead><tr><th>Activity Type</th><th>Tier</th><th>Min</th><th>Order</th></tr></thead>
        <tbody></tbody>
      </table>
      <button type="button" data-action="add-type">Add Activity Type</button>
    `;
    const body = wrap.querySelector('tbody');

    const typeOptions = (selected) => activityTypes
      .map((t) => `<option value="${escapeHtml(t.activityTypeKey)}"${t.activityTypeKey === selected ? ' selected' : ''}>${escapeHtml(t.label)}</option>`)
      .join('');
    const tierOptions = (selected) => tiers
      .map((t) => `<option value="${escapeHtml(t.tierId)}"${t.tierId === selected ? ' selected' : ''}>${escapeHtml(t.tierId)} — ${escapeHtml(t.label)}</option>`)
      .join('');

    // Moving a row is a DOM move, never a re-render — the same reasoning as
    // courses.js: a <select>'s selection and a number input's value are element
    // state, so they ride along untouched.
    function refreshMoveButtons() {
      const rows = Array.from(body.children);
      rows.forEach((row, i) => {
        row.querySelector('[data-action="move-up"]').disabled = i === 0;
        row.querySelector('[data-action="move-down"]').disabled = i === rows.length - 1;
      });
    }

    function addRow(typeKey) {
      const fallback = ExpanderCore.DEFAULTS[typeKey] || { difficultyTier: 'D01', expectedDurationMin: 10 };
      const tier = tiers.some((t) => t.tierId === fallback.difficultyTier) ? fallback.difficultyTier : (tiers[0] && tiers[0].tierId);
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><select data-field="activityType">${typeOptions(typeKey)}</select></td>
        <td><select data-field="difficultyTier">${tierOptions(tier)}</select></td>
        <td><input type="number" data-field="expectedDurationMin" min="1" step="1" value="${escapeHtml(fallback.expectedDurationMin)}"></td>
        <td class="expander-row-controls">
          <button type="button" data-action="move-up" aria-label="Move up">&uarr;</button>
          <button type="button" data-action="move-down" aria-label="Move down">&darr;</button>
          <button type="button" data-action="remove" aria-label="Remove">&times;</button>
        </td>
      `;
      row.querySelector('[data-action="remove"]').addEventListener('click', () => {
        row.remove();
        refreshMoveButtons();
      });
      row.querySelector('[data-action="move-up"]').addEventListener('click', () => {
        const previous = row.previousElementSibling;
        if (previous) { body.insertBefore(row, previous); refreshMoveButtons(); }
      });
      row.querySelector('[data-action="move-down"]').addEventListener('click', () => {
        const next = row.nextElementSibling;
        if (next) { body.insertBefore(next, row); refreshMoveButtons(); }
      });
      body.appendChild(row);
      refreshMoveButtons();
    }

    // A type's own default duration follows the type when the row's type is
    // changed, unless the parent has already typed a number of their own.
    wrap.addEventListener('change', (event) => {
      const select = event.target.closest('[data-field="activityType"]');
      if (!select) return;
      const row = select.closest('tr');
      const minutes = row.querySelector('[data-field="expectedDurationMin"]');
      const preset = ExpanderCore.DEFAULTS[select.value];
      if (preset && !minutes.dataset.touched) minutes.value = preset.expectedDurationMin;
    });
    wrap.addEventListener('input', (event) => {
      if (event.target.matches('[data-field="expectedDurationMin"]')) event.target.dataset.touched = '1';
    });

    wrap.querySelector('[data-action="add-type"]').addEventListener('click', () => {
      const used = new Set(Array.from(body.querySelectorAll('[data-field="activityType"]')).map((s) => s.value));
      const unused = activityTypes.find((t) => !used.has(t.activityTypeKey));
      addRow(unused ? unused.activityTypeKey : activityTypes[0].activityTypeKey);
    });

    seedKeys.forEach(addRow);

    // DOM order is the emission order; the two are never stored separately.
    wrap.collect = () => Array.from(body.children).map((row) => ({
      activityType: row.querySelector('[data-field="activityType"]').value,
      difficultyTier: row.querySelector('[data-field="difficultyTier"]').value,
      expectedDurationMin: Number(row.querySelector('[data-field="expectedDurationMin"]').value) || 0,
    }));

    return wrap;
  }

  // ---- Result ----

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
      <div class="expander-table-wrap">
        <table class="expander-preview">
          <thead><tr><th>Lesson</th><th>Type</th><th>Title</th><th>Pages</th><th>Tier</th><th>Min</th></tr></thead>
          <tbody>${sampleRows}</tbody>
        </table>
      </div>
      <div class="expander-actions">
        <button type="button" data-action="download-xlsx">Download .xlsx</button>
        <button type="button" class="secondary" data-action="download-csv">Download .csv</button>
      </div>
      <p class="expander-hint">
        Same rows in both. The workbook is the one to edit on a phone; the CSV
        is what <a href="#/courses">Bulk Import</a> reads.
      </p>`;
  }

  async function render(root) {
    const [templates, tiers, activityTypes] = await Promise.all([
      listTemplates(),
      Storage.getAll('tiers'),
      Storage.getAll('activityTypes'),
    ]);
    tiers.sort((a, b) => a.order - b.order);

    if (templates.length === 0) {
      root.innerHTML = `
        <h1>Course Structure Expander</h1>
        <p class="error">
          No Course Templates yet. The expander stamps a real course code onto
          every row, and the importer rejects a code that names no template —
          so create the Course first under <a href="#/courses">Course Templates</a>.
        </p>`;
      return;
    }

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

        <h2>3. Activities</h2>
        <p class="expander-hint" id="expander-types-hint"></p>
        <p class="expander-hint">
          Top to bottom is the order a Lesson's Activities are written in. Tier
          and minutes apply to every row of that type; outliers are for the LLM
          pass or a later edit. A type in the counts sheet that is not listed
          here is still written, after these.
        </p>
        <div id="expander-types"></div>

        <div class="expander-actions">
          <button type="button" data-action="generate">Generate proposal</button>
        </div>
      </section>
      <section class="expander-result" hidden></section>`;

    const courseSelect = root.querySelector('#expander-course');
    const startInput = root.querySelector('#expander-start');
    const startHint = root.querySelector('#expander-start-hint');
    const typesHint = root.querySelector('#expander-types-hint');
    const typesHost = root.querySelector('#expander-types');
    const resultEl = root.querySelector('.expander-result');
    let table = null;

    // Both the next free Lesson code and the Activity seed depend on which
    // Course is chosen, so they are recomputed together on every change.
    async function syncCourse() {
      const course = templates.find((c) => c.id === courseSelect.value);

      const codes = await existingLessonCodes(course.id);
      const next = ExpanderCore.nextLessonNumber(codes);
      startInput.value = next;
      startHint.textContent = codes.length
        ? `${course.courseCode} already has ${codes.length} Lesson(s); numbering continues at ${next}.`
        : `${course.courseCode} has no Lessons yet.`;

      const seed = await seedTypeKeys(course, activityTypes);
      const curriculum = course.curriculumId ? await Storage.get('curricula', course.curriculumId) : null;
      const named = curriculum && (curriculum.suggestedActivityTypes || []).length;
      typesHint.textContent = named
        ? `Seeded from ${curriculum.name}'s suggested Activity Types.`
        : 'This Curriculum names no suggested Activity Types, so this is a starting point — reorder, add and remove freely.';

      table = buildActivityTable(activityTypes, tiers, seed);
      typesHost.innerHTML = '';
      typesHost.appendChild(table);
    }
    courseSelect.addEventListener('change', syncCourse);
    await syncCourse();

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

      const configured = table.collect();
      const defaults = {};
      for (const row of configured) {
        defaults[row.activityType] = {
          difficultyTier: row.difficultyTier,
          expectedDurationMin: row.expectedDurationMin,
        };
      }

      const result = ExpanderCore.expand({
        counts,
        pageMap,
        courseCode: course.courseCode,
        startNumber: Number(startInput.value) || 1,
        defaults,
        typeOrder: configured.map((r) => r.activityType),
        knownTypeKeys: activityTypes.map((t) => t.activityTypeKey),
      });

      resultEl.innerHTML = renderPreview(result, course.courseCode);
      const base = `${course.courseCode}_lesson_activity_import_proposed`;
      resultEl.querySelector('[data-action="download-csv"]').addEventListener('click', () => {
        downloadBlob(`${base}.csv`, new Blob([ExpanderCore.toCsv(result.rows)], { type: 'text/csv;charset=utf-8' }));
      });
      resultEl.querySelector('[data-action="download-xlsx"]').addEventListener('click', () => {
        downloadBlob(`${base}.xlsx`, new Blob([ExpanderCore.buildXlsx(result.rows)], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }));
      });
    });
  }

  return { render };
})();
