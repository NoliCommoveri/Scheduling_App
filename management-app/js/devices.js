/* Module: devices.js — Pairing + Devices UI.
 * Per TDS_Slice_Online_Revamp.md §4.3 (pairing flow) and §5.3 (parent routes).
 * Online Revamp Phase 2 (§12): the Worker routes already exist from Phase 1
 * (§5.3a); this is the client. Renders inside Settings (settings.js), reusing
 * the same SYNC_TOKEN the Cloud backup panel above it already collects, via
 * Sync.api().
 */

const Devices = (() => {
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(ms) {
    return ms ? new Date(ms).toLocaleString() : '—';
  }

  async function render(root) {
    root.innerHTML = `
      <p>Pair a child's device so it can fetch its plan and record completions
         directly, instead of importing files.</p>
      <p class="devices-status" role="status">Loading…</p>
    `;
    const statusEl = root.querySelector('.devices-status');

    const { token } = await Sync.getConfig();
    if (!token) {
      statusEl.textContent = 'Set your sync token above first — pairing uses the same credential.';
      return;
    }

    let children, devicesResult;
    try {
      [children, devicesResult] = await Promise.all([
        Storage.getAll('children'),
        Sync.api('/api/devices'),
      ]);
    } catch (err) {
      statusEl.textContent = `Could not load devices: ${err.message}`;
      return;
    }
    statusEl.remove();

    const childById = new Map(children.map((c) => [c.id, c]));

    // The device list gets every child, so a device already paired to an
    // archived one still shows a name instead of a raw id. The pair form gets
    // active children only — archiving a child should stop new devices being
    // handed out for them, while leaving the ones they have (revoke is the
    // separate, deliberate act for those).
    renderDeviceList(root, devicesResult.devices, childById);
    renderPairForm(root, Children.activeOnly(children));
    renderWallPairForm(root);
  }

  // A wall device's child_id is the WALL_SENTINEL_CHILD_ID empty string
  // (worker/index.js §8.1) — never a real child id, since ids are
  // server-minted UUIDs. That sentinel is what tells a wall row apart from a
  // child row here, with no need to thread `scope` through this list.
  function isWallDevice(d) {
    return d.child_id === '';
  }

  function renderDeviceList(root, devices, childById) {
    const heading = document.createElement('h3');
    heading.textContent = 'Paired devices';
    root.appendChild(heading);

    if (devices.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No devices paired yet.';
      root.appendChild(p);
      return;
    }

    const active = devices.filter((d) => !d.revoked_at);
    const revoked = devices.filter((d) => d.revoked_at);

    if (active.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No active devices.';
      root.appendChild(p);
    } else {
      root.appendChild(buildDeviceListEl(active, childById, root));
    }

    if (revoked.length > 0) {
      const details = document.createElement('details');
      details.className = 'device-list-revoked';
      const summary = document.createElement('summary');
      summary.textContent = `Revoked devices (${revoked.length})`;
      details.appendChild(summary);
      details.appendChild(buildDeviceListEl(revoked, childById, root));
      root.appendChild(details);
    }
  }

  function buildDeviceListEl(devices, childById, root) {
    const list = document.createElement('ul');
    list.className = 'device-list';
    for (const d of devices) {
      const child = childById.get(d.child_id);
      const item = document.createElement('li');
      const childLabel = isWallDevice(d)
        ? 'Wall display (household)'
        : escapeHtml(child ? child.name : d.child_id);
      item.innerHTML = `
        <span class="device-child">${childLabel}</span>
        <span class="device-label">${escapeHtml(d.label || '(unlabeled)')}</span>
        <span class="device-seen">last seen: ${formatTime(d.last_seen_at)}</span>
        ${
          d.revoked_at
            ? `<span class="device-revoked">revoked ${formatTime(d.revoked_at)}</span>`
            : `<button data-action="revoke">Revoke</button>`
        }
      `;
      const revokeBtn = item.querySelector('[data-action="revoke"]');
      if (revokeBtn) {
        revokeBtn.addEventListener('click', async () => {
          const warned = window.confirm(
            `Revoke "${d.label || 'this device'}"? It loses access immediately and will need to be re-paired.`
          );
          if (!warned) return;
          await Sync.api(`/api/devices/${d.id}/revoke`, { method: 'POST' });
          render(root);
        });
      }
      list.appendChild(item);
    }
    return list;
  }

  function renderPairForm(root, children) {
    const heading = document.createElement('h3');
    heading.textContent = 'Pair a device';
    root.appendChild(heading);

    if (children.length === 0) {
      const p = document.createElement('p');
      // The caller has already filtered to active children, so an empty list
      // here means either none exist or they are all archived. Saying "add a
      // child" to someone who has three archived ones sends them the wrong way.
      p.textContent = 'No active children. Add one, or restore an archived child from the Children page.';
      root.appendChild(p);
      return;
    }

    const childOptions = children.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    const form = document.createElement('form');
    form.innerHTML = `
      <label>Child<select name="childId">${childOptions}</select></label>
      <p class="error" hidden></p>
      <p class="code-result" hidden></p>
      <button type="submit">Generate pairing code</button>
    `;
    const errorEl = form.querySelector('.error');
    const resultEl = form.querySelector('.code-result');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      try {
        const { code, expiresAt } = await Sync.api('/api/devices/pair-code', {
          method: 'POST',
          body: { childId: form.childId.value },
        });
        resultEl.hidden = false;
        resultEl.innerHTML =
          `Code: <strong>${escapeHtml(code)}</strong> — enter it in the Child App within 15 minutes ` +
          `(expires ${formatTime(expiresAt)}).`;
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    });

    root.appendChild(form);
  }

  // TDS_Slice_Wall_Display_App.md §3.2 — the wall is paired once, as a
  // device, not per child. `/api/devices/pair-code` already accepts
  // `{ scope: 'wall' }` (worker/index.js `handlePairCodeMint`); this is the
  // form for it. No child selector: the code names no child, and the wall
  // reads every active one straight from D1 once it redeems the code.
  function renderWallPairForm(root) {
    const heading = document.createElement('h3');
    heading.textContent = 'Pair the wall display';
    root.appendChild(heading);

    const p = document.createElement('p');
    p.textContent = 'One code pairs the whole display — every active child appears on it automatically, with nothing to pair per child.';
    root.appendChild(p);

    const form = document.createElement('form');
    form.innerHTML = `
      <p class="error" hidden></p>
      <p class="code-result" hidden></p>
      <button type="submit">Pair wall display</button>
    `;
    const errorEl = form.querySelector('.error');
    const resultEl = form.querySelector('.code-result');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      try {
        const { code, expiresAt } = await Sync.api('/api/devices/pair-code', {
          method: 'POST',
          body: { scope: 'wall' },
        });
        resultEl.hidden = false;
        resultEl.innerHTML =
          `Code: <strong>${escapeHtml(code)}</strong> — enter it in the wall display's setup wizard within 15 minutes ` +
          `(expires ${formatTime(expiresAt)}).`;
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    });

    root.appendChild(form);
  }

  return { render };
})();
