# Patient App - Language Health Report

_Last verified: 2026-09-02. Reproducible via `melos run i18n-health`
or `node apps/patient/scripts/i18n-verify.mjs`._

The patient app uses Flutter ARB localization with generated Dart files
under `apps/patient/lib/generated/`. This report verifies structural
coverage only. Tamil, Telugu, and Malayalam were completed through an AI
first-pass fill and still require human clinical review before production
rollout.

---

## Headline numbers

| | en | hi | ta | te | ml |
|---|---:|---:|---:|---:|---:|
| Keys present | 1,328 | 1,328 | 1,328 | 1,328 | 1,328 |
| Coverage vs en | 100% | 100% | 100% | 100% | 100% |
| Missing keys | 0 | 0 | 0 | 0 | 0 |
| Length outliers | - | 0 | 1 | 0 | 0 |

Expected copy-paste findings are limited to intentional identifiers or
brand/example strings such as `example@domain.com`, `DOB:`, `VH Health`,
and `Venkataeswara Hospitals`.

---

## What's verified

- **All supported patient locales have 100% structural coverage.**
English, Hindi, Tamil, Telugu, and Malayalam all define every source key.

- **ARB JSON parses cleanly.** The translated locale files remain valid
JSON and include copied English `@key` metadata for newly added entries.

- **Generated Flutter localization files were refreshed.** Run
`flutter gen-l10n` from `apps/patient` after ARB edits.

- **Placeholders are preserved.** ICU placeholders such as `{doctor}`,
`{name}`, and `{medication}` remain intact and were adjusted where needed
to avoid ambiguous Dart interpolation in generated code.

- **Parity is blocking.** `node apps/patient/scripts/i18n-verify.mjs --check`
  fails on a missing key, ICU-placeholder drift, or an English-identical value
  that is not in the short, reasoned identifier/brand allowlist. It runs in
  both Flutter CI halves alongside the staff parity gate.

- **The direct `Text('...')` screen heuristic is clear.** Visit-type, linked
  dependent, ANC timeline, achievement-share, About, and splash copy now use
  generated localization accessors. This heuristic is a floor, not proof that
  every dynamically assembled or non-`Text` string is localized.

---

## Review queue

Tamil, Telugu, and Malayalam values are AI first-pass translations.
Before production rollout:

1. Validate clinical, medication, investigation, ABDM/ABHA, consent,
   emergency, payment, family, and profile-completion copy with fluent
   reviewers.
2. Spot-check small-screen layouts for the Tamil outlier
   `appointmentsBookOneNow`.
3. Keep brand names unchanged unless the hospital supplies a formal
   localized style guide.
4. Review the 2026-09-02 SOS, dependent-upload, referral, logout, released
   diagnostic-report, appointment, linked-dependent, ANC, and achievement-share
   additions listed in
   `docs/TRANSLATION_REVIEW_TRACKER.md` before locale activation.

---

## Re-verification

After every translator edit:

```bash
melos run i18n-health-patient
node apps/patient/scripts/i18n-verify.mjs --check
cd apps/patient && flutter gen-l10n
```
