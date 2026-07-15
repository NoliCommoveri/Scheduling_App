/* Module: tiers.js — Module 02, Difficulty Tier & Reward Category.
 * Per TDS_Slice_M4_Management_App_Rev3.md §1/§2/§4. */

const Tiers = (() => {
  function pad2(n) {
    return String(n).padStart(2, '0'); // minimum width 2, not a ceiling (TDS §1)
  }

  async function listSorted() {
    const tiers = await Storage.getAll('tiers');
    return tiers.sort((a, b) => a.order - b.order);
  }

  // Mints a tier + its paired category from the one shared, persisted
  // counter, in a single transaction (tiers + rewardCategories + meta) —
  // never derived from existing rows (max()+1 reuses numbers after a
  // delete, which is wrong — TDS §1).
  async function createTier(label) {
    const existing = await listSorted();
    const order = existing.length;
    let tierId, categoryId;

    await Storage.runTransaction(['tiers', 'rewardCategories', 'meta'], 'readwrite', (t) => {
      const metaStore = t.objectStore('meta');
      const getReq = metaStore.get('idCounters');
      getReq.onsuccess = () => {
        const seq = getReq.result.nextSeq;
        tierId = 'D' + pad2(seq);
        categoryId = 'R' + pad2(seq);
        t.objectStore('tiers').put({ tierId, label, order, rewardCategoryId: categoryId });
        t.objectStore('rewardCategories').put({ categoryId, internalLabel: label });
        metaStore.put({ nextSeq: seq + 1 }, 'idCounters');
      };
    });

    return { tierId, categoryId };
  }

  // FR-3 — label is display text only; rewardCategoryId, tierId untouched.
  async function renameTier(tierId, newLabel) {
    const tier = await Storage.get('tiers', tierId);
    await Storage.put('tiers', { ...tier, label: newLabel });
  }

  // FR-4 — move-up/move-down swaps two adjacent tiers' order values only.
  async function moveTier(tierId, direction) {
    const sorted = await listSorted();
    const idx = sorted.findIndex((t) => t.tierId === tierId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;

    const a = sorted[idx];
    const b = sorted[swapIdx];
    await Storage.runTransaction(['tiers'], 'readwrite', (t) => {
      const store = t.objectStore('tiers');
      store.put({ ...a, order: b.order });
      store.put({ ...b, order: a.order });
    });
  }

  // FR-7 — reference-guarded against Activity/Chore only (§2.2 — Reward
  // Ledger data is never checked; the Management App structurally cannot
  // see it). At M4 both stores are always empty, so this always passes —
  // real code now so M5/M6 don't inherit a stub.
  async function deleteGuardSummary(tierId) {
    const [activities, chores] = await Promise.all([
      Storage.getAll('activities'),
      Storage.getAll('chores'),
    ]);
    const activityCount = activities.filter((a) => a.difficultyTier === tierId).length;
    const choreCount = chores.filter((c) => c.difficultyTier === tierId).length;
    if (activityCount === 0 && choreCount === 0) return null;
    return `Used by ${activityCount} Activities, ${choreCount} Chores`;
  }

  // On success, deletes the paired Reward Category too (AC-6). Counter is
  // never rolled back — nextSeq only ever advances.
  async function deleteTier(tierId) {
    const blockMessage = await deleteGuardSummary(tierId);
    if (blockMessage) return { blocked: true, message: blockMessage };

    const tier = await Storage.get('tiers', tierId);
    await Storage.runTransaction(['tiers', 'rewardCategories'], 'readwrite', (t) => {
      t.objectStore('tiers').delete(tierId);
      t.objectStore('rewardCategories').delete(tier.rewardCategoryId);
    });
    await recompactOrder();
    return { blocked: false };
  }

  // Keeps `order` contiguous from 0 after a delete (TDS §1). Never touches
  // tierId, label, or rewardCategoryId.
  async function recompactOrder() {
    const sorted = await listSorted();
    await Storage.runTransaction(['tiers'], 'readwrite', (t) => {
      const store = t.objectStore('tiers');
      sorted.forEach((tier, index) => {
        if (tier.order !== index) store.put({ ...tier, order: index });
      });
    });
  }

  async function render(root) {
    root.innerHTML = '';
    const tiers = await listSorted();

    const heading = document.createElement('h1');
    heading.textContent = 'Difficulty Tiers';
    root.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'tier-list';

    tiers.forEach((tier, index) => {
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="tier-label">${escapeHtml(tier.label)}</span>
        <span class="tier-id">${tier.tierId} / ${tier.rewardCategoryId}</span>
        <button data-action="up" ${index === 0 ? 'disabled' : ''}>&uarr;</button>
        <button data-action="down" ${index === tiers.length - 1 ? 'disabled' : ''}>&darr;</button>
        <button data-action="rename">Rename</button>
        <button data-action="delete">Delete</button>
        <span class="tier-error" hidden></span>
      `;

      item.querySelector('[data-action="up"]').addEventListener('click', async () => {
        await moveTier(tier.tierId, 'up');
        render(root);
      });
      item.querySelector('[data-action="down"]').addEventListener('click', async () => {
        await moveTier(tier.tierId, 'down');
        render(root);
      });
      item.querySelector('[data-action="rename"]').addEventListener('click', async () => {
        const newLabel = window.prompt('New label:', tier.label);
        if (newLabel && newLabel.trim()) {
          await renameTier(tier.tierId, newLabel.trim());
          render(root);
        }
      });
      item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const result = await deleteTier(tier.tierId);
        if (result.blocked) {
          const errEl = item.querySelector('.tier-error');
          errEl.hidden = false;
          errEl.textContent = result.message;
        } else {
          render(root);
        }
      });

      list.appendChild(item);
    });

    root.appendChild(list);

    const form = document.createElement('form');
    form.innerHTML = `
      <label>New tier label<input type="text" name="label" required></label>
      <button type="submit">Add tier</button>
    `;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const label = form.label.value.trim();
      if (!label) return;
      await createTier(label);
      render(root);
    });
    root.appendChild(form);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { render, createTier, renameTier, moveTier, deleteTier, listSorted };
})();
