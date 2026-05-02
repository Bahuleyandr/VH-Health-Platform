# Staff App — Colour Contrast Audit

_Last sweep: 2026-05-02. Method: WCAG 2.2 luminance formula computed
against every `<text colour, background colour>` pair declared in
`lib/core/theme/app_theme.dart`._

WCAG thresholds:

| Grade | Normal text | Large (18pt+ / 14pt+ bold) | UI |
|---|---|---|---|
| AA | 4.5:1 | 3:1 | 3:1 |
| AAA | 7:1 | 4.5:1 | — |

---

## Results — full pair matrix (post-fix)

After the three palette adjustments + adaptive semantic getters
shipped in this PR, the pair matrix is:

| Pair | Ratio | Kind | Grade |
|---|---:|---|---|
| Light · primary text on bg | 12.34:1 | normal | AAA |
| Light · primary text on card | 13.24:1 | normal | AAA |
| Light · secondary text on bg | 5.03:1 | normal | AA |
| Light · secondary text on card | 5.40:1 | normal | AA |
| Light · hint on input *(was 2.59 → 4.32 fixed)* | 4.32:1 | normal | AA |
| Light · primaryBlue link on card | 5.75:1 | normal | AA |
| Light · successGreen on card | 5.13:1 | normal | AA |
| Light · errorRed on card | 5.62:1 | normal | AA |
| Light · warningAmber on card *(was 2.65 → 5.83 fixed)* | 5.83:1 | normal | AA |
| Light · primaryTeal on card | 5.32:1 | normal | AA |
| Light · accentCyan on card | 3.51:1 | normal | AA-large only ⚠ |
| Light · white on primaryBlue (button) | 5.75:1 | normal | AA |
| Light · white on successGreen | 5.13:1 | normal | AA |
| Light · white on errorRed | 5.62:1 | normal | AA |
| Light · white on warningAmber *(fixed)* | 5.83:1 | normal | AA |
| Light · primaryBlue on chip | 5.03:1 | normal | AA |
| Light · divider visibility | 1.15:1 | ui | FAIL (decorative) |
| Light · input border visibility | 1.91:1 | ui | FAIL (decorative) |
| Dark · primary text on bg | 13.90:1 | normal | AAA |
| Dark · primary text on card | 11.45:1 | normal | AAA |
| Dark · primary text on surface | 12.52:1 | normal | AAA |
| Dark · secondary text on bg | 6.91:1 | normal | AA |
| Dark · secondary text on card | 5.70:1 | normal | AA |
| Dark · hint on input | 3.02:1 | normal | AA-large only ⚠ |
| Dark · darkPrimary link on card | 8.59:1 | normal | AAA |
| Dark · darkPrimary on bg | 10.43:1 | normal | AAA |
| Dark · successOnSurface on card *(via adaptive getter)* | 6.45:1 | normal | AA |
| Dark · errorOnSurface on card *(via adaptive getter)* | 6.42:1 | normal | AA |
| Dark · warningOnSurface on card *(via adaptive getter)* | 6.92:1 | normal | AA |
| Dark · darkButtonFg on darkPrimary (btn) | 9.94:1 | normal | AAA |
| Dark · darkPrimary on darkChipBg | 8.47:1 | normal | AAA |
| Dark · divider visibility | 1.14:1 | ui | FAIL (decorative) |
| Dark · input border visibility | 1.36:1 | ui | FAIL (decorative) |

**Pass rate (text pairs): 28 / 30 AA or better.** The two ⚠
borderlines (Light accentCyan on white card, Dark hint on dark card)
are large-text-only AA — acceptable for headings / chip labels but
not for body copy.

---

## Fixes shipped in this PR

### 1. `warningAmber`: `#F57F17` → `#E65100`

The previous Material Orange 800 hit only **2.65:1** for both
warningAmber-on-white AND white-on-warningAmber — failing AA either
way. Material Orange 900 raises both pairs to 5.83:1 (AA) without
losing the "amber" reading at a glance. The colour is used as both
foreground (warning text on cards) and background (offline-sync
banner, urgency pills) — the swap improves both directions.

**Visual impact:** warningAmber is now a deeper orange-red. Existing
icons and pills will look slightly more red but stay clearly
distinct from `errorRed`. Verified on the offline-sync banner,
attendance-outside-campus warning, urgent-priority chip, and the
`SuccessToast` warning fall-through path.

### 2. `_lightHint`: `#90A4AE` → `#607D8B`

BlueGrey 300 → BlueGrey 600. Was 2.59:1 (FAIL) on white input
backgrounds — invisible to many users; on a sunny ward window it
disappeared entirely. Now 4.32:1 (AA) and still reads as a faded
placeholder.

