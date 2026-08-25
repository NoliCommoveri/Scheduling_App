/* Module: settings.js — Module 11, FR-1 (initial launchPin setup) and
 * FR-2 (change launchPin) only. Backup/restore (FR-3-8) is M8, not in scope.
 * Per TDS_Slice_M4_Management_App_Rev3.md §3. */

const Settings = (() => {
  const WRITE_IT_DOWN_WARNING =
    "Write this PIN down somewhere safe. There is currently no way to recover it if forgotten, " +
    "and forgetting it means losing everything you've authored.";

  function isValidPin(pin) {
    return /^\d{4,}$/.test(pin);
  }

  function clear(root) {
    root.innerHTML = '';
  }

  // FR-1 — first launch, no appSettings record exists yet.
  function renderInitialSetup(root, onUnlocked) {
    clear(root);

    const form = document.createElement('form');
    form.innerHTML = `
      <h1>Set up your launch PIN</h1>
      <p class="warning">${WRITE_IT_DOWN_WARNING}</p>
      <label>New PIN (4+ digits)<input type="password" inputmode="numeric" name="pin" autocomplete="off"></label>
      <label>Confirm PIN<input type="password" inputmode="numeric" name="confirm" autocomplete="off"></label>
      <p class="error" hidden></p>
      <button type="submit">Set PIN</button>
    `;
    const errorEl = form.querySelector('.error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = form.pin.value;
      const confirm = form.confirm.value;

      if (!isValidPin(pin)) {
        showError(errorEl, 'PIN must be at least 4 digits, numeric only.');
        return;
      }
      if (pin !== confirm) {
        showError(errorEl, 'PIN and confirmation do not match.');
        return;
      }

      await Storage.put('appSettings', { launchPin: pin }, 'appSettings');

      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist(); // Q11 — fire-and-proceed, denial never surfaced
      }

      onUnlocked();
    });

    root.appendChild(form);
  }

  // Gate branch — appSettings already exists.
  function renderGate(root, storedPin, onUnlocked) {
    clear(root);

    const form = document.createElement('form');
    form.innerHTML = `
      <h1>Enter your launch PIN</h1>
      <label>PIN<input type="password" inputmode="numeric" name="pin" autocomplete="off" autofocus></label>
      <p class="error" hidden></p>
      <button type="submit">Unlock</button>
    `;
    const errorEl = form.querySelector('.error');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (form.pin.value === storedPin) {
        onUnlocked();
      } else {
        showError(errorEl, 'Incorrect PIN.');
        form.pin.value = '';
        form.pin.focus();
      }
    });

    root.appendChild(form);
  }

  // Settings view (#/settings): FR-2 change-PIN form.
  function renderSettingsPage(root) {
    clear(root);
    const heading = document.createElement('h1');
    heading.textContent = 'Settings';
    root.appendChild(heading);

    root.appendChild(buildSection('Change launch PIN', renderChangePinForm));
    root.appendChild(buildSection('Cloud backup (Cloudflare D1)', renderSyncPanel));
    // Settings → Database, the everyday migration surface (Revamp §3.7.5).
    // Placed after the sync panel because it reuses that panel's token.
    root.appendChild(buildSection('Database', Migrations.renderPanel));
    root.appendChild(buildSection('Devices', Devices.render));
    root.appendChild(buildSection('Grading defaults', renderGradingDefaultsForm));
    root.appendChild(buildSection('Subject order', renderSubjectOrderForm));
  }

  // Grading Assistant §2.1 — the household layer of the three-layer rubric
  // (§2's householdDefaults → course.gradingRubric → resolved rubric).
  // Values/labels mirror worker/grading-core.js's RUBRIC_DEFAULTS; duplicated
  // here (not imported) because worker/ is never served as a public asset,
  // so this browser app cannot reach it. Keep in sync if §2.1 changes.
  const GRADING_RUBRIC_DEFAULTS = {
    spelling: 'listOnly',
    grammar: 'off',
    paraphraseTolerance: 'normal',
    partialCredit: true,
    houseRules: '',
  };

  // Unlike a Course's override (courses.js buildGradingRubricFieldset), this
  // layer has no further fallback to leave a field on, so every field always
  // resolves to a concrete value and the saved record is never sparse.
  function renderGradingDefaultsForm(root) {
    root.innerHTML = `
      <p>Applies to every Course that does not set its own override
         (Courses → Edit Course → Grading rubric).</p>
      <form>
        <label>Spelling<select name="spelling">
          <option value="off">Off</option>
          <option value="listOnly">Common words only</option>
          <option value="all">All misspellings</option>
        </select></label>
        <label>Grammar<select name="grammar">
          <option value="off">Off</option>
          <option value="on">On</option>
        </select></label>
        <label>Paraphrase tolerance<select name="paraphraseTolerance">
          <option value="strict">Strict</option>
          <option value="normal">Normal</option>
          <option value="generous">Generous</option>
        </select></label>
        <label>Partial credit<select name="partialCredit">
          <option value="true">Yes — partial credit counts as half</option>
          <option value="false">No — partial credit counts as incorrect</option>
        </select></label>
        <label>House rules<textarea name="houseRules" rows="2" placeholder="Appended verbatim to every grading prompt, unless a Course overrides it."></textarea></label>
        <p class="error" hidden></p>
        <p class="success" hidden></p>
        <button type="submit">Save</button>
      </form>
    `;
    const form = root.querySelector('form');
    const errorEl = form.querySelector('.error');
    const successEl = form.querySelector('.success');

    Storage.get('meta', 'gradingDefaults').then((stored) => {
      const r = { ...GRADING_RUBRIC_DEFAULTS, ...(stored || {}) };
      form.spelling.value = r.spelling;
      form.grammar.value = r.grammar;
      form.paraphraseTolerance.value = r.paraphraseTolerance;
      form.partialCredit.value = String(r.partialCredit);
      form.houseRules.value = r.houseRules;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;
      await Storage.put('meta', {
        spelling: form.spelling.value,
        grammar: form.grammar.value,
        paraphraseTolerance: form.paraphraseTolerance.value,
        partialCredit: form.partialCredit.value === 'true',
        houseRules: form.houseRules.value.trim(),
      }, 'gradingDefaults');
      successEl.hidden = false;
      successEl.textContent = 'Saved.';
    });
  }

  // Collapsed-by-default <details> bucket per Settings section — same
  // convention as .course-subject-group (courses.js) and the other list/panel
  // groupings — so opening Settings isn't one long scroll through Cloud
  // backup, Database, and Devices to reach the one you came for.
  // Module 11 FR-9 / TDS_Slice_Subject_Order_Grouped_Review.md §1.3 — the
  // household's standing subject order, one record in `meta` under
  // `subjectOrder`. `meta` and not `appSettings`: the latter is device-local by
  // design and never mirrored (storage.js SYNC_EXCLUDED), so an order entered
  // here would evaporate on the other laptop. `gradingDefaults` above is the
  // same class of household preference stored the same way (§1.1).
  //
  // The list shown is the *effective* order — stored entries in their stored
  // positions, then every subject in use on a Course that the stored list does
  // not mention. Save writes the whole array: the record is the list, and there
  // is no per-row write to get out of step with it.
  function renderSubjectOrderForm(root) {
    root.innerHTML = `
      <p>Sets the order subjects appear in wherever Courses are grouped by subject —
         the Course Template Library, Assigned Courses and the weekly view today,
         and the Generate and Assignments screens as they adopt it. Subjects not
         listed here sort alphabetically after the ones that are, so a Course given
         a brand-new subject shows up without a visit to this screen.</p>
      <div class="subject-order-list"><p>Loading…</p></div>
      <p class="error" hidden></p>
      <p class="success" hidden></p>
      <button type="button" class="subject-order-save" disabled>Save order</button>
    `;

    const listEl = root.querySelector('.subject-order-list');
    const errorEl = root.querySelector('.error');
    const successEl = root.querySelector('.success');
    const saveBtn = root.querySelector('.subject-order-save');

    // `rows` is the working list — merge()'s output, reordered in place by the
    // arrows. `inUse` is kept so a save can re-derive the markers without
    // re-reading every Course record.
    let rows = [];
    let inUse = [];

    function draw() {
      listEl.innerHTML = '';
      if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.textContent =
          'No subjects yet. Give a Course a subject and it will appear here.';
        listEl.appendChild(empty);
        return;
      }

      const list = document.createElement('ul');
      list.className = 'subject-order';
      rows.forEach((row, i) => {
        const li = document.createElement('li');
        li.className = 'list-row';

        const text = document.createElement('div');
        text.className = 'row-text';
        const name = document.createElement('span');
        name.className = 'row-title';
        name.textContent = row.subject;
        text.appendChild(name);
        if (!row.listed || !row.inUse) {
          const note = document.createElement('span');
          note.className = 'row-meta';
          note.textContent = row.listed ? 'no Course uses this any more' : 'not yet ordered';
          text.appendChild(note);
        }
        li.appendChild(text);

        const actions = document.createElement('div');
        actions.className = 'row-actions';
        // Buttons, not drag-and-drop: a handful of rows, and a pair of arrows is
        // less code and fewer ways to lose a list — and works on a touchscreen
        // and a keyboard without either being a special case (§1.3).
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'secondary';
        up.textContent = '↑';
        up.title = `Move ${row.subject} up`;
        up.disabled = i === 0;
        up.addEventListener('click', () => moveRow(i, -1));
        actions.appendChild(up);

        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'secondary';
        down.textContent = '↓';
        down.title = `Move ${row.subject} down`;
        down.disabled = i === rows.length - 1;
        down.addEventListener('click', () => moveRow(i, 1));
        actions.appendChild(down);

        // Only a stored entry nothing uses can be removed. An in-use subject is
        // removed by editing the Courses that carry it, not from here — this
        // screen never writes a Course record (FR-9).
        if (row.listed && !row.inUse) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'secondary';
          remove.textContent = 'Remove';
          remove.addEventListener('click', () => {
            rows.splice(i, 1);
            markDirty();
            draw();
          });
          actions.appendChild(remove);
        }

        li.appendChild(actions);
        list.appendChild(li);
      });
      listEl.appendChild(list);
    }

    function markDirty() {
      successEl.hidden = true;
      errorEl.hidden = true;
    }

    function moveRow(i, delta) {
      const to = i + delta;
      if (to < 0 || to >= rows.length) return;
      const [row] = rows.splice(i, 1);
      rows.splice(to, 0, row);
      markDirty();
      draw();
    }

    Promise.all([Storage.get('meta', 'subjectOrder'), Storage.getAll('courses')])
      .then(([stored, courses]) => {
        inUse = courses.map((c) => c.subject);
        rows = SubjectOrderCore.merge((stored && stored.order) || [], inUse);
        saveBtn.disabled = false;
        draw();
      })
      .catch((err) => {
        listEl.innerHTML = '';
        errorEl.hidden = false;
        errorEl.textContent = `Could not load subjects: ${err.message}`;
      });

    saveBtn.addEventListener('click', async () => {
      markDirty();
      const order = rows.map((r) => r.subject);
      try {
        await Storage.put('meta', { order, updatedAt: Date.now() }, 'subjectOrder');
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Could not save: ${err.message}`;
        return;
      }
      // Everything on screen is now stored, so the "not yet ordered" markers
      // clear — re-derived rather than assumed, so what is drawn is what a
      // reload would draw.
      rows = SubjectOrderCore.merge(order, inUse);
      draw();
      successEl.hidden = false;
      successEl.textContent = order.length === 0
        ? 'Saved — no standing order, so subjects sort alphabetically.'
        : 'Saved.';
    });
  }

  function buildSection(title, renderer) {
    const details = document.createElement('details');
    details.className = 'settings-section';
    const summary = document.createElement('summary');
    summary.textContent = title;
    details.appendChild(summary);
    const body = document.createElement('div');
    details.appendChild(body);
    renderer(body);
    return details;
  }

  // Cloud backup panel — TDS_Slice_D1_Sync_Management_App.md §6/§1.9. The
  // three destructive actions each sit behind their own nested, closed
  // <details> — rarely used and irreversible, so hiding them one level deeper
  // than the token/sync controls above them is a feature, not just declutter.
  function renderSyncPanel(root) {
    root.innerHTML = `
      <p>Your data lives in this browser. With a sync token set, every change is
         also copied to your Cloudflare D1 database automatically, so losing this
         browser no longer means losing your work.</p>
      <p class="sync-status" role="status">Checking…</p>
      <form class="sync-token-form">
        <label>Sync token<input type="password" name="token" autocomplete="off" placeholder="Paste your SYNC_TOKEN"></label>
        <button type="submit">Save token</button>
        <button type="button" class="sync-now">Sync now</button>
      </form>
      <p class="error sync-error" hidden></p>
      <p class="success sync-success" hidden></p>

      <details class="settings-subsection">
        <summary>Restore from cloud</summary>
        <p class="warning">This <strong>replaces everything</strong> in this browser with the
           cloud copy. Your launch PIN is not affected. There is no undo.</p>
        <form class="sync-restore-form">
          <label>Type <code>RESTORE</code> to confirm<input type="text" name="confirm" autocomplete="off"></label>
          <button type="submit">Restore from cloud</button>
        </form>
      </details>

      <details class="settings-subsection">
        <summary>Clear assignments</summary>
        <p class="warning">This <strong>permanently empties</strong> the generated plan — every
           assignment, chore claim, and this device's Propose/Commit history, including which
           activities were already sent — in the cloud database and this browser. Children,
           curriculum, devices, and reward balances are <strong>not</strong> touched. Useful
           while testing the generator or pacing engine, so the same range can be proposed
           again from a clean slate. There is no undo.</p>
        <form class="sync-clear-assignments-form">
          <label>Type <code>CLEAR</code> to confirm<input type="text" name="confirm" autocomplete="off"></label>
          <button type="submit">Clear assignments</button>
        </form>
      </details>

      <details class="settings-subsection">
        <summary>Reset everything</summary>
        <p class="warning">This <strong>permanently empties</strong> the cloud database and this
           browser's local data — every child, curriculum item, assignment, and reward entry.
           Paired child devices will be logged out and need to be re-paired. Your launch PIN
           and this device's sync token are not affected. There is no undo.</p>
        <form class="sync-reset-form">
          <label>Type <code>RESET</code> to confirm<input type="text" name="confirm" autocomplete="off"></label>
          <button type="submit">Reset to empty</button>
        </form>
      </details>
    `;

    const statusEl = root.querySelector('.sync-status');
    const errorEl = root.querySelector('.sync-error');
    const successEl = root.querySelector('.sync-success');
    const tokenForm = root.querySelector('.sync-token-form');
    const restoreForm = root.querySelector('.sync-restore-form');
    const clearAssignmentsForm = root.querySelector('.sync-clear-assignments-form');
    const resetForm = root.querySelector('.sync-reset-form');

    Sync.subscribe((state) => {
      if (!state.enabled) {
        statusEl.textContent = 'Not configured — changes are saved on this device only.';
      } else if (state.lastError) {
        statusEl.textContent = `${state.pending} change(s) waiting. Last attempt failed: ${state.lastError}`;
      } else if (state.inFlight) {
        statusEl.textContent = `Syncing… ${state.pending} change(s) waiting.`;
      } else if (state.pending > 0) {
        statusEl.textContent = `${state.pending} change(s) waiting to upload.`;
      } else {
        const when = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : 'never';
        statusEl.textContent = `Up to date. Last synced: ${when}.`;
      }
    });

    Sync.getConfig().then(({ token }) => {
      if (token) tokenForm.token.placeholder = 'Token saved — paste a new one to replace it';
    });

    tokenForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;
      const token = tokenForm.token.value.trim();
      if (!token) {
        showError(errorEl, 'Paste the SYNC_TOKEN you set on the Worker.');
        return;
      }
      await Sync.setToken(token);
      tokenForm.reset();
      try {
        const remote = await Sync.status();
        successEl.hidden = false;
        successEl.textContent = `Connected. Cloud holds ${remote.count} record(s).`;
      } catch (err) {
        showError(errorEl, `Token saved, but the server rejected it: ${err.message}`);
      }
    });

    root.querySelector('.sync-now').addEventListener('click', () => Sync.drain());

    restoreForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;
      if (restoreForm.confirm.value !== 'RESTORE') {
        showError(errorEl, 'Type RESTORE exactly to confirm.');
        return;
      }
      try {
        const { restored } = await Sync.restoreFromCloud();
        restoreForm.reset();
        successEl.hidden = false;
        successEl.textContent = `Restored ${restored} record(s). Reloading…`;
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        showError(errorEl, `Restore failed, nothing was changed: ${err.message}`);
      }
    });

    clearAssignmentsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;
      if (clearAssignmentsForm.confirm.value !== 'CLEAR') {
        showError(errorEl, 'Type CLEAR exactly to confirm.');
        return;
      }
      try {
        await Sync.clearAssignments();
        clearAssignmentsForm.reset();
        successEl.hidden = false;
        successEl.textContent = 'Assignments cleared. Reloading…';
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        showError(errorEl, `Clear failed: ${err.message}`);
      }
    });

    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;
      if (resetForm.confirm.value !== 'RESET') {
        showError(errorEl, 'Type RESET exactly to confirm.');
        return;
      }
      try {
        await Sync.factoryReset();
        resetForm.reset();
        successEl.hidden = false;
        successEl.textContent = 'Everything reset to empty. Reloading…';
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        showError(errorEl, `Reset failed: ${err.message}`);
      }
    });
  }

  // FR-2 — change PIN, reached via the gated Settings view (#/settings).
  function renderChangePinForm(root) {
    const form = document.createElement('form');
    form.innerHTML = `
      <label>Current PIN<input type="password" inputmode="numeric" name="current" autocomplete="off"></label>
      <label>New PIN (4+ digits)<input type="password" inputmode="numeric" name="pin" autocomplete="off"></label>
      <label>Confirm new PIN<input type="password" inputmode="numeric" name="confirm" autocomplete="off"></label>
      <p class="error" hidden></p>
      <p class="success" hidden></p>
      <button type="submit">Change PIN</button>
    `;
    const errorEl = form.querySelector('.error');
    const successEl = form.querySelector('.success');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;

      const settings = await Storage.get('appSettings', 'appSettings');
      if (form.current.value !== settings.launchPin) {
        showError(errorEl, 'Current PIN is incorrect. No change was made.');
        return;
      }
      if (!isValidPin(form.pin.value)) {
        showError(errorEl, 'New PIN must be at least 4 digits, numeric only.');
        return;
      }
      if (form.pin.value !== form.confirm.value) {
        showError(errorEl, 'New PIN and confirmation do not match.');
        return;
      }

      // Spread, don't replace: appSettings also carries the device-local sync
      // token (TDS_Slice_D1_Sync §4.1), which a whole-record put would wipe.
      await Storage.put('appSettings', { ...settings, launchPin: form.pin.value }, 'appSettings');
      form.reset();
      successEl.hidden = false;
      successEl.textContent = 'PIN changed.';
    });

    root.appendChild(form);
  }

  function showError(errorEl, message) {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  return { renderInitialSetup, renderGate, renderSettingsPage };
})();
