# Translation Human Review Tracker

> **Last reviewed: 2026-06-29.** Structural i18n coverage is 100%; human clinical review of translated strings remains PENDING (deprioritized until the pilot). This is a tracking artifact, not a blocker.

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

## Priority queue — added 2026-08-25 (re-audit lane L)

The ABHA self-enrolment wizard
(`apps/patient/lib/features/abdm/widgets/abha_enrolment_flow.dart`) was
hardcoded English; lane L moved all of its copy into ARB keys prefixed
`abhaEnrol*`, plus `abdmCreateAbhaCta`, `settingsBiometricLockSubtitle`, and
the three `biometricGate*` strings on the locked pane
(`biometricGateLockedEscapeHint`, `biometricGateOpenSettings`,
`biometricGateGoHome`). The hi/ta/te/ml values are an **AI first pass** and
land at the top of this queue, because they are identity-and-consent copy
under §"Review Scope":

| Key | Why it is high risk |
|---|---|
| `abhaEnrolAadhaarIntro` | States that the patient's **Aadhaar** is used for OTP verification to create the ABHA. This is the disclosure the patient acts on; a loose rendering changes what they believe they are consenting to. |
| `abhaEnrolAadhaarLabel`, `abhaEnrolAadhaarHint`, `abhaEnrolAadhaarInvalid` | Statutory identity document. Reviewer must confirm the standard local-language term for Aadhaar, not a descriptive paraphrase. |
| `abhaEnrolMobileLabel`, `abhaEnrolMobileHint` | Says the OTP defaults to the Aadhaar-linked mobile — wrong here means the patient waits for an OTP on the wrong handset. |
| `abhaEnrolDoneIntro` | Asserts the new ABHA is **linked to the hospital record**, i.e. that a national health ID is now bound to their local chart. |
| `settingsBiometricLockSubtitle` | Security promise: names exactly which screens the biometric lock covers and which it does not. An imprecise translation re-creates the "user believes the lock is complete" defect in four languages. |
| `biometricGateLockedEscapeHint` | The only in-app instruction a patient whose sensor has broken gets for recovering access to their own records. A rendering that does not name Settings leaves them locked out. |

Deliberately **untranslated** in every locale, and to be confirmed rather than
"fixed" by a reviewer: `ABHA`, `OTP`, and `abhaEnrolOtpLabel` ("OTP *"). These
are the forms the ABDM programme itself uses.

`apps/patient/test/features/abdm/abha_enrolment_l10n_test.dart` fails if any
key in the table above is left identical to its English value in hi/ta/te/ml,
so the queue cannot silently gain an English fallback.

**Still English-only, deliberately:** the rest of
`apps/patient/lib/features/abdm/screens/abdm_screen.dart` — the existing-ABHA
link form and the consent grant/deny/revoke dialogs. Those interpolate an
English verb into an English sentence frame and are consent-bearing, so they
were parked in `docs/ROADMAP.md` rather than machine-translated. A patient in
Tamil/Telugu/Hindi/Malayalam can now *create* an ABHA in their language but
still grants or revokes record-sharing consent in English.

## Verification After Review

```bash
melos run i18n-health
cd apps/patient && flutter gen-l10n
```

Generated patient files under `apps/patient/lib/generated/` should be committed
when ARB edits change them.
