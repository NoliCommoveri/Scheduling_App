// planner-ui.js — the Daily Planner's rendering and interactions (SRS Module 3).
// Presentation and light organization only: it reads Received Packet content and
// writes just two child-owned override fields (sortOrder, blockHint) via plannerMeta.
// The plan itself is derived here each render and never persisted.

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
      // SRS Module 8 FR-7: dismissed only for this session — reappears on the
      // next app open as long as the condition still holds.
      reminderDismissed: false
    };

    function reload() {
      return Promise.all([g.DB.loadState(), g.DB.getAll("activityRecords"), g.Export.reminderState(), g.Reward.gatherDisplay()]).then(function (r) {
        state.data = r[0];
        var resolved = Object.create(null);
        r[1].forEach(function (rec) { resolved[rec.activityId] = true; });
        state.isResolved = function (id) { return !!resolved[id]; };
        state.reminderInfo = r[2];
        state.rewards = r[3];
        render();
      });
    }

    function setMeta(id, patch) { return g.DB.setMeta(id, patch).then(reload); }

    function render() {
      root.innerHTML = "";
      var app = node("div", "app");
      app.appendChild(appbar());
      app.appendChild(viewBody());
      root.appendChild(app);
    }

    // ---------- app bar ----------
    function appbar() {
      var bar = node("div", "appbar");
      var row = node("div", "appbar-row");
      var left = node("div");
      left.appendChild(node("h1", "greeting", greetingText()));
      left.appendChild(node("div", "semester", ctx.semester ? ctx.semester : ""));
      row.appendChild(left);

      var prev = node("div", "preview");
      prev.appendChild(node("span", null, "Preview"));
      var dateInput = node("input");
      dateInput.type = "date";
      dateInput.value = state.today;
      dateInput.oninput = function () { if (dateInput.value) { state.today = dateInput.value; render(); } };
      prev.appendChild(dateInput);
      row.appendChild(prev);
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

      // Theme switcher (Module 10) and Settings (Module 11) each get their
      // own entry point, neither nested inside the other or inside gated
      // Settings — the switcher stays ungated, Settings gates on entry
      // (TDS_Slice_M3 §7).
      var utilityRow = node("div", "utility-row");
      var themeBtn = node("button", "btn ghost small", "🎨 Theme");
      themeBtn.onclick = openThemeDialog;
      utilityRow.appendChild(themeBtn);
      var settingsBtn = node("button", "btn ghost small", "⚙️ Settings");
      settingsBtn.style.marginLeft = "8px";
      settingsBtn.onclick = openSettingsGate;
      utilityRow.appendChild(settingsBtn);
      bar.appendChild(utilityRow);

      var importRow = node("div", "import-row");
      var btn = node("button", "btn ghost small", "Import a packet");
      var file = node("input", "hidden-file");
      file.type = "file"; file.accept = "application/json,.json";
      file.onchange = function () {
        if (file.files && file.files[0]) doImport(file.files[0]);
        file.value = "";
      };
      btn.onclick = function () { file.click(); };
      importRow.appendChild(btn);
      importRow.appendChild(file);
      if (g.EMBEDDED_SAMPLE) {
        var sampleBtn = node("button", "btn ghost small", "Load sample");
        sampleBtn.style.marginLeft = "8px";
        sampleBtn.onclick = doImportEmbedded;
        importRow.appendChild(sampleBtn);
      }
      bar.appendChild(importRow);

      // Export + Wipe share one access area, by design (SRS Module 8 §2.1 /
      // Module 9 §2.2) — kept off the daily/Today view entirely.
      var exportRow = node("div", "export-row");
      var exportBtn = node("button", "btn ghost small", "Export completions");
      exportBtn.onclick = doExport;
      exportRow.appendChild(exportBtn);
      var wipeBtn = node("button", "btn ghost small", "Wipe sent work");
      wipeBtn.style.marginLeft = "8px";
      wipeBtn.onclick = doWipe;
      exportRow.appendChild(wipeBtn);
      bar.appendChild(exportRow);

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

      // DEV-ONLY reset — not the spec'd Module 9 Wipe (that's a future, child-
      // facing, resolved+exported-only clear paired with CSV Export). This
      // wipes everything, including Child/Semester/Theme, for local testing.
      var devRow = node("div", "dev-reset-row");
      var devBtn = node("button", "dev-reset-btn", "⚠ Reset app (dev)");
      devBtn.onclick = function () {
        if (!window.confirm("DEV RESET: delete ALL local data (child, semester, theme, packets, planner overrides) and reload? This cannot be undone.")) return;
        g.DB.devWipeAll().then(function () {
          window.location.reload();
        }).catch(function (e) {
          toast("Reset failed: " + e.message, true);
        });
      };
      devRow.appendChild(devBtn);
      bar.appendChild(devRow);

      return bar;
    }

    function greetingText() {
      var h = new Date().getHours();
      var part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
      return ctx.name ? part + ", " + ctx.name : part;
    }

    // ---------- body ----------
    function viewBody() {
      var d = state.data;
      var container = node("div");
      // Rewards (Module 6) is never gated by the empty-content state below —
      // a category balance or the completion count can exist independent of
      // whatever's currently imported.
      if (state.view === "rewards") { container.appendChild(renderRewards()); return container; }

      var totalItems = d.activities.length + d.chores.length + d.events.length;
      if (totalItems === 0) { container.appendChild(emptyState()); return container; }

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

    function emptyState() {
      var e = node("div", "empty");
      e.appendChild(node("h2", null, "Nothing here yet"));
      e.appendChild(node("p", null, "Import a packet to see today's school work, chores, and events."));
      var b = node("button", "btn", "Import a packet");
      var file = node("input", "hidden-file");
      file.type = "file"; file.accept = "application/json,.json";
      file.onchange = function () { if (file.files && file.files[0]) doImport(file.files[0]); file.value = ""; };
      b.onclick = function () { file.click(); };
      e.appendChild(b); e.appendChild(file);
      if (g.EMBEDDED_SAMPLE) {
        var sampleBtn = node("button", "btn ghost", "Load sample packet");
        sampleBtn.style.marginTop = "10px";
        sampleBtn.onclick = doImportEmbedded;
        e.appendChild(sampleBtn);
      }
      return e;
    }

    // ---------- Today ----------
    function renderToday() {
      var d = state.data;
      var stateArrays = { activities: d.activities, chores: d.chores, events: d.events };
      var today = P.assembleToday(stateArrays, d.meta, state.today, state.isResolved);
      var wrap = node("div");

      if (today.blocks.length === 0 && today.events.length === 0) {
        wrap.appendChild(node("div", "section-empty", "Nothing due for this date. Enjoy the breather."));
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
      var stateArrays = { activities: d.activities, chores: d.chores, events: d.events };
      var list = P.filterView(stateArrays, d.meta, state.today, state.isResolved, category);
      var wrap = node("div");
      if (list.length === 0) {
        wrap.appendChild(node("div", "section-empty",
          category === "chores" ? "No chores for this date." : "No school work for this date."));
        return wrap;
      }
      list.forEach(function (item, i) {
        var blockName = P.effectiveBlock(item, d.meta);
        var card = itemCard(item, category === "chores" ? "chore" : "activity", blockName, list, i);
        card.style.setProperty("--lane-color", "var(--" + blockName + ")");
        wrap.appendChild(card);
      });
      return wrap;
    }

    // ---------- Events view ----------
    function renderEvents() {
      var d = state.data;
      var list = P.eventsView({ events: d.events }, state.today);
      var wrap = node("div");
      if (list.length === 0) { wrap.appendChild(node("div", "section-empty", "No family events for this date.")); return wrap; }
      list.forEach(function (ev) { wrap.appendChild(eventCard(ev)); });
      return wrap;
    }

    // ---------- Subjects view ----------
    function renderSubjects() {
      var d = state.data;
      var stateArrays = { activities: d.activities, chores: d.chores, events: d.events };
      var groups = P.subjectsView(stateArrays, d.meta, state.today, state.isResolved);
      var wrap = node("div");
      if (groups.length === 0) { wrap.appendChild(node("div", "section-empty", "No school work to group by subject for this date.")); return wrap; }
      groups.forEach(function (grp) {
        wrap.appendChild(node("div", "subject-head", grp.courseName));
        grp.items.forEach(function (a, i) {
          var blockName = P.effectiveBlock(a, d.meta);
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
      var typeText = kind === "chore" ? item.choreType : item.activityType;
      if (typeText) tagrow.appendChild(node("span", "type-tag", typeText));
      // sequenceNumber: rendered whenever present, keyed off presence (FR-10),
      // distinct from the title, regardless of payload.kind.
      if (typeof item.sequenceNumber === "number") {
        tagrow.appendChild(node("span", "ordinal", "No. " + item.sequenceNumber));
      }
      if (tagrow.childNodes.length) main.appendChild(tagrow);

      // courseName label (FR-12) — above the title, activities only, only when present.
      if (kind === "activity" && item.courseName) {
        main.appendChild(node("div", "course-sub", item.courseName));
      }

      main.appendChild(node("div", "title", item.title));

      // lessonTitle subline (FR-8) — only when present, never an empty element.
      if (kind === "activity" && item.lessonTitle) {
        main.appendChild(node("div", "lesson-sub", item.lessonTitle));
      }

      // payload line by kind (FR-11) — activities only.
      if (kind === "activity") {
        var payloadEl = renderPayload(item.payload);
        if (payloadEl) main.appendChild(payloadEl);
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
      pick.onchange = function () { setMeta(item.id, { blockHint: pick.value }); };
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

    function renderPayload(payload) {
      if (!payload) return null;
      switch (payload.kind) {
        case "pageRange":
          return node("div", "payload", "Pages " + payload.pageRangeStart + "\u2013" + payload.pageRangeEnd);
        case "reference":
          return node("div", "payload ref", payload.reference);
        case "freeText":
          return node("div", "payload", payload.text);
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
    // (never inferred from activityType/kind — Chores simply lack the field,
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
      var meta = state.data.meta;
      var keyAt = function (idx) { return P.effectiveSortKey(group[idx], meta); };
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
      setMeta(moved.id, { sortOrder: newKey });
    }

    // ---------- import ----------
    function handleResult(res) {
      if (res.ok) {
        var msg = res.counts.added + " new item" + (res.counts.added === 1 ? "" : "s");
        if (res.counts.refreshed) msg += ", " + res.counts.refreshed + " refreshed";
        toast("Packet imported — " + msg + ".", false);
        reload();
      } else if (res.versionError || res.parseError) {
        toast(res.message, true);
      } else {
        toast("Packet rejected: " + res.errors[0] + (res.errors.length > 1 ? " (+" + (res.errors.length - 1) + " more)" : ""), true);
      }
    }
    function doImport(file) {
      g.Importer.importFile(file).then(handleResult).catch(function (e) {
        toast("Something went wrong reading that file.", true);
        console.error(e);
      });
    }
    function doImportEmbedded() {
      g.Importer.importText(JSON.stringify(g.EMBEDDED_SAMPLE)).then(handleResult).catch(function (e) {
        toast("Something went wrong loading the sample.", true);
        console.error(e);
      });
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
      if (!window.confirm("Clear completed & exported work, plus past family events? Pending work, your Reward Ledger balance, and streak are never touched. This can't be undone.")) return;
      g.Wipe.runWipe().then(function (res) {
        toast("Cleared " + res.clearedRecords + " item" + (res.clearedRecords === 1 ? "" : "s") + " and " + res.clearedEvents + " past event" + (res.clearedEvents === 1 ? "" : "s") + ".", false);
        reload();
      }).catch(function (e) {
        toast("Wipe failed. Try again.", true);
        console.error(e);
      });
    }

    reload();
  }

  // ---------- helpers ----------
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


