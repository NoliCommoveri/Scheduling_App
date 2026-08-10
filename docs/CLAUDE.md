# CLAUDE.md — moved

The build-session guardrails live at **`/CLAUDE.md`** in the repository root. That is the
only copy Claude Code loads, and the only one kept current.

This file previously held a byte-identical duplicate. Two copies of a constraints document
is a hazard in itself — a session that reads the stale one builds against repealed rules —
so it has been reduced to this pointer rather than maintained in parallel.

**Current version: 2.0 (2026-08-10)**, which repeals the offline-first architecture in
favour of Cloudflare D1 as the system of record. See `docs/TDS_Slice_Online_Revamp.md` for
the controlling design.
