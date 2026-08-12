# SRS — Management App, Module 13: Assignment Messages

**Status:** Stub, authored 2026-08-12 ahead of the build, per
`TDS_Slice_Child_Feedback_Loop.md` §6.5 and §11.10. The controlling design is that slice's §6;
this document is the module contract the build is checked against, and exists because
`CLAUDE.md` §II.3 requires a current SRS for every affected module before code is written.

**Scope:** the *parent-facing* half of one-way assignment messaging — the inbox that makes a
child's question readable, and the read-state that stops it being asked twice. The Child App's
composer is Child Module 04's concern (Activity/Chore Completion), not this one; the two share the
`assignment_messages` table and the API, never a JS file (`CLAUDE.md` §I.A).

**Depends on:** `migrations/0005_assignment_messages.sql` (not yet written), and the three routes
in the slice's §6.2. None of those exist as of this stub.

---

## 1. Purpose

A child working alone hits a question — "I don't understand problem 7," "the video won't load,"
"is this the right chapter?" — and today has nowhere to put it. The completion note (§5, Module 04)
is the wrong place: it is attached to work already finished, and nothing tells the parent a note is
waiting. This module gives the question a destination and gives the parent a queue.

**One-way, v1.** Child → parent only. There is no reply channel, and the Child App does not poll
for one. That is a decision (slice §0.3), not an omission; two-way threading is deferred (§7.2).

---

## 2. Functional requirements

**FR-1 — Inbox list.** A new Management App view lists messages newest-first. Each row identifies
the sender (child name), the assignment the question is about (title + date — enough to recognise
it without opening anything), the body, and when it was sent.

**FR-2 — Unread is the default filter.** The inbox opens on unread. A parent's question is "what
needs me," not "what has ever been asked." Read messages remain reachable through a filter, never
deleted.

**FR-3 — Unread badge on the nav.** A count beside the existing `Assignments / Reporting /
Settings` nav, so a message is discoverable without visiting the view. Zero unread shows no badge
rather than a "0".

**FR-4 — Mark read is explicit and reversible-by-omission.** A parent marks a message read; the
action sets `read_at` and never deletes the row. `read_at` is the one parent-owned column on an
otherwise child-owned, append-only table (slice §8). There is no "mark unread" in v1 — flagged in
§7.4 rather than assumed away.

**FR-5 — Read state is server-side, not per-device.** `read_at` lives on the row, so a parent who
reads on a phone does not see it unread again on a laptop.

**FR-6 — A message outlives its assignment.** Rescinding an assignment (`rescinded_at`) does not
hide, delete, or alter messages attached to it. The question was still asked. The inbox marks such
a row as referring to withdrawn work rather than dropping it.

**FR-7 — No message is ever destroyed by this module.** The table is append-only but for `read_at`,
matching `reward_entries`. There is no delete action in the UI and no route that offers one.

---

## 3. Non-functional / constraints

| Constraint | Source |
|---|---|
| Body capped server-side | Slice §6.2 proposes 500 chars — **still open** (§7.1) |
| `child_id` derived from the device token, never the body | `CLAUDE.md` §III.E |
| A device may only message an assignment it owns | Slice §6.2 — a `child_id` check before insert |
| Client-minted UUID id, idempotent insert | Online Revamp §5.5 |
| Parent reads with `SYNC_TOKEN`; child appends with a device token | `CLAUDE.md` §III.E |
| Query results capped via `capRows` / `MAX_QUERY_ROWS` | Existing convention |
| Migration applied in-browser, registered in `worker/migrations.js` | `CLAUDE.md` §III.D |

---

## 4. Data

Defined in the slice's §6.1; not restated here to avoid a second source of truth. One table,
`assignment_messages`, two indexes, one nullable parent-owned column (`read_at`).

---

## 5. Routes

Defined in the slice's §6.2: `POST /api/messages` (device), `GET /api/messages` (parent),
`POST /api/messages/read` (parent).

Note for the build: all three land after §11.7's containment, so a fault against a table the
migration has not yet created is a per-row `deferred` on the device-authenticated route rather than
a drain-wide stall — provided the new route follows the same pattern the other two device batch
routes now use, and honours `X-Outbox-Protocol`.

---

## 6. Out of scope for v1

Parent replies; child-visible read receipts; child-side polling; notifications of any kind
(push, email, sound); message threading; attachments; editing or deleting a sent message.

---

## 7. Decisions and open items

Three of the five below were decided in-session with Ray on 2026-08-12, before any code was
written. They are recorded here rather than removed, so the contract shows what was chosen and
what it was chosen against.

1. ~~**Body cap.**~~ **DECIDED: 500 characters** (`MAX_MESSAGE_LEN`, `validation.js`), deliberately
   shorter than the completion note's 1000. A message is a question, not the account of finished
   work a note carries, and the inbox is a list a parent scans rather than reads. Measured after
   trimming, so padding cannot push a legal body over the line and a whitespace-only body is
   rejected as empty rather than stored.
2. **Two-way messaging** — still deferred, by slice §0.3 / §11.2. No reply route exists and no
   `created_by: 'parent'` write path exists; that absence is the enforcement.
3. ~~**Phase split.**~~ **DECIDED: backend first, UIs deferred.** Migration 0005 and the three
   routes ship on their own; the Child App composer (slice §6.3) and this module's inbox (§6.5) are
   later releases, each to be sequenced when it is taken up. The migration ships *with* the routes
   rather than one release ahead — the §5.5 ordering exists to protect a client mid-drain, and at
   this point no client calls these routes at all.
4. ~~**Mark-unread.**~~ **DECIDED: not in v1.** `read_at` goes from NULL to a timestamp and is never
   cleared, matching `rescinded_at` and `revoked_at`. There is no route that clears it, which is
   how the decision is enforced rather than merely documented.
5. **What the child sees after sending.** Slice §6.3 proposes a local "📨 sent" marker on the card.
   That is Child Module 04's surface, but it is the only feedback a one-way channel offers, so it
   should be confirmed when the composer is built. **Still open.**

---

## 8. Build status

| Piece | Status |
|---|---|
| `migrations/0005_assignment_messages.sql`, registered in `worker/migrations.js` | ✅ Landed |
| `POST /api/messages` (device) — per-row rejection, ownership check, idempotent insert | ✅ Landed |
| `GET /api/messages` (parent) — filters, assignment join, unread count | ✅ Landed |
| `POST /api/messages/read` (parent) | ✅ Landed |
| Child App composer (slice §6.3) — IndexedDB store, outbox op, UI | ⬜ Not started |
| Management App inbox (§1-§5 above) | ⬜ Not started |

**Ray applies migration 0005** from Settings → Database before the first client release. Nothing
reads or writes the table until then, so there is no window to get wrong.
