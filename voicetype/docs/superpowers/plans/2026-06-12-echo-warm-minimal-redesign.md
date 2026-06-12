# Echo Warm-Minimal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the whole Echo app to the approved "warm minimal hybrid" direction — airier two-layer surfaces, hairlines instead of boxes, serif demoted to display moments, clay as the only accent.

**Architecture:** All surfaces flow through CSS variables and shared `echo-*` classes in `src/renderer/index.css`, so the redesign lands as (1) a token retune, (2) a shared-class restraint pass, (3) small structural edits to the shell (`App.tsx`) and home (`Dashboard.tsx`), then (4) per-screen verification passes that fix local deviations. Visual verification uses the existing Playwright UI driver (`scripts/ui-driver.mjs`).

**Tech Stack:** Electron + React + Tailwind + CSS variables. No new dependencies. Spec: `docs/superpowers/specs/2026-06-12-echo-warm-minimal-redesign-design.md`.

**Working directory:** `D:\VoiceDT\voicetype` (all paths below relative to it).

---

## The cohesion contract (used by every verification step)

1. Shell canvas `#F2F0EA` visible around a floating `#FDFCFA` content panel, ~16px radius, whisper shadow, no hard border.
2. Hairlines (`var(--line-soft)`) separate list rows; white bordered cards only for true containers (settings group, snippet row container).
3. Serif (`var(--font-display)`) ONLY on: home greeting, stat numerals, empty-state headlines, the Echo wordmark. Screen titles, ledes, nav, buttons, labels = sans (`var(--font-body)`).
4. Clay `#C96442` is the only accent (primary buttons, active states, streak). Moss/amber status-only.
5. Spacing: content gutters ~44-48px, section gaps ~32px, list rows airy.
6. No boxes inside boxes; no competing borders.

## Visual verification harness (used by several tasks)

```powershell
# one-time per session, from D:\VoiceDT\voicetype (run in background):
node scripts/build-bundles.cjs --dev
node scripts/ui-driver.mjs        # run_in_background; polls .ui-driver/cmds.txt

# drive it by appending lines to .ui-driver\cmds.txt:
Add-Content .ui-driver\cmds.txt "launch"      # wait ~12s
Add-Content .ui-driver\cmds.txt "show"
Add-Content .ui-driver\cmds.txt "resize 1280 800"
Add-Content .ui-driver\cmds.txt "ss home"     # screenshot -> .ui-driver/shots/home.png
Add-Content .ui-driver\cmds.txt "click-text History"   # navigate tabs by label
Add-Content .ui-driver\cmds.txt "quit"        # when done
```

Read `.ui-driver/driver-log.txt` for command results and the PNGs in `.ui-driver/shots/` with the Read tool. After editing source, rebuild (`node scripts/build-bundles.cjs --dev`) and relaunch (`quit` then `launch`) — the app loads built bundles, not a dev server.

---

### Task 1: Token retune

**Files:**
- Modify: `src/renderer/index.css` (`:root` block, lines ~75-207)

- [ ] **Step 1: Retune the HSL Tailwind tokens**

In the `:root` block, replace these values (leave all others untouched):

```css
    --background: 40 43% 99%;             /* #FDFCFA  pane / main writing surface */
    --card: 0 0% 100%;
    --popover: 40 43% 99%;                /* #FDFCFA  main panel + popover sheet */
    --secondary: 45 24% 94%;              /* #F4F2EC */
    --muted: 45 24% 96%;                  /* #F8F7F3  card-soft */
    --border: 44 22% 90%;                 /* #EBE8E0  hairline, quieter */
    --border-strong: 44 16% 84%;          /* #DEDAD0 */
    --input: 44 22% 90%;
    --sidebar: 45 24% 93%;                /* #F2F0EA  sidebar merges into shell */
    --app-bg: 45 24% 93%;                 /* #F2F0EA  outer canvas */
```

- [ ] **Step 2: Retune the raw redesign tokens**

In the same `:root` block:

```css
    --canvas: #F2F0EA;
    --sidebar-bg: #F2F0EA;
    --pane: #FDFCFA;
    --card-raw: #FFFFFF;
    --card-soft: #F8F7F3;
    --line: #EBE8E0;
    --line-soft: #EFECE4;
    --line-strong: #DEDAD0;
```

(`--ink*`, `--clay*`, `--accent*`, `--moss`, `--amber`, toast/status tokens all stay.)

- [ ] **Step 3: Typecheck still passes (CSS-only change, sanity)**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```powershell
git add src/renderer/index.css
git commit -m "restyle(tokens): quieter warm-minimal surface + hairline palette"
```

### Task 2: Shell — floating panel, quiet sidebar

**Files:**
- Modify: `src/renderer/App.tsx:1523` (main panel classes)
- Modify: `src/renderer/index.css` (`.echo-nav-item` ~2794, `.echo-user-chip` ~2685)

- [ ] **Step 1: Soften the main panel**

In `App.tsx` line 1523, the `<main>` element currently:

```tsx
<main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-border bg-popover shadow-[0_18px_60px_-44px_rgba(15,23,42,0.42)]">
```

becomes (16px radius, hard border → faint edge, whisper shadow):

```tsx
<main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-popover shadow-[0_0_0_1px_rgba(31,27,22,0.04),0_1px_2px_rgba(31,27,22,0.03),0_12px_40px_-24px_rgba(31,27,22,0.16)]">
```

And the wrapper at line 1369 gets a slightly larger inset: `px-2 pb-2` → `px-2.5 pb-2.5`.

- [ ] **Step 2: Quiet the nav items**

In `index.css`, `button.echo-nav-item` block: font-size `15.5px` → `14px`; `padding: 9px 11px` → `8px 11px`; color `#1a1a1a` → `var(--ink-2)`. Hover: `background: rgba(255,255,255,0.42); color: #1a1a1a` → `background: var(--hover-neutral); color: var(--ink)`. Active:

```css
button.echo-nav-item.active {
  background: #FFFFFF;
  color: var(--ink);
  font-weight: 500;
  box-shadow: inset 0 0 0 1px rgba(31, 27, 22, 0.05), 0 1px 2px rgba(31, 27, 22, 0.03);
}
```

Icons: `button.echo-nav-item svg { color: var(--ink-soft); }` and add `button.echo-nav-item.active svg, button.echo-nav-item:hover svg { color: var(--ink); }`.

- [ ] **Step 3: Borderless user chip**

`.echo-user-chip`: `background: var(--pane); border: 1px solid var(--line-soft)` → `background: transparent; border: none;` and `padding: 12px` → `padding: 10px 8px`. (Keep `.plan-pill` and `.avatar` as-is — the pill is a true control.)

- [ ] **Step 4: Visual check + commit**

Rebuild + relaunch via the harness; screenshot `ss shell`. Verify contract items 1 and 6 (floating panel, quiet sidebar, no hard divider).

```powershell
git add src/renderer/App.tsx src/renderer/index.css
git commit -m "restyle(shell): floating content panel + borderless quiet sidebar"
```

### Task 3: Shared-class restraint pass

**Files:**
- Modify: `src/renderer/index.css` (`.echo-h-title` ~2390, `.echo-lede` ~1859, `.echo-stat-chip` ~1870, `.echo-cta-press` ~1901, `.echo-history-item` ~2017, `.echo-search` ~2432, `.echo-tabs` ~2403)

- [ ] **Step 1: Demote serif on functional text**

`.echo-h-title` (screen titles like "Dictionary", "History") goes sans:

```css
.echo-h-title {
  font-family: var(--font-body);
  font-size: 20px;
  line-height: 1.2;
  letter-spacing: -0.014em;
  font-weight: 600;
  color: var(--ink);
  margin: 0;
}
```

`.echo-lede` (the explanatory line under headings) goes sans and quieter:

```css
.echo-lede {
  font-family: var(--font-body);
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--ink-soft);
  font-weight: 400;
  letter-spacing: -0.003em;
}
```

