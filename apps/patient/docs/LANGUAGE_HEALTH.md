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
| Keys present | 1,447 | 1,447 | 1,447 | 1,447 | 1,447 |
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

- **Current measured key set: 1,447 per locale.** The 2026-09-02
  Malayalam technical-parity batches added ordinary appointment, About,
  dashboard, generic error, gamification-chrome, and non-safety step copy.
  This count is structural evidence only and does not change human review or
  activation status. The 48 first-pass review keys from this closure are
  enumerated, one by one, under the 2026-09-02 queue in
  `docs/TRANSLATION_REVIEW_TRACKER.md`; the count is derived from that list.

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

- **The direct `Text('...')` screen heuristic is clear, but remains only a
  floor.** Visit-type, appointment validation/reason/date/time copy, About
  contact actions, linked-dependent badges, ANC timeline, achievement-share,
  and splash copy now use generated localization accessors. A broader
  2026-09-02 residual scan still found dynamically assembled and non-`Text`
  English elsewhere. The current high-confidence scan has no remaining safe
  technical candidates. The exact review queue is the 48-key tracker list,
  plus the separately named dependent/guardianship/consent and Staff Web
  activation holds in that tracker; no unsupported aggregate hold count is
  claimed. 100% key parity is not global presentation parity or linguistic
  approval.

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
   diagnostic-report, appointment, About, linked-dependent, ANC, and
   achievement-share additions listed in
   `docs/TRANSLATION_REVIEW_TRACKER.md` before locale activation.

---

## Re-verification

After every translator edit:

```bash
melos run i18n-health-patient
node apps/patient/scripts/i18n-verify.mjs --check
cd apps/patient && flutter gen-l10n
```
