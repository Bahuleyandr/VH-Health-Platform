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
| Staff | Hindi | 100% | Partial — B1 cath (96 keys) reviewed 2026-09-05, owner approval pending |
| Staff | Tamil | 100% | Partial — B1 cath (96 keys) reviewed 2026-09-05, owner approval pending |
| Staff | Telugu | 100% | Partial — B1 cath (96 keys) reviewed 2026-09-05, owner approval pending |
| Staff | Malayalam | 100% technical parity (4,008 English-source placeholders) | Partial — B1 cath (96 keys) reviewed 2026-09-05, owner approval pending |
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

## Review completed — 2026-09-05 — Batch 1: cath lab (Plans 2 and 3), 96 keys × hi/ta/te/ml

**Reviewer:** Claude Fable 5.1 review pipeline: per-locale reviewers, blind back-translation, reconciliation; incorporating the owner-forwarded external human review of 2026-09-05 (disposition REQUEST CHANGES; authoritative where it speaks — §3 and §4 for this batch).
**Commit reviewed:** `e53dae66d` (main; the 23 keys of PR #1004 / merge `a7dbcd03c` and the 73 keys of PR #1008 / merge `65532d431`).
**Source:** `apps/staff/lib/l10n/app_strings.dart` (`_byLang`). All 96 keys have explicit values in all four locales; no `ml` placeholders; no `// REVIEW:` flags.
**Artefacts:** `scratchpad/open21/b1/{apply.jsonl, en.changes.jsonl, escalations.md, glossary.rows.md}`; reviewer inputs `{hi,ta,te,ml}.review.jsonl`, blind checks `{hi,ta,te,ml}.back.jsonl`; `reconcile.mjs` derives `apply.jsonl` and the table below from those inputs plus the reconciler overrides recorded in it.

### Counts

| Locale | Agent verdicts (confirm / change / escalate) | Final: confirmed | Final: changed | Final: escalated |
|---|---|---:|---:|---:|
| hi | 87 / 9 / 0 | 76 | 20 | 0 |
| ta | 77 / 19 / 0 | 69 | 27 | 0 |
| te | 79 / 16 / 1 | 73 | 23 | 0 |
| ml | 83 / 12 / 1 | 75 | 21 | 0 |
| **Total** | | **293** | **91** | **0** |

"Changed" = the applied value differs from the shipped value at `e53dae66d`. Of the 91 changed rows, 20 are the four-locale renderings of the five REQUIRED English source changes and 8 are the renderings of the three PROPOSED ones (`date_required`'s four locales already read as the proposed English, so they stay confirms); of the remaining 63 locale-only corrections, 30 are agent-reviewer changes accepted as proposed and 33 are reconciler decisions (human-review corrections, blind-check findings, code facts). The two agent escalations (`readiness.check.labs` te/ml) were resolved on a code fact and are applied as `confirm` (see "Decisions" below). No key is withheld.

### What was applied

`apply.final.jsonl` = `apply.jsonl` with the `en.changes.jsonl` renderings substituted for every (key, locale) those rows name, plus one `en` source row per entry — 392 rows, 99 changed. Both the REQUIRED and the PROPOSED English source changes are applied, with their four locale renderings, so that the owner's veto window is this PR's review and a veto is a revert, not a re-translation. The old locale renderings of a changed source are never carried across: all five values in a source-change row come from the review.

### Changed keys

| Key | Locale | Old | New | Reason |
|---|---|---|---|---|
| `s4.dynamic.cath_lab.consumables.device_tag` | ta | குறிச்சொல் {tag} | குறிச்சீட்டு {tag} | [ta reviewer] GLOSSARY: device tag → குறிச்சீட்டு. குறிச்சொல் literally means keyword/hashtag (software tag), not a physical asset tag on a catheter. |
| `s4.lib.cath_lab.consumables.device_blocked` | hi | इस उपकरण पर रक्तजनित संक्रमण का चिह्न है और इसे पुनः उपयोग नहीं किया जा सकता | इस उपकरण पर रक्तजनित एक्सपोज़र का चिह्न दर्ज है; पुनः उपयोग की अनुमति नहीं है | [human review §3A] Reviewer's fix still said infection risk. Now: a blood-borne exposure flag is recorded; reuse is not permitted (a rule, not an inability). |
| `s4.lib.cath_lab.consumables.device_blocked` | ta | இந்த சாதனத்தில் இரத்தம் வழி நோய்த்தொற்று குறி உள்ளது; மறுபயன்பாடு இயலாது | இந்தச் சாதனத்திற்கு இரத்தவழி எக்ஸ்போஷர் குறி பதிவாகியுள்ளது; மறுபயன்பாடு தடுக்கப்பட்டுள்ளது | [human review §3A] Reviewer's fix still said infection-risk marker. Now: exposure flag recorded; reuse is blocked. |
| `s4.lib.cath_lab.consumables.device_blocked` | te | ఈ పరికరంపై రక్తజనిత సంక్రమణ గుర్తు ఉంది; తిరిగి వాడలేము | ఈ పరికరానికి రక్తజనిత ఎక్స్‌పోజర్ ఫ్లాగ్ నమోదై ఉంది; తిరిగి వాడటం నిరోధించబడింది | [human review §3A] Reviewer's fix still said infection-risk mark. Now: exposure flag recorded; reuse is blocked. |
| `s4.lib.cath_lab.consumables.device_blocked` | ml | ഈ ഉപകരണത്തിൽ രക്തജന്യ അണുബാധ ഫ്ലാഗ് ഉണ്ട്; പുനരുപയോഗം സാധ്യമല്ല | ഈ ഉപകരണത്തിൽ രക്തത്തിലൂടെ പകരുന്ന അണുബാധയുമായുള്ള സമ്പർക്കം സൂചിപ്പിക്കുന്ന മുന്നറിയിപ്പ് രേഖപ്പെടുത്തിയിട്ടുണ്ട്; ഇത് പുനരുപയോഗിക്കാനാവില്ല. | [human review §3A] Human review's Malayalam candidate, verbatim: a warning indicating contact with a blood-borne infection is recorded; it cannot be reused. |
| `s4.lib.cath_lab.consumables.device_tag_label` | ta | சாதன குறிச்சொல் | சாதன குறிச்சீட்டு | [ta reviewer] GLOSSARY: device tag → குறிச்சீட்டு, consistent with consumables.device_tag; குறிச்சொல் is the keyword sense. |
| `s4.lib.cath_lab.consumables.exposure_badge` | hi | संक्रमण जोखिम | एक्सपोज़र | [human review §3A] Badge said infection risk (संक्रमण जोखिम); an exposure flag is neither infection nor a risk grade. Ward term for blood-borne exposure (PEP vocabulary) in every locale; the adjacent device_blocked text carries the full meaning. |
| `s4.lib.cath_lab.consumables.exposure_badge` | ta | தொற்று ஆபத்து | எக்ஸ்போஷர் | [human review §3A] தொற்று ஆபத்து = infection risk. Exposure is the established infection-control term; native வெளிப்பாடு alone reads as expression/manifestation on a chip. |
| `s4.lib.cath_lab.consumables.exposure_badge` | te | సంక్రమణ ప్రమాదం | ఎక్స్‌పోజర్ | [human review §3A] సంక్రమణ ప్రమాదం = infection risk. Same exposure term as the other locales. |
| `s4.lib.cath_lab.consumables.exposure_badge` | ml | അണുബാധ സാധ്യത | എക്സ്പോഷർ | [human review §3A] അണുബാധ സാധ്യത = infection possibility. Same exposure term as the other locales; the block text uses the human review's native gloss. |
| `s4.lib.cath_lab.consumables.mode_new` | ta | புதிய அலகு | புதிய யூனிட் | [ta reviewer] GLOSSARY: stock/device unit → யூனிட் (spoken TN ward usage). அலகு reads as a measurement unit and is reserved for readiness.unit. |
| `s4.lib.cath_lab.consumables.post_use_device_already_discarded` | hi | डिवाइस पहले ही CSSD द्वारा नष्ट किया जा चुका है; निपटान दर्ज किया गया | CSSD ने इस उपकरण को पहले ही डिस्कार्ड के रूप में चिह्नित कर दिया है; उपयोग-पश्चात निर्णय दर्ज किया गया | [en source change, required] Human review §3B. Verified: cathDeviceReuseService.js sets cath_reprocessable_devices.status = 'discarded' (terminal lifecycle status, discard_reason required), not verified physical destruction. Every locale says "marked as discarded" and uses the batch discard term (never destroy/delete). |
| `s4.lib.cath_lab.consumables.post_use_device_already_discarded` | ta | சாதனம் ஏற்கனவே CSSD ஆல் அகற்றப்பட்டது; அகற்றல் பதிவு செய்யப்பட்டது | CSSD இந்தச் சாதனத்தை ஏற்கனவே அப்புறப்படுத்தப்பட்டதாகக் குறித்துள்ளது; பயன்பாட்டிற்குப் பிந்தைய நடவடிக்கை பதிவு செய்யப்பட்டது | [en source change, required] Human review §3B. Verified: cathDeviceReuseService.js sets cath_reprocessable_devices.status = 'discarded' (terminal lifecycle status, discard_reason required), not verified physical destruction. Every locale says "marked as discarded" and uses the batch discard term (never destroy/delete). |
| `s4.lib.cath_lab.consumables.post_use_device_already_discarded` | te | పరికరాన్ని CSSD ఇప్పటికే పారవేసింది; పారవేత నమోదైంది | CSSD ఈ పరికరాన్ని ఇప్పటికే పారవేసినట్లు గుర్తించింది; వినియోగానంతర నిర్ణయం నమోదైంది | [en source change, required] Human review §3B. Verified: cathDeviceReuseService.js sets cath_reprocessable_devices.status = 'discarded' (terminal lifecycle status, discard_reason required), not verified physical destruction. Every locale says "marked as discarded" and uses the batch discard term (never destroy/delete). |
| `s4.lib.cath_lab.consumables.post_use_device_already_discarded` | ml | ഉപകരണം CSSD ഇതിനകം നീക്കം ചെയ്തു; തീർപ്പാക്കൽ രേഖപ്പെടുത്തി | CSSD ഈ ഉപകരണം ഇതിനകം ഉപേക്ഷിച്ചതായി അടയാളപ്പെടുത്തിയിട്ടുണ്ട്; ഉപയോഗാനന്തര തീരുമാനം രേഖപ്പെടുത്തി | [en source change, required] Human review §3B. Verified: cathDeviceReuseService.js sets cath_reprocessable_devices.status = 'discarded' (terminal lifecycle status, discard_reason required), not verified physical destruction. Every locale says "marked as discarded" and uses the batch discard term (never destroy/delete). |
| `s4.lib.cath_lab.consumables.post_use_discard` | hi | नष्ट करें | डिस्कार्ड करें | [human review §3B] नष्ट = destroy is out. डिस्कार्ड is the status name on the record (status = discarded) and the word cath-lab staff use; निपटान would assert physical disposal the status does not guarantee. |
| `s4.lib.cath_lab.consumables.post_use_discard` | ta | அகற்று | அப்புறப்படுத்து | [human review §3B] அகற்று (remove) is too vague - it is also the UI word for removing a row. அப்புறப்படுத்து is the specific Tamil for disposing of an item; the reviewer's objection (waste-handling register) is the correct register for a device that will not be reprocessed. Not நாசம் (destroy), not நீக்கு (delete). |
| `s4.lib.cath_lab.consumables.post_use_discard` | ml | നീക്കം ചെയ്യുക | ഉപേക്ഷിക്കുക | [ml reviewer] GLOSSARY: discard → ഉപേക്ഷിക്കുക. നീക്കം ചെയ്യുക is the Malayalam UI word for Remove/Delete, so the button read as 'remove this row', not 'do not reprocess, throw it away'. |
| `s4.lib.cath_lab.consumables.post_use_discard_reason` | hi | नष्ट करने का कारण | डिस्कार्ड का कारण | [human review §3B] Follows post_use_discard. |
| `s4.lib.cath_lab.consumables.post_use_discard_reason` | ta | அகற்றுவதற்கான காரணம் | அப்புறப்படுத்துவதற்கான காரணம் | [human review §3B] Follows post_use_discard. |
| `s4.lib.cath_lab.consumables.post_use_discard_reason` | ml | നീക്കം ചെയ്യാനുള്ള കാരണം | ഉപേക്ഷിക്കാനുള്ള കാരണം | [ml reviewer] GLOSSARY discard → ഉപേക്ഷിക്കുക; follows post_use_discard. |
| `s4.lib.cath_lab.consumables.post_use_units` | ta | CSSD-க்கு செல்லும் அலகுகள் | CSSD-க்கு செல்லும் யூனிட்டுகள் | [ta reviewer] GLOSSARY: stock/device unit → யூனிட்; அலகு here read as measurement units, colliding with readiness.unit. |
| `s4.lib.cath_lab.consumables.restriction_restricted` | hi | इस केस में उपयोग किए गए उपकरण नष्ट किए जाएंगे, पुनःसंसाधित नहीं | इस केस में उपयोग किए गए उपकरण डिस्कार्ड किए जाएंगे, पुनःसंसाधित नहीं | [human review §3B] नष्ट किए जाएंगे (will be destroyed) -> डिस्कार्ड किए जाएंगे; discard/reprocess contrast kept. |
| `s4.lib.cath_lab.consumables.restriction_restricted` | ta | இந்த வழக்கில் பயன்படுத்தப்படும் சாதனங்கள் அகற்றப்படும்; மறுசெயலாக்கப்படாது | இந்தச் செயல்முறையில் பயன்படுத்தப்படும் சாதனங்கள் அப்புறப்படுத்தப்படும்; மறுசெயலாக்கப்படாது | [ta reviewer + human review §3B] வழக்கு (court case) -> செயல்முறை per the reviewer; அகற்றப்படும் -> அப்புறப்படுத்தப்படும் per the discard decision. |
| `s4.lib.cath_lab.consumables.restriction_restricted` | ml | ഈ കേസിൽ ഉപയോഗിക്കുന്ന ഉപകരണങ്ങൾ നീക്കം ചെയ്യപ്പെടും; പുനഃസംസ്കരിക്കില്ല | ഈ കേസിൽ ഉപയോഗിക്കുന്ന ഉപകരണങ്ങൾ ഉപേക്ഷിക്കപ്പെടും; പുനഃസംസ്കരിക്കില്ല | [ml reviewer] GLOSSARY discard → ഉപേക്ഷിക്കുക: the restriction strip must say the devices are thrown away, not merely 'removed'. |
| `s4.lib.cath_lab.consumables.restriction_unknown` | hi | सीरोलॉजी दर्ज नहीं है; पुनःसंसाधन के लिए पुष्टि आवश्यक | सीरोलॉजी परिणाम दर्ज नहीं हैं; पुनःसंसाधन से पहले इसकी जानकारी होने की पुष्टि आवश्यक है | [human review §3A] Mirrors the review's ta/ml frame: serology results not on record; before reprocessing, confirmation that this is known is required. Not consent, not a safety confirmation. |
| `s4.lib.cath_lab.consumables.restriction_unknown` | ta | சீராலஜி பதிவில் இல்லை; மறுசெயலாக்கத்திற்கு ஒப்புதல் தேவை | சீராலஜி முடிவுகள் பதிவில் இல்லை; மறுசெயலாக்கத்திற்கு முன் இதை அறிந்ததற்கான உறுதிப்படுத்தல் தேவை | [human review §3A] Review's Tamil candidate (final stop dropped to match en and the sibling strip string). ஒப்புதல் is the consent term; this is staff acknowledgement. |
| `s4.lib.cath_lab.consumables.restriction_unknown` | te | సెరాలజీ నమోదులో లేదు; పునఃప్రాసెసింగ్‌కు ధృవీకరణ అవసరం | సెరాలజీ ఫలితాలు నమోదులో లేవు; పునఃప్రాసెసింగ్‌కు ముందు ఇది తెలిసినట్లు ధృవీకరించాలి | [blind check + human review §3A] Reviewer's అంగీకారం back-translated as "consent is required" - the exact confusion the review names. Acknowledgement frame: it must be confirmed that this is known; the object of confirmation is the awareness, so ధృవీకరించు no longer reads as "verify the serology". |
| `s4.lib.cath_lab.consumables.restriction_unknown` | ml | സെറോളജി രേഖയിലില്ല; പുനഃസംസ്കരണത്തിന് സ്ഥിരീകരണം ആവശ്യം | സെറോളജി ഫലങ്ങൾ രേഖപ്പെടുത്തിയിട്ടില്ല; പുനഃസംസ്കരണത്തിന് മുമ്പ് ഈ വിവരം അറിഞ്ഞതായി സ്ഥിരീകരിക്കണം | [human review §3A] Review's Malayalam candidate (final stop dropped to match en and the sibling strip string). |
| `s4.lib.cath_lab.readiness.auto_managed_note` | hi | यह जाँच स्वचालित रूप से प्रबंधित है; अगला रिफ्रेश इसे वापस बदल सकता है। | यह जांच स्वचालित रूप से प्रबंधित है; अगला रिफ्रेश इसे वापस बदल सकता है। | [hi reviewer] GLOSSARY: check → जांच. Only key spelling it जाँच; every other key in the batch uses जांच. |
| `s4.lib.cath_lab.readiness.auto_managed_note` | ta | இந்தச் சரிபார்ப்பை தானியங்கி நிர்வகிக்கிறது; அடுத்த புதுப்பிப்பு இதை மாற்றக்கூடும். | இந்தச் சரிபார்ப்பை தானியங்கி நிர்வகிக்கிறது; அடுத்த புதுப்பிப்பு இதைப் பழைய நிலைக்கு மாற்றக்கூடும். | [ta reviewer] set it back means revert; மாற்றக்கூடும் alone lost that, so staff could not tell their edit may be undone. |
| `s4.lib.cath_lab.readiness.check.anticoagulation` | hi | थक्कारोधी | एंटीकोआग्यूलेशन | [human review §3D] थक्कारोधी is the adjective/agent (anticoagulant). एंटीकोआग्यूलेशन is the corpus rendering already used in s4.calculators.hasBled.subtitle and what Hindi-belt cardiology staff say. |
| `s4.lib.cath_lab.readiness.check.anticoagulation` | te | రక్తం గడ్డకట్టే నిరోధకం | ప్రతిస్కందక చికిత్స | [human review §3D] రక్తం గడ్డకట్టే నిరోధకం names an inhibitor substance. ప్రతిస్కందక is the corpus root (hasBled.subtitle: ప్రతిస్కందకం); with చికిత్స it names anticoagulant therapy, which is what the check reviews. |
| `s4.lib.cath_lab.readiness.check.labs` | ta | ஆய்வக பரிசோதனைகள் | ஆய்வகப் பரிசோதனைகள் | [reconciler] Reviewer dropped the lab qualifier (bare பரிசோதனைகள் = tests/examinations, which the blind check confirmed carries no lab sense). Row label, not a chip: cath_readiness_checklist.dart renders it as a ListTile title in a column of eight rows whose width is set by "Implants and device rep". Same as shipped plus the sandhi ப். |
| `s4.lib.cath_lab.readiness.check.timeout` | hi | टाइम-आउट | प्रक्रिया सुरक्षा टाइम-आउट | [en source change, required] Human review §3D. Bare "Timeout" reads as a time limit (ml reviewer: സമയപരിധി would mislead). The four locales keep the theatre transliteration of time-out that every reviewer confirmed and prefix the procedure-safety qualifier. |
| `s4.lib.cath_lab.readiness.check.timeout` | ta | டைம்-அவுட் | செயல்முறை பாதுகாப்பு டைம்-அவுட் | [en source change, required] Human review §3D. Bare "Timeout" reads as a time limit (ml reviewer: സമയപരിധി would mislead). The four locales keep the theatre transliteration of time-out that every reviewer confirmed and prefix the procedure-safety qualifier. |
| `s4.lib.cath_lab.readiness.check.timeout` | te | టైమ్-అవుట్ | ప్రక్రియ భద్రతా టైమ్-అవుట్ | [en source change, required] Human review §3D. Bare "Timeout" reads as a time limit (ml reviewer: സമയപരിധി would mislead). The four locales keep the theatre transliteration of time-out that every reviewer confirmed and prefix the procedure-safety qualifier. |
| `s4.lib.cath_lab.readiness.check.timeout` | ml | ടൈം-ഔട്ട് | പ്രൊസീജ്യർ സുരക്ഷാ ടൈം-ഔട്ട് | [en source change, required] Human review §3D. Bare "Timeout" reads as a time limit (ml reviewer: സമയപരിധി would mislead). The four locales keep the theatre transliteration of time-out that every reviewer confirmed and prefix the procedure-safety qualifier. |
| `s4.lib.cath_lab.readiness.checks_title` | ml | നടപടിക്ക് മുമ്പുള്ള പരിശോധനകൾ | പ്രൊസീജ്യറിന് മുമ്പുള്ള പരിശോധനകൾ | [ml reviewer] GLOSSARY: procedure → പ്രൊസീജ്യർ. Bare നടപടി reads as an administrative action/proceeding, not a cath-lab procedure. |
| `s4.lib.cath_lab.readiness.confirm_action` | te | నిర్ధారించు | నిర్ధారించండి | [te reviewer] Same English 'Confirm' as consumables.post_use_confirm but familiar imperative; whole batch uses polite -ండి. Register normalised. |
| `s4.lib.cath_lab.readiness.confirm_body` | te | {check}ని {status}కి సెట్ చేయాలా? | {check}: {status} అని సెట్ చేయాలా? | [te reviewer] Case suffixes on placeholders break: {check}ని yields పరికరాలుని/ల్యాబ్ పరీక్షలుని, and {status}కి yields వర్తించదుకి / మినహాయించారుకి. Quotative అని frame is grammatical for every check and status value. |
| `s4.lib.cath_lab.readiness.confirm_critical` | hi | गंभीर मान मौजूद: {items}। इस जांच को पास करने का कारण दें। | गंभीर मान मौजूद: {items}। गंभीर परिणाम के बावजूद इस जांच को उत्तीर्ण के रूप में चिह्नित करने का कारण दें। | [en source change, required] Human review §3C: "passing this check" leaned to completing (ta) / approving (te). Every locale now names the Pass chip term (उत्तीर्ण / தேர்ச்சி / ఉత్తీర్ణం / വിജയം) and carries "despite the critical result". |
| `s4.lib.cath_lab.readiness.confirm_critical` | ta | ஆபத்தான மதிப்பு உள்ளது: {items}. இந்தச் சரிபார்ப்பை நிறைவேற்றுவதற்கான காரணத்தைக் குறிப்பிடவும். | ஆபத்தான மதிப்புகள் உள்ளன: {items}. ஆபத்தான முடிவு இருந்தும் இந்தச் சரிபார்ப்பைத் தேர்ச்சி எனக் குறிப்பதற்கான காரணத்தைத் தரவும். | [en source change, required] Human review §3C: "passing this check" leaned to completing (ta) / approving (te). Every locale now names the Pass chip term (उत्तीर्ण / தேர்ச்சி / ఉత్తీర్ణం / വിജയം) and carries "despite the critical result". |
| `s4.lib.cath_lab.readiness.confirm_critical` | te | క్లిష్ట విలువ ఉంది: {items}. ఈ తనిఖీని ఆమోదించడానికి కారణం తెలియజేయండి. | క్రిటికల్ విలువలు ఉన్నాయి: {items}. క్రిటికల్ ఫలితం ఉన్నప్పటికీ ఈ తనిఖీని ఉత్తీర్ణం అని గుర్తించడానికి కారణం తెలియజేయండి. | [en source change, required] Human review §3C: "passing this check" leaned to completing (ta) / approving (te). Every locale now names the Pass chip term (उत्तीर्ण / தேர்ச்சி / ఉత్తీర్ణం / വിജയം) and carries "despite the critical result". |
| `s4.lib.cath_lab.readiness.confirm_critical` | ml | ഗുരുതര മൂല്യം ഉണ്ട്: {items}. ഈ പരിശോധന പാസാക്കുന്നതിന്റെ കാരണം നൽകുക. | ഗുരുതര മൂല്യങ്ങൾ ഉണ്ട്: {items}. ഗുരുതര ഫലം ഉണ്ടായിട്ടും ഈ പരിശോധന വിജയം എന്ന് അടയാളപ്പെടുത്തുന്നതിനുള്ള കാരണം നൽകുക. | [en source change, required] Human review §3C: "passing this check" leaned to completing (ta) / approving (te). Every locale now names the Pass chip term (उत्तीर्ण / தேர்ச்சி / ఉత్తీర్ణం / വിജയം) and carries "despite the critical result". |
| `s4.lib.cath_lab.readiness.confirm_critical_unnamed` | hi | गंभीर मान मौजूद है। इस जांच को पास करने का कारण दें। | एक गंभीर मान मौजूद है। गंभीर परिणाम के बावजूद इस जांच को उत्तीर्ण के रूप में चिह्नित करने का कारण दें। | [en source change, required] Same as confirm_critical, unnamed variant (backend blanks critical_items for roles outside the result audience). |
| `s4.lib.cath_lab.readiness.confirm_critical_unnamed` | ta | ஆபத்தான மதிப்பு உள்ளது. இந்தச் சரிபார்ப்பை நிறைவேற்றுவதற்கான காரணத்தைக் குறிப்பிடவும். | ஆபத்தான மதிப்பு ஒன்று உள்ளது. ஆபத்தான முடிவு இருந்தும் இந்தச் சரிபார்ப்பைத் தேர்ச்சி எனக் குறிப்பதற்கான காரணத்தைத் தரவும். | [en source change, required] Same as confirm_critical, unnamed variant (backend blanks critical_items for roles outside the result audience). |
| `s4.lib.cath_lab.readiness.confirm_critical_unnamed` | te | క్లిష్ట విలువ ఉంది. ఈ తనిఖీని ఆమోదించడానికి కారణం తెలియజేయండి. | ఒక క్రిటికల్ విలువ ఉంది. క్రిటికల్ ఫలితం ఉన్నప్పటికీ ఈ తనిఖీని ఉత్తీర్ణం అని గుర్తించడానికి కారణం తెలియజేయండి. | [en source change, required] Same as confirm_critical, unnamed variant (backend blanks critical_items for roles outside the result audience). |
| `s4.lib.cath_lab.readiness.confirm_critical_unnamed` | ml | ഗുരുതര മൂല്യം ഉണ്ട്. ഈ പരിശോധന പാസാക്കുന്നതിന്റെ കാരണം നൽകുക. | ഒരു ഗുരുതര മൂല്യം ഉണ്ട്. ഗുരുതര ഫലം ഉണ്ടായിട്ടും ഈ പരിശോധന വിജയം എന്ന് അടയാളപ്പെടുത്തുന്നതിനുള്ള കാരണം നൽകുക. | [en source change, required] Same as confirm_critical, unnamed variant (backend blanks critical_items for roles outside the result audience). |
| `s4.lib.cath_lab.readiness.critical` | te | క్లిష్టం | క్రిటికల్ | [te reviewer] GLOSSARY: critical = క్రిటికల్. క్లిష్టం = 'complicated'; badge must read as an alarm flag. Matches resus.trigger.critical_vital. |
| `s4.lib.cath_lab.readiness.critical_value` | hi | गंभीर मान | गंभीर जांच मान | [human review §3C] Review candidate गंभीर जाँच मान with the batch spelling जांच (the hi reviewer normalised जाँच->जांच across the batch). Chip on the Labs check row: names a critical TEST value. |
| `s4.lib.cath_lab.readiness.critical_value` | ta | ஆபத்தான மதிப்பு | ஆபத்தான பரிசோதனை மதிப்பு | [human review §3C] Review candidate. 16 clusters vs 22.4 budget. |
| `s4.lib.cath_lab.readiness.critical_value` | te | క్లిష్ట విలువ | క్రిటికల్ పరీక్ష విలువ | [human review §3C] Review candidate; reviewer had క్రిటికల్ విలువ (also correct on the critical term). క్లిష్ట = complicated is out. |
| `s4.lib.cath_lab.readiness.critical_value` | ml | ഗുരുതര മൂല്യം | ഗുരുതര പരിശോധനാ മൂല്യം | [human review §3C] Review candidate. |
| `s4.lib.cath_lab.readiness.external_report_ref` | ta | அறிக்கை குறிப்பு | அறிக்கை எண் | [ta reviewer] குறிப்பு is the batch term for Note (post_use_note, readiness.notes), so அறிக்கை குறிப்பு read as report note. The outside report is identified by its number. |
| `s4.lib.cath_lab.readiness.external_report_ref` | te | నివేదిక సూచిక | నివేదిక రిఫరెన్స్ | [te reviewer] సూచిక = 'index/indicator', not a report identifier; staff say 'reference'. |
| `s4.lib.cath_lab.readiness.external_unverified_hint` | te | బాహ్య ల్యాబ్ ఫలితంగా నిల్వ; పాథాలజిస్ట్ ధృవీకరించలేదు | బయటి ల్యాబ్ ఫలితంగా నమోదు చేయబడింది; పాథాలజిస్ట్ ధృవీకరించలేదు | [te reviewer] GLOSSARY: external/outside = బయటి (was బాహ్య here, బయటి in 5 sibling keys). Bare నిల్వ is a noun ('stock') and ungrammatical as a predicate; unverified clause kept intact. |
| `s4.lib.cath_lab.readiness.external_unverified_hint` | ml | ബാഹ്യ ലാബ് ഫലമായി സൂക്ഷിച്ചു; പാത്തോളജിസ്റ്റ് പരിശോധിച്ചിട്ടില്ല | പുറത്തെ ലാബ് ഫലമായി സൂക്ഷിച്ചിരിക്കുന്നു; പാത്തോളജിസ്റ്റ് സ്ഥിരീകരിച്ചിട്ടില്ല | [human review §3D, code fact] Review's rendering. The reviewer avoided സ്ഥിരീകരിക്കുക because it is "the Confirm button on the same screen" - but cath_external_result_sheet.dart has Save/Cancel (actionSave/actionCancel), no Confirm; the premise does not hold. ബാഹ്യ -> പുറത്തെ so the hint matches external_lab_name / lab_name_required two fields below on the same sheet (the review's own chip uses പുറത്തുനിന്നുള്ള). |
| `s4.lib.cath_lab.readiness.header.missing` | hi | जांचें अधूरी: {items} | लैब जांच अधूरी: {items} | [blind check] Reviewer's अधूरी लैब जांचें could be read as the polite imperative "check the incomplete lab". Collective noun जांच cannot be a verb form; parallels te/ml "Lab tests incomplete". |
| `s4.lib.cath_lab.readiness.header.missing` | ta | ஆய்வுகள் முழுமையடையவில்லை: {items} | ஆய்வகப் பரிசோதனைகள் முழுமையடையவில்லை: {items} | [reconciler] Reviewer's fix removed ஆய்வுகள் (studies) correctly but also the lab qualifier; the human review's te/ml corrections for this key both keep "lab tests". Matches check.labs. |
| `s4.lib.cath_lab.readiness.header.missing` | te | ల్యాబ్‌లు అసంపూర్ణం: {items} | ల్యాబ్ పరీక్షలు అసంపూర్ణం: {items} | [te reviewer] ల్యాబ్‌లు = 'the laboratories'; what is incomplete is the lab tests. Matches check.labs. |
| `s4.lib.cath_lab.readiness.header.missing` | ml | ലാബുകൾ അപൂർണ്ണം: {items} | ലാബ് പരിശോധനകൾ അപൂർണ്ണം: {items} | [ml reviewer] 'Labs' here means the tests, not the laboratories: ലാബുകൾ അപൂർണ്ണം read as 'the laboratories are incomplete'. Matches check.labs. |
| `s4.lib.cath_lab.readiness.item.platelets` | ta | தட்டணுக்கள் | பிளேட்லெட்டுகள் | [ta reviewer] GLOSSARY: platelets → பிளேட்லெட்டுகள், matching blood_bank.component.platelets and the CBC report form. தட்டணுக்கள் is textbook Tamil for thrombocytes and clashes with the transliterated Hb/creatinine/potassium beside it in the same list. |
| `s4.lib.cath_lab.readiness.load_failed` | ml | സന്നദ്ധത ലോഡ് ചെയ്യാനായില്ല | തയ്യാറെടുപ്പ് ലോഡ് ചെയ്യാനായില്ല | [ml reviewer] GLOSSARY: readiness → തയ്യാറെടുപ്പ്. സന്നദ്ധത means willingness/volunteering, so the error read as 'could not load willingness'. |
| `s4.lib.cath_lab.readiness.observed_line` | hi | {date} तक | {date} को पाया गया | [en source change, **proposed**] Renders the proposed English "Observed {date}" with a verb, which removes the deadline reading the reviewer flagged in the shipped `{date} तक` without the as-of paraphrase. Placeholder intact. |
| `s4.lib.cath_lab.readiness.observed_line` | ta | {date} வரை | {date} அன்று கண்டறியப்பட்டது | [en source change, **proposed**] Renders the proposed English "Observed {date}"; `{date} வரை` read as "until {date}", wrong for a single observation on a staleness-sensitive line. Placeholder intact. |
| `s4.lib.cath_lab.readiness.observed_line` | te | {date} నాటికి | {date}న పరిశీలించారు | [en source change, **proposed**] Renders the proposed English "Observed {date}"; `{date} నాటికి` ("as of / by {date}") carries the same validity-window reading the other three locales were corrected for. Placeholder intact. |
| `s4.lib.cath_lab.readiness.observed_line` | ml | {date} വരെ | {date}-ന് നിരീക്ഷിച്ചു | [en source change, **proposed**] Renders the proposed English "Observed {date}"; the blind check read the reviewer's `പ്രകാരം` as "as per", and `വരെ` (until) is out per the human review. Placeholder intact. |
| `s4.lib.cath_lab.readiness.ordered_on` | ml | {date}ന് ഓർഡർ ചെയ്തു | {date}-ന് ഓർഡർ ചെയ്തു | [ml reviewer] Hyphen before the case suffix on a Latin/numeric token, matching waived_on ({date}-ന്). Placeholder intact. |
| `s4.lib.cath_lab.readiness.result_required` | hi | एक परिणाम चुनें | परिणाम आवश्यक है | [en source change, **proposed**] Renders the proposed English "A result is required". The shipped `एक परिणाम चुनें` rendered the current imperative source, which collides with the dropdown hint `external.select_result` (`परिणाम चुनें`) on the same control. Vetoing the proposal reverts these four rows. |
| `s4.lib.cath_lab.readiness.result_required` | ta | ஒரு முடிவைத் தேர்ந்தெடுக்கவும் | முடிவு தேவை | [en source change, **proposed**] Renders the proposed English "A result is required"; the shipped value rendered the current imperative source, which duplicates `external.select_result` on the same control. |
| `s4.lib.cath_lab.readiness.result_required` | te | ఒక ఫలితాన్ని ఎంచుకోండి | ఫలితం అవసరం | [en source change, **proposed**] Renders the proposed English "A result is required"; the shipped value rendered the current imperative source, which duplicates `external.select_result` on the same control. |
| `s4.lib.cath_lab.readiness.result_required` | ml | ഒരു ഫലം തിരഞ്ഞെടുക്കുക | ഫലം ആവശ്യമാണ് | [en source change, **proposed**] Renders the proposed English "A result is required"; the shipped value rendered the current imperative source, which duplicates `external.select_result` on the same control. |
| `s4.lib.cath_lab.readiness.state.external_recorded` | ta | வெளி, சரிபார்க்கப்படாதது | வெளி முடிவு, சரிபார்க்கப்படாதது | [ta reviewer] வெளி is a bound adjectival form and cannot stand alone before a comma. வெளி முடிவு matches external_title and enter_external; the unverified half is unchanged. |
| `s4.lib.cath_lab.readiness.state.external_recorded` | te | బాహ్య, ధృవీకరించనిది | బయటి ఫలితం; ధృవీకరించనిది | [reconciler] Reviewer's బయటి, ధృవీకరించనిది back-translated as "two adjectives joined by a comma". Head noun added so the chip is a noun phrase like ta (வெளி முடிவு, ...) and ml (പുറത്തുനിന്നുള്ള ഫലം; ...); బయటి kept per the reviewer's glossary. |
| `s4.lib.cath_lab.readiness.state.external_recorded` | ml | ബാഹ്യം, പരിശോധിക്കാത്തത് | പുറത്തുനിന്നുള്ള ഫലം; സ്ഥിരീകരിച്ചിട്ടില്ല | [human review §3D] Review's rendering verbatim. The Confirm button on this surface lives only inside the modal check-status dialog, which is about a check row, not a lab item; the chip stays unambiguous. Same verb as the hint, so the two agree. |
| `s4.lib.cath_lab.readiness.state.result_final` | hi | परिणाम | अंतिम परिणाम | [en source change, required] Human review §3D: bare "Result" does not name the state; "Final result" is the guaranteed meaning of result_final (no "signed"/"verified" added). Pairs with result_preliminary, which now carries the head noun in every locale. |
| `s4.lib.cath_lab.readiness.state.result_final` | ta | முடிவு | இறுதி முடிவு | [en source change, required] Human review §3D: bare "Result" does not name the state; "Final result" is the guaranteed meaning of result_final (no "signed"/"verified" added). Pairs with result_preliminary, which now carries the head noun in every locale. |
| `s4.lib.cath_lab.readiness.state.result_final` | te | ఫలితం | తుది ఫలితం | [en source change, required] Human review §3D: bare "Result" does not name the state; "Final result" is the guaranteed meaning of result_final (no "signed"/"verified" added). Pairs with result_preliminary, which now carries the head noun in every locale. |
| `s4.lib.cath_lab.readiness.state.result_final` | ml | ഫലം | അന്തിമ ഫലം | [en source change, required] Human review §3D: bare "Result" does not name the state; "Final result" is the guaranteed meaning of result_final (no "signed"/"verified" added). Pairs with result_preliminary, which now carries the head noun in every locale. |
| `s4.lib.cath_lab.readiness.state.result_preliminary` | hi | प्रारंभिक | प्रारंभिक परिणाम | [reconciler] Head noun added so the pair reads अंतिम परिणाम / प्रारंभिक परिणाम once result_final becomes "Final result" (required source change); ta/te reviewers made the same point about a bare adjective as a chip. |
| `s4.lib.cath_lab.readiness.state.result_preliminary` | ta | ஆரம்ப | முதற்கட்ட முடிவு | [human review §3D] Review candidate; reviewer's ஆரம்ப முடிவு back-translated as "initial/first result". |
| `s4.lib.cath_lab.readiness.state.result_preliminary` | te | ప్రాథమిక | ప్రాథమిక ఫలితం | [te reviewer] Bare ప్రాథమిక most commonly reads 'primary/basic' (ప్రాథమిక చికిత్స = first aid) and is an incomplete adjective; adding ఫలితం pins it to 'preliminary result' against state.result_final. |
| `s4.lib.cath_lab.readiness.state.result_preliminary` | ml | പ്രാഥമികം | പ്രാഥമിക ഫലം | [reconciler] Same: അന്തിമ ഫലം / പ്രാഥമിക ഫലം. |
| `s4.lib.cath_lab.readiness.state.sample_sent_awaiting_result` | hi | प्रयोगशाला भेजा गया, परिणाम प्रतीक्षित | प्रयोगशाला को भेजा गया, परिणाम प्रतीक्षित | [hi reviewer] Missing postposition: भेजना requires को for the destination (cf. CSSD को भेजें). Meaning unchanged. |
| `s4.lib.cath_lab.readiness.state.sample_sent_awaiting_result` | te | ల్యాబ్‌కు పంపారు; ఫలితం వేచి ఉంది | ల్యాబ్‌కు పంపారు; ఫలితం రావాల్సి ఉంది | [te reviewer] వేచి ఉంది takes an animate subject; an awaited result is రావాల్సి ఉంది. Sent-to-lab half unchanged. |
| `s4.lib.cath_lab.readiness.waive` | te | మినహాయించు | మినహాయించండి | [te reviewer] GLOSSARY: waive = మినహాయించు stem; button was familiar imperative beside polite ఆర్డర్ చేయండి in the same row. |
| `s4.lib.cath_lab.readiness.waive_reason_line` | ta | விலக்கு: {reason} | விலக்கப்பட்டது: {reason} | [ta reviewer] The bare noun விலக்கு duplicated the Waive button label; this line reports a recorded state, so it takes the waived form. Placeholder intact. |
| `s4.lib.cath_lab.readiness.waived_done` | hi | जांच को छूट दी गई | लैब जांच को छूट दी गई | [hi reviewer] en says 'Lab item'; bare जांच was ambiguous between waiving a pre-procedure check and waiving a lab item — both are real operations here. |
| `s4.lib.cath_lab.readiness.waived_on` | ta | {date} அன்று விலக்கு அளிக்கப்பட்டது | {date} அன்று விலக்கப்பட்டது | [ta reviewer] விலக்கு அளிக்கப்பட்டது was a second waive form in the same screen; one form (விலக்கப்பட்டது) across the batch, and shorter. Placeholder intact. |
| `s4.lib.cath_lab.readiness.waived_on` | te | {date}న మినహాయింపు ఇవ్వబడింది | {date}న మినహాయించారు | [te reviewer] GLOSSARY: waived = మినహాయించారు; third form of the same word and unparallel with ordered_on ({date}న ఆర్డర్ చేశారు). |

### English source changes (`en.changes.jsonl`)

| Key | Status | Old | New | Why | Tests asserting the old text |
|---|---|---|---|---|---|
| `readiness.state.result_final` | required (human review §3D) | Result | Final result | Bare "Result" does not name the state; no "signed"/"verified" added. | none (tests use the state code) |
| `readiness.check.timeout` | required (§3D) | Timeout | Procedure safety time-out | Bare "Timeout" reads as a time limit. | none |
| `readiness.confirm_critical` | required (§3C) | Critical value present: {items}. Give a reason for passing this check. | Critical values present: {items}. Give a reason for marking this check as passed despite the critical result. | "passing this check" leaned to completing (ta) / approving (te). | `apps/staff/test/features/cath_lab/cath_readiness_checklist_test.dart:341,405,452` (`textContaining('Critical value present:')`) |
| `readiness.confirm_critical_unnamed` | required (§3C) | A critical value is present. Give a reason for passing this check. | A critical value is present. Give a reason for marking this check as passed despite the critical result. | Same. | `cath_readiness_checklist_test.dart:400,448` |
| `consumables.post_use_device_already_discarded` | required (§3B) | Device was already discarded by CSSD; disposition recorded | CSSD has already marked this device as discarded; post-use disposition recorded | Verified in `cathDeviceReuseService.js`: `discarded` is a terminal lifecycle status (`cath_reprocessable_devices.status`, `discard_reason` required), not verified physical destruction. | `apps/staff/test/features/cath_lab/cath_case_consumables_panel_test.dart:966` |
| `readiness.date_required` | **proposed** (owner may veto) | Choose the report date | Report date is required | hi/ta/te reviewers independently kept the validator register; a literal imperative duplicates `external.select_date` on the same field. All four shipped values already say "Report date is required". | `cath_readiness_checklist_test.dart:720` |
| `readiness.result_required` | **proposed** | Choose a result | A result is required | Validator text near-identical to the dropdown hint `external.select_result` on the same control; parallels `reason_required`. | `cath_readiness_checklist_test.dart:669` |
| `readiness.observed_line` | **proposed** | As of {date} | Observed {date} | hi/ta/ml all read the shipped "until {date}" as a deadline; blind check read ml പ്രകാരം as "as per". `observed_at` is the observation/collection instant and `_timingLine` renders it in parallel with "Ordered {date}" / "Waived {date}". | none (`textContaining` on dates only) |

The five values as one row (the four locale renderings come from the review, rendered against the NEW English — the old translations are not carried across):

| Key | Status | en (new) | hi | ta | te | ml |
|---|---|---|---|---|---|---|
| `readiness.state.result_final` | required | Final result | अंतिम परिणाम | இறுதி முடிவு | తుది ఫలితం | അന്തിമ ഫലം |
| `readiness.check.timeout` | required | Procedure safety time-out | प्रक्रिया सुरक्षा टाइम-आउट | செயல்முறை பாதுகாப்பு டைம்-அவுட் | ప్రక్రియ భద్రతా టైమ్-అవుట్ | പ്രൊസീജ്യർ സുരക്ഷാ ടൈം-ഔട്ട് |
| `readiness.confirm_critical` | required | Critical values present: {items}. Give a reason for marking this check as passed despite the critical result. | गंभीर मान मौजूद: {items}। गंभीर परिणाम के बावजूद इस जांच को उत्तीर्ण के रूप में चिह्नित करने का कारण दें। | ஆபத்தான மதிப்புகள் உள்ளன: {items}. ஆபத்தான முடிவு இருந்தும் இந்தச் சரிபார்ப்பைத் தேர்ச்சி எனக் குறிப்பதற்கான காரணத்தைத் தரவும். | క్రిటికల్ విలువలు ఉన్నాయి: {items}. క్రిటికల్ ఫలితం ఉన్నప్పటికీ ఈ తనిఖీని ఉత్తీర్ణం అని గుర్తించడానికి కారణం తెలియజేయండి. | ഗുരുതര മൂല്യങ്ങൾ ഉണ്ട്: {items}. ഗുരുതര ഫലം ഉണ്ടായിട്ടും ഈ പരിശോധന വിജയം എന്ന് അടയാളപ്പെടുത്തുന്നതിനുള്ള കാരണം നൽകുക. |
| `readiness.confirm_critical_unnamed` | required | A critical value is present. Give a reason for marking this check as passed despite the critical result. | एक गंभीर मान मौजूद है। गंभीर परिणाम के बावजूद इस जांच को उत्तीर्ण के रूप में चिह्नित करने का कारण दें। | ஆபத்தான மதிப்பு ஒன்று உள்ளது. ஆபத்தான முடிவு இருந்தும் இந்தச் சரிபார்ப்பைத் தேர்ச்சி எனக் குறிப்பதற்கான காரணத்தைத் தரவும். | ఒక క్రిటికల్ విలువ ఉంది. క్రిటికల్ ఫలితం ఉన్నప్పటికీ ఈ తనిఖీని ఉత్తీర్ణం అని గుర్తించడానికి కారణం తెలియజేయండి. | ഒരു ഗുരുതര മൂല്യം ഉണ്ട്. ഗുരുതര ഫലം ഉണ്ടായിട്ടും ഈ പരിശോധന വിജയം എന്ന് അടയാളപ്പെടുത്തുന്നതിനുള്ള കാരണം നൽകുക. |
| `consumables.post_use_device_already_discarded` | required | CSSD has already marked this device as discarded; post-use disposition recorded | CSSD ने इस उपकरण को पहले ही डिस्कार्ड के रूप में चिह्नित कर दिया है; उपयोग-पश्चात निर्णय दर्ज किया गया | CSSD இந்தச் சாதனத்தை ஏற்கனவே அப்புறப்படுத்தப்பட்டதாகக் குறித்துள்ளது; பயன்பாட்டிற்குப் பிந்தைய நடவடிக்கை பதிவு செய்யப்பட்டது | CSSD ఈ పరికరాన్ని ఇప్పటికే పారవేసినట్లు గుర్తించింది; వినియోగానంతర నిర్ణయం నమోదైంది | CSSD ഈ ഉപകരണം ഇതിനകം ഉപേക്ഷിച്ചതായി അടയാളപ്പെടുത്തിയിട്ടുണ്ട്; ഉപയോഗാനന്തര തീരുമാനം രേഖപ്പെടുത്തി |
| `readiness.date_required` | **proposed — owner may veto** | Report date is required | रिपोर्ट की तारीख आवश्यक है | அறிக்கை தேதி தேவை | నివేదిక తేదీ అవసరం | റിപ്പോർട്ട് തീയതി ആവശ്യമാണ് |
| `readiness.result_required` | **proposed — owner may veto** | A result is required | परिणाम आवश्यक है | முடிவு தேவை | ఫలితం అవసరం | ഫലം ആവശ്യമാണ് |
| `readiness.observed_line` | **proposed — owner may veto** | Observed {date} | {date} को पाया गया | {date} அன்று கண்டறியப்பட்டது | {date}న పరిశీలించారు | {date}-ന് നിരീക്ഷിച്ചു |

Locale renderings for every row are in `en.changes.jsonl`. `confirm_body` ("Set {check} to {status}?") stays as it is: the Telugu frame `{check}: {status} అని సెట్ చేయాలా?` avoids inflecting the placeholders; hi/ta/ml already use spaced postpositions/clitics that tolerate any substituted label.

### Glossary decisions (rows appended to `docs/i18n/GLOSSARY.md`; full table in `glossary.rows.md`)

- **Critical** (clinical critical / critical value): hi गंभीर · ta ஆபத்தானது · te క్రిటికల్ · ml ഗുരുതരം. Never "important" (ta முக்கியம்) or "complex" (te క్లిష్ట). Chip on the labs check row uses the qualified **Critical value**: गंभीर जांच मान · ஆபத்தான பரிசோதனை மதிப்பு · క్రిటికల్ పరీక్ష విలువ · ഗുരുതര പരിശോധനാ മൂല്യം; sentences that name the items use the bare form. Context-specific — no global replacement of the corpus's other `critical` keys in this batch (human review §4).
- **Exposure flag** ≠ infection ≠ infection risk: badge एक्सपोज़र · எக்ஸ்போஷர் · ఎక్స్‌పోజర్ · എക്സ്പോഷർ (the PEP/infection-control term staff use); block text says "an exposure flag is recorded; reuse is blocked" (ml in the human review's native gloss).
- **Acknowledgement** (staff, that serology is not recorded) ≠ **Consent** (patient): consent stays सहमति · ஒப்புதல் · సమ్మతి · സമ്മതം; the acknowledgement always states its object ("confirmation that this is known"): पुष्टि · உறுதிப்படுத்தல் · ధృవీకరణ · സ്ഥിരീകരണം. Tamil ஒப்புதல் and Telugu అంగీకారం are out of the acknowledgement strings.
- **Discard(ed)** = lifecycle status, not destroyed, not deleted: डिस्कार्ड करें / डिस्कार्ड · அப்புறப்படுத்து / அப்புறப்படுத்தப்பட்டது · పారవేయండి / పారవేసినట్లు · ഉപേക്ഷിക്കുക / ഉപേക്ഷിച്ചു. Out: नष्ट (destroy), அகற்று / நீக்கு / നീക്കം ചെയ്യുക / తొలగించు (remove/delete). "CSSD marked as discarded" is rendered as marked, never as done.
- **Pass / Fail** are check statuses: उत्तीर्ण/असफल · தேர்ச்சி/தோல்வி · ఉత్తీర్ణం/విఫలం · വിജയം/പരാജയം — never "normal"; the critical-override dialog names the same Pass term.
- **Waive / Waived** (a requirement being waived; distinct from not applicable / passed / cancelled): छूट दें / छूट दी गई · விலக்கு / விலக்கப்பட்டது · మినహాయించండి / మినహాయించారు · ഒഴിവാക്കുക / ഒഴിവാക്കി. One past form per locale across all eight waive keys.
- **Stale result**: descriptive age, not expiry — परिणाम बहुत पुराना · முடிவு மிகப் பழையது · ఫలితం చాలా పాతది · ഫലം വളരെ പഴയത്.
- **External / unverified**: बाहरी / असत्यापित · வெளி (முடிவு) / சரிபார்க்கப்படாதது · బయటి / ధృవీకరించనిది · പുറത്ത്- / സ്ഥിരീകരിച്ചിട്ടില്ല (ml verb per the human review; see Decisions).
- **Ordered / awaiting**: ऑर्डर किया गया / प्रतीक्षित · ஆர்டர் செய்யப்பட்டது / நிலுவை · ఆర్డర్ చేశారు / రావాల్సి ఉంది · ഓർഡർ ചെയ്തു / കാത്തിരിക്കുന്നു.
- **Reprocessed device**: पुनःसंसाधित उपकरण · மறுசெயலாக்கப்பட்ட சாதனம் · పునఃప్రాసెస్ చేసిన పరికరం · പുനഃസംസ്കരിച്ച ഉപകരണം. **Return/send to CSSD**: CSSD को भेजें · CSSD-க்கு அனுப்பு · CSSDకి పంపండి · CSSD-ലേക്ക് അയയ്ക്കുക.
- **Platelets**: प्लेटलेट्स · பிளேட்லெட்டுகள் · ప్లేట్‌లెట్లు · പ്ലേറ്റ്‌ലെറ്റുകൾ (ta தட்டணுக்கள் retired; matches `blood_bank.component.platelets`). **Haemoglobin**: हीमोग्लोबिन · ஹீமோகுளோபின் · హిమోగ్లోబిన్ · ഹീമോഗ്ലോബിൻ; the abbreviation Hb stays Latin.
- **Procedure** (cath): प्रक्रिया · செயல்முறை · ప్రక్రియ · പ്രൊസീജ്യർ (ml നടപടി = administrative action, retired). **Case** (cath): केस · செயல்முறை (வழக்கு = court case, retired) · కేసు · കേസ്.
- **Readiness**: तैयारी · தயார்நிலை · సంసిద్ధత · തയ്യാറെടുപ്പ് (ml സന്നദ്ധത = willingness, retired).
- **Anticoagulation (check)**: एंटीकोआग्यूलेशन · இரத்த உறைவு எதிர்ப்பு · ప్రతిస్కందక చికిత్స · രക്തം കട്ടപിടിക്കൽ പ്രതിരോധം.
- **Time-out (procedure safety)**: टाइम-आउट · டைம்-அவுட் · టైమ్-అవుట్ · ടൈം-ഔട്ട് — the theatre term, transliterated in every locale.
- Also set by this batch: device tag (ta குறிச்சீட்டு, not குறிச்சொல் = keyword), stock unit vs measurement unit (ta யூனிட் vs அலகு), lab test vs laboratory (ta பரிசோதனை vs ஆய்வகம்; hi लैब जांच vs प्रयोगशाला), order (ऑर्डर / ஆர்டர் / ఆర్డర్ / ഓർഡർ), serology tokens as report-form transliterations, Confirm button (पुष्टि करें · உறுதிப்படுத்து · నిర్ధారించండి · സ്ഥിരീകരിക്കുക — note the app-wide `action.confirm` te is the familiar నిర్ధారించు; flagged for Batch 2).
- **Urgent**: not in this batch; left `pending` with the corpus candidates and the rule that Urgent, Emergency and Critical stay three distinct classes (human review §4).

### Decisions taken against an agent reviewer (or resolving one)

1. **Exposure badge (all four locales)** — every reviewer confirmed an "infection risk" rendering; the human review names that as the defect. Rendered as the exposure term instead; the block text carries the flag-recorded / reuse-blocked meaning.
2. **Malayalam "unverified" (`external_unverified_hint`, `state.external_recorded`)** — the reviewer avoided സ്ഥിരീകരിക്കുക because it is "the Confirm button on the same screen". Code fact: `cath_external_result_sheet.dart` has `actionSave` / `actionCancel`, no Confirm; the only Confirm on the panel surface is inside the modal check-status dialog, which is about a check row. The human review's സ്ഥിരീകരിച്ചിട്ടില്ല is applied in both keys (hint harmonised ബാഹ്യ → പുറത്തെ to match the field labels two rows below it).
3. **Tamil discard** — the reviewer kept அகற்று and rejected அப்புறப்படுத்து as waste-handling register; the human review calls அகற்று ("remove") too vague. அப்புறப்படுத்து applied across the four discard keys: it is the specific Tamil for disposing of an item, and a device that will not be reprocessed is exactly that.
4. **Blind-check corrections** — te `restriction_unknown` (reviewer's అంగీకారం back-translated as "consent"), hi `header.missing` (reviewer's अधूरी लैब जांचें readable as an imperative), ml `observed_line` (reviewer's പ്രകാരം back-translated as "as per"). Each replaced with a rendering whose meaning matches the English.
5. **`readiness.check.labs` te/ml escalations** — resolved as `confirm` of the qualified form: `cath_readiness_checklist.dart` renders the label as a `ListTile` title in a column of eight rows, so its width is set by the longest sibling ("Implants and device rep"); it is not a chip. Tamil restored to the qualified `ஆய்வகப் பரிசோதனைகள்` for the same reason (the reviewer had dropped the qualifier).
6. **hi/te anticoagulation** — reviewers confirmed थक्कारोधी / రక్తం గడ్డకట్టే నిరోధకం; the human review reads them as adjective / inhibitor. Replaced with the corpus-consistent therapy/check nouns (एंटीकोआग्यूलेशन as in `s4.calculators.hasBled.subtitle`; ప్రతిస్కందక చికిత్స on the same corpus root).
7. **hi discard** — reviewer confirmed नष्ट as the ward term; the human review rules it out (destruction). डिस्कार्ड applied: it names the recorded status and does not assert physical disposal.

### Length check (buttons and chips, rendered grapheme clusters via `Intl.Segmenter`, budget 1.6 × en)

All button and chip renderings in the batch are within budget (e.g. Discard 7 → hi 6 / ta 9 / te 5 / ml 5 of 11.2; Waive 5 → 4 / 4 / 6 / 5 of 8; Exposure 8 → 5 / 6 / 5 / 4 of 12.8; Critical value 14 → 9 / 16 / 12 / 13 of 22.4; External, unverified 20 → 10 / 19 / 16 / 18 of 32; Waived 6 → 7 / 9 / 6 / 4 of 9.6). Two measured exceptions, both accepted on code facts: the Tamil `device_tag` template's fixed part (குறிச்சீட்டு = 7 vs 6.4) on a chip whose width is the 10-character tag itself, inside a `Wrap`; and the `check.labs` row labels (hi 5 / ta 13 / te 7 / ml 10 vs 6.4), which are `ListTile` titles, not chips.

### Confirm, do not fix

`readiness.item.hiv`, `readiness.item.hbsag`, `readiness.item.hcv`, `consumables.device_tag_hint` (`RP00000042`) — English in every locale by design (programme terms / device tag); `confirm` in all four locales. `CSSD` stays Latin inside every rendering.

### Human-review instructions applied with a deviation (all word-level, none of meaning)

- ta / ml `restriction_unknown`: the review's candidates end with a full stop; dropped to match the English and the sibling `restriction_restricted` on the same strip.
- ml `external_unverified_hint`: the review's `ബാഹ്യ ലാബ്` rendered as `പുറത്തെ ലാബ്` so the hint matches `external_lab_name` / `lab_name_required` on the same sheet and the review's own chip (`പുറത്തുനിന്നുള്ള ഫലം`).
- hi `critical_value`: the review's `गंभीर जाँच मान` rendered with the batch spelling `जांच`.
- te `critical_value` in the two `confirm_critical` sentences uses the bare `క్రిటికల్ విలువ(లు)` because the items are named in the same sentence; the qualified form is used on the chip, as the review says ("context-specific candidates, not global replacements").

### Source-string issues reported (deduplicated from the four reviewers and the human review)

1. `readiness.date_required` "Choose the report date" is a validator message in the code, and the picker prompt `external.select_date` already says "Select the report date" on the same field (hi, ta, te). → proposed source change.
2. `readiness.result_required` "Choose a result" is near-identical to the dropdown hint `external.select_result` on the same control (hi). → proposed source change.
3. `readiness.observed_line` "As of {date}" is read as a deadline/validity window next to the "Result too old" state (hi, ta, ml; human review §3D). → proposed source change.
4. `readiness.confirm_body` "Set {check} to {status}?" forces case-marked placeholders in Telugu; the locale frame avoids it, en unchanged (te).
5. `readiness.check.labs` "Labs" is a 4-character label, so any qualified rendering exceeds 1.6×; it is a row label, so the budget does not bind (ta, te, ml).
6. "Labs" / "check" / "lab item" name related concepts with three English words; Hindi renders check and test with the same word (जांच), so `header.missing` and `waived_done` needed the lab qualifier (hi).
7. `consumables.post_use_device_already_discarded` "discarded … disposition recorded" implied destruction / physical disposal (hi blind check; human review §3B). → required source change.
8. `readiness.confirm_critical*` "passing this check" was read as completing / approving (ta, te; human review §3C). → required source change.
9. `readiness.state.result_final` bare "Result" and `readiness.check.timeout` bare "Timeout" under-specify the state / the ceremony (human review §3D; ml reviewer). → required source changes.
10. `consumables.device_blocked` "carries a blood-borne exposure flag" was rendered as infection in three locales; the source could say "has a blood-borne exposure flag recorded" (human review §3A).
11. `readiness.ordered_on` / `waived_on` / `observed_line` glue a case suffix to `{date}` in ml (`{date}-ന്`); safe today because `cathReadinessDisplayDate` is ASCII `yyyy-MM-dd`, but any future localisation of that display date must keep the token suffixable (ml blind check).
12. Cross-batch: `blood_bank.component.platelets` (ml) and the two `s4.calculators` creatinine keys (ml) are English placeholders that should adopt the glossary terms set here (ml reviewer).

### Reuse-policy note from the human review (not a string decision)

The human review states that its localisation review does not approve the reuse policy itself, that standard precautions apply regardless of infection status, that serology is not a general guarantee of reprocessing safety, and that a stricter institutional discard rule should be identified as that rule. Recorded here for the owner; no key in this batch is changed on that basis.

**Owner approval: pending** — the approval packet is this section plus the escalations list in the PR body (`scratchpad/open21/b1/escalations.md`): (A) the three proposed English source changes, (B) the reconciler decisions taken against an agent reviewer or between two defensible renderings, (C) the human-review items that are not string decisions. A reply naming the batch turns the Coverage rows below from `reviewed … owner approval pending` into `approved <date> (owner)`.

---

## Verification After Review

```bash
melos run i18n-health
cd apps/patient && flutter gen-l10n
```

Generated patient files under `apps/patient/lib/generated/` should be committed
when ARB edits change them.
