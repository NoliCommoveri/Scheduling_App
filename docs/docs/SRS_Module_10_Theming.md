# Software Requirements Specification — Child App
## Module 10: Theming

*Written against Architecture Evaluation  §10 (theming and the reward economy), Domain Model §3.9, Module 1's theme-timing note, and Module 6's per-category display consumer. Per-kid theme gating is **resolved and locked** (Domain Model §0/§3.9, Roadmap §8, Architecture Evaluation §13): no gating, full child choice.*

---

## 1. Purpose

Owns the visual presentation layer — palette and signature themes, and the Reward Category display mapping that Module 6 depends on. This is the module the Roadmap's M3 milestone refers to: the point where reward *earning* (working since Module 4/M2) finally becomes reward the child can actually *see* (Module 1 §2, Module 6, both flag this dependency).

## 2. The four-part structure and two tiers

Per Architecture Evaluation §10: "the four-part theme structure (Palette / Emoji-icon set / Copy pack / Signature reward visual), the two tiers (Palette themes vs. Signature themes)."

A theme is built from **four components**:
1. **Palette** — the color scheme (CSS custom properties).
2. **Emoji-icon set** — the icons used throughout that theme.
3. **Copy pack** — the theme's own microcopy/tone (e.g., "Saddle up, Fall 2025" vs. "LET'S BUILD, NORA!").
4. **Signature reward visual** — the theme's own bespoke way of visualizing progress/reward (e.g., a ribbon rail vs. a build grid).

**The two tiers are defined by how many of those four a given theme customizes:**
- **Palette themes** customize **only the Palette** (color swap) — e.g., a simple "Space / Ocean / Dino / Rainbow" swatch row, which shows color only, no distinct icons/copy/visual per swatch.
- **Signature themes** customize **all four parts** — having a bespoke reward visual (paired with bespoke icons and copy) is what makes a theme "Signature" rather than "Palette."

Palette themes share **generic** versions of the Emoji-icon set, Copy pack, and Signature reward visual — only the Palette itself is custom per Palette theme.

**Base tier/category count:** the Difficulty Tier & Reward Category reference table (Domain Model §2.3) is seeded with **4 base tiers** (expanded from the original 3). Each Signature theme must supply a distinct name/icon/visual for all 4 — the specific per-category design (labels, icons, visual treatment for the 4th tier in each theme) is being worked out in the TDR and is not specified in this SRS.

**The two Signature themes being built:**
- **Horse Lover** — the "Stable" theme (ribbon rail as its signature reward visual, warm hay/leather palette, horse iconography).
- A **Minecraft-inspired builder theme** — the "Builder" theme (build grid as its signature reward visual, voxel/blocky styling), evoking the voxel-builder genre generically ("the Walmart version, not copyright infringing") — which makes FR-4's licensed-IP guardrail directly load-bearing for this specific theme, not just a hypothetical rule. It can evoke the voxel-builder genre (blocky shapes, pickaxe iconography, that general aesthetic) but must not use the name "Minecraft," any Mojang/Microsoft trademarks, official block/mob textures, or the actual typeface/logo treatment. "Builder" is a safe in-app name; "Minecraft" should never surface anywhere the child or a reviewer would see it.

**Licensed-IP guardrail:** stated explicitly in Architecture Evaluation §10 ("No copyrighted assets, characters, or logos. Beloved franchises are captured as *aesthetic-adjacent* themes built from non-ownable elements"). FR-4 below matches that text directly.

## 3. Per-kid theme gating — resolved and locked

**Full child choice, no gating.** The child can switch between any available theme — palette or signature — at any time, from within the app, without a PIN or any parental approval step. There is no mechanism to restrict which themes a given child can access.

## 4. User stories

- As a child, I want to pick a theme that feels like mine, and change my mind whenever I want.
- As a parent, I want every theme to feel polished and safe — nothing borrowed from a real franchise that could cause IP trouble or feel like a knockoff.
- As a parent, I want theming to stay light on a budget Android device — no lag, no janky animation, nothing hard to tap.

