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

**Still English-only, deliberately:** the existing-ABHA link form in
`apps/patient/lib/features/abdm/screens/abdm_screen.dart` (ABHA number/address
fields, Link ABHA / Cancel buttons). The consent grant/deny/revoke dialogs were
localized on 2026-08-27 — see the queue entry below.

## Priority queue — added 2026-08-27 (ABDM consent actions + Ask a Doubt)

The consent grant/deny/revoke flow in
`apps/patient/lib/features/abdm/screens/abdm_screen.dart` no longer
interpolates an English verb into an English sentence frame; each action now
has its own ARB keys (`abdmConsentGrantAction`/`...DenyAction`/`...RevokeAction`,
`abdmConsent*ConfirmTitle`, `abdmConsent*ConfirmBody`, `abdmConsent*Success`).
The hi/ta/te/ml values are an **AI first pass** and are **pending
clinician/legal review** — they are consent-bearing copy under §"Review Scope"
(a patient grants, denies, or revokes record-sharing consent on these exact
words), so they land at the top of this queue alongside the `abhaEnrol*` set.

Also added 2026-08-27: `askDoubtIntro` and `askDoubtSuccess`
(`apps/patient/lib/features/feedback/screens/ask_a_doubt_screen.dart`). These
state the Ask-a-Doubt expectation contract — the care team reads every message
and follows up by phone or at the next visit; there is **no in-app reply**.
Reviewers must preserve that one-way promise exactly; a rendering that implies
an in-app answer re-creates the defect the copy was rewritten to remove.

Also on 2026-08-27, three machine-translation corruption fixes (mixed-script
passages, no meaning change intended, still AI-quality pending review):
`aboutUsContent` (ta — Telugu/Russian/Bengali fragments), `conditionsBody`
(ta — one Telugu word), `labOrdersScheduled` (te — Tamil suffix).

## Verification After Review

```bash
melos run i18n-health
cd apps/patient && flutter gen-l10n
```

Generated patient files under `apps/patient/lib/generated/` should be committed
when ARB edits change them.
