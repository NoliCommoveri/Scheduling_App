// planner-ui.js — the Daily Planner's rendering and interactions (SRS Module 3).
// Presentation and light organization only: it reads the assignment rows
// DB.loadState() hands back, and writes just two child-owned columns
// (child_sort_order, child_block_hint) straight onto the cached row via
// DB.setAssignmentFields (§14 — plannerMeta folded into the columns). The plan
// itself is derived here each render and never persisted.
//
// Online Revamp §14, shim collapse — **phase 2 was this file's render side.**
// It used to render by the pre-revamp field names — `courseName`,
// `sequenceNumber`, `activityType` and a `payload` that assignment-core had
// quietly replaced with a parsed object — which was the only reason those
// names were minted at all. It now renders from the §3.3 columns themselves:
// `course_name`, `sequence_no`, `activity_type`.
//
// The camelCase names that remain here are not columns and are not aliases:
// `choreType`, `lessonTitle`, `capturesGrade`, `required`, `notes`, `time` and
// an event's `startDate`/`endDate` come out of the row's `payload`, where the
// Management App writes what §3.3 gives no column, and `content` is that
// payload's kind-specific descriptor. Phase 3 (§14) dropped the
// `activities`/`chores`/`events` stores and the four legacy `loadState()` keys;
// folding `plannerMeta` into `child_block_hint`/`child_sort_order` — split out
// of that collapse as its own write-path item — is also done: setOverride
// below writes the column directly rather than a separate store's vocabulary.

