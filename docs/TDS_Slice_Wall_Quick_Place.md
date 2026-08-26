# TDS Slice — Quick Place: long-press an empty slot to schedule a chore

**Status:** **DESIGN ONLY — authorized by Ray in-session 2026-08-26, unbuilt.**
**Extends:** `TDS_Slice_Wall_Calendar_Redesign.md` §3.4 (the unscheduled tray), §4.3/§4.4 (the grid
and block modes), §8.1 (tap targets); `TDS_Slice_Wall_Placement_Scopes.md` §7.1 (a gesture writes
the level already in force) and §2.1 (the first-placement gate).
**Supersedes:** nothing. Every gesture that exists today keeps working exactly as it does.
**App scope:** `wall-app/` only. **No Worker change, no migration, no route, no API call that does
not already exist.**

---

## 0. Why this exists

**0.1 — Placing a chore is arm-then-aim, and the two halves are far apart.** Reported by Ray,
2026-08-26. Today the only way to give an unscheduled chore a time is the unscheduled tray (§3.4):
open the child's tray cell, find the chore in a single list of everything unplaced, tap it to arm it
(`tryToggleSelection`, `day-ui.js:1019`), then scroll the grid to the hour you want and tap there
(`attachGridTapToPlace`, `:1032`). Or drag it the same distance. The tray sits pinned above the
grid; the target hour is often most of a screen below it. Two gestures, a scroll between them, and
the list gives no hint which of its items belongs anywhere near where you are aiming.

**0.2 — The list already knows, and cannot say.** §3.4.1 put the block badge on each tray item
(`Dishes · Evening`) and ordered the tray morning → night precisely because a bare list of titles is
ambiguous. So the wall already knows which part of the day each unplaced chore was meant for — it
just makes you carry that knowledge across the gesture yourself. `ChoresCore.BLOCK_HOURS`
(`chores-core.js:68`) maps each of the four canonical blocks to real clock hours, and
`blockFromStartMin` (`:118`) already answers "which block is this minute in" for the now-line and
for block-mode bucketing. Every fact this feature needs is already computed; nothing joins them at
the moment of placing.

**The shape of the fix:** invert the gesture. Instead of picking a chore and then hunting for a
time, **press the time and be offered the chores that belong there.**

```
[DECISION] Quick Place — press an empty slot, get the chores that belong in it
Decided: a LONG-PRESS (held ~550ms, no movement) on empty grid space inside a
  child's column opens a sheet listing that child's unscheduled chores whose
  block hint matches the block containing the pressed minute. A tap on one
  places it at that minute immediately — one gesture chain, no arming step.
Rationale: the pressed point already carries both facts a placement needs —
  the COLUMN names the child (redesign §2.3: "the column a tap lands in names
  the child"), and the Y names the minute, hence the block. Filtering by hint
  is what turns a list of everything unplaced into a list of two or three
  things, which is what makes the sheet faster to read than the tray it
  replaces for this purpose.
Locked for: wall-app, this milestone.
```

### 0.3 The alternative Ray raised, and why this slice does not build it

Ray proposed a second option: a **per-block side tray** — a rail beside the grid, segmented into the
four blocks, each segment spanning that block's hours and holding only the unscheduled chores hinted
for it. It is a good idea and it loses on two specific, checkable grounds.

