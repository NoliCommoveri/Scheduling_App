# TDS Slice — Completed Courses

**Status:** Built 2026-10-12
**Scope:** Management App only. No Worker change, no migration, no schema change, no new route,
no credential change.
**Amends:** `SRS_Management_Module_04_Child_Management.md` (FR-16).

---

## 0. What this is, and what it is not

**It is a way to clear finished courses out of the Assigned Courses list.** Each assigned Course
gets a **Mark complete** button. A completed Course leaves the main list and moves to a
**Completed Courses (N)** section below it, collapsed by default, where **Open** and **Reopen**
stay one click away.

**It is a view state, not a lifecycle.** Ray chose in-session (2026-10-12):

1. **Manual, not automatic.** A Course is completed when the parent says so. It is not inferred
   from "every Activity delivered". If it were, a Course the parent is still adjusting could drop
   out of view without warning, and the list would need a D1 read on every render.
2. **View only.** Nothing reads the flag except the Assigned Courses list, the Course's detail
   page and the child page's count. Propose, the weekly overview, reporting, grading and the
   Child and Wall apps are unchanged. Marking a Course complete therefore can never withhold or
   lose work. A completed Course with Activities still pending keeps generating, the same as
   before.

The precedent is a child's Archive/Restore (`children.active`, Online Revamp §3.2): the same
dimmed, never-red treatment, with every control still reachable.

## 1. Data

One sparse field on the Course **Instance** record (`state: 'instance'`):

| Field | Type | Meaning |
|---|---|---|
| `completedAt` | `YYYY-MM-DD` (local date) | Present = completed on that date. Absent = in progress. |

Course records are opaque JSON blobs in the D1 `records` mirror, so the field rides the existing
`records` sync push exactly as `gradingRubric` does. No column, no migration and no Worker
validation are involved. Template Courses never carry it.

Reopening **deletes** the key rather than writing `null`, so a reopened record is byte-identical
to one that was never completed. `editInstanceCourse` spreads the existing record, so renaming a
completed Course keeps its `completedAt`.

## 2. UI (`management-app/js/instances.js`)

- **List rows:** `Open · Mark complete · Un-assign`.
- **Completed section:** a `<details class="completed-courses">` after the in-progress groups.
  It is a flat list sorted by child, then by name, with each row showing the child's name and
  completion date. It has `Open` and `Reopen` and no Un-assign. It honours the page's child filter.
  Its open/closed state lives in module memory like the subject groups do.
- **Detail page:** a `Mark complete` button, or `Marked complete <date>. Reopen`, beneath
  "Assigned to …".
- **Child page (`children.js`):** the count reads "N Courses in progress, M completed."

## 3. Acceptance

1. Mark complete moves a Course from its subject group into Completed Courses (N). The other
   Courses for that child are unaffected.
2. Reopen returns it to its subject group, and the stored record has no `completedAt` key.
3. A completed Course's Activities still appear in Propose exactly as before (view only).
4. With the child filter set, only that child's completed Courses are listed.
5. When every Course is completed, the main list reads "Every assigned Course here is marked
   complete." instead of "No Courses assigned yet."