## 5. Functional requirements

**FR-1 — Four-part theme structure, two tiers (§2).** Every theme is composed of four parts: Palette, Emoji-icon set, Copy pack, and Signature reward visual. **Palette themes** customize the Palette only, using shared generic versions of the other three parts. **Signature themes** customize all four parts, including their own bespoke reward visual (e.g., a ribbon rail or build grid). Both tiers are built entirely from plain DOM/CSS — no separate rendering technology between them.

**FR-2 — Free child choice (§3).** Switching themes requires no PIN and no confirmation beyond the switch itself. Every available theme is available to every child on every device, always.

**FR-3 — Reward Category display mapping ("display skin per Reward Category," Architecture Evaluation §10).** Each theme supplies a name and icon/visual per Reward Category, layered over the neutral, kid-invisible internal `categoryId` the Ledger actually stores. A category with no entry in the currently active theme's mapping falls back to a shared, theme-neutral **generic default** display — never a raw `categoryId`, never blank, never an error. **This fallback is required from the very first theme built, not a later polish pass** — a parent can add a new difficulty tier, and its paired category, at any time, and display must never break when they do.

**FR-4 — Licensed-IP guardrail.** No theme may use, reference, or closely evoke a real trademarked character, franchise, or brand. Themes evoke a genre or vibe (a stable, a builder's world) through original art, language, and design only. This applies to every theme, including any added after this SRS is written.

**FR-5 — Reliability rules.** Plain DOM/CSS only — no canvas, no WebGL, no animation library. No continuous or repaint-costly animation. Every interactive touch target is at least 44px, in every theme, on every screen.

**FR-6 — Shared storage with Module 1.** The `themeId` field this module reads and writes is the exact same field Module 1's Startup Wizard first set — there is no separate or duplicated theme-selection data model.

**FR-7 — Live application.** Switching themes applies immediately across the whole app — no restart, no reload required.

## 6. Validation rules

| Rule | Detail |
|---|---|
| `themeId` | Must always resolve to a theme bundled with the current app build. If a previously-selected theme is somehow no longer available (e.g., after a build downgrade), fall back to a default palette theme rather than erroring. |
| Reward Category display | Every category must resolve to either a theme-specific or generic-default display — never a raw ID, never a blank. |
| Touch targets | ≥44px for every interactive element, in every theme. |

## 7. Permissions

None. Theme switching is entirely child-initiated and ungated (§3).

## 8. Inputs / Outputs

**Inputs:** the set of themes bundled with the current app build; the Reward Category list as referenced by any item the child has ever earned into (from the Reward Ledger, Module 6); the child's theme selection.

**Outputs (written to device storage):** `themeId` on Theme/Settings — the same field Module 1 first populated (FR-6). No other module's data is touched.

## 9. Acceptance criteria

1. Switching themes changes the full visual presentation immediately, without a PIN, confirmation, or restart.
2. A Reward Category with no theme-specific mapping under the active theme still renders correctly via the generic default, in every theme.
3. No screen, in any theme, references a real trademarked character, logo, or franchise.
4. Every interactive element meets the 44px touch-target minimum, in every theme.
5. No theme contains continuous or repaint-heavy animation.
6. The `themeId` set during Startup Wizard (Module 1) is the exact value read and updated here — switching themes later never creates a second, conflicting theme field.
7. A Palette theme shows a custom color scheme paired with the shared generic icon set, copy pack, and reward visual — never a half-custom mix. A Signature theme shows all four parts customized together.
8. The Horse Lover and the Minecraft-inspired Builder theme each render their own distinct Palette, Emoji-icon set, Copy pack, and Signature reward visual — no shared/generic fallback appears in either.
9. All 4 base Reward Categories render with a bespoke, theme-specific name/icon/visual in both Signature themes (Horse Lover, Builder) — no base category falls through to the generic default in either theme. (Specific per-category design is defined in the TDR, not this SRS.)