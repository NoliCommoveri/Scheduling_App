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
    '#/expander': () => Expander.render(root),
    '#/children': () => Children.render(root),
    '#/assigned-courses': () => Instances.render(root),
    '#/chores': () => Chores.render(root),
    '#/events': () => Events.render(root),
    '#/packet': () => Packet.render(root),
    '#/assignments': () => Assignments.render(root),
    '#/grading': () => GradingReview.render(root),
    '#/reporting': () => Reporting.render(root),
    '#/remediation': () => Remediation.render(root),
    '#/settings': () => Settings.renderSettingsPage(root),
  };

  // Landing page, and the fallback for a hash that names no route — including
  // the retired #/pacing and #/weekly, which someone may still have
  // bookmarked. Deliberately not Curriculum, which held this job while the nav
  // was alphabetical-ish and is the page you need least often once a year's
  // sources are entered.
  const DEFAULT_HASH = '#/assigned-courses';

  // ---- Nav hubs ----
  //
  // Twelve flat links in one wrapping row was a list of modules, not of
  // workflows, and it made every page equally far away — which in practice
  // meant the Course Template Library (rarely wanted mid-term) was as easy to
  // reach as the assigned Course you actually meant to edit. The hubs below
  // group by how often a page is touched and what it is touched for. The split
  // that does the work is Library vs. Workload: templates are what you author,
  // assigned Courses are what you adjust, and they now live under different
  // hubs so the wrong one is no longer the easier one to reach.
  const HUBS = [
    {
      id: 'workload',
      label: 'Workload',
      links: [
        ['#/assigned-courses', 'Assigned Courses'],
        ['#/chores', 'Chores'],
        ['#/events', 'Events'],
      ],
    },
    {
      id: 'library',
      label: 'Library',
      links: [
        ['#/courses', 'Course Templates'],
        ['#/expander', 'Expander'],
        ['#/curriculum', 'Curriculum'],
        ['#/activity-types', 'Activity Types'],
        ['#/tiers', 'Tiers'],
      ],
    },
    {
      id: 'assign',
      label: 'Assign & Review',
      links: [
        ['#/packet', 'Generate'],
        ['#/assignments', 'Assignments'],
        ['#/grading', 'Grading'],
        ['#/reporting', 'Reporting'],
        ['#/remediation', 'Remediation'],
      ],
    },
    {
      id: 'household',
      label: 'Household',
      links: [
        ['#/children', 'Children'],
        ['#/settings', 'Settings'],
      ],
    },
  ];

  // Which hub's links are showing in the second row. `null` means "follow the
  // route" — the row shows the hub owning the current page, which is the
  // useful default: the links next to the one you are on are the ones you are
  // most likely to want next. A click on a hub button overrides it until the
  // next navigation, so a hub can be browsed without leaving the page.
  let openHubId = null;

  function hubForHash(hash) {
    return HUBS.find((h) => h.links.some(([href]) => href === hash)) || HUBS[0];
  }

  function renderNav() {
    const hash = ROUTES[window.location.hash] ? window.location.hash : DEFAULT_HASH;
    const activeHub = hubForHash(hash);
    const shownHub = (openHubId && HUBS.find((h) => h.id === openHubId)) || activeHub;

    nav.innerHTML = '';

    const hubRow = document.createElement('div');
    hubRow.className = 'nav-hubs';
    for (const hub of HUBS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-hub';
      btn.textContent = hub.label;
      // aria-expanded on the button that controls the row, and the row's id
      // on aria-controls, so a screen reader gets the same "this opened that"
      // the highlight gives everyone else.
      btn.setAttribute('aria-expanded', String(hub.id === shownHub.id));
      btn.setAttribute('aria-controls', 'nav-sub');
      if (hub.id === activeHub.id) btn.classList.add('is-active');
      if (hub.id === shownHub.id) btn.classList.add('is-open');
      btn.addEventListener('click', () => {
        openHubId = hub.id;
        renderNav();
      });
      hubRow.appendChild(btn);
    }
    nav.appendChild(hubRow);

    const subRow = document.createElement('div');
    subRow.className = 'nav-sub';
    subRow.id = 'nav-sub';
    for (const [href, label] of shownHub.links) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      if (href === hash) {
        a.classList.add('is-current');
        a.setAttribute('aria-current', 'page');
      }
      subRow.appendChild(a);
    }
    nav.appendChild(subRow);
  }

  function startRouter() {
    window.addEventListener('hashchange', renderRoute);
    renderRoute();
  }

  function renderRoute() {
    if (!unlocked) return; // router is only reachable after the gate resolves
    // A navigation releases any hub the user opened by hand, so the second row
    // goes back to showing the hub of the page now on screen.
    openHubId = null;
    renderNav();
    const view = ROUTES[window.location.hash] || ROUTES[DEFAULT_HASH];
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
    startRouter(); // renderRoute() builds the nav; it depends on the current hash

    // Starts the D1 mirror drain (TDS_Slice_D1_Sync §6). Deliberately after
    // the gate, and deliberately not awaited — no view waits on the network.
    Sync.init().catch((err) => console.warn('[sync] init failed:', err));

    // Pending-migration check (Revamp §3.7.5): announces a schema change
    // without being asked. Same placement and same reasoning as Sync.init —
    // after the gate, never awaited.
    Migrations.mountBanner(document.getElementById('app-banner'))
      .catch((err) => console.warn('[migrations] banner failed:', err));
  }

  return { boot, navigate };
})();

document.addEventListener('DOMContentLoaded', () => App.boot());
