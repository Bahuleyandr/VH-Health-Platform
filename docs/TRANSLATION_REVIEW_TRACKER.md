# Translation Human Review Tracker

> **Last structurally reconciled: 2026-09-02.** Structural i18n coverage is
> 100%; human clinical, linguistic, finance, and legal review remains PENDING.
> This tracker does not block technical development, but the named human
> reviews remain fail-closed activation gates.

The Flutter apps now have structural i18n coverage, but AI first-pass
translations are not clinical sign-off. This tracker is the human validation
queue before production rollout in Tamil, Telugu, Malayalam, or Hindi.

## Current Coverage

| App | Locale | Structural coverage | Human clinical review |
|---|---:|---:|---:|
| Staff | Hindi | 100% | Pending |
| Staff | Tamil | 100% | Pending |
| Staff | Telugu | 100% | Pending |
| Staff | Malayalam | 100% technical parity (4,008 English-source placeholders) | Pending |
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

## Priority queue — added 2026-09-02 (Malayalam parity closure)

The staff app no longer exempts Malayalam from structural parity. The exact
review queue is the 4,008-key generated map at
`apps/staff/lib/l10n/app_strings_ml_parity.g.dart`. Every value in that file is
the English source copied as a technical placeholder, not approved Malayalam.
An approved translation belongs in the explicit `ml` map in
`app_strings.dart`; regeneration then removes that key from the placeholder
file. Review must prioritize clinical action, dosage/MAR, consent, emergency,
finance/payroll, controlled-drug, legal declaration, and operator copy.

The patient app gained first-pass hi/ta/te/ml wording for 48 previously
missing or English-copy keys. Human review is required for:

- `authSosBackendFailed`, `authSosGuestSkipped`
- `investigationsUploadNotAvailableForDependent`
- `logoutProgressMessage`
- `referralsAppointment`, `referralsAppointmentLinked`,
  `referralsEmptySubtitle`, `referralsEmptyTitle`, `referralsFollowUp`,
  `referralsLoadFailed`, `referralsNextSteps`, `referralsSpecialist`,
  `referralsSummary`, `referralsTitle`
- `diagnosticResultsTitle`, `diagnosticResultsEmptyTitle`,
  `diagnosticResultsEmptySubtitle`, `diagnosticResultsLoadFailed`,
  `diagnosticResultDetailsTitle`, `diagnosticResultDetailLoadFailed`,
  `diagnosticResultRadiology`, `diagnosticResultPathology`,
  `diagnosticResultAmended`, `diagnosticResultAddendum`,
  `diagnosticResultAdvice`
- `appointmentVisitType`, `appointmentInPersonConsultation`,
  `appointmentTeleconsultVideoVisit`, `appointmentSelectDateError`,
  `appointmentSelectAvailableSlotError`, `appointmentSelectDoctorError`,
  `appointmentSessionMissingError`, `appointmentReasonForVisitLabel`,
  `appointmentReasonForVisitHint`, `appointmentSelectDateLabel`,
  `appointmentSelectedTime`, `appointmentSelectTimeLabel`
- `aboutDoctorAppointmentsTitle`, `aboutHomeSampleAction`,
  `aboutFreeHomeSampleCollectionTitle`, `aboutAmbulanceAction`,
  `aboutEmergencyAmbulanceTitle`, `aboutNavigateAction`
- `familyLinkedDependentBadge`, `familySetUpLinkedDependent`
- `ancBookedVisits`, `ancRecordedBpWeight`
- `gamificationShareEarnedBadge`

The backend payment-link presentation now resolves the patient's server-owned
preferred locale across en/hi/ta/te/ml, but all five entries deliberately
retain the pre-existing bilingual English/Hindi message. Locale-specific
payment wording remains blocked on finance and linguistic approval; replacing
those technical placeholders must not widen what the payment page promises.

The appointment and About entries above close the technically safe portion of
audit finding OPEN-21. They are first-pass translations, not human approval.
The dependent-setup errors, guardianship explanation, relationship declaration,
and consent wording remain English and fail-closed on legal plus linguistic
review. The Staff Web activation title/message also remain unchanged and held
for operator/release ownership. Neither hold may be converted into a technical
placeholder merely to make the parity ledger look complete.

## Confirm, do not fix (all locales)

Everything in this section is already decided. A reviewer who meets one of these
strings emits `confirm` — never `change`, and never `escalate` for wording. The
only legitimate way to alter one is a separate, named decision by the authority
in the "who decided" column, recorded here in the same commit as the change.

