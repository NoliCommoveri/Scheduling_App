# Split-Account Build — Session Guide

*Load this alongside the Domain Model, Architecture Evaluation, SRS modules, Roadmap, the relevant TDS slice, and `Interchange_Contract.md`. This document explains the current build arrangement and what any Claude session — Child App or Management App — should assume about its own role before doing any work.*

---

## 1. What's happening

This project builds two apps — Child App and Management App — that never share a database and were designed from day one to interact only through one thing: the interchange (a Packet going one way, a Completion CSV going the other). That existing design choice (Domain Model §5.3, "two schemas, one contract") is what makes the following arrangement possible:

**The two apps are now being built by two separate Claude accounts, in parallel, each coding against its own part of the same GitHub repo.**

Neither session is "in charge" of the other. Neither session has visibility into the other's conversation history. The parent (Jen) is the only participant who sees both sides — which makes Jen the integration point, not just the requester.

---

## 2. Which one are you?

Before doing anything else, work out — from context, from what's been loaded, or by asking — which of these two you are:

- **Child App session** — scope is everything under Roadmap milestones M1–M3: Startup Wizard, Packet Import, Daily Planner, Activity/Chore Completion, Deferment/Waive, Reward Economy, Streak, Completion CSV Export, Wipe, Theming, Settings.
- **Management App session** — scope is everything under Roadmap milestones **M4–M10** (re-cut; the old "M4–M6" range predates the Management SRS and is superseded — Roadmap §5): shell + `launchPin` + Curriculum + Tiers (M4); Course Template Library manual path + Child Management (M5); Chore + Family Event Authoring (M6); **Pacing + Packet Generation & Export (M7 — the seam)**; bulk CSV import + content-planning presets + backup/restore (M8); Master Reporting (M9); Completion Import (M10, still "Phase 4" in Architecture Evaluation §12 terms).

You build **only** your own app. You do not open, read, or reason about the other app's code, even if it's sitting in the same repo. If a question about the other app comes up, that's a signal to stop and say so — not to infer an answer from the Domain Model and proceed as if you'd confirmed it with the other side.

---

## 3. What you can rely on without checking further

Everything in the Domain Model, Architecture Evaluation, SRS modules, and locked decisions (Roadmap §6, §7) applies to you regardless of which app you are. These were written before the split and don't change because of it. In particular:

- The two schemas are permanently separate. You will never need to know the other app's IndexedDB structure, file layout, or internal module boundaries to do your job correctly.
- **`Interchange_Contract.md` is the complete and only description of what crosses between the apps.** If it's not in that file, it doesn't cross the boundary — full stop. You do not need the other app's TDS slice, and the other session does not need yours.
- Locked modeling decisions (no propagation, unique-at-creation IDs, additive-with-refresh-on-pending import, two independent PINs, no spend channel in the interchange, etc.) bind you exactly as they would a single combined session. Being one of two sessions is not license to revisit them.

---

## 4. What you must treat as a hard boundary

- **Repo folders are non-crossing.** Work only inside your app's top-level folder (e.g. `/child-app` or `/management-app`). Never import from, reference, or "helpfully" reuse code in the other folder. `Interchange_Contract.md` at the repo root is the one file both folders may reference.
- **You do not modify `Interchange_Contract.md` unilaterally.** If your build work surfaces a reason the contract needs a new field, a changed rule, or a clarification, stop and flag it to Jen explicitly rather than adjusting the shape on your own side and assuming the other session will match it. A contract that only one side has updated is worse than one neither side has touched — it produces work that looks done and isn't.
- **A TDS slice must exist for your milestone group before you start building it.** `TDS_Slice_M1_Child_App.md` is the existing precedent. If you're picking up a Management App milestone (M4+) and no equivalent slice exists yet, that's the prerequisite to write first — with Jen, in this session or a prior one — not something to improvise as you go.
- **Style is yours to own.** Code style, comment conventions, and internal structure can differ from whatever the other app's session is doing. That's expected and not a defect — the apps never share code, so there's nothing to reconcile there.

---

## 4a. M7 is the moment the two builds actually meet

Everything before M7 on the Management side is authoring that nothing has verified. **M7's exit criterion is not "Packet Generation is written" — it is "a packet this app generated was imported, clean and end to end, by the other app."** That is a two-account, two-session event, and Jen is the only participant who can run it.

Practically: when the Management session reaches the end of M7, it produces a real packet file and stops. Jen carries that file to the Child App session, which imports it through its already-built Module 2. A failure there is *the* finding the whole seam design exists to surface, and it is far cheaper to surface at M7 than at the end of the build. Neither session may declare M7 done on its own — the Management session cannot see the import succeed, and the Child session cannot see how the packet was produced.

Until that has happened once, treat every packet-shaped assumption on either side as unproven, however carefully it was written down.

---

## 5. The one thing that requires coordination: the interchange

The interchange (Packet + Completion CSV, per `Interchange_Contract.md`) is the single seam between two otherwise-independent builds. Treat any work that touches it as higher-stakes than ordinary within-app work:

- Before writing or changing anything on your side of the interchange (Packet Generation/Export on the Management side; Packet Import on the Child side; Completion CSV Export on the Child side; Completion Import on the Management side), re-check `Interchange_Contract.md` in this session — don't rely on a memory of it from an earlier session.
- If your work reveals the contract is ambiguous or incomplete for something you need to build, that's not yours to resolve alone. Surface it plainly: "the contract doesn't specify X — here's what I'd assume, but this needs to be confirmed against the other side before I proceed."
- Assume the other session cannot see anything you decide unless it's written down in `Interchange_Contract.md`, the Domain Model, or the relevant SRS module. A decision that only exists in this conversation does not exist for the other app.

---

## 6. Reconciliation ritual (for Jen, referenced here so both sessions know it exists)

After any session — on either side — that touches the interchange, Jen does a short reconciliation pass: diff what changed against `Interchange_Contract.md`, update it plus Domain Model §4 and the relevant SRS module in the same pass, and feed the updated file into the *other* account before that session's next work block. If you're a session being handed a freshly updated `Interchange_Contract.md`, treat it as authoritative over anything you inferred previously — including things you may have inferred earlier in this same conversation.

---

## 7. Quick self-check before you start building

1. Which app am I? (§2)
2. Do I have the current `Interchange_Contract.md`, not a stale copy? (§5, §6)
3. Does a TDS slice exist for the milestone I'm about to build? If not, that's the first thing to produce. (§4)
4. Is anything I'm about to build going to touch the Packet or the Completion CSV? If yes, re-read §5 before writing code.
5. Am I about to reference, assume, or "fill in" anything about the other app that isn't written in a shared document? If yes, stop and flag it instead.
