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

  // Settings view (#/settings): FR-2 change-PIN form, plus the dev-only
  // clear-a-store tool (not part of any spec'd FR — see dev-tools.js).
  function renderSettingsPage(root) {
    clear(root);
    renderChangePinForm(root);

    const devToolsSection = document.createElement('section');
    root.appendChild(devToolsSection);
    DevTools.render(devToolsSection);
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

      await Storage.put('appSettings', { launchPin: form.pin.value }, 'appSettings');
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
