/* Module: app.js — launchPin gate (Module 11 FR-1/FR-2) + hash router.
 * Per TDS_Slice_M4_Management_App_Rev3.md §3.
 * Gate runs before the router; no view renders and no store other than
 * appSettings is read until it resolves. */

const App = (() => {
  const root = document.getElementById('app-root');
  const nav = document.getElementById('app-nav');

  // In-memory only (Q8) — never written to sessionStorage, localStorage, or
  // IndexedDB. Reload, new tab, or reopened browser re-prompts.
  let unlocked = false;

  const ROUTES = {
    '#/curriculum': () => Curriculum.render(root),
    '#/tiers': () => Tiers.render(root),
    '#/activity-types': () => ActivityTypes.render(root),
    '#/courses': () => Courses.render(root),
    '#/children': () => Children.render(root),
    '#/chores': () => Chores.render(root),
    '#/events': () => Events.render(root),
    '#/settings': () => Settings.renderSettingsPage(root),
  };

  function startRouter() {
    window.addEventListener('hashchange', renderRoute);
    renderRoute();
  }

  function renderRoute() {
    if (!unlocked) return; // router is only reachable after the gate resolves
    const view = ROUTES[window.location.hash] || ROUTES['#/curriculum'];
    view();
  }

  function navigate(hash) {
    if (window.location.hash === hash) renderRoute();
    else window.location.hash = hash;
  }

  async function boot() {
    await Storage.openDB(); // creates + seeds on first ever run
    const settings = await Storage.get('appSettings', 'appSettings');

    if (!settings) {
      Settings.renderInitialSetup(root, onUnlocked);
      return;
    }

    Settings.renderGate(root, settings.launchPin, onUnlocked);
  }

  function onUnlocked() {
    unlocked = true;
    nav.hidden = false;
    nav.innerHTML = `
      <a href="#/curriculum">Curriculum</a>
      <a href="#/tiers">Tiers</a>
      <a href="#/activity-types">Activity Types</a>
      <a href="#/courses">Courses</a>
      <a href="#/children">Children</a>
      <a href="#/chores">Chores</a>
      <a href="#/events">Events</a>
      <a href="#/settings">Settings</a>
    `;
    startRouter();
  }

  return { boot, navigate };
})();

document.addEventListener('DOMContentLoaded', () => App.boot());
