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
      <h2>Devices</h2>
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

    renderDeviceList(root, devicesResult.devices, childById);
    renderPairForm(root, children);
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

    const list = document.createElement('ul');
    list.className = 'device-list';
    for (const d of devices) {
      const child = childById.get(d.child_id);
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="device-child">${escapeHtml(child ? child.name : d.child_id)}</span>
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
    root.appendChild(list);
  }

  function renderPairForm(root, children) {
    const heading = document.createElement('h3');
    heading.textContent = 'Pair a device';
    root.appendChild(heading);

    if (children.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'Add a child first.';
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

  return { render };
})();
