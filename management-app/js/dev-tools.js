/* Module: dev-tools.js — NOT part of any spec'd module (no SRS/TDS FR owns
 * this). A testing convenience: clears one IndexedDB store at a time so a
 * build session can exercise seed/empty-state behavior repeatedly without
 * deleting the whole database. Safe to delete this file entirely with no
 * effect on any product module. */

const DevTools = (() => {
  function render(container) {
    const heading = document.createElement('h2');
    heading.textContent = 'Developer Tools';
    container.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'warning';
    note.textContent =
      'Testing only — not part of the app spec. Each button clears every record in that one ' +
      'IndexedDB store immediately. There is no undo.';
    container.appendChild(note);

    const list = document.createElement('ul');
    list.className = 'dev-tools-list';

    Storage.STORE_NAMES.forEach((storeName) => {
      const item = document.createElement('li');
      item.innerHTML = `
        <span class="store-name">${storeName}</span>
        <button data-store="${storeName}">Clear</button>
      `;
      item.querySelector('button').addEventListener('click', async () => {
        const confirmed = window.confirm(`Clear all records in "${storeName}"? This cannot be undone.`);
        if (!confirmed) return;
        await Storage.clearStore(storeName);
        // Reload so every view (and the launchPin gate, if appSettings was
        // the store cleared) re-reads from the now-cleared store.
        window.location.reload();
      });
      list.appendChild(item);
    });

    container.appendChild(list);
  }

  return { render };
})();
