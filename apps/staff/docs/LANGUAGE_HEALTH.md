# Staff App - Language Health Report

_Last verified: 2026-06-10 (roadmap E2 session). Reproducible via
`melos run i18n-health` or `node apps/staff/scripts/i18n-verify.mjs`._

This report is the structural verification of the staff app i18n setup.
It answers "does every key resolve?" - not "is every translation clinically
approved?" Tamil and Telugu are structurally complete through an AI
first-pass fill; **Malayalam is a declared-partial nurse-facing first pass
(2026-06-10)** — both still require fluent clinical review before
production rollout.

## What changed 2026-06-10 (roadmap E2)

- **In-app language switcher** (Settings → Appearance → Language) backed
  by `LocaleProvider` (SharedPreferences-persisted; default = follow the
  device locale, the historical behaviour).
- **Malayalam (`ml`) added** as a declared-partial locale: 532
  nurse-facing keys (actions, labels, login, dashboard, settings, bed
  sheet, vitals + vitals chart, MAR scan, due meds, nursing notes,
  handover, code blue, CDS, orders/composer/order sets, drug chart,
  notifications, logout/splash/error). All other keys fall back to
  English by design. The verifier reports `ml` separately and does not
  treat partial coverage as a finding.
- **hi/ta/te gap-fill**: the 43 keys added en-only by later sessions
  (bed-sheet transfer, clinical-AI reviewer notes/governance, change
  password, vitals-chart tabs/sections) are translated again — all three
  back at 100%.
- **Drug chart screen de-hardcoded** (`drug_chart.*` keys ×5 locales).

## Headline numbers

| | en | hi | ta | te | ml |
|---|---:|---:|---:|---:|---:|
| Keys present | 1,704 | 1,704 | 1,704 | 1,704 | 532 |
| Coverage vs en | 100% | 100% | 100% | 100% | 31.2% (partial by design) |
| `// REVIEW:` flags | - | 229 | 669 | 670 | map-level banner |
| Length outliers | - | 0 | 2 | 0 | 0 |
| Copy-pasted English | - | 1 | 3 | 3 | 6 |

The copy-paste hits are intentional catalog-example hints
(`composer.study_hint` "Chest X-ray PA…" etc.) where clinicians type
English terms; revisit with the translator pass.

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

- **~213 unused getters** remain declared on `AppStrings`. They are not
  user-visible and should be pruned in a separate cleanup-only change.
- **Hardcoded English remains on ~55 screens (~300 heuristic hits)** —
  screens built after the 05-03 pass (front-office workbench, pharmacy
  screen, patient records upload, housekeeping roster, prescriptions
  dialogs, reception counter, discharge hub, order-sets browser, …).
  The drug chart was de-hardcoded 2026-06-10; pharmacy screen is the
  next-highest nurse-facing offender. Bottom-nav labels in
  `staff_scaffold.dart` / `role_config.dart` are pinned by the
  role-config test suite — localising them needs a coordinated
  role_config + tests change.
- **Malayalam beyond the nurse-facing core** (1,172 keys fall back to
  English) — extend per screen as the pilot demands.
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

## New-module i18n backlog (2026-08-23, once-over train D)

The med_rec and transport modules shipped English-first (matching the
specialty-module idiom: AppStrings where an existing key fits, raw English
otherwise). Their strings queue for the next translator pass alongside the
specialty-module backlog. The verifier heuristic now also catches English
assigned to error/message state variables — the blind spot that hid the MAR
hard-stop message (now localized ×5 with `mar_scan.mismatch_blocked`).