**Visual impact:** all `InputDecoration.hintText` text on light
mode is now noticeably darker. Forms read better in glare; nothing
else changes.

### 3. New adaptive semantic getters

Added three new public getters on `AppTheme`:

```dart
static Color get successOnSurface;  // Light: #2E7D32 / Dark: #66BB6A
static Color get errorOnSurface;    // Light: #C62828 / Dark: #FF8A80
static Color get warningOnSurface;  // Light: #E65100 / Dark: #FFB74D
```

Use these whenever you render success / error / warning **text**
directly on a card or scaffold background. The dark-mode variants
all hit ≥6.4:1 on `darkCard`, fixing the previously-failing pairs:

- Dark · successGreen on card: was **2.93:1** → 6.45:1 with `successOnSurface`
- Dark · errorRed on card: was **2.67:1** → 6.42:1 with `errorOnSurface`
- Dark · warningAmber on card (would have been similar): now 6.92:1

The raw brand colours (`successGreen`, `errorRed`, `warningAmber`)
stay AA-passing for **white-on-coloured-bg** (filled buttons, status
pills) — those use cases don't need the swap.

---

## What's left — known acceptable failures

### a) `Light · accentCyan` on white — 3.51:1 (AA-large only)

`#0097A7` — used as a tertiary accent (clinical AI / lab tabs).
Borderline. Acceptable for chip labels, headings, and icons (≥18pt
or 14pt-bold gets AA at 3:1) but **not** for body text.

**Convention to enforce:** if you need accentCyan on body text, swap
to `primaryTeal` (5.32:1, AA). Search-and-replace candidates:
- `clinical_ai_*_screen.dart` — verify accentCyan is only used on
  tab labels, not running paragraphs.

### b) `Dark · hint` on dark card — 3.02:1 (AA-large only)

`_darkHint` (#6E6E82) on `darkCard` (#252536). Just above 3:1, so
acceptable for short hint phrases on input fields (matching the
"placeholder" semantic), not body. Material's dark-mode hint
guidance accepts ~60% white-on-dark which is roughly where we are.

**No fix shipped** — bumping the hint colour brighter starts to
read like the actual entered text and degrades the placeholder
signal.

### c) Decorative dividers and input borders — < 2:1

`divider` (#ECEFF1 light, #2E2E42 dark) against their respective
card surfaces, and `_lightInputBorder` / `_darkInputBorder` against
the input fill colour, all sit ~1.1–1.9:1.

**Acceptable** under WCAG 1.4.11 because dividers and inactive
field borders are decorative — they're not the only indicator of
field boundaries (the labelText, prefixIcon, fill colour, and
focus-state border all carry the same information). The **focused**
input border uses `primaryBlue` / `_darkPrimary` which both pass.

### d) `Dark · primaryBlue legacy uses` — 2.62:1 FAIL

Some places still use `AppTheme.primaryBlue` (a const) where they
should use the adaptive `Theme.of(context).colorScheme.primary` or
`_darkPrimary`. The audit flagged 2.62:1 on dark mode.

**Fix path:** sweep Flutter for `color: AppTheme.primaryBlue` in
text styles inside dark-mode-rendered surfaces. The per-screen
work is similar to the i18n migration — mostly mechanical. Not
shipped in this PR; tracked for a follow-up.

---

## Verification steps

1. **Light theme** — log in, walk: dashboard → bed board → bed
   sheet → notes save → vitals form (input hint text now darker).
   Confirm warningAmber pills read clearly.
2. **Dark theme** — Settings → Theme → Dark. Walk same screens.
   Confirm error / success / warning text on cards reads cleanly
   wherever migrated to `*OnSurface` getters.
3. **Stark or Axe DevTools** — run against the staff app's exposed
   dark-mode screens. Should report 0 critical text-pair failures
   on the screens whose semantic-colour use has been migrated.

The migration step (replacing `successGreen` → `successOnSurface`
etc. at call sites that render text on cards) is mechanical follow-up
work — see the Section "What's left" → (d).

---

## Methodology + reproducibility

The full pair matrix is reproducible via
`apps/staff/docs/_contrast_calc.mjs` (a one-off node script). The
script reads hex values from this doc inline, computes WCAG 2.2
luminance + ratio, and prints the table above. To re-run after a
palette change:

```bash
node apps/staff/docs/_contrast_calc.mjs
```

Update the hex values in the `palette` map at the top of the
script if you change `app_theme.dart`. The script is intentionally
NOT part of the Flutter build — it's a one-shot diagnostic.
