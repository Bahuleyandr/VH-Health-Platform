# Staff App - Language Health Report

_Last verified: 2026-05-03. Reproducible via `melos run i18n-health`
or `node apps/staff/scripts/i18n-verify.mjs`._

This report is the structural verification of the staff app i18n setup.
It answers "does every key resolve?" - not "is every translation clinically
approved?" Tamil and Telugu are now structurally complete through an AI
first-pass fill, but they still require fluent clinical review before
production rollout.

---

## Headline numbers

| | en | hi | ta | te |
|---|---:|---:|---:|---:|
| Keys present | 1,576 | 1,576 | 1,576 | 1,576 |
| Coverage vs en | 100% | 100% | 100% | 100% |
| `// REVIEW:` flags | - | 216 | 619 | 620 |
| Length outliers | - | 0 | 2 | 0 |
| Copy-pasted English | - | 1 | 0 | 0 |

| | |
|---|---:|
| Getters declared on `AppStrings` | 1,573 |
| Getters called from `lib/` | 1,445 |
| Unused getters | 128 |
| Orphan calls (would crash at runtime) | 0 |
| Hardcoded English remaining (UI text heuristic) | 1 |

---

## What's verified

- **English, Hindi, Tamil, and Telugu all have 100% structural key
coverage.** The runtime fallback remains English, but no staff locale
currently depends on fallback for missing keys.

- **No runtime crashes from orphan calls.** Every `s.foo` /
`AppStrings.of(context).foo` reference resolves to a declared getter.

- **No accidental Tamil/Telugu copy-paste from English.** The only
copy-paste finding is the existing Hindi pharmacy example string
(`Dolo 650...`), which is an intentionally sample-like input hint.

- **No catastrophic length blow-ups.** Tamil has two length outliers
(`theatre.preop_checklist`, `pharmacy.view_confirm`); both are short
UI labels that should wrap, but should be watched during visual QA.

- **Fallback still works.** Any future missing key in a non-English map
falls through to English at runtime. Empty-string values are not
supported - leave a key out of the map to fall through cleanly.

---

## Review queue

Tamil and Telugu were completed as an AI first pass on 2026-05-03.
Every newly high-stakes clinical, security, financial, payroll,
discharge, medication, investigation, incident, and consent string was
marked with `// REVIEW:` near the map entry.

Before production rollout in Tamil/Telugu-speaking staff populations:

1. Validate all `// REVIEW:` strings with a fluent clinician or hospital
   operations translator.
2. Pay special attention to medication administration, discharge,
   emergency/code-blue, consent, payroll, HR, investigation, radiology,
   pharmacy, incident, grievance, and blood-bank copy.
3. Run `melos run i18n-health` after edits and confirm coverage remains
   100%.

---

## Remaining non-blocking cleanup

- **128 unused getters** remain declared on `AppStrings`. They are not
  user-visible and should be pruned in a separate cleanup-only change.
- **1 hardcoded English heuristic hit** remains in
  `lib/core/widgets/debounced_button.dart` (`"Check In"`). Existing notes
  treat this as non-user-facing/example copy, but it can be revisited with
  the unused-getter cleanup.
- **Admin portal and backend notifications** remain English-only and are
  tracked separately.

---

## Translator handoff package

For a human validation pass, provide:

1. `apps/staff/lib/l10n/app_strings.dart`
2. `apps/staff/scripts/i18n-verify.mjs`
3. This report
4. `apps/staff/docs/ACCESSIBILITY_AUDIT.md`
5. `apps/staff/docs/COLOR_CONTRAST_AUDIT.md`

Run after every translator edit:

```bash
melos run i18n-health-staff
```
