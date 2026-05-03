# Staff App — Language Health Report

_Last verified: 2026-05-02. Reproducible via `melos run i18n-health`
or `node apps/staff/scripts/i18n-verify.mjs`._

This report is the structural verification of the i18n setup. It
answers "does the scaffold work?" — not "are the translations
accurate?" The latter requires a clinical translator pass per
non-English locale.

---

## Headline numbers

| | en | hi | ta | te |
|---|---:|---:|---:|---:|
| Keys present | 1,576 | 1,054 | 977 | 977 |
| Coverage vs en | 100% | **66.9%** | **62.0%** | **62.0%** |
| `// REVIEW:` flags | — | 52 | 58 | 58 |
| Length outliers | — | 0 | 1 | 0 |
| Copy-pasted English | — | 0 | 0 | 0 |

| | |
|---|---:|
| Getters declared on `AppStrings` | 1,573 |
| Getters called from `lib/` | 1,438 |
| Unused getters | 135 |
| Orphan calls (would crash at runtime) | **0** |
| Hardcoded English remaining (UI text) | **1** (docstring example, not real UI) |

---

## What's verified

✅ **Every navigable screen** in the staff app is wired to
`AppStrings`. Search the codebase for `AppStrings.of(context)` —
1,438 call sites across 50+ screens.

✅ **No runtime crashes from orphan calls.** Every `s.foo` /
`AppStrings.of(context).foo` reference resolves to a declared
getter. Verified by static analysis.

✅ **English is complete and self-consistent.** 1,576 keys, all
populated, source-of-truth for the other locales.

✅ **No accidental copy-paste.** Where a non-English value matches
the English value, it's because the string is intentionally English
(medical abbreviations like `SpO₂`, format placeholders like
`+91 XXXXX`, employee-id prefix `EMP:`). The verifier filters these
correctly.

✅ **No catastrophic length blow-ups.** One Tamil string is 2.8×
the English ("Pre-op Checklist" → "அறுவை சிகிச்சைக்கு முன்
சரிபார்ப்பு பட்டியல்") — acceptable; UI wraps cleanly at the
display sites.

✅ **Fallback works.** Any key missing from a non-English map falls
through to English at runtime — UI never blanks. Spec is in
`AppStrings._t()` at `lib/l10n/app_strings.dart:71`.

---

## What's NOT verified — the gap to triage

### 1. Hindi: 522 keys still missing

Mostly recent additions (batches 3 + 4 + the final hardcoded
sweep) where the previous agent populated en but not hi. Top areas:

- `blood_bank.*` (~25 keys)
- `theatre.*` (~30 keys)
- `radiology.*` (~25 keys)
- `dietary.*` (~20 keys)
- `clinical_ai.*` patient-explainer flow (~24 keys)
- `cds.*` blocker modal (~7 keys, **clinical-safety**)
- `code_blue.*` (~6 keys, **clinical-safety**)
- `payroll.*`, `hr.*`, `housekeeping.*`, `splash.*`,
  `first_run.*`, `voice_dictate.*` various

Run `node scripts/i18n-verify.mjs` from `apps/staff/` for the full
list (522 lines under `[hi] missing:`).

### 2. Tamil + Telugu: 599 keys missing each

Same recent additions plus roughly 80 more from earlier batches
where Tamil/Telugu lagged Hindi. Section 2 of the verifier output
is the authoritative list.

### 3. Translation quality is unverified

Even where Hindi/Tamil/Telugu keys ARE present:

- Hindi was second-pass reviewed for register and clinical
  terminology (see commit `223d2dc2`); 52 keys flagged
  `// REVIEW:` for hospital-specific wording (discharge, urgency,
  consent).
- Tamil + Telugu remain first-pass machine translations. **No
  clinical-action / security / financial string in either locale
  has been validated by a fluent clinician.** All such keys are
  marked `// REVIEW:` for the translator queue.

### 4. 135 unused getters

Declared on `AppStrings` but never called from any screen. Probably
because (a) they were added speculatively in batch 4 for screens
that ended up reusing existing keys, or (b) the call site got
refactored. Not user-visible; would shrink the file by ~3% if
pruned. Low priority.

---

## Translator handoff package

When you're ready to engage a clinical translator (recommended
before going live in any region with a non-English staff
population), here's what they need:

1. **The source-of-truth map** — `apps/staff/lib/l10n/app_strings.dart`
   under the `'en':` key in `_byLang`.
2. **The verification script** — `apps/staff/scripts/i18n-verify.mjs`,
   run as `melos run i18n-health` to confirm coverage post-fill.
3. **Context comments** — every key is grouped under a labelled
   section header (`// ── Bed sheet ────────────────────`)
   indicating which screen / flow uses it. Reduces misinterpretation
   risk significantly compared to raw key names.
4. **High-stakes flags** — every `// REVIEW:` comment in the file
   points the translator at strings where mistranslation would have
   clinical-safety impact. Suggested workflow: translate REVIEW
   strings first, validate against hospital convention, then bulk
   the rest.
5. **The audit doc** — `apps/staff/docs/ACCESSIBILITY_AUDIT.md`,
   `COLOR_CONTRAST_AUDIT.md`, and this file should travel with the
   handoff so the translator understands the surrounding QA bar.

For ARB-format export (Lokalise / Crowdin / Google Translation
Toolkit ingest), one-time conversion script:

```bash
# Pseudocode — write a converter when you actually need ARB
# (the manual map is easier to maintain otherwise).
node scripts/i18n-export-arb.mjs --locale hi > app_hi.arb
```

We don't ship one yet — Lokalise can ingest JSON, and the manual
map → JSON conversion is `Object.fromEntries` over the chunks the
verifier already parses.

---

## Re-verification

After every translator pass, run:

```bash
melos run i18n-health
```

The script is non-blocking (always exits 0) and informational. It's
appropriate to wire into CI as a "language health" job that posts
the diff in PR comments — but it should NOT gate merges, since
"Hindi coverage at 71%" is a fact, not a regression.

---

## Out of scope for this report

- **Patient app i18n.** Same scaffolding pattern applies but
  separate rollout. ~50 screens, smaller surface than staff.
- **Admin portal i18n.** Next.js — needs `next-intl` or similar.
  Untouched so far.
- **Backend localised messages.** Notification templates, SMS
  copy, email subjects are still English-only on the API side.
  See `apps/backend/src/services/notifications/` for the
  template directory once you scope this work.
- **RTL languages.** Not currently supported; would need `Directionality`
  audit on every screen plus mirrored icons.
