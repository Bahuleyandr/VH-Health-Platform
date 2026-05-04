# Translation Human Review Tracker

The Flutter apps now have structural i18n coverage, but AI first-pass
translations are not clinical sign-off. This tracker is the human validation
queue before production rollout in Tamil, Telugu, Malayalam, or Hindi.

## Current Coverage

| App | Locale | Structural coverage | Human clinical review |
|---|---:|---:|---:|
| Staff | Hindi | 100% | Pending |
| Staff | Tamil | 100% | Pending |
| Staff | Telugu | 100% | Pending |
| Patient | Hindi | 100% | Pending |
| Patient | Tamil | 100% | Pending |
| Patient | Telugu | 100% | Pending |
| Patient | Malayalam | 100% | Pending |

## Review Scope

Reviewers should focus on high-risk wording first:

- medication administration and allergy/interaction warnings
- emergency, SOS, code-blue, and escalation text
- consent, ABDM/ABHA, identity, and security copy
- payroll, billing, insurance, and payment text
- discharge, investigation, radiology, pharmacy, incident, and grievance copy
- staff HR actions that can affect leave, attendance, pay, or replacements

## Source Files

- `apps/staff/lib/l10n/app_strings.dart`
- `apps/patient/lib/l10n/intl_hi.arb`
- `apps/patient/lib/l10n/intl_ta.arb`
- `apps/patient/lib/l10n/intl_te.arb`
- `apps/patient/lib/l10n/intl_ml.arb`

## Verification After Review

```bash
melos run i18n-health
cd apps/patient && flutter gen-l10n
```

Generated patient files under `apps/patient/lib/generated/` should be committed
when ARB edits change them.