(`.echo-h-display` stays serif — it's the greeting. `.echo-h-section` kicker stays as-is.)

- [ ] **Step 2: Stats become a borderless inline trio with serif numerals**

```css
.echo-stat-chip {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 0;
  white-space: nowrap;
  font-size: 13px;
  color: var(--ink-soft);
}
.echo-stat-chip .num {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 500;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.echo-stat-chip .div { width: 1px; height: 14px; background: var(--line); }
```

- [ ] **Step 3: Flatten the CTA card + orb shadow**

`.echo-cta-press`: `background: linear-gradient(180deg, #FBF8F1 0%, #F4F0E4 100%); border: 1px solid var(--line)` → `background: var(--card-soft); border: 1px solid var(--line-soft);` and `border-radius: 14px` → `16px`.
`.echo-mic-orb`: box-shadow → `0 6px 18px -8px rgba(201, 100, 66, 0.4)`.

- [ ] **Step 4: History rows — hairlines, no accent bar**

```css
.echo-history-list { display: flex; flex-direction: column; gap: 0; }
.echo-history-item {
  display: grid;
  grid-template-columns: 88px 1fr auto;
  gap: 18px;
  padding: 15px 12px;
  border-radius: 10px;
  transition: background 120ms ease;
  align-items: start;
}
.echo-history-item + .echo-history-item { border-top: 1px solid var(--line-soft); }
.echo-history-item:hover { background: var(--hover-neutral); }
```

(Delete the `border-left` accent rules. Rounded hover + top hairline coexist fine at this size.)

- [ ] **Step 5: Quieter search + tabs**

`.echo-search`: `border-radius: 8px` → `10px`; focus ring `border-color: var(--ink)` → `border-color: var(--line-strong); box-shadow: 0 0 0 3px rgba(31,27,22,0.04);`.
`.echo-tabs`: `border: 1px solid var(--line-soft)` → `border: none;`.

- [ ] **Step 6: Visual check + commit**

Rebuild + relaunch; screenshot home, History, Snippets, Style (`click-text` navigation). Verify contract items 2-4.

```powershell
git add src/renderer/index.css
git commit -m "restyle(components): serif demoted to display moments, hairline lists, flat stats"
```

### Task 4: Home screen pass

**Files:**
- Modify: `src/renderer/components/Dashboard.tsx:368-393`

- [ ] **Step 1: Open up the page gutter and rhythm**

Line 368: `className="relative flex h-full flex-col px-10 pt-6"` → `px-12 pt-9`.
Line 392 (history toolbar): `style={{ marginTop: 14 }}` → `style={{ marginTop: 28 }}`.
Line 393: remove the inline `style={{ fontSize: 22 }}` from the History `<h2>` (the class now sets 20px).

- [ ] **Step 2: Greeting block air**

In `index.css`, `.echo-greeting-block`: `padding: 8px 0 28px` → `padding: 4px 0 36px`.

- [ ] **Step 3: Visual check against the spec's home description**

Rebuild + relaunch; screenshot `ss home-final`. Check: serif greeting, sans lede with mono key chips, borderless stat trio top-right with serif numerals, hairline history rows, generous gutters.

- [ ] **Step 4: Commit**

```powershell
git add src/renderer/components/Dashboard.tsx src/renderer/index.css
git commit -m "restyle(home): airier greeting, gutters, and history rhythm"
```

### Task 5: Stage 2 screens — History, Snippets, Style

**Files:**
- Inspect/modify: `src/renderer/components/History.tsx`, `src/renderer/components/Snippets.tsx`, `src/renderer/components/Style.tsx`
- Modify (likely): `src/renderer/index.css` (`.echo-entry-row`, `.echo-shortcut-row`, `.echo-tone-*` blocks)

Most of these screens restyled themselves via Tasks 1-3 (they consume the shared classes). This task is a per-screen audit against the cohesion contract.

- [ ] **Step 1: Screenshot all three screens** (`click-text Dictionary` etc. — nav labels come from `navItems` in `App.tsx:1301`)
- [ ] **Step 2: For each screen, read the component file and fix deviations** — typical fixes: inline `fontSize`/`fontFamily` overrides that re-introduce serif on functional text; redundant borders around already-hairlined lists; gutters below ~44px; any non-clay decorative accent. Keep `.echo-card` containers (true containers are allowed).
- [ ] **Step 3: Re-screenshot, verify contract, commit**

```powershell
git add src/renderer/components/History.tsx src/renderer/components/Snippets.tsx src/renderer/components/Style.tsx src/renderer/index.css
git commit -m "restyle(content-screens): history, snippets, style cohesion pass"
```

### Task 6: Stage 3 screens — Settings, Notepad

**Files:**
- Inspect/modify: `src/renderer/components/Settings.tsx`, `src/renderer/components/Account.tsx`, `src/renderer/components/PlansBilling.tsx`, `src/renderer/components/Notepad.tsx`
- Modify (likely): `src/renderer/index.css` (settings-* utilities ~41-72, `.echo-composer-*` blocks)

- [ ] **Step 1: Screenshot Settings (open via the sidebar cog) and Notepad**
- [ ] **Step 2: Audit + fix against the contract** — settings panels are dense: group rows inside `.echo-card` containers with hairline row separators; kill nested borders; `settings-parent-panel-subdued` shadow stays subtle. Notepad: the editor surface is the panel itself — no extra frame.
- [ ] **Step 3: Re-screenshot, verify, commit**

```powershell
git add src/renderer/components/Settings.tsx src/renderer/components/Account.tsx src/renderer/components/PlansBilling.tsx src/renderer/components/Notepad.tsx src/renderer/index.css
git commit -m "restyle(dense-screens): settings + notepad cohesion pass"
```

### Task 7: Stage 4 — Onboarding, auth, sticky window, modals, toasts

**Files:**
- Inspect/modify: `src/renderer/components/Onboarding.tsx`, `src/renderer/auth/LoginScreen.tsx`, `src/renderer/auth/SignupScreen.tsx`, `src/renderer/auth/ForgotPasswordScreen.tsx`, `src/renderer/auth/authShell.tsx`, `src/renderer/components/StickyNoteWindow.tsx`, `src/renderer/components/sticky/*.tsx`, `src/renderer/components/toast/ToastItem.tsx`, `src/renderer/components/ConfirmationModal.tsx`
- Modify (likely): `src/renderer/index.css` (`.echo-modal-*`, toast tokens, onboarding/mic-orb blocks)

- [ ] **Step 1: Audit + fix each surface against the contract** — these inherit tokens, so expect small fixes only: modal radius 16px, toast hairlines, auth screens on the new canvas, onboarding serif limited to its headline + the mic orb as the one decorative moment. Sticky window keeps its own compact layout, retuned colors come free via tokens.
- [ ] **Step 2: Screenshot what the driver can reach** (onboarding can be re-entered via the "Replay onboarding" affordance if present; auth/sticky verified by reading the code against tokens if not reachable).
- [ ] **Step 3: Commit**

```powershell
git add -A src/renderer
git commit -m "restyle(edges): onboarding, auth, sticky, modals, toasts"
```

### Task 8: Final cohesion sweep + checks

- [ ] **Step 1: Walk every screen in the running app**, screenshots side by side; confirm contract items 1-6 hold everywhere (same panel inset, same hairline color, same heading scale).
- [ ] **Step 2: Grep for leftovers**: `grep -n "font-display" src/renderer/components` — every hit must be a display moment per contract item 3; `grep -n "EAE6D9\|EFECE3\|E2DDD0" src/renderer` — should return nothing outside comments.
- [ ] **Step 3: Run checks**

Run: `npm run lint` and `npm run typecheck` and `npm test`
Expected: all exit 0 (this was a styling change; failures mean an accidental code edit).

- [ ] **Step 4: Final commit if the sweep changed anything**

```powershell
git add -A src/renderer
git commit -m "restyle: final cross-screen cohesion sweep"
```
