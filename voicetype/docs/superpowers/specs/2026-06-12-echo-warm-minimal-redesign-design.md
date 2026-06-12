# Echo "Warm Minimal" Redesign — Design Spec

**Date:** 2026-06-12
**Status:** Approved
**Scope:** Whole app, staged. Visual restyle + targeted layout rearrangement. No functional changes.

## Goal

Make Echo feel airier, more cohesive, and more premium — qualities the user
identified in Wispr Flow — without copying Wispr Flow's design. Echo keeps its
own identity: warm tones, clay accent, serif display moments.

The user's diagnosis of the current design (the May 2026 "Echo Redesign"):
- Not enough whitespace / breathing room — too many borders and boxed cards.
- Lacks cohesion/restraint — elements compete for attention.
- Reads "cozy/papery" rather than modern/premium.
- Detail polish (chips, hover states, icons) is fine — not the problem.

## Direction: Warm Minimal Hybrid

Chosen over (A) a lighter version of the current full-warm look and (B) a
neutral "gallery white" look. C = modern airy structure with near-white
surfaces, the serif reserved for display moments, and clay kept as the single
signature accent.

## 1. Visual language

### Surfaces — two-layer structure (the core change)

- **Shell** (sidebar + titlebar region): quiet warm-tinted canvas `#F2F0EA`.
  No borders on the shell; the sidebar sits directly on it.
- **Content panel**: floating near-white surface `#FDFCFA`, ~16px radius,
  very soft shadow, inset from the shell edges (~10px top/right/bottom).
  The panel owns its own scroll.
- **Restraint rule**: borders nearly disappear. Lists separate rows with soft
  hairlines (`#EFECE4`), not card-per-row. White bordered cards are reserved
  for true containers (a settings group, a snippet entry). No boxes inside
  boxes.

### Color

- Ink stays warm near-black (`#201F1C` family); muted text one step quieter.
- **Clay `#C96442` is the only accent**, used sparingly: primary buttons,
  active/selected states, the streak stat. Hover `#B5563A`.
- Moss and amber remain status-only (success/warning); never decorative.

### Typography

- **Figtree** remains the body face (with existing stylistic sets).
- **Source Serif 4** retreats to display moments only: home greeting, large
  stat numerals, empty-state headlines. All navigation, labels, buttons, and
  list content go sans. This is the main "papery → modern" lever.
- **Geist Mono** keeps the hotkey chips and code.

### Space

- Content panel padding ~44px (up from ~32px).
- Section gaps ~32px.
- List rows: taller, hairline-separated, more horizontal air between
  timestamp and content.
- Fewer, larger groupings per screen.

## 2. Shell & navigation

- Borderless sidebar on the shell tint; no divider against the content (the
  floating panel provides the separation).
- Active nav item: white pill with hairline border. Inactive: quiet muted
  text, warms on hover. Icons stay (lucide), sized consistently.
- Account chip bottom-left, borderless, quiet.
- Titlebar/window controls integrate into the shell tint so the app top is
  one calm surface; drag region on the shell.

## 3. Token-level implementation

All surfaces flow through the CSS variable layer in
`src/renderer/index.css` (both the HSL Tailwind tokens and the raw
`--canvas/--pane/--line/...` redesign tokens). The redesign starts as a
token retune:

| Token | Current | New |
|---|---|---|
| `--canvas` / `--app-bg` | `#EFECE3` | `#F2F0EA` |
| `--sidebar-bg` | `#EAE6D9` | `#F2F0EA` (merges into shell) |
| `--pane` / `--background` | `#FAF9F5` | `#FDFCFA` |
| `--line` | `#E2DDD0` | `#EBE8E0` (quieter) |
| `--line-soft` | `#ECE7DA` | `#EFECE4` |
| `--card-soft` | `#F7F5EE` | `#F8F7F3` (less yellow) |

Clay, ink, moss, amber values stay. Exact values may be fine-tuned during
implementation against the running app; the relationships (shell darker than
panel, hairlines barely-there) are the contract.

After the token retune, each screen gets a structural pass: remove redundant
borders/cards, apply the spacing scale, demote serif to display moments,
rearrange where layout itself causes heaviness.

## 4. Staged rollout

1. **Foundation:** token retune + shell/sidebar/titlebar restructure + Home
   (greeting, lighter dictate hero — quieter than the current large tinted
   card, inline stat trio with serif numerals, airier history list).
2. **Content screens:** History, Snippets, Style.
3. **Dense screens:** Settings, Notepad.
4. **Edges:** Onboarding, auth screens, sticky-note window, modals, toasts.

Each stage ends with a visual check in the running app before the next
begins.

## 5. Constraints

- No functional changes; all features stay.
- Layout rearrangement allowed where it buys breathing room (approved), but
  no feature removal or navigation changes.
- No new dependencies. framer-motion and the existing component structure
  are kept.
- Light mode only — the app has no dark mode today; adding one is out of
  scope.
- Do not copy Wispr Flow: no mirrored layouts or signature elements
  (e.g. their right-rail stats card, promo banners). The floating-panel
  structure is a common pattern (Notion/Linear/Slack) executed with Echo's
  own palette and type.

## 6. Testing / verification

- Visual verification per stage via the running app (screenshots), checked
  against this spec's surface/spacing/type rules.
- Existing tests must keep passing (no behavior changes expected).
- A final whole-app pass for cross-screen cohesion: same panel inset, same
  hairline color, same heading scale everywhere.