**It costs horizontal width, permanently, against a rule that has no slack in it.** §4.3 pins
"vertical scrolling only, no horizontal scroll anywhere," which is why the day view is flexbox over
N equal-width columns rather than CSS Grid (`day-ui.js`'s header comment states this as the reason).
A permanent rail subtracts its width from every child column on a fixed-width wall tablet, and gets
worse with each active child added. The chips inside those columns already have a narrowness
problem — §9's overlap handling collapses to a `+N` tile below `NARROW_CHIP_MIN_H` (72px).

**It cannot name a child.** A rail sits outside the columns, so an item in it has no child. That
breaks the §2.3 principle the whole board rests on and would force either a child name on every rail
item (a second label competing with the title, in the narrowest element on screen) or a rail nested
inside each column, at roughly 40px wide.

**And functionally it lands back where we started.** Tap a rail item to arm it, tap the grid to
place it, is today's tap-to-place with a pre-filter — §0.1's two-gesture chain, shortened but not
removed.

The grouping insight the rail was reaching for is kept: it is the sheet's filter (§2.2) and its
header (§6.1).

---

## 1. What does not change

Stated first, because the value of this slice is how little it touches.

- **No schema.** No migration, no new table, no new column. `migrations/` is untouched, so
  `worker/migrations.js` is untouched.
- **No Worker change of any kind.** No route added, no route modified, no validation change.
  `CLAUDE.md` §I.A's Data Flow cell for the Wall App stays accurate as written.
- **No new credential, no new scope.** §III.E's three classes and the four bounds on `/api/wall/*`
  are untouched, because no request shape changes.
- **No column ownership moves.** The only write this feature performs is `commitPlacement`
  (`day-ui.js:616`), which already writes `wall_slots` / `wall_slot_weekdays` / `wall_slot_days` and
  nothing else. **`assignments` is not touched at all** — not `expected_duration_min`, not
  `ASSIGNMENT_COMPLETION_FIELDS`, not anything. This feature never reaches the assignment row.
- **Every existing gesture survives unchanged.** The unscheduled tray stays (it is still the only
  way to reach a chore whose hint is wrong — see §2.3 — and the only way to *un*-place one). Tap to
  arm + tap to place stays. Drag from tray to grid stays. Long-press on a placed chip still opens
  the adjust sheet (§6.1 of Placement Scopes). Long-press on a school block still opens its span
  editor.
- **No new scope rule.** Which level the placement writes is decided by the code that already
  decides it (§2.4).

---

## 2. The model

One press resolves to three facts, all from things already on screen:

```
   long-press at (x, y) on empty grid space
            │
            ├── x  → the .day-column it landed in     → CHILD    (redesign §2.3)
            │
            └── y  → startMinFromPointer(...)          → MINUTE   (snapped to 15, day-ui.js:300)
                        │
                        └── ChoresCore.blockFromStartMin(minute % 1440) → BLOCK
                                                        (chores-core.js:118, §4.4's table)

   sheet lists: this CHILD's unscheduled chores whose hint === BLOCK
   tap one    → commitPlacement(row, MINUTE)
```

### 2.1 What "unscheduled" means here

Exactly what the tray means by it, resolved the same way: a chore row that is on this date
(`ChoresCore.choresForChild(rows, childId, date, today)`) and whose resolved chip has
`startMin == null` (`SlotsCore.resolveChip(...)`). That is `layoutPerChildGrid`'s own `unplaced`
test (`day-ui.js:2585-2601`), reached through the same two calls rather than a second rule that
could drift from it.

Note the consequence, which is inherited rather than chosen: `choresForChild` deliberately keeps
**completed** rows (so §8.4's done-in-place chip has a day to render on), so an unplaced-and-already-
complete chore appears in the tray today and will appear in this sheet too. Matching the tray is the
right call — diverging would mean two lists of "unscheduled" that disagree — but it is listed in
§11.2 as a thing to look at once, together.

### 2.2 What the hint filter is

`ChoresCore.effectiveBlockHint(row)` (`chores-core.js:81`) — `child_block_hint`, then `block_hint`,
then `"morning"`, mirroring `planner-core.js:54-56`. A row is a candidate when its hint equals the
pressed block. This is the *hint*, never a placement: a candidate has no `start_min` by definition
(§2.1), so `blockForChip`'s "the placement wins" branch cannot apply and is not consulted.

Candidates keep the order they arrive in, which is the parent's `sort_order` (`handlePlan` orders by
it). No re-sorting: within one block there is nothing to sort by that the parent has not already
said.

### 2.3 The "show all" fallback — and the hole it closes

A strict filter makes a morning-hinted chore **unreachable at 4pm through this gesture**. The tray
still reaches it, so this is not a dead end, but a gesture with a hole in it teaches people not to
trust it.

So the sheet's foot carries **Show all unscheduled**, revealing this child's remaining unplaced
chores — the ones the filter excluded — ordered by `ChoresCore.compareBlockHint` and each carrying
its block badge exactly as the tray renders it (`blockHintLabel`, §3.4.1). Tapping one places it at
the pressed minute, same as a matching chore. The badge is the whole point of showing it: you can
see that you are putting `Dishes · Evening` into the morning, and choose to.

The toggle is not sticky — every press opens filtered. The filter is the feature; the fallback is
the escape hatch.

### 2.4 What the placement writes (nothing new)

`commitPlacement(row, startMin)` unchanged. Its scope decision (`rows.chip.scope || "standing"`,
`day-ui.js:619`) resolves to `"standing"` for every chore this sheet can offer, and not by accident:
`resolveStartMin` returns `{ startMin: null, scope: null }` when there is no `wall_slots` row at all
(`slots-core.js:171`), which is Placement Scopes §2.1's gate — **a first placement is always
standing**, because "placed on Fridays only" would write a dormant override and leave the chore
sitting in the tray (§11.7).

So a Quick Place is a standing placement, carried forward to future days like any other, and the
move toast offers **Undo alone** rather than the two other scope buttons — `moveActions` already
returns exactly that when `wasAt == null` (`:655`). Per-weekday and per-occurrence times are reached
afterwards, from the placed chip's adjust sheet, which is where Placement Scopes put them. **This
slice adds no scope behaviour and changes none.**

---

## 3. Schema

**None.** Stated as its own section so a reader looking for the migration can stop looking.

## 4. Worker API

**None.** The one write is `WallApi.putSlot`, already called by `commitPlacement` on every drag and
every tap-to-place since Phase 5 of the redesign. No route is added, modified, or newly permitted.

---

## 5. The pure layer

One function, in `wall-app/js/chores-core.js`, beside the block helpers it belongs with:

```js
// Quick Place §2.2 — the unplaced chores whose hint puts them in `block`.
// `rows` is already-unplaced rows (the caller resolved that; this file has no
// placement index). Pure and order-preserving: the parent's sort_order
// survives, per §2.2.
function unplacedForBlock(rows, block) {
  return (rows || []).filter(function (row) {
    return effectiveBlockHint(row) === block;
  });
}
```

Exported on `g.ChoresCore`. That is the whole pure-layer change — deliberately: the resolution
"which rows are unplaced for this child on this date" needs the slot indexes and belongs at the call
site (`day-ui.js`), the same way `layoutPerChildGrid` and `layoutPerChildForBlock` already do it,
and the same way `buildAddSchoolSheet` recomputes `blocksNotOnDate` on every render rather than
closing over a stale list.

---

## 6. UI

### 6.1 The sheet

Reuses `.duration-sheet-overlay` / `.duration-sheet-card` / `.duration-sheet-actions` and the
`.school-picker-list` / `.overflow-sheet-row` row layout verbatim, exactly as the "+ School" fork
does (`wall.css:1517`'s comment already records that reuse as the house pattern).

```
┌──────────────────────────────────────┐
│  Morning · 08:15 — Sam               │   ← block name, pressed time (§11.3 fmt), child
│  ──────────────────────────────────  │
│  Feed the dog                        │
│  Make the bed                        │
│  ──────────────────────────────────  │
│  [ Show all unscheduled ]  [ Cancel ] │
└──────────────────────────────────────┘
```

- **Header:** `blockLabel(block) + " · " + TimeCore.formatMinutes(startMin, fmt) + " — " + child.name`.
  The time goes through the §11.3 formatter like every other clock on the wall, so a 12h household
  reads `8:15 am` here too.
- **A row is the whole tap target** — title only. No time (they are all going to the pressed
  minute), no duration, no stars. Under **Show all**, a row gains the block badge
  (`.day-tray-block`, `blockHintLabel(row)`) and nothing else.
- **Tapping a row** closes the sheet and calls `commitPlacement(row, startMin)`. The existing toast
  reports it, with Undo (§2.4), and the existing collision warning fires if it overlaps
  (`findCollisionForDrop`) — a Quick Place is never refused, per §3.6.
- **Dismissal:** `pointerdown` on the overlay, **not `click`** — `buildAddSchoolSheet` carries the
  comment explaining why (`day-ui.js:2018`), and the reason applies with more force here: the
  gesture that opens this sheet is a long-press whose own `pointerup`/`click` arrive *after* the
  overlay is in the DOM. Its `pointerdown` fired before the overlay existed, so it cannot dismiss
  it. Plus a `Cancel` button.
- **Sheet state is module-scope** (`quickPlaceSheetState = { child, startMin, block, showAll }`) and
  **rebuilt on every render**, joining the five sheets that already do this in `render()`
  (`:2868-2872`). Same reason as always: a background poll re-render every 10 minutes must not close
  the sheet out from under whoever is reading it.

### 6.2 The empty case

If the child has **no unplaced chores at all** on this date, the press does nothing — no sheet, no
toast. An empty modal on every stray press would be worse than the press doing nothing.

If the child has unplaced chores but **none matching the pressed block**, the sheet opens with
`Nothing unscheduled for Morning` in place of the list, and **Show all unscheduled** right there.
The press was not wasted: the fallback is one tap away, which is the case §2.3 exists for.

---

## 7. The gesture

This is the load-bearing section. The recogniser is small but it must not be `attachGesture`.

### 7.1 Why a long-press, and not a tap

Ray's call, 2026-08-26, offered both. **Long-press only.**

A plain tap on empty grid space is not free the way it looks: it is the *second half of
tap-to-place*. `attachGridTapToPlace` claims it whenever a tray item is armed (`:1032`). Giving the
unarmed tap a second meaning would mean the same physical gesture opens a sheet or places a chore
depending on invisible state — the thing §7.1 of Placement Scopes calls the worst failure mode,
arriving through the affordance meant to prevent it.

The cost is honest and worth stating: **a long-press is invisible.** Nobody discovers this without
being told. That is accepted, and §11.1 keeps a discoverability affordance open as a later,
separable question.

### 7.2 Why it cannot reuse `attachGesture`

`attachGesture` calls `ev.preventDefault()` and `setPointerCapture` on every `pointerdown`
(`:1166-1167`). That is correct for a chip — a chip must not scroll the page when you drag it — and
**it would break the grid.** A `.day-column` fills the entire scrollable body; `preventDefault` on
its `pointerdown` kills touch scrolling of the day view outright.

So Quick Place gets its own recogniser, `attachSlotPress(colEl, child)`, whose defining property is
what it does *not* do:

- **No `preventDefault`.** The grid scrolls normally.
- **No `setPointerCapture`.** The browser keeps the pointer and can hand it to the scroller.
- **No ghost, no drag, no drop.** There is nothing being dragged; there is a timer and a cancel.

```js
var PRESS_CANCEL_PX = 10; // a press that moves at all is a scroll — see below
```

Tighter than `TOUCH_DRAG_SLOP_PX` (44) on purpose. A chip's long-press tolerates 44px because it has
to be told apart from a *drag* of that chip. This press has no drag to be told apart from, only a
scroll, so any real movement is a scroll and cancels. `pointerup`, `pointercancel`, and movement
past `PRESS_CANCEL_PX` all clear the timer; `pointercancel` is what actually fires on most touch
scrollers once the browser takes the gesture over.

`LONG_PRESS_MS` (550) is reused, not re-tuned — one press duration across the whole app.

### 7.3 What the press must ignore

Three exclusions, checked on `pointerdown` before the timer is even set:

1. **`ev.target.closest(".day-chip, .day-chip-hit, .school-block-chip")`** — these carry their own
   long-press (the adjust sheet; the block span editor). `.day-chip` also covers the `+N` overflow
   tile. This is `attachGridTapToPlace`'s own exclusion idiom (`:1037`), extended by the school-block
   class.
2. **`selectedForPlacement` is armed** — a tray item is mid-placement. The armed tap-to-place wins;
   Quick Place stands down entirely rather than racing it. One placement gesture is in flight at a
   time.
3. **`ev.button !== 0`** — as everywhere else.

The time gutter needs no exclusion: `.day-gutter` is a sibling of the columns inside
`.day-grid-body`, not a descendant of one, so attaching to `.day-column` excludes it structurally.

### 7.4 Where it attaches, and which modes get it

In `buildColumn` (`:2419`), which is called by `buildGridBody` — so it lands in **grid mode and
single-expanded-block mode**, the two modes with a real time axis, and nowhere else. Collapsed block
mode builds its rows through `buildBlockRow`, not `buildColumn`, and gets nothing; the events band
and the early/late strips likewise. That is the same boundary Phase 5 drew for drag and
tap-to-place, inherited rather than restated.

### 7.5 Coordinate space

The handler reads `current.range` **at fire time**, never from a closure — exactly as
`attachGesture`'s `onUp` does, and for the identical reason (`render()` sets `current.range` on
every render, and a handler bound during an earlier render must not use the old mode's window).

```js
var virtual = startMinFromPointer(ev.clientY, bodyEl, current.range.start, current.range.end);
var startMin = virtual % 1440;                       // block-virtual → real clock minute
var block    = g.ChoresCore.blockFromStartMin(startMin);
```

In single-block mode `virtual` may exceed 1440 (the night block's wrap, §4.4); `% 1440` converts
back before anything reads it, matching `attachGridTapToPlace:1041`. In that mode `block` is by
construction the expanded block, so the sheet's filter agrees with the tray above it — which is
correct, and means the sheet's value there is placing at an exact minute rather than filtering.

---

## 8. Tests

`tests/wall-cores.test.js`, alongside the existing block-classification tests (`:225-253`):

1. **`unplacedForBlock` filters on the hint chain** — a row with `child_block_hint: "evening"` and
   `block_hint: "morning"` is an evening candidate, not a morning one; a row with neither is a
   morning candidate (`effectiveBlockHint`'s default).
2. **`unplacedForBlock` preserves input order** — the parent's `sort_order` survives the filter.
3. **`unplacedForBlock` on an empty/absent list** returns `[]`, not a throw.
4. **The block boundaries are the ones the press will land on** — already covered by the existing
   `blockFromStartMin` boundary test; this slice adds no new hour table and must not introduce one.

The gesture itself is DOM and pointer behaviour, so it belongs in §9's manual checks, not here —
`tests/` covers the pure layers only (CLAUDE.md §I.B).

### 8.1 Manual acceptance (on the tablet)

1. Long-press empty space at ~08:15 in one child's column → sheet headed `Morning · 08:15 — <name>`,
   listing only that child's morning-hinted unplaced chores.
2. Tap one → it appears as a chip at 08:15, toast says so, **Undo** restores it to the tray.
3. Long-press at ~19:00 → an **Evening** sheet, different candidates.
4. **Show all unscheduled** → the remaining chores appear with block badges; placing one works.
5. **Scroll the grid with a finger starting on empty space** → the day scrolls and no sheet opens.
   *(The single most important check in this list — §7.2.)*
6. Long-press a **placed chip** → the adjust sheet, not this one.
7. Long-press a **school block** → its span editor, not this one.
8. Arm a tray item, then long-press empty space → nothing opens; the armed placement still works.
9. Switch to a single expanded block, long-press inside it → sheet opens, headed with that block.
10. In collapsed block mode → no press behaviour at all.
11. A child with nothing unplaced → press does nothing.
12. Leave the sheet open across a poll (≥10 min, or force one with a write elsewhere) → it survives.

---

## 9. Build phasing

| Phase | Scope | Est. |
|---|---|---|
| **1 — Pure layer** | `ChoresCore.unplacedForBlock` + §8's tests. | ~20 min |
| **2 — Gesture & sheet** | `attachSlotPress` in `buildColumn`, `quickPlaceSheetState` + `buildQuickPlaceSheet`, the render hook, the CSS reuse. | ~1.5 h |
| **3 — Acceptance** | §8.1 on the tablet; this file's status line updated. | ~20 min |

Total ~2 h — inside CLAUDE.md §V.A's 2–3 hour gate, and phases 1 and 2 are separately committable.

---

## 10. Guardrail amendments this requires

**None.** Recorded explicitly, because every wall slice so far has needed one and a reader will look
for it.

- No new wall-owned table → §I.A's write list and §III.E's "the wall's own tables" bullet are
  unchanged.
- No new route → §I.A's Data Flow cell is unchanged and stays accurate.
- No `assignments` write of any kind → §0's column-ownership row and §IV.B's placement-write check
  are satisfied trivially; `expected_duration_min` is not read, let alone written.
- No credential class, no new `child_id` path → §III.E's four bounds are untouched, since no request
  shape changes.
- No narrowing of any locked decision → §VII gains nothing.

`CLAUDE.md` is not edited by this slice. §VIII may gain a file reference for this document when the
build lands, which is a pointer, not an amendment.

---

## 11. Open items

**11.1 — Discoverability is unsolved, deliberately.** §7.1 accepts an invisible gesture on Ray's
call. If it goes unused, the separable follow-ups, cheapest first: a one-line hint in the empty tray
cell (`Long-press a time to place a chore`); a faint press-in progress ring on the pressed slot; or
revisiting the plain-tap question with the arming state made visible. None of these change the model
in §2 — they are all about advertising it.

**11.2 — A completed-but-unplaced chore is offered.** Inherited from the tray, not introduced here
(§2.1). It is arguably wrong in both places. Worth one look at the tray and this sheet together, and
deliberately not fixed in one of them alone.

**11.3 — The toast says "moved" for a first placement.** `commitPlacement`'s wording
(`day-ui.js:636`) reads `<title> moved to 08:15 — every day`, which is slightly off when the chore
came from the tray rather than from another time. Pre-existing — the tray's own drag says the same —
so it is named here, not changed here. A `wasAt == null` branch saying `placed at` is a one-line fix
if it grates.

**11.4 — A slot fully covered by a school block cannot be pressed.** §7.3's first exclusion means a
press inside a block's span opens the *block's* sheet, so a chore cannot be Quick Placed into school
hours. The tray still reaches it, and overlapping a school block is unusual enough that a second
gesture for it is not obviously worth it. Flagged rather than solved.

**11.5 — `.day-chip-hit`'s padding extends up to 14px past a chip** (`HIT_PAD_MAX_PX`), so presses
in a narrow gap between two chips are excluded along with the chip itself. Correct — that padding
exists so §8.1's tap target is reachable — but it means the pressable gaps are slightly smaller than
they look. Only worth revisiting if it is felt in use.

---

## 12. Revision log

| Date | Change |
|---|---|
| 2026-08-26 | Written. Ray reported that placing an unscheduled chore is arm-then-aim (§0.1) and proposed two fixes: a per-block side tray, or a long-press on an open slot offering the chores hinted for that block. He chose the long-press (§0.3 records why the rail loses on §4.3's no-horizontal-scroll rule and on child attribution), long-press only with no plain-tap variant (§7.1), and the filtered list with a **Show all unscheduled** fallback (§2.3). Design only, no code — the same order §2.9 of `CLAUDE.md` set for Placement Scopes. |
