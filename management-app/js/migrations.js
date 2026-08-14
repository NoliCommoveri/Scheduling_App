/* Module: migrations.js — the in-app migration surface.
 * Per TDS_Slice_Online_Revamp.md §3.7.5 (first of two surfaces) and §5.3a.
 *
 * Two things live here: the load-time banner that announces pending schema
 * changes without being asked, and the Settings → Database panel that lists and
 * applies them. Both are one button away from a schema change reaching D1,
 * which is the whole point — Ray has no CLI, so a migration that cannot be
 * applied from a browser cannot be applied at all (§3.7).
 *
 * The OTHER surface, /admin/migrations, is server-rendered by the Worker and is
 * deliberately independent of this file. If a schema change breaks this app's
 * own startup, a migrations UI living inside it is unreachable exactly when it
 * is needed (§3.7.5). Nothing here may become the only way to apply a
 * migration.
 *
 * Authorization is the parent SYNC_TOKEN (§3.7.6), read from sync.js rather
 * than stored a second time. Child device tokens are rejected by the Worker.
 */

const Migrations = (() => {
  // Held so the panel can refresh the banner after applying, and vice versa —
  // otherwise a successful apply leaves a stale "2 pending" bar on screen.
  let bannerEl = null;

  // ---- API (§5.3a) ----

  async function status() {
    return Sync.api('/api/migrations');
  }

  async function apply() {
    // 207 when a migration failed partway; Sync.api treats it as success and
    // hands back the body, which is what carries `failed` (§3.7.4).
    return Sync.api('/api/migrations/apply', { method: 'POST' });
  }

  async function hasToken() {
    const { token } = await Sync.getConfig();
    return Boolean(token);
  }

  function describeFailure(result) {
    return `Applied ${result.applied.length}, then stopped: ${result.failed.name} failed — ` +
      `${result.failed.error} Later migrations were not attempted, and the failed one left ` +
      `nothing behind.`;
  }

  // ---- load-time banner (§3.7.5) ----

  async function mountBanner(el) {
    bannerEl = el;
    await refreshBanner();
  }

  async function refreshBanner() {
    if (!bannerEl) return;
    hideBanner();

    // With no token there is nothing to ask the server with. The Settings panel
    // says so in words; a banner about a check that never ran would be noise.
    if (!(await hasToken())) return;

    let state;
    try {
      state = await status();
    } catch (err) {
      // A banner is the wrong place to report a network blip on a page the
      // operator did not ask to check. Settings → Database shows the error.
      console.warn('[migrations] status check failed:', err);
      return;
    }

    if (state.pending === 0) return;

    const noun = state.pending === 1 ? 'migration' : 'migrations';
    bannerEl.hidden = false;
    bannerEl.innerHTML = `
      <span class="banner-text">${state.pending} ${noun} pending — the database is
        missing a schema change this app expects.</span>
      <button type="button" class="banner-apply">Apply</button>
      <a href="#/settings">Details</a>
    `;

    bannerEl.querySelector('.banner-apply').addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      button.textContent = 'Applying…';
      try {
        const result = await apply();
        if (result.failed) {
          showBannerError(describeFailure(result) + ' See Settings → Database.');
        } else {
          showBannerSuccess(`Applied ${result.applied.length} ${noun}.`);
        }
      } catch (err) {
        showBannerError(`Could not apply: ${err.message} — try /admin/migrations.`);
      }
    });
  }

  function hideBanner() {
    if (!bannerEl) return;
    bannerEl.hidden = true;
    bannerEl.className = '';
    bannerEl.innerHTML = '';
  }

  function showBannerError(message) {
    bannerEl.className = 'banner-error';
    bannerEl.textContent = message;
  }

  function showBannerSuccess(message) {
    bannerEl.className = 'banner-success';
    bannerEl.textContent = message;
    setTimeout(hideBanner, 6000);
  }

  // ---- Settings → Database panel (§3.7.5) ----

  function renderPanel(root) {
    root.innerHTML = `
      <p>Schema changes ship as numbered files and apply from this button. There
         is no console step and no command line — if a task ever seems to need
         one, that is a bug in the task.</p>
      <p class="migrations-status" role="status">Checking…</p>
      <ul class="migrations-list"></ul>
      <button type="button" class="migrations-apply" disabled>Apply pending migrations</button>
      <p class="error migrations-error" hidden></p>
      <p class="success migrations-success" hidden></p>
      <p class="migrations-fallback">If this app ever fails to start, the same
         controls live at <a href="/admin/migrations">/admin/migrations</a>, which
         needs no JavaScript and does not depend on this app loading.</p>
    `;

    const statusEl = root.querySelector('.migrations-status');
    const listEl = root.querySelector('.migrations-list');
    const applyButton = root.querySelector('.migrations-apply');
    const errorEl = root.querySelector('.migrations-error');
    const successEl = root.querySelector('.migrations-success');

    // Deliberately never touches errorEl/successEl: refresh runs immediately
    // after an apply, and clearing them here would wipe the failure report
    // (which names the migration that broke) a moment after showing it. The
    // status line owns refresh's own errors; the message elements belong to
    // the apply action alone.
    async function refresh() {
      if (!(await hasToken())) {
        statusEl.textContent = 'No sync token on this device — save one above, or use /admin/migrations.';
        listEl.innerHTML = '';
        applyButton.disabled = true;
        return;
      }

      let state;
      try {
        state = await status();
      } catch (err) {
        statusEl.textContent = `Could not reach the server: ${err.message}`;
        listEl.innerHTML = '';
        applyButton.disabled = true;
        return;
      }

      statusEl.textContent = state.pending === 0
        ? `Up to date — ${state.migrations.length} migration(s) applied.`
        : `${state.pending} pending of ${state.migrations.length} total.`;

      listEl.innerHTML = state.migrations
        .map((m) => `
          <li>
            <span class="migration-name">${escapeHtml(m.name)}</span>
            <span class="migration-state">${m.applied ? 'applied' : 'pending'}</span>
          </li>
        `)
        .join('');

      applyButton.disabled = state.pending === 0;
    }

    applyButton.addEventListener('click', async () => {
      errorEl.hidden = true;
      successEl.hidden = true;
      applyButton.disabled = true;

      try {
        const result = await apply();
        if (result.failed) {
          showError(errorEl, describeFailure(result));
        } else if (result.applied.length === 0) {
          successEl.hidden = false;
          successEl.textContent = 'No pending migrations. Nothing was written.';
        } else {
          successEl.hidden = false;
          successEl.textContent = `Applied: ${result.applied.join(', ')}`;
        }
      } catch (err) {
        showError(errorEl, `Apply failed: ${err.message}`);
      }

      await refresh();
      await refreshBanner();
    });

    refresh();
  }

  function showError(errorEl, message) {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  return { status, apply, mountBanner, renderPanel };
})();