### English by decision — Staff (`DELIBERATE_ENGLISH_FALLBACK` in `apps/staff/scripts/i18n-verify.mjs`)

| Key | Why it stays English | Who decided |
|---|---|---|
| `clinical_inbox.action.attestation` | First-person attestation the clinician signs against a diagnostic result; the wording is the legal content of the signature. | Deploying hospital |
| `ed_trauma.continuity.external_attestation` | States what an inter-facility handoff record asserts was confirmed. | Deploying hospital |
| `s4.lib.referrals.continue_ownership` | First-person declaration of continuing clinical ownership of a patient. | Deploying hospital |
| `continuity.unknown.allergy` | Pinned to `Allergy status UNKNOWN — not recorded` in all five locales by `apps/staff/test/i18n_guard_test.dart:37-46`; an UNKNOWN marker read by clinicians whatever their language setting. | Clinical safety (test-pinned) |
| `continuity.unknown.code_status` | Pinned to `Code status NOT RECORDED — confirm per hospital policy` in all five locales by the same test. | Clinical safety (test-pinned) |

Note that `continuity.unknown.generic` is NOT on this list: the same test asserts
it resolves to something other than the key, and it is translated in hi/ta/te/ml.

### English by decision — Patient (`DELIBERATE_ENGLISH_VALUES` in `apps/patient/scripts/i18n-verify.mjs`)

The patient parity gate fails on an untranslated value unless the key is on this
allowlist, so the allowlist is the authority; it currently holds eleven keys:

| Key | Why it stays English |
|---|---|
| `profileEmailHint` | Literal example email address. |
| `vitalsSpO2` | International clinical abbreviation. |
| `splashAppName` | Product name. |
| `aboutHospitalName` | Registered hospital name. |
| `ancBpLabel`, `ancFhrLabel`, `ancHbLabel` | International clinical abbreviations (BP, FHR, Hb). |
| `yourHealthTimelineRxPill` | International prescription symbol. |
| `teleconsultBadge` | Product badge token. |
| `abdmAddressHint` | Literal example ABHA address. |
| `abhaEnrolOtpLabel` | ABDM programme term and required-field marker. |

### Programme terms and units — Latin script in every locale

`ABHA`, `OTP`, `HIV`, `HBsAg`, `HCV`; unit strings (`g/dL`, `mmol/L`, `10^3/uL`,
`mmHg`, `bpm`); device tags (`RP00000042`); drug and test codes as printed on the
report. `Aadhaar` is the exception: it takes the standard local form
(hi आधार, ta ஆதார், te ఆధార్, ml ആധാർ). See `docs/i18n/GLOSSARY.md`.

### Renderings pinned by a test

Changing one of these is allowed, but the same commit updates the pin and the
batch's tracker row says which pin moved and why.

| Rendering | Key / locale | Pin |
|---|---|---|
| `வார்டு ஒதுக்கீடு` | `mar_supply.allocation` (ta) | `apps/staff/test/features/nursing/mar_supply_i18n_test.dart:80-92` |
| `వార్డు కేటాయింపు` | `mar_supply.allocation` (te) | same test |
| `कृपया फिर से साइन इन करें ताकि ऐप इस डिवाइस की पुष्टि कर सके।` | staff re-auth API error message (hi) | `apps/staff/test/core/utils/api_error_messages_test.dart:133-136` |
| `ദാതൃ റീഫണ്ടിന് പൊരുത്തപ്പെടുത്തൽ ആവശ്യമാണ്` | gateway-refund reconciliation notification title (ml) | `apps/backend/src/tests/unit/paymentGatewayService.test.js:302` |
| `Allergy status UNKNOWN — not recorded`, `Code status NOT RECORDED — confirm per hospital policy` | `continuity.unknown.allergy`, `continuity.unknown.code_status` (all five locales) | `apps/staff/test/i18n_guard_test.dart:37-46` |

### Dead surfaces

Keys marked dead in `apps/staff/docs/LANGUAGE_HEALTH.md` (`reception_counter.*`
except the eight live ones) are `confirm` with reason `dead surface`. Do not
spend review budget on them and do not delete them in a linguistic batch.

## Verification After Review

```bash
melos run i18n-health
cd apps/patient && flutter gen-l10n
```

Generated patient files under `apps/patient/lib/generated/` should be committed
when ARB edits change them.
