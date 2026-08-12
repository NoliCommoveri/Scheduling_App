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
    renderChangePinForm(root);

    const syncSection = document.createElement('section');
    root.appendChild(syncSection);
    renderSyncPanel(syncSection);

    // Settings → Database, the everyday migration surface (Revamp §3.7.5).
    // Placed after the sync panel because it reuses that panel's token.
    const migrationsSection = document.createElement('section');
    root.appendChild(migrationsSection);
    Migrations.renderPanel(migrationsSection);

    const devicesSection = document.createElement('section');
    root.appendChild(devicesSection);
    Devices.render(devicesSection);
  }

  // Cloud backup panel — TDS_Slice_D1_Sync_Management_App.md §6/§1.9.
  function renderSyncPanel(root) {
    root.innerHTML = `
      <h2>Cloud backup (Cloudflare D1)</h2>
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

      <h3>Restore from cloud</h3>
      <p class="warning">This <strong>replaces everything</strong> in this browser with the
         cloud copy. Your launch PIN is not affected. There is no undo.</p>
      <form class="sync-restore-form">
        <label>Type <code>RESTORE</code> to confirm<input type="text" name="confirm" autocomplete="off"></label>
        <button type="submit">Restore from cloud</button>
      </form>

      <h3>Reset everything</h3>
      <p class="warning">This <strong>permanently empties</strong> the cloud database and this
         browser's local data — every child, curriculum item, assignment, and reward entry.
         Paired child devices will be logged out and need to be re-paired. Your launch PIN
         and this device's sync token are not affected. There is no undo.</p>
      <form class="sync-reset-form">
        <label>Type <code>RESET</code> to confirm<input type="text" name="confirm" autocomplete="off"></label>
        <button type="submit">Reset to empty</button>
      </form>
    `;

    const statusEl = root.querySelector('.sync-status');
    const errorEl = root.querySelector('.sync-error');
    const successEl = root.querySelector('.sync-success');
    const tokenForm = root.querySelector('.sync-token-form');
    const restoreForm = root.querySelector('.sync-restore-form');
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
      <h1>Settings</h1>
      <h2>Change launch PIN</h2>
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