(function (g) {
  "use strict";

  var P = g.PlannerCore;
  var BLOCKS = P.CANON_BLOCKS;
  var VIEWS = [
    { id: "today", label: "Today" },
    { id: "school", label: "School" },
    { id: "chores", label: "Chores" },
    { id: "events", label: "Events" },
    { id: "subjects", label: "Subjects" },
    { id: "rewards", label: "Rewards" }
  ];

  // --- tiny DOM helpers (content set via textContent — never innerHTML for data) ---
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgGlyph(block) {
    // simple line glyphs: rising sun / high sun / low sun / moon
    var paths = {
      morning: '<circle cx="12" cy="14" r="4"/><path d="M12 4v2M4 14H2M22 14h-2M6 8 5 7M18 8l1-1M2 18h20"/>',
      afternoon: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
      evening: '<circle cx="12" cy="15" r="4"/><path d="M2 19h20M12 6v1M5 11 4 10M20 10l-1 1"/>',
      night: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (paths[block] || paths.morning) + '</svg>';
  }

  function mount(root, ctx) {
    var state = {
      view: "today",
      // Preview date defaults to the real device-local date. It exists so a plan
      // for a future/other date can be inspected (and so the 2026-07-12 acceptance
      // layout is verifiable). All date logic reads this as "today".
      today: g.DateUtil.localISODate(new Date()),
      isResolved: function () { return false; },
      reminderInfo: { show: false },
      upload: { pending: 0, error: null },
      // SRS Module 8 FR-7: dismissed only for this session — reappears on the
      // next app open as long as the condition still holds.
      reminderDismissed: false
    };

    function reload() {
      return Promise.all([g.DB.loadState(), g.DB.getAll("activityRecords"), g.Export.reminderState(), g.Reward.gatherDisplay(), g.PlanSync.status(), g.Outbox.status()]).then(function (r) {
        state.data = r[0];
        state.records = r[1]; // activityRecords — drives the daily completion visual
        var resolved = Object.create(null);
        r[1].forEach(function (rec) { resolved[rec.activityId] = true; });
        state.isResolved = function (id) { return !!resolved[id]; };
        state.reminderInfo = r[2];
        state.rewards = r[3];
        state.sync = r[4]; // Online Revamp §8.3 — link state, for the empty state and Settings
        state.upload = r[5]; // Online Revamp §8.4 — how much is still queued to go up
        render();
      });
    }

    // The child's own block and order overrides (§3.3.3's child_block_hint /
    // child_sort_order). Written locally first, then queued — the local write
    // is what the next render reads, and the queue is what a parent's
    // Reporting view eventually sees. `patch` is keyed by column name, the
    // same vocabulary DB.setAssignmentFields writes and OutboxCore translates
    // for the wire.
    function setOverride(id, patch) {
      return g.DB.setAssignmentFields(id, patch)
        .then(function () { return g.Outbox.enqueueMeta(id, patch); })
        .then(reload);
    }

    function render() {
      root.innerHTML = "";
      var app = node("div", "app");
      app.appendChild(appbar());
      app.appendChild(viewBody());
      root.appendChild(app);
    }

    // ---------- app bar ----------
    // Everything that used to stack settings-style buttons across the top —
    // Theme (Module 10), Settings (Module 11), Export (Module 8), Wipe
    // (Module 9), dev reset — now lives behind one menu.
    // These are weekly/per-semester/one-off actions; the daily view stays
    // just greeting + tabs + today's plan (Ray, 2026-07-13).
    function appbar() {
      var bar = node("div", "appbar");
      var row = node("div", "appbar-row");
      var left = node("div");
      left.appendChild(node("h1", "greeting", greetingText()));
      left.appendChild(node("div", "semester", ctx.semester ? ctx.semester : ""));
      row.appendChild(left);

      var menuBtn = node("button", "menu-btn", "⋯");
      menuBtn.setAttribute("aria-label", "Menu — theme, import, export, settings");
      menuBtn.setAttribute("aria-haspopup", "menu");
      menuBtn.onclick = openMenu;
      row.appendChild(menuBtn);
      bar.appendChild(row);

      var tabs = node("div", "tabs");
      VIEWS.forEach(function (v) {
        var t = node("button", "tab", v.label);
        t.setAttribute("role", "tab");
        t.setAttribute("aria-selected", state.view === v.id ? "true" : "false");
        t.onclick = function () { state.view = v.id; render(); };
        tabs.appendChild(t);
      });
      bar.appendChild(tabs);

      if (state.reminderInfo.show && !state.reminderDismissed) {
        var reminder = node("div", "reminder-banner");
        reminder.appendChild(node("span", null, "It's been a week or more since your last export — " + state.reminderInfo.eligibleCount + " item" + (state.reminderInfo.eligibleCount === 1 ? "" : "s") + " ready to send."));
        var reminderActions = node("div", "reminder-actions");
        var exportNowBtn = node("button", "btn small", "Export now");
        exportNowBtn.onclick = doExport;
        var dismissBtn = node("button", "btn ghost small", "Dismiss");
        dismissBtn.onclick = function () { state.reminderDismissed = true; render(); };
        reminderActions.appendChild(exportNowBtn);
        reminderActions.appendChild(dismissBtn);
        reminder.appendChild(reminderActions);
        bar.appendChild(reminder);
      }

      return bar;
    }

    // ---------- menu sheet (all the tucked-away, non-daily actions) ----------
    function openMenu() {
      var overlay = node("div", "modal-overlay menu-overlay");
      overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
      var sheet = node("div", "menu-sheet");
      sheet.appendChild(node("div", "menu-title", "Menu"));

      var list = node("div", "menu-list");
      function addItem(icon, label, fn, cls) {
        var b = node("button", "menu-item" + (cls ? " " + cls : ""));
        b.appendChild(node("span", "menu-ico", icon));
        b.appendChild(node("span", "menu-label", label));
        b.onclick = function () { overlay.remove(); fn(); };
        list.appendChild(b);
      }

      addItem("🎨", "Change theme", openThemeDialog);
      addItem("📤", "Export completions", doExport);
      addItem("🧹", "Wipe sent work", doWipe);
      addItem("⚙️", "Settings", openSettingsGate);
      addItem("📅", "Preview another day", openPreviewDate);
      sheet.appendChild(list);

      // DEV-ONLY reset — not the spec'd Module 9 Wipe (that's a future, child-
      // facing, resolved+exported-only clear paired with CSV Export). This
      // wipes everything, including Child/Semester/Theme, for local testing.
      var devList = node("div", "menu-list menu-list-dev");
      var devBtn = node("button", "menu-item danger");
      devBtn.appendChild(node("span", "menu-ico", "⚠"));
      devBtn.appendChild(node("span", "menu-label", "Reset app (dev)"));
      devBtn.onclick = function () {
        overlay.remove();
        if (!window.confirm("DEV RESET: delete ALL local data (child, semester, theme, packets, planner overrides) and reload? This cannot be undone.")) return;
        g.DB.devWipeAll().then(function () {
          window.location.reload();
        }).catch(function (e) {
          toast("Reset failed: " + e.message, true);
        });
      };
      devList.appendChild(devBtn);
      sheet.appendChild(devList);

      var close = node("button", "btn ghost block", "Close");
      close.onclick = function () { overlay.remove(); };
      sheet.appendChild(close);

      overlay.appendChild(sheet);
      document.body.appendChild(overlay);
    }

    // Preview date is a testing affordance (inspect a future/other day's plan);
    // moved off the daily chrome into the menu so it no longer clutters the top.
    function openPreviewDate() {
      var overlay = node("div", "modal-overlay");
      var card = node("div", "modal-card");
      card.appendChild(node("h2", "modal-title", "Preview another day"));
      card.appendChild(node("p", "modal-help", "See the plan for a different date. This only changes what you're looking at — it doesn't move any work."));
      var dateInput = node("input", "modal-input");
      dateInput.type = "date"; dateInput.value = state.today;
      card.appendChild(dateInput);
      var actions = node("div", "modal-actions");
      var reset = node("button", "btn ghost", "Back to today");
      reset.onclick = function () { overlay.remove(); state.today = g.DateUtil.localISODate(new Date()); render(); };
      var go = node("button", "btn", "Show it");
      go.onclick = function () { if (dateInput.value) { state.today = dateInput.value; } overlay.remove(); render(); };
      actions.appendChild(reset); actions.appendChild(go);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
    }

    function greetingText() {
      var h = new Date().getHours();
      var part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
      return ctx.name ? part + ", " + ctx.name : part;
    }

    // ---------- signature home hero + daily completion visual (Module 10) ----------
    function timePart() {
      var h = new Date().getHours();
      return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
    }
    function fillTemplate(str, map) {
      return String(str).replace(/\{(\w+)\}/g, function (m, k) { return (k in map) ? map[k] : m; });
    }
    function activeTheme() {
      return (state.rewards && state.rewards.theme) || g.ThemeCore.getTheme(null);
    }
    function homeCopy() {
      var c = activeTheme().copy;
      return (c && c.home) || g.ThemeCore.getTheme(null).copy.home;
    }
    // done today / still-to-do today / total — the completion status the hero shows.
    function todayCounts() {
      var d = state.data;
      var t = P.assembleToday(d.rows, state.today, state.isResolved);
      var remaining = 0;
      t.blocks.forEach(function (b) { remaining += b.school.length + b.chores.length; });
      var done = (state.records || []).filter(function (r) {
        return r.status === "complete" && r.date === state.today;
      }).length;
      return { done: done, remaining: remaining, total: done + remaining };
    }
    function earnedTotal() {
      if (!state.rewards || !state.rewards.categories) return 0;
      return state.rewards.categories.reduce(function (s, c) { return s + c.balance; }, 0);
    }

    function heroStat(big, label) {
      var s = node("div", "hero-stat");
      s.appendChild(node("div", "hero-stat-big", big));
      s.appendChild(node("div", "hero-stat-lbl", label));
      return s;
    }

    function renderHero() {
      var copy = homeCopy();
      var c = todayCounts();
      var name = ctx.name || "friend";
      var map = { name: name, part: timePart(), done: c.done, total: c.total };

      var hero = node("div", "hero");
      var eyebrowText = copy.eyebrow || "";
      if (ctx.semester) eyebrowText = eyebrowText ? (eyebrowText + " · " + ctx.semester) : ctx.semester;
      if (eyebrowText) hero.appendChild(node("div", "hero-eyebrow", eyebrowText));

      var titleText = fillTemplate(copy.titleTemplate, map);
      hero.appendChild(node("h1", "hero-title", copy.upper ? titleText.toUpperCase() : titleText));
      hero.appendChild(node("div", "hero-sub", fillTemplate(copy.sub, map)));

      var stats = node("div", "hero-stats");
      stats.appendChild(heroStat("🔥 " + (state.rewards ? state.rewards.currentStreak : 0), copy.streakLabel));
      stats.appendChild(heroStat(c.done + "/" + c.total, copy.progressLabel));
      stats.appendChild(heroStat(String(earnedTotal()), copy.earnLabel));
      hero.appendChild(stats);
      return hero;
    }

    function renderSignature() {
      var copy = homeCopy();
      var c = todayCounts();
      var card = node("div", "sig-card");
      card.appendChild(node("div", "sig-title", copy.visualTitle));
      var note = c.total === 0 ? copy.visualNoteEmpty
        : (c.done >= c.total ? copy.visualNoteAll : fillTemplate(copy.visualNoteDone, { done: c.done, total: c.total }));
      card.appendChild(node("div", "sig-note", note));

      if (copy.visual === "rail") card.appendChild(railVisual(c));
      else if (copy.visual === "grid") card.appendChild(gridVisual(c));
      else card.appendChild(barVisual(c));
      return card;
    }

    // Slot count: real total, or a few ghosts so an empty day still reads as a visual.
    function slotCount(c) { return Math.min(Math.max(c.total, 3), 16); }

    function railVisual(c) {
      var rail = node("div", "rail");
      var n = slotCount(c);
      for (var i = 0; i < n; i++) {
        var earned = i < c.done;
        var r = node("div", "rosette" + (earned ? (i % 2 ? " brass" : "") : " ghost"));
        r.appendChild(node("div", "flower"));
        r.appendChild(node("div", "core", earned ? "✓" : ""));
        var tails = node("div", "tails");
        tails.appendChild(node("span")); tails.appendChild(node("span"));
        r.appendChild(tails);
        rail.appendChild(r);
      }
      return rail;
    }

    var BUILD_MATS = ["grass", "stone", "wood", "gold"];
    function gridVisual(c) {
      var grid = node("div", "build-grid");
      var n = slotCount(c);
      for (var i = 0; i < n; i++) {
        var mined = i < c.done;
        var cell = node("div", "cell" + (mined ? " b " + BUILD_MATS[i % BUILD_MATS.length] : " ghost"));
        grid.appendChild(cell);
      }
      return grid;
    }

    function barVisual(c) {
      var bar = node("div", "prog-bar");
      var n = slotCount(c);
      for (var i = 0; i < n; i++) {
        bar.appendChild(node("div", "seg" + (i < c.done ? " on" : "")));
      }
      return bar;
    }

    // ---------- body ----------
    function viewBody() {
      var d = state.data;
      var container = node("div");
      // Rewards (Module 6) is never gated by the empty-content state below —
      // a category balance or the completion count can exist independent of
      // whatever's currently imported.
      if (state.view === "rewards") { container.appendChild(renderRewards()); return container; }

      if (d.rows.length === 0) { container.appendChild(emptyState()); return container; }

      if (state.view === "today") container.appendChild(renderToday());
      else if (state.view === "school") container.appendChild(renderFilter("school"));
      else if (state.view === "chores") container.appendChild(renderFilter("chores"));
      else if (state.view === "events") container.appendChild(renderEvents());
      else if (state.view === "subjects") container.appendChild(renderSubjects());
      return container;
    }

    // ---------- Rewards (Module 6) ----------
    // Read-only display, no PIN — the child's own view of what they've
    // earned (FR-1/FR-2/FR-3). Spend is a separate, PIN-gated flow (§5).
    function renderRewards() {
      var rw = state.rewards;
      var wrap = node("div", "rewards-view");
      var display = node("div", "reward-display tier-" + rw.theme.tier + " theme-" + rw.theme.id);
      display.appendChild(node("div", "rewards-heading", rw.theme.copy.rewardsTitle));

      if (rw.categories.length === 0) {
        display.appendChild(node("div", "section-empty", "Nothing earned yet — complete something to start earning."));
      } else {
        var list = node("div", "reward-cat-list");
        rw.categories.forEach(function (c) {
          var chip = node("div", "reward-cat");
          chip.appendChild(renderRewardIcon(c.icon));
          var info = node("div", "reward-cat-info");
          info.appendChild(node("div", "reward-cat-label", c.label));
          info.appendChild(node("div", "reward-cat-balance", String(c.balance)));
          chip.appendChild(info);
          var spendBtn = node("button", "btn ghost small", "Spend");
          spendBtn.onclick = function () { openSpendGate(c.categoryId, c.label); };
          chip.appendChild(spendBtn);
          list.appendChild(chip);
        });
        display.appendChild(list);
      }
      wrap.appendChild(display);

      // FR-3: distinct from — never merged into — the category balances above.
      var countRow = node("div", "completion-count-row");
      countRow.appendChild(node("div", "completion-count", rw.completionsThisWeek + " done this week"));
      countRow.appendChild(node("div", "streak-count", rw.currentStreak + " day" + (rw.currentStreak === 1 ? "" : "s") + " streak"));
      wrap.appendChild(countRow);
      return wrap;
    }

    function renderRewardIcon(icon) {
      if (icon.kind === "ribbon") {
        var r = node("span", "ribbon-icon");
        r.style.setProperty("--ribbon-color", icon.color);
        return r;
      }
      return node("span", "emoji-icon", icon.value);
    }

    // Two genuinely different empty states now that the file path is gone
    // (Phase 5, §11): a paired device has nothing to do but wait for §8.3's
    // poll, while an unpaired one cannot receive work at all until someone
    // enters a pairing code. Neither offers an action the child can take on
    // their own — pairing lives behind the Settings PIN gate, because the code
    // comes from the Management App and is a parent's job to fetch.
    function emptyState() {
      var e = node("div", "empty");
      e.appendChild(node("h2", null, "Nothing here yet"));
      e.appendChild(node("p", null, state.sync && state.sync.paired
        ? "No work has been assigned yet. This fills in on its own once it's ready."
        : "This device isn't linked yet. Ask a grown-up to link it in Settings, then today's plan will show up here."));
      return e;
    }

    // ---------- Today ----------
    function renderToday() {
      var d = state.data;
      var today = P.assembleToday(d.rows, state.today, state.isResolved);
      var wrap = node("div");

      // Signature home: themed greeting + the day's completion graphic, above the plan.
      wrap.appendChild(renderHero());
      wrap.appendChild(renderSignature());

      if (today.blocks.length === 0 && today.events.length === 0) {
        wrap.appendChild(node("div", "section-empty", "Nothing left for this date — the trail's clear."));
        return wrap;
      }

      today.blocks.forEach(function (block) {
        wrap.appendChild(laneHead(block.name));
        var group = [];
        if (block.school.length) {
          wrap.appendChild(node("div", "cat-label", "School"));
          block.school.forEach(function (a, i) {
            wrap.appendChild(itemCard(a, "activity", block.name, block.school, i));
          });
        }
        if (block.chores.length) {
          wrap.appendChild(node("div", "cat-label", "Chores"));
          block.chores.forEach(function (c, i) {
            wrap.appendChild(itemCard(c, "chore", block.name, block.chores, i));
          });
        }
      });

      if (today.events.length) {
        var head = node("div", "lane");
        var lh = node("div", "lane-head");
        lh.style.setProperty("--lane-color", "var(--ink-soft)");
        lh.appendChild(node("span", null, "Family events"));
        lh.appendChild(node("div", "lane-rule"));
        head.appendChild(lh);
        wrap.appendChild(head);
        today.events.forEach(function (ev) { wrap.appendChild(eventCard(ev)); });
      }
      return wrap;
    }

    function laneHead(blockName) {
      var lane = node("div", "lane");
      var head = node("div", "lane-head");
      head.style.setProperty("--lane-color", "var(--" + blockName + ")");
      var glyph = node("div", "lane-glyph");
      glyph.innerHTML = svgGlyph(blockName);
      head.appendChild(glyph);
      head.appendChild(node("span", null, blockName));
      head.appendChild(node("div", "lane-rule"));
      lane.appendChild(head);
      return lane;
    }

    // ---------- filter views (School / Chores) ----------
    function renderFilter(category) {
      var d = state.data;
      var list = P.filterView(d.rows, state.today, state.isResolved, category);
      var wrap = node("div");
      if (list.length === 0) {
        wrap.appendChild(node("div", "section-empty",
          category === "chores" ? "No chores for this date." : "No school work for this date."));
        return wrap;
      }
      list.forEach(function (item, i) {
        var blockName = P.effectiveBlock(item);
        var card = itemCard(item, category === "chores" ? "chore" : "activity", blockName, list, i);
        card.style.setProperty("--lane-color", "var(--" + blockName + ")");
        wrap.appendChild(card);
      });
      return wrap;
    }

    // ---------- Events view ----------
    function renderEvents() {
      var d = state.data;
      var list = P.eventsView(d.rows, state.today);
      var wrap = node("div");
      if (list.length === 0) { wrap.appendChild(node("div", "section-empty", "No family events for this date.")); return wrap; }
      list.forEach(function (ev) { wrap.appendChild(eventCard(ev)); });
      return wrap;
    }

    // ---------- Subjects view ----------
    function renderSubjects() {
      var d = state.data;
      var groups = P.subjectsView(d.rows, state.today, state.isResolved);
      var wrap = node("div");
      if (groups.length === 0) { wrap.appendChild(node("div", "section-empty", "No school work to group by subject for this date.")); return wrap; }
      groups.forEach(function (grp) {
        wrap.appendChild(node("div", "subject-head", grp.course_name));
        grp.items.forEach(function (a, i) {
          var blockName = P.effectiveBlock(a);
          var card = itemCard(a, "activity", blockName, grp.items, i);
          card.style.setProperty("--lane-color", "var(--" + blockName + ")");
          wrap.appendChild(card);
        });
      });
      return wrap;
    }

    // ---------- item card ----------
    function itemCard(item, kind, blockName, group, indexInGroup) {
      var card = node("div", "card");
      card.style.setProperty("--lane-color", "var(--" + blockName + ")");

      var top = node("div", "card-top");
      var main = node("div", "card-main");

      var tagrow = node("div", "tagrow");
      // A chore's type is a payload field (no column); an activity's is the
      // `activity_type` column, carrying the parent's label rather than the key.
      var typeText = kind === "chore" ? item.choreType : item.activity_type;
      if (typeText) tagrow.appendChild(node("span", "type-tag", typeText));
      // sequence_no: rendered whenever present, keyed off presence (FR-10),
      // distinct from the title, regardless of the content descriptor's kind.
      if (typeof item.sequence_no === "number") {
        tagrow.appendChild(node("span", "ordinal", "No. " + item.sequence_no));
      }
      if (tagrow.childNodes.length) main.appendChild(tagrow);

      // course_name label (FR-12) — above the title, activities only, only when present.
      if (kind === "activity" && item.course_name) {
        main.appendChild(node("div", "course-sub", item.course_name));
      }

      main.appendChild(node("div", "title", item.title));

      // lessonTitle subline (FR-8) — only when present, never an empty element.
      if (kind === "activity" && item.lessonTitle) {
        main.appendChild(node("div", "lesson-sub", item.lessonTitle));
      }

      // content line by kind (FR-11) — activities only, and only an activity's
      // payload carries a content descriptor at all.
      if (kind === "activity") {
        var contentEl = renderContent(item.content);
        if (contentEl) main.appendChild(contentEl);
      }

      // instructions / notes (FR-9) — only when present.
      var detailText = kind === "chore" ? item.notes : item.instructions;
      if (detailText) {
        var det = node("details", "detail");
        det.appendChild(node("summary", null, "Details"));
        det.appendChild(node("p", null, detailText));
        main.appendChild(det);
      }

      top.appendChild(main);

      // reorder controls (FR-4) — within this block+category group only.
      var controls = node("div", "controls");
      var up = node("button", "icon-btn", "\u2191");
      up.setAttribute("aria-label", "Move up");
      up.disabled = indexInGroup === 0;
      up.onclick = function () { reorder(group, indexInGroup, -1); };
      var down = node("button", "icon-btn", "\u2193");
      down.setAttribute("aria-label", "Move down");
      down.disabled = indexInGroup === group.length - 1;
      down.onclick = function () { reorder(group, indexInGroup, +1); };
      controls.appendChild(up); controls.appendChild(down);
      top.appendChild(controls);
      card.appendChild(top);

      // footer: block mover (FR-5) + entry-point stubs (FR-6/FR-7).
      var footer = node("div", "footer-row");
      footer.appendChild(node("span", "move-label", "Block"));
      var pick = node("select", "block-pick");
      BLOCKS.forEach(function (b) {
        var opt = node("option", null, b);
        opt.value = b;
        if (b === blockName) opt.selected = true;
        pick.appendChild(opt);
      });
      pick.onchange = function () { setOverride(item.id, { child_block_hint: pick.value }); };
      footer.appendChild(pick);

      var doneBtn = node("button", "btn small", "Mark done");
      doneBtn.onclick = function () { handleComplete(item); };
      footer.appendChild(doneBtn);
      if (item.required) {
        var rescheduleBtn = node("button", "btn ghost small", "Reschedule");
        rescheduleBtn.onclick = function () { openRescheduleDialog(item); };
        footer.appendChild(rescheduleBtn);

        var waiveBtn = node("button", "btn ghost small", "Waive");
        waiveBtn.onclick = function () { openWaiveDialog(item); };
        footer.appendChild(waiveBtn);
      }
      card.appendChild(footer);
      return card;
    }

    // `content` is what packet.js's projectPayload wrote: the kind-specific
    // half of an activity's payload, promoted out of it by assignment-core.
    function renderContent(content) {
      if (!content) return null;
      switch (content.kind) {
        case "pageRange":
          return node("div", "payload", "Pages " + content.pageRangeStart + "\u2013" + content.pageRangeEnd);
        case "reference":
          return node("div", "payload ref", content.reference);
        case "freeText":
          return node("div", "payload", content.text);
        case "none":
        default:
          return null; // a Practice Level's content is its ordinal (FR-10)
      }
    }

    function eventCard(ev) {
      var card = node("div", "event-card");
      var line = node("div");
      if (ev.time) {
        var t = node("span", "event-time", ev.time + "  ");
        line.appendChild(t);
      }
      line.appendChild(node("span", "title", ev.title));
      card.appendChild(line);
      if (ev.notes) card.appendChild(node("div", "event-note", ev.notes));
      return card;
    }

    // ---------- completion (Module 4) ----------
    // Grade entry is offered only when the item's own capturesGrade is true
    // (never inferred from activity_type/kind — Chores simply lack the field,
    // SRS Module 4 FR-1/FR-2). Either way completion always succeeds.
    function handleComplete(item) {
      if (item.capturesGrade) openGradeDialog(item);
      else doComplete(item, undefined);
    }

    function doComplete(item, grade) {
      g.Completion.completeItem(item, grade).then(function (res) {
        if (!res.ok) { toast(res.gradeError || "Couldn't mark that complete.", true); return; }
        if (res.alreadyDone) toast("Already marked done.", false);
        else toast("Marked done" + (typeof grade === "number" ? " — grade " + grade + "%" : "") + ".", false);
        reload();
      }).catch(function (e) {
        toast("Something went wrong marking that done.", true);
        console.error(e);
      });
    }

    function openGradeDialog(item) {
      var overlay = node("div", "modal-overlay");
      var card = node("div", "modal-card");
      card.appendChild(node("h2", "modal-title", "Add a grade?"));
      card.appendChild(node("p", "modal-help", "Optional — a whole number 0 to 100. You can skip this and still mark it done."));
      var input = node("input", "modal-input");
      input.type = "number"; input.min = "0"; input.max = "100"; input.inputMode = "numeric";
      card.appendChild(input);
      var err = node("div", "err-text");
      card.appendChild(err);

      var actions = node("div", "modal-actions");
      var cancel = node("button", "btn ghost", "Cancel");
      cancel.onclick = function () { overlay.remove(); };
      var skip = node("button", "btn ghost", "Skip grade");
      skip.onclick = function () { overlay.remove(); doComplete(item, undefined); };
      var save = node("button", "btn", "Complete");
      save.onclick = function () {
        var raw = input.value.trim();
        if (raw === "") { overlay.remove(); doComplete(item, undefined); return; }
        var n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 100) {
          err.textContent = "Enter a whole number 0–100, or leave it blank.";
          return;
        }
        overlay.remove();
        doComplete(item, n);
      };
      actions.appendChild(cancel); actions.appendChild(skip); actions.appendChild(save);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      input.focus();
    }

    // ---------- deferment / waive (Module 5) ----------
    // Both require the parent PIN (Module 1), checked before any write (FR-1).
    function openRescheduleDialog(item) {
      var overlay = node("div", "modal-overlay");
      var card = node("div", "modal-card");
      card.appendChild(node("h2", "modal-title", "Reschedule"));
      card.appendChild(node("p", "modal-help", "Enter the parent PIN and pick a new date — today or later."));

      var pinInput = node("input", "modal-input");
      pinInput.type = "password"; pinInput.inputMode = "numeric"; pinInput.autocomplete = "off";
      pinInput.placeholder = "Parent PIN";
      card.appendChild(pinInput);

      var dateInput = node("input", "modal-input");
      dateInput.type = "date"; dateInput.min = state.today; dateInput.value = state.today;
      dateInput.style.marginTop = "10px";
      card.appendChild(dateInput);

      var err = node("div", "err-text");
      card.appendChild(err);

      var actions = node("div", "modal-actions");
      var cancel = node("button", "btn ghost", "Cancel");
      cancel.onclick = function () { overlay.remove(); };
      var confirm = node("button", "btn", "Reschedule");
      confirm.onclick = function () {
        g.Deferment.reschedule(item, dateInput.value, pinInput.value).then(function (res) {
          if (!res.ok) {
            if (res.pinError) { err.textContent = "Incorrect PIN."; return; }
            if (res.dateError) { err.textContent = res.dateError; return; }
            if (res.alreadyResolved) { overlay.remove(); toast("That item is already resolved.", true); return; }
            err.textContent = "Couldn't reschedule that.";
            return;
          }
          overlay.remove();
          toast("Rescheduled to " + dateInput.value + ".", false);
          reload();
        }).catch(function (e) {
          err.textContent = "Something went wrong.";
          console.error(e);
        });
      };
      actions.appendChild(cancel); actions.appendChild(confirm);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      pinInput.focus();
    }

    function openWaiveDialog(item) {
      var overlay = node("div", "modal-overlay");
      var card = node("div", "modal-card");
      card.appendChild(node("h2", "modal-title", "Waive this item?"));
      card.appendChild(node("p", "modal-help", "This can't be undone — it will not be made up. Enter the parent PIN to confirm."));

      var pinInput = node("input", "modal-input");
      pinInput.type = "password"; pinInput.inputMode = "numeric"; pinInput.autocomplete = "off";
      pinInput.placeholder = "Parent PIN";
      card.appendChild(pinInput);

      var err = node("div", "err-text");
      card.appendChild(err);

      var actions = node("div", "modal-actions");
      var cancel = node("button", "btn ghost", "Cancel");
      cancel.onclick = function () { overlay.remove(); };
      var confirm = node("button", "btn", "Waive");
      confirm.onclick = function () {
        g.Deferment.waive(item, pinInput.value).then(function (res) {
          if (!res.ok) {
            if (res.pinError) { err.textContent = "Incorrect PIN."; return; }
            if (res.alreadyResolved) { overlay.remove(); toast("That item is already resolved.", true); return; }
            err.textContent = "Couldn't waive that.";
            return;
          }
          overlay.remove();
          toast("Waived.", false);
          reload();
        }).catch(function (e) {
          err.textContent = "Something went wrong.";
          console.error(e);
        });
      };
      actions.appendChild(cancel); actions.appendChild(confirm);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      pinInput.focus();
    }

    // ---------- generic PIN gate (Module 6 spend, Module 11 Settings) ----------
    // TDS_Slice_M3 §5/§7: the gate is checked before the gated screen is even
    // reachable, not only at a final confirm — a stricter rule than
    // deferment/waive's single combined dialog, so this is a separate step.
    function openPinGate(title, help, onVerified) {
      var overlay = node("div", "modal-overlay");
      var card = node("div", "modal-card");
      card.appendChild(node("h2", "modal-title", title));
      card.appendChild(node("p", "modal-help", help));
      var pinInput = node("input", "modal-input");
      pinInput.type = "password"; pinInput.inputMode = "numeric"; pinInput.autocomplete = "off";
      pinInput.placeholder = "Parent PIN";
      card.appendChild(pinInput);
      var err = node("div", "err-text");
      card.appendChild(err);
      var actions = node("div", "modal-actions");
      var cancel = node("button", "btn ghost", "Cancel");
      cancel.onclick = function () { overlay.remove(); };
      var confirm = node("button", "btn", "Continue");
      confirm.onclick = function () {
        g.Settings.checkEntryPin(pinInput.value).then(function (ok) {
          if (!ok) { err.textContent = "Incorrect PIN."; return; }
          var pin = pinInput.value;
          overlay.remove();
          onVerified(pin);
        });
      };
      actions.appendChild(cancel); actions.appendChild(confirm);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      pinInput.focus();
    }

    // ---------- theme switcher (Module 10) — always ungated ----------
    function openThemeDialog() {
      var overlay = node("div", "modal-overlay");
      var card = node("div", "modal-card");
      card.appendChild(node("h2", "modal-title", "Pick a theme"));
      card.appendChild(node("p", "modal-help", "No PIN needed — pick whatever feels like yours, any time."));
      var grid = node("div", "theme-grid");
      g.ThemeCore.listThemes().forEach(function (t) {
        var opt = node("button", "theme-opt");
        opt.setAttribute("aria-pressed", state.rewards && state.rewards.theme.id === t.id ? "true" : "false");
        var swatch = node("div", "theme-swatch");
        t.swatch.forEach(function (c) { var s = node("span"); s.style.background = c; swatch.appendChild(s); });
        opt.appendChild(swatch);
        opt.appendChild(document.createTextNode(t.name));
        opt.onclick = function () {
          g.Theming.setTheme(t.id).then(function () { overlay.remove(); reload(); });
        };
        grid.appendChild(opt);
      });
      card.appendChild(grid);
      var actions = node("div", "modal-actions");
      var close = node("button", "btn ghost", "Close");
      close.onclick = function () { overlay.remove(); };
      actions.appendChild(close);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
    }

    // ---------- spend (Module 6 FR-4) — PIN-gated ----------
    function openSpendGate(categoryId, label) {
      openPinGate("Spend from " + label, "Enter the parent PIN to spend from this category.", function (pin) {
        openSpendForm(categoryId, label, pin);
      });
    }

    function openSpendForm(categoryId, label, pin) {
      var overlay = node("div", "modal-overlay");
      var card = node("div", "modal-card");
      card.appendChild(node("h2", "modal-title", "Spend — " + label));
      card.appendChild(node("p", "modal-help", "Enter a whole number to deduct from this category."));
      var input = node("input", "modal-input");
      input.type = "number"; input.min = "1"; input.inputMode = "numeric";
      card.appendChild(input);
      var err = node("div", "err-text");
      card.appendChild(err);
      var actions = node("div", "modal-actions");
      var cancel = node("button", "btn ghost", "Cancel");
      cancel.onclick = function () { overlay.remove(); };
      var confirm = node("button", "btn", "Spend");
      confirm.onclick = function () {
        var amountText = input.value;
        g.Reward.spend(categoryId, amountText, pin).then(function (res) {
          if (!res.ok) {
            if (res.pinError) { err.textContent = "Incorrect PIN."; return; }
            if (res.amountError) { err.textContent = res.amountError; return; }
            if (res.ceilingError) { err.textContent = "That's more than the current balance (" + res.balance + ")."; return; }
            err.textContent = "Couldn't process that.";
            return;
          }
          overlay.remove();
          toast("Spent " + amountText + " from " + label + ".", false);
          reload();
        }).catch(function (e) {
          err.textContent = "Something went wrong.";
          console.error(e);
        });
      };
      actions.appendChild(cancel); actions.appendChild(confirm);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      input.focus();
    }

    // ---------- Settings (Module 11) — PIN-gated on entry ----------
    function openSettingsGate() {
      openPinGate("Settings", "Enter the parent PIN to open Settings.", function () {
        openSettingsPanel();
      });
    }

    function openSettingsPanel() {
      g.Pairing.getStatus().then(buildSettingsPanel);
    }

    function buildSettingsPanel(pairing) {
      var overlay = node("div", "modal-overlay");
      var card = node("div", "modal-card wide");
      card.appendChild(node("h2", "modal-title", "Settings"));

      // --- Name (FR-1) ---
      card.appendChild(node("div", "settings-label", "Child's name"));
      var nameRow = node("div", "settings-row");
      var nameInput = node("input", "modal-input");
      nameInput.type = "text"; nameInput.maxLength = 24; nameInput.value = ctx.name || "";
      nameRow.appendChild(nameInput);
      var nameBtn = node("button", "btn small", "Save");
      nameRow.appendChild(nameBtn);
      card.appendChild(nameRow);
      var nameErr = node("div", "err-text"); card.appendChild(nameErr);
      nameBtn.onclick = function () {
        g.Settings.updateName(nameInput.value).then(function (res) {
          if (!res.ok) { nameErr.textContent = res.message; return; }
          nameErr.textContent = ""; ctx.name = res.name;
          toast("Name updated.", false);
          reload();
        });
      };

      // --- Semester label (FR-2) ---
      card.appendChild(node("div", "settings-label", "Semester label"));
      var semRow = node("div", "settings-row");
      var semInput = node("input", "modal-input");
      semInput.type = "text"; semInput.maxLength = 40; semInput.value = ctx.semester || "";
      semRow.appendChild(semInput);
      var semBtn = node("button", "btn small", "Save");
      semRow.appendChild(semBtn);
      card.appendChild(semRow);
      var semErr = node("div", "err-text"); card.appendChild(semErr);
      semBtn.onclick = function () {
        g.Settings.updateSemesterLabel(semInput.value).then(function (res) {
          if (!res.ok) { semErr.textContent = res.message; return; }
          semErr.textContent = ""; ctx.semester = res.label;
          toast("Semester label updated.", false);
          reload();
        });
      };

      // --- Change PIN (FR-3) ---
      card.appendChild(node("div", "settings-label", "Change parent PIN"));
      var curPin = node("input", "modal-input");
      curPin.type = "password"; curPin.inputMode = "numeric"; curPin.autocomplete = "off"; curPin.placeholder = "Current PIN";
      var newPin = node("input", "modal-input");
      newPin.type = "password"; newPin.inputMode = "numeric"; newPin.autocomplete = "off"; newPin.placeholder = "New PIN"; newPin.style.marginTop = "8px";
      var newPin2 = node("input", "modal-input");
      newPin2.type = "password"; newPin2.inputMode = "numeric"; newPin2.autocomplete = "off"; newPin2.placeholder = "Repeat new PIN"; newPin2.style.marginTop = "8px";
      card.appendChild(curPin); card.appendChild(newPin); card.appendChild(newPin2);
      var pinBtn = node("button", "btn small", "Change PIN");
      pinBtn.style.marginTop = "8px";
      card.appendChild(pinBtn);
      var pinErr = node("div", "err-text"); card.appendChild(pinErr);
      pinBtn.onclick = function () {
        g.Settings.changePin(curPin.value, newPin.value, newPin2.value).then(function (res) {
          if (!res.ok) { pinErr.textContent = res.currentPinError ? "Incorrect current PIN." : res.newPinError; return; }
          pinErr.textContent = "";
          curPin.value = ""; newPin.value = ""; newPin2.value = "";
          toast("PIN changed.", false);
        });
      };

      // --- Linked device (Online Revamp §4.3) ---
      card.appendChild(node("div", "settings-label", "Linked device"));
      if (pairing && pairing.deviceToken) {
        card.appendChild(node("p", "modal-help", "Paired to " + (pairing.childName || ctx.name || "this child") + "."));
        // Online Revamp §8.3/§8.4: the plan arrives by polling, so the one thing
        // worth showing here is whether that is actually working. "unauthorized"
        // is called out separately from "offline" because only one of the two
        // resolves by waiting — a revoked device (§4.1) needs a new pairing code.
        card.appendChild(node("div", "modal-help", syncStatusText(pairing)));
        // §8.4: the queue is the honest answer to "did my work get sent?" —
        // shown only when there is something in it, so a device that is keeping
        // up says nothing rather than reassuring anyone about plumbing.
        if (state.upload && state.upload.pending > 0) {
          card.appendChild(node("div", "modal-help", uploadStatusText(state.upload)));
        }
        // Shown on its own gate, not folded into the one above: a rejection
        // leaves nothing in the queue, so anything conditioned on `pending`
        // would announce a refused upload exactly never (§5.6).
        if (state.upload && state.upload.rejected > 0) {
          card.appendChild(node("div", "err-text", rejectedStatusText(state.upload.rejected)));
          var seeBtn = node("button", "btn small ghost", "What didn't send?");
          card.appendChild(seeBtn);
          seeBtn.onclick = function () {
            seeBtn.disabled = true;
            g.Outbox.rejections().then(function (rows) {
              var box = node("div", "modal-help");
              rows.slice(0, 20).forEach(function (row) {
                box.appendChild(node("div", "err-text",
                  new Date(row.at).toLocaleString() + " — " + row.error));
              });
              card.insertBefore(box, seeBtn);
              var clearBtn = node("button", "btn small ghost", "Got it, hide this");
              card.insertBefore(clearBtn, seeBtn);
              clearBtn.onclick = function () {
                g.Outbox.clearRejections().then(function () {
                  overlay.remove();
                  reload().then(openSettingsPanel);
                });
              };
              seeBtn.remove();
            });
          };
        }
        var checkBtn = node("button", "btn small ghost", "Check for new work");
        card.appendChild(checkBtn);
        var forgetBtn = node("button", "btn small ghost", "Forget this device");
        forgetBtn.style.marginLeft = "8px";
        card.appendChild(forgetBtn);
        var forgetErr = node("div", "err-text"); card.appendChild(forgetErr);
        checkBtn.onclick = function () {
          checkBtn.disabled = true;
          // Push before pull. The queue holds work this kid has already done,
          // and sending it first means the plan that comes back down already
          // reflects it instead of arriving one poll out of date.
          g.Outbox.drain().then(function () { return g.PlanSync.syncNow(); }).then(function (res) {
            checkBtn.disabled = false;
            if (res && res.error === "unauthorized") toast("This device is no longer linked. Ask for a new pairing code.", true);
            else if (res && res.error) toast("Couldn't reach the server. Your saved plan is still here.", true);
            else toast(res && res.changed ? "Plan updated." : "Already up to date.", false);
            overlay.remove();
            // Reopened rather than left closed, so the status line above redraws
            // with the result of the check that was just asked for.
            reload().then(openSettingsPanel);
          });
        };
        forgetBtn.onclick = function () {
          g.Pairing.forget().then(function () {
            toast("Device unlinked.", false);
            overlay.remove();
            openSettingsPanel();
          });
        };
      } else {
        card.appendChild(node("p", "modal-help", "Enter the pairing code shown in the Management App to link this device."));
        var codeInput = node("input", "modal-input");
        codeInput.type = "text"; codeInput.autocomplete = "off"; codeInput.placeholder = "Pairing code";
        var labelInput = node("input", "modal-input");
        labelInput.type = "text"; labelInput.autocomplete = "off"; labelInput.placeholder = "Label this device (optional)"; labelInput.style.marginTop = "8px";
        card.appendChild(codeInput); card.appendChild(labelInput);
        var pairBtn = node("button", "btn small", "Pair"); pairBtn.style.marginTop = "8px";
        card.appendChild(pairBtn);
        var pairErr = node("div", "err-text"); card.appendChild(pairErr);
        pairBtn.onclick = function () {
          pairBtn.disabled = true;
          g.Pairing.redeem(codeInput.value, labelInput.value).then(function (res) {
            if (!res.ok) { pairBtn.disabled = false; pairErr.textContent = res.message; return; }
            pairErr.textContent = "";
            // Fetch the plan immediately rather than waiting out the poll
            // interval: a device is paired precisely because someone is standing
            // there expecting work to appear.
            return g.PlanSync.syncNow().then(function () {
              pairBtn.disabled = false;
              toast("Device linked.", false);
              overlay.remove();
              return reload().then(openSettingsPanel);
            });
          });
        };
      }

      // --- Repair form (FR-7) ---
      card.appendChild(node("div", "settings-label", "Recovery / repair"));
      card.appendChild(node("p", "modal-help", "Use the values from your latest recovery note (saved alongside a Completion CSV export) — not a general editor."));

      if (state.rewards && state.rewards.categories.length) {
        var catSelect = node("select", "block-pick");
        state.rewards.categories.forEach(function (c) {
          var opt = node("option", null, c.label + " (currently " + c.balance + ")");
          opt.value = c.categoryId;
          catSelect.appendChild(opt);
        });
        card.appendChild(catSelect);
        var adjInput = node("input", "modal-input");
        adjInput.type = "number"; adjInput.placeholder = "Signed amount, e.g. -5 or 10"; adjInput.style.marginTop = "8px";
        card.appendChild(adjInput);
        var adjBtn = node("button", "btn small", "Apply adjustment"); adjBtn.style.marginTop = "8px";
        card.appendChild(adjBtn);
        var adjErr = node("div", "err-text"); card.appendChild(adjErr);
        adjBtn.onclick = function () {
          g.Settings.adjustBalance(catSelect.value, adjInput.value).then(function (res) {
            if (!res.ok) { adjErr.textContent = res.message; return; }
            adjErr.textContent = ""; adjInput.value = "";
            toast("Balance adjusted.", false);
            reload();
          });
        };
      } else {
        card.appendChild(node("p", "modal-help", "No reward categories yet."));
      }

      var streakInput = node("input", "modal-input");
      streakInput.type = "number"; streakInput.min = "0"; streakInput.placeholder = "Streak (days)"; streakInput.style.marginTop = "12px";
      if (state.rewards) streakInput.value = state.rewards.currentStreak;
      card.appendChild(streakInput);
      var streakDate = node("input", "modal-input");
      streakDate.type = "date"; streakDate.style.marginTop = "8px";
      card.appendChild(streakDate);
      var streakBtn = node("button", "btn small", "Set streak"); streakBtn.style.marginTop = "8px";
      card.appendChild(streakBtn);
      var streakErr = node("div", "err-text"); card.appendChild(streakErr);
      streakBtn.onclick = function () {
        g.Settings.setStreak(streakInput.value, streakDate.value).then(function (res) {
          if (!res.ok) { streakErr.textContent = res.message; return; }
          streakErr.textContent = "";
          toast("Streak updated.", false);
          reload();
        });
      };

      var actions = node("div", "modal-actions");
      var done = node("button", "btn", "Done");
      done.onclick = function () { overlay.remove(); };
      actions.appendChild(done);
      card.appendChild(actions);

      overlay.appendChild(card);
      document.body.appendChild(overlay);
    }

    // ---------- reorder math (writes only sortOrder for the moved item) ----------
    function reorder(group, i, dir) {
      var j = i + dir;
      if (j < 0 || j >= group.length) return;
      var keyAt = function (idx) { return P.effectiveSortKey(group[idx]); };
      var moved = group[i];
      var newKey;
      if (dir < 0) {
        // moving up: land above neighbour j (= i-1)
        if (j === 0) newKey = keyAt(0) - 1;
        else newKey = (keyAt(j - 1) + keyAt(j)) / 2;
      } else {
        // moving down: land below neighbour j (= i+1)
        if (j === group.length - 1) newKey = keyAt(j) + 1;
        else newKey = (keyAt(j) + keyAt(j + 1)) / 2;
      }
      setOverride(moved.id, { child_sort_order: newKey });
    }

    // ---------- export (Module 8) ----------
    function doExport() {
      g.Export.exportCompletions().then(function (res) {
        if (!res.ok) { toast("Export failed — nothing was marked sent. Try again.", true); return; }
        if (res.empty) { toast("Nothing to export right now.", false); return; }
        state.reminderDismissed = false; // FR-7: clears once an export succeeds
        var msg = "Exported " + res.count + " item" + (res.count === 1 ? "" : "s") + ".";
        if (!res.noteOk) msg += " (Recovery note couldn't be saved — try exporting again later.)";
        toast(msg, !res.noteOk);
        reload();
      }).catch(function (e) {
        toast("Something went wrong exporting.", true);
        console.error(e);
      });
    }

    // ---------- wipe (Module 9) ----------
    // FR-8: a plain confirmation, not the parent PIN — placement in this
    // Export-adjacent area (not the daily/Today view) is what makes an
    // unguarded button safe here.
    function doWipe() {
      if (!window.confirm("Clear completed & exported work? Pending work, your Reward Ledger balance, and streak are never touched. This can't be undone.")) return;
      g.Wipe.runWipe().then(function (res) {
        toast("Cleared " + res.clearedRecords + " item" + (res.clearedRecords === 1 ? "" : "s") + ".", false);
        reload();
      }).catch(function (e) {
        toast("Wipe failed. Try again.", true);
        console.error(e);
      });
    }

    reload();

    // The handle app.js needs to re-render when plan-sync.js pulls new work in
    // (Online Revamp §8.3). Everything above stays private to the mount.
    return { reload: reload };
  }

  // ---------- helpers ----------

  // Reads the syncMeta bookkeeping plan-sync.js writes on every attempt.
  function syncStatusText(pairing) {
    if (pairing.lastError === "unauthorized") {
      return "This device is no longer linked — ask a parent for a new pairing code.";
    }
    if (!pairing.lastSyncedAt) {
      return pairing.lastError
        ? "Not connected yet. Check the wifi and try again."
        : "Checking for work…";
    }
    var when = new Date(pairing.lastSyncedAt);
    var stamp = g.DateUtil.localISODate(when) + " " +
      String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0");
    return pairing.lastError
      ? "Offline — showing the plan saved at " + stamp + "."
      : "Up to date. Last checked " + stamp + ".";
  }

  // Reads the in-memory drain state outbox.js keeps (Online Revamp §8.4).
  // Deliberately reassuring rather than alarming: nothing has been lost in any
  // of these cases — the queue is durable and the work is already recorded on
  // this device. The only one worth acting on is a revoked link.
  function uploadStatusText(upload) {
    var n = upload.pending;
    var what = n + " thing" + (n === 1 ? "" : "s") + " you finished ";
    if (upload.error === "unauthorized") {
      return what + "can't be sent — this device is no longer linked. Ask for a new pairing code.";
    }
    if (upload.error === "rejected") {
      return what + "couldn't be sent. Show a parent — nothing here is lost.";
    }
    return what + (upload.error === "offline" ? "will be sent when you're back online." : "is still being sent.");
  }

  // The one upload state that is genuinely not reassuring, so it does not
  // pretend otherwise. The work is still recorded on this device — that is why
  // it says "on the family list" rather than "gone" — but the server refused it
  // and no amount of waiting will change that (§5.6).
  function rejectedStatusText(n) {
    return n + " thing" + (n === 1 ? "" : "s") + " couldn't be saved on the family list. " +
      "They're still ticked off here. Show a parent so they can sort it out.";
  }

  var toastTimer = null;
  function toast(message, isError) {
    var t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
    t.textContent = message;
    t.className = "toast show" + (isError ? " err" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast" + (isError ? " err" : ""); }, isError ? 6000 : 3200);
  }

  g.PlannerUI = { mount: mount, toast: toast };
})(window);


