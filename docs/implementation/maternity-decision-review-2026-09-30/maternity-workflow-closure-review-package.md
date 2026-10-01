# Maternity workflow closure: implementation and decision package

Updated 2026-09-30 against GitHub main
`a38055b8d2f3e2215ccc17338f6e199d0a063685`, verified with `git ls-remote github`.
The original September 16 inventory used `d60f1ea2c853a9fa525f4a15e60b9fe7b044fc4e`.

Unsigned repository snapshot prepared 2026-10-01 from the reviewed package,
SHA-256 `23DF969DBF9ED47358F65874819BEEF77BB77029589ACB5B5DFF0F21E5C27C0B`.
References to current source or main describe the September 30 evidence baseline
above. Inclusion in a draft checkpoint does not approve D2/D8, implementation or
release. The coordinator retains ownership of the canonical plan and audit status.

This is a bounded engineering inventory and decision worksheet, not an approved
clinical protocol, release authorization, or a claim that maternity is complete.
D2 and D8 remain unresolved in the reviewed decision artifacts and current audit.
No unsigned field below takes effect through silence or through approval to fix
engineering defects. On September 30 the coordinator confirmation authorized this
session to update this package and its existing D8 worksheet only. It did not
approve either clinical decision or authorize implementation.

The existing canonical execution plan, `obgyn-journey-controlled-parallel-plan.md`
(July 13; coordinator-held evidence, not included in this snapshot), remains
coordinator-owned. Its decision register at lines 264–283 defines D2/D8; line 65
reserves plan edits to the coordinator. This package remains its review companion,
not another plan or audit ledger. The [repository audit](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/docs/FULL_REPOSITORY_AUDIT_2026_08.md#L206)
(lines 206, 242 and 685) and [ROADMAP](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/docs/ROADMAP.md#L149)
(lines 149 and 989) retain the maternity approval and OPEN-19 boundaries.

## What is already implemented

- Migrations 800–802 restore eight declared maternity domain constraints and
  widen labour status to represent the already-declared discharged-undelivered
  value. Domain membership does not authorize a lifecycle transition.
- Pregnancy, ANC, labour, partograph, delivery, newborn/Apgar and postnatal
  backend operations exist. Their canonical clinical events remain staff-only.
- Signed D7 supplies automatic infant identity and initial mother guardianship,
  independent infant subjects, and the maternal/infant event split.
- Staff has a labour board and partograph entry/chart loop. Admin has labour
  oversight and a separate newborn immunisation workbench. Patient has factual
  ANC rendering, fetal-kick capture and existing supplement-reminder controls.
- Existing code is not evidence that clinical schedules, new forms, delegated
  documentation or new patient-visible projections have been approved.

## Current-main workflow matrix

All code anchors below are relative to the repository at the SHA above. They are
source-inspection evidence; tests are only claimed in each repair's own receipt.

| Workflow | Current source | Remaining closure |
| --- | --- | --- |
| Pregnancy registration/update | `apps/backend/src/routes/maternity/maternityRoutes.js:271,292`; `maternityService.js:359,477` | No dedicated Staff/Admin callers; existing walk-in LMP capture is not a complete pregnancy workspace. Approve form/ownership and episode correction semantics. |
| ANC capture | `maternityRoutes.js:307,317`; `maternityService.js:668,877–929` | No structured Staff/Admin capture caller. Audit projection repair is already merged in #1089. The September inventory's postcommit screening-recovery concern remains outside this D2/D8 refresh; do not infer its closure. |
| Labour admission | `maternityRoutes.js:325`; Staff `maternity_screen.dart:82`; Admin `maternity/page.tsx:212` | Boards read existing admissions but do not create them. Both request 50 entries; wider-list access and truthful truncation remain product work. Approve actor/performer rules, retrospective documentation and undelivered-discharge/transfer semantics before adding transitions. |
| Partograph | Staff `partograph_entry_screen.dart:94`; backend `maternityService.js:2461` | Existing entry loop is real. Parent-board refresh and Admin read-state repairs are already merged. The September inventory's downstream clinical-alert recovery concern is not re-certified or closed here. |
| Delivery | `maternityRoutes.js:366,375`; `maternityService.js:2787` | Capture caller missing; requires D2/D8. Lost-response retry encounters state conflict rather than a durable prior-success receipt. |
| Newborn and Apgar | `maternityRoutes.js:384,394,401,405`; `maternityService.js:3113,3381` | Capture callers missing; D2/D8 required. Exact integer repairs are merged. Preserve D7 identity/guardian semantics; separately owned outcome-token/sex-width questions remain unresolved. |
| Postnatal mother/baby/both | `maternityRoutes.js:417,427`; `maternityService.js:3591` | Capture caller missing; D2/D8 required. Stored red flags are not a closed acknowledgment/action/escalation workflow. Policy must name owner, action and deadline. |
| Immunisations | Admin `dashboard/immunisations/page.tsx:130,201,211,389,574` | Existing Admin callers are not absent. Contextual newborn navigation is missing; vaccine-policy implementation remains held on signed D6 and Staff forms on D8. |
| Outcome correction | `maternityService.js:477,2940–2946,3319–3325`; D7 record engineering defaults | No dedicated pregnancy-lifecycle/newborn-outcome correction endpoint found; ordinary non-status pregnancy amendments already exist. The D7 record specifies compensation and no deletion of minted identity; exact authorized transitions and correction ceremony still need a design. Preserve its countersign flags. |
| Patient visibility and language | Patient `maternity_repository.dart:25,50,84,123,144` | Preserve existing factual projection. No new inpatient narratives or broad event release. Clinical-advice language fallback is not five-language approval. |
| Request replay | Maternity router and app mount; `services/idempotency/idempotencyService.js:14,98,107,125`; `middleware/idempotencyMiddleware.js:230` | Insert-only operations have no demonstrated durable request replay. Shared HTTP receipts expire after 24 hours and finalize after sending the response; they are not atomic maternity command receipts. |

## Engineering repairs already on main

Do not repeat these repairs. Main ancestry and source were inspected on September
30; historical test receipts were not rerun or recertified.

1. #1088 (`d60f1ea2c`): migrations 801–802 followed migration 800. These restore
   eight declared checks in total and widen labour status; they do not finish
   newborn schema reconciliation or authorize lifecycle transitions.
2. #1089 (`09cca3d4f`): truthful ANC audit projection and exact newborn birth-order
   and APGAR integer validation. Current service anchors: 877–929, 3125–3127,
   3385–3395; regression source: `maternityDomainValidation.test.js:105,126`.
3. #1090 (`a014daaad`): Admin maternity reads distinguish errors from empty
   results, hide stale clinical rows on error and offer retry. Regression source:
   `apps/admin/src/__tests__/dashboard/maternity/read-states.test.tsx:144,167,184`.
4. #1091 (`d3bf7b313`): Staff board refresh after chart return with mounted-state
   protection, `maternity_screen.dart:251–254`; existing widget regressions cover
   save/cancel, failed refresh and disposal.
5. #1092 (`52620f76d`): bounded audit/ROADMAP reconciliation. OPEN-19 remains open.

The September 30 lane is document review only. Migration 803 and all active
repair lanes retain their existing owners. No deployment state was inspected.

## D2: who may record an action performed by somebody else?

Existing backend actor attribution is authenticated, but the named responsible
performer and the submitting actor are not governed by a signed D2 selection.
The delivery route pins `actor_uid`/`actor_role` after the body spread while
retaining `delivered_by` (`maternityRoutes.js:366–372`). Newborn, APGAR and
postnatal routes also pin `recorded_by` (384–424), but their service signatures
have no separate assessment-performer input. `delivered_by_name` is display text,
not verified identity. The default-off credential gate checks the named delivery
performer (`maternityService.js:121–136,2822`); route access is not delegation.
The mount uses configured `ip_flow` capability roles plus Patient
(`config/routeRolePolicy.js:603–606`); the target write routes additionally apply
`requireStaffOrAdmin` and their patient-context guard. That existing intersection
is not an approved list of D2 clinical performers or signers.

**Proposal:** use self-entry as the initial form scope, provided clinical and
nursing owners confirm it fits actual ward practice. This is a smaller authority
model to implement and audit; it is not a decision already taken. If the ward
requires on-behalf-of recording, approve the delegated model before implementing
that form, rather than mislabelling the recorder as the performer.

| Choice | Required implementation and evidence |
| --- | --- |
| Self-entry only | Authenticated submitter is the named performer; relevant current credentials are checked. Tests reject another performer even when the submitter is otherwise privileged. |
| Audited delegated documentation | Named performer is credentialed and submitter has explicit on-behalf-of authority. Record performer, submitter, delegation basis and request context immutably. Owner must define who grants delegation, its scope/expiry, and whether performer confirmation is required. |

Self-entry reduces delegation machinery but may delay documentation when the
performer is unavailable. Delegation supports team recording but adds grants,
revocation, attestation and correction evidence. Neither choice changes who is
clinically entitled to perform an act.

- **OPEN-QUESTION D2-01 — model:** self-entry, delegated, or a form-specific
  combination? Define the performer of each act, including separate APGAR and
  maternal/infant assessments. Decision/reference: **UNSET**.
- **OPEN-QUESTION D2-02 — permission:** name eligible recorder, performer and
  signer roles/departments, credential source, tenant/site scope, and any
  delegation grantor, basis, duration and revocation rule. Decide credential
  checks at occurrence and submission when they differ. Decision: **UNSET**.
- **OPEN-QUESTION D2-03 — attestation:** is performer confirmation required for
  delegated work; who may confirm, correct or dispute it; and what happens while
  confirmation is outstanding? Retrospective/emergency exceptions and their
  accountable approver must be explicit, if any. Decision: **UNSET**.
- **OPEN-QUESTION D2-04 — attribution evidence:** approve visible recorder versus
  performer labels and the versioned evidence of identity, role, delegation,
  event time, recording time and amendment author. Delivery already stores a
  performer UUID; the other three forms need a representation decision if their
  performer differs from the recorder. Decision: **UNSET**.

Proposed accountable approver: clinical/product owner. Required review roles:
obstetrics lead, nursing/midwifery lead, paediatrics/neonatology lead and
medical-records/medico-legal owner. Credentialing owner confirms the permission
source; engineering validates enforceability. Person names, authority reference,
decision version, effective tenant/site/date and signatures: **UNSET**. The D7
record's clinician-owner convention does not itself sign D2.

Never implement the rejected shortcut “actor is credentialed OR actor equals
performer.” Existing default-off credential-gate activation remains an operator
decision, not part of this worksheet.

## D8: approve forms, not merely endpoints

The companion [field-level worksheet](maternity-d8-field-review-worksheet.md)
lists the inspected inputs, existing defaults and amendment behavior, with blank
owner decisions and signatures. It is unsigned and grants no implementation
authority. Its September 30 refresh distinguishes current-main evidence from
the earlier local-candidate inventory and preserves all unsigned field cells.

These are fields accepted by existing backend service signatures, not a clinical
recommendation that every field should be exposed, required, defaulted or editable.
For each form the owner must approve visible fields, requiredness, units,
validation, responsible role, signature/finalization and correction behavior.

The worksheet retains all 135 field rows, including pregnancy/ANC, labour,
partograph, supplements and the separate immunisation review/dose workflows.
Their existing open decisions remain in scope of the programme; this update
focuses on delivery, newborn/APGAR and postnatal forms. Required field matrices,
named approvers, language reviewers and effective scope remain **UNSET**.

### Focused implemented versus missing matrix

These four write operations remain without production capture callers in Staff,
Admin and Patient source at the verified main. The Admin newborn-immunisation
workbench is a different, existing workflow. Each target OpenAPI POST currently
has a generic `Success` response and no `requestBody`; endpoint existence does
not supply a typed form contract.

| Capture | Existing authority and backend representation | Missing work after owner approval |
| --- | --- | --- |
| Delivery | Backend requires pregnancy, delivery timestamp and mode; supports optional labour link, performer UUID/name and observations. It atomically records delivery, closes the ongoing pregnancy/active labour and updates the mother's projection and staff-only evidence (service 2787–2975). These checks are implemented behavior, not approved form requiredness. | D2, D8 delivery field/signing matrix; reachable context selection and readback; typed request/result/error contract; command replay; approved correction/cancellation design. No draft/sign/correct/cancel lifecycle is exposed by these routes. |
| Newborn | D7 selected automatic identity for live birth/early neonatal death, initial mother guardian, separate infant subjects and no identity for stillbirth. Service 3113–3365 supplies those writes, existing consent evidence and unique delivery/birth-order handling. | D8 newborn form; truthful outcome/unknown handling; no arbitrary identity selector. Resolve the separately owned outcome-token and sex-width conflicts before promising full vocabulary support. Existing consent writes are not evidence that a clinician captured consent in a new form; the owner must specify how the form truthfully uses the existing D7 process. |
| APGAR | Service 3381–3531 accepts the existing minute/component integer domains, writes on the infant subject, returns identical effective repeats unchanged and records revisions for changed scores. | D2 assessment-performer semantics; D8 partial-assessment and amendment policy; observed versus recorded time; typed contract and UI. Missing components overwrite to null, and null contributes zero to `total_score`; there is no explicit draft/completed flag or expected-version input. |
| Postnatal | Service 3591–3752 supports `mother`, `baby`, `both`. D7 requires a matching newborn for infant scope; one combined detail row emits two subject-separated event/audit pairs. Notes/red flags stay detail-only. | Approved maternal/infant field sets, explicit scope/time, recorder/performer policy, readback and correction/retry contract. Stored red flags have no closed response workflow in this method; response owner, policy and recovery remain decisions. |

### Remaining D8 decisions

All recommendations below are proposals. The worksheet carries the same IDs and
the field groups affected; no proposal sets a clinical range or mandatory field.

| Decision | Recommendation, alternative and consequence | Required owner decision |
| --- | --- | --- |
| **OPEN-QUESTION D8-01 — fields** | Sign visible/required/optional/conditional fields and unknown/not-assessed/not-applicable representation individually. Avoid converting an unanswered observation to false/zero or an unselected outcome to live. Retaining current defaults is simpler but can misstate what was assessed. Representation changes require a separately authorized contract/schema design. | Obstetrics, nursing and neonatology: exact D01–D14, N01–N14, AP01–AP09 and PN01–PN11 choices, units, vocabulary and primary clinical authority/version: **UNSET**. |
| **OPEN-QUESTION D8-02 — time** | Show event/assessment time separately from server recording time, with an explicit zone and late-entry provenance. Delivery and birth have supplied timestamps; postnatal defaults to now. APGAR carries an assessment-minute category but uses `recorded_at` for its canonical occurrence time. Keeping that API is cheaper but cannot present it as a separately captured assessment timestamp. | Clinical/product and medical records: event-time definition per form, unknown/estimated time, retrospective/future-time policy, source and correction rules: **UNSET**. No back-entry window is proposed. |
| **OPEN-QUESTION D8-03 — lifecycle** | Treat pre-submit cancellation as discarding an uncommitted form; treat correction or cancellation after commit as an attributable amendment/compensation preserving original evidence. Decide drafts and completion explicitly. Existing routes commit immediately; APGAR UPSERT is not a draft workflow. Immediate final entry is smaller than durable drafts but less tolerant of interrupted/incomplete capture. | Clinical/product and medico-legal: draft ownership, persistence/expiry, completion criteria, signing, amendment reason/reviewer, permitted transitions and post-commit cancellation meaning: **UNSET**. |
| **OPEN-QUESTION D8-04 — retries and concurrency** | Separate command identity from clinical-content similarity. Prefer atomic result receipts and current-authority checks on replay; require stale-revision detection for amendments. Current delivery/newborn duplicates conflict, postnatal inserts again, and APGAR serializes writes without rejecting a stale editor. A UI-only double-submit guard leaves lost responses and cross-device races unresolved. | Product/medical records choose duplicate-versus-new-assessment intent and conflict-resolution owner; backend owner designs receipts/versioning, retention and reconciliation. Scope/authority: **UNSET**. No migration number is allocated. |
| **OPEN-QUESTION D8-05 — linkage** | Select mother, pregnancy, delivery and exact infant from authorized context with readable confirmation; preserve D7 multiples and independent infant identity. Reject invalid infant links rather than recording against the mother. An arbitrary numeric-ID field cannot demonstrate identity selection. | Product, obstetrics and neonatology: entry/navigation locations, wrong-episode recovery and outside-birth routing under D7's existing limitation: **UNSET**. D7 itself is not reopened. |
| **OPEN-QUESTION D8-06 — evidence** | Preserve transactional detail plus staff-only timeline/audit evidence; expose recorder, performer, event time, record time and amendment provenance to authorized reviewers. APGAR evidence currently summarizes the total, not a full historical component snapshot; assess whether the approved amendment review needs more evidence. A success toast alone supplies no review trail. | Medical records/privacy and clinical/product: reviewer view, evidence detail, attestation and retention authority: **UNSET**. New patient release remains D3. |
| **OPEN-QUESTION D8-07 — error and recovery** | Distinguish validation, denied access, missing/mismatched context, duplicate/stale state, unknown save outcome and failed readback. Preserve recoverable entry without resubmitting blindly; clear stale patient context. Red flags need an assigned human response under a signed policy, rather than implying that saving text created an alert. | Clinical/nursing owners: red-flag vocabulary, response/action policy, deadlines and escalation; product/backend: uncertain-save reconciliation and recovery owner: **UNSET**. Notification governance remains D4. |
| **OPEN-QUESTION D8-08 — offline** | Propose online-only submission for the first approved scope, with explicit unavailable/uncertain states. Offline suitability is not established by a generic queue: birth identity, delegation revocation and duplicate resolution need reviewed replay semantics. Offline draft/synchronization support is an alternative requiring a separately approved continuity design and data-handling policy. | Clinical/product, privacy and continuity owner: whether local drafts are permitted, storage/expiry/device rules, reconciliation and downtime procedure reference: **UNSET**. No queue or continuity activation is authorized. |
| **OPEN-QUESTION D8-09 — wording** | Review exact labels, units, score-versus-measurement wording, loss/outcome terminology, attribution, signing and error text in en/hi/ta/te/ml. Keep technical locale parity separate from clinical/linguistic approval. Generated or copied wording alone is insufficient evidence. | Clinical leads and named human reviewers for each locale: approved text version, source, exceptions and signatures: **UNSET**. No localization resources are changed here. |

### Conflicts and limits to carry into review

- Migration 155:253 names `fresh_still_birth`/`macerated_still_birth`; current
  `newbornIdentity.js:30–35` accepts `fresh_stillbirth`/`macerated_stillbirth`.
  Preserve the existing September 25 `newborn-outcome-token-ruling-packet.md`
  (line 7; coordinator-held evidence, not included in this snapshot).
  D7's identity choice does not settle the persisted spelling, aliases or repair
  policy. No choice is made here.
- Migration 155:245 includes `indeterminate` although the newborn sex column is
  `VARCHAR(10)` in baseline 11884 and Prisma 15325. Current main still lacks the
  September 25 local service lane's sex validation. That unmerged worktree is
  evidence of a separate lane, not delivered behavior or available ownership.
- Route patient-access selectors resolve the maternal episode
  (`maternityRoutes.js:99–114`); infant identity is additionally checked inside
  the service. Independent infant timeline subjects do not prove a separately
  evaluated infant access decision. D2/D8 owners must explicitly accept or
  request review of that access model; do not silently widen it.
- D7's record distinguishes signed selections from engineering defaults flagged
  for countersign, including correction/consent details. Preserve that distinction
  and its open flags. This review adds no consent requirement or legal conclusion.
- OPEN-19's phrase that labour admissions are “wired” includes board reads;
  its same row lists the admission POST as callerless. Current source confirms
  read/partograph callers, not an admission capture form.

## Other decisions required for full closure

- D3: exact patient-visible event/content allowlist, proxy visibility and
  episode/loss suppression. D7 does not authorize broad patient release.
- D4: consent, channels, quiet hours, frequency limits, recipients, dispatch-time
  authority revalidation, cancellation and failure/reconciliation ownership.
- D5: approved ANC/maternal/newborn follow-up schedules, variants and effective
  versions. Engineering must not invent due dates or clinical escalation clocks.
- D6: the July 17 draft contains owner selections but explicitly remains unsigned.
  Required items include signed dose-equivalence mapping, exact edition
  attestation, IAP-derived-content legal clearance, clinical review of existing
  seed anomalies, target readback and signatures/effective scope. Do not apply a
  schedule importer or infer approval from the current Admin labels.
- D1 applies if scope includes missed-cycle screening or provisional pregnancy;
  no threshold or diagnosis logic is added by the current repair work.

## Acceptance and implementation after approval

Approved screens need authorized navigation and deep-link coverage, successful
and denied journeys, atomic detail/projection/timeline/audit writes and rollback
evidence. Any approved follow-up obligation needs an owner, due policy,
acknowledgment/action evidence, escalation, delivery receipt and recovery path.
Clinical/linguistic sign-off and separately authorized publication, merge,
deployment and activation remain required programme boundaries.

### Acceptance scenarios for the proposed capture scope

These are future acceptance scenarios after approval, not tests run in this lane.

1. **Identity and permissions:** an authorized recorder opens the correct episode;
   spoofed actor fields never replace authentication. The selected D2 model
   determines the positive and denial cases for another performer, expired
   delegation, changed privileges and absent attestation.
2. **Timing and incomplete facts:** late entry retains both event and recording
   times. Unknown observations stay distinguishable from negative/zero values;
   incomplete APGAR cannot be presented as a completed assessment without the
   approved completion rule. Test null components and changing a prior score.
3. **Lifecycle:** cancelled unsubmitted input creates nothing. Completion and
   each approved amendment have attributable evidence; post-commit cancellation
   never deletes a minted identity or silently reverses delivery state.
4. **Retry and stale edits:** lose a response after commit, retry concurrently
   from two devices, and restart before readback. Recover one authorized result;
   distinguish a changed payload or a genuinely new visit. Reject or reconcile
   stale APGAR edits according to the chosen policy, including A/B/A revisions.
5. **Mother and infant:** cover live birth, early neonatal death, stillbirth,
   twins, an existing valid infant identity, a mother UID supplied as infant,
   another delivery and another tenant. A combined postnatal visit produces one
   detail row and exactly two subject-separated canonical pairs, or rolls back
   entirely. Maternal-only care remains possible without an infant identity.
6. **Failure recovery:** validation preserves safe input; denial clears protected
   cached context; missing/mismatched links prevent save. A failed readback or
   timeout displays uncertainty instead of success or an automatic new visit.
   Test rapid patient switching, navigation disposal and red-flag follow-up failure.
7. **Offline and language:** offline actions match the signed scope and never
   appear committed while queued. Human reviewers approve the exact clinical
   and linguistic text version for all five locales; parity tests prove only
   technical completeness.

### Implementation split after approval

| Bounded work | Proposed owner and prerequisite | Reviewable result |
| --- | --- | --- |
| Sign the decision record in these existing artifacts | Clinical/product owner with obstetrics, nursing, neonatology and medico-legal reviewers; coordinator owns sequencing | D2 selection; exact approved D8 rows, authority references, named people and effective scope. No implied signatures. |
| Define contracts and evidence | Backend/API owner plus medical records, after D2 and affected D8 choices | Typed OpenAPI overlays and mirrored contracts, performer/time/lifecycle/replay design, errors and evidence requirements. Any schema need returns to coordinator allocation; 803 stays excluded. |
| Implement delivery capture | Staff owner after delivery decisions and backend prerequisites | Authorized navigation, approved fields, submit/readback and correction/recovery journey with focused tests. |
| Implement newborn and APGAR capture | Staff owner and backend owner after neonatal approvals and separately owned domain conflict resolution | Per-infant context, D7-preserving identity behavior, complete/partial assessment and amendment journeys. |
| Implement postnatal capture | Staff owner after maternal/infant matrix and red-flag response decision | Mother/baby/both flow, exact infant link, two-pair evidence and approved response/recovery behavior. |
| Verify approved scope and wording | QA, independent reviewer and named locale/clinical reviewers | Synthetic journey, permission, rollback, replay/concurrency and wording evidence; coordinator separately seeks any publication/release authority. |

These are proposed responsibilities, not assignments to occupied worktrees or
authorization to begin code. Any independently releasable subset needs explicit
owner agreement on the omitted capabilities and the remaining workflow limits.

### Source verification on September 30

On September 30 the checkout was clean at
`fbd85e913100d2f73ad72443fa5c21311c91ed4b`, which differed from the verified main.
Claims above used `git show`/`git grep` at the recorded main SHA. Portable source
links are pinned to that same evidence baseline:
[maternityService.js](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/services/maternity/maternityService.js#L2787)
and [maternityRoutes.js](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/routes/maternity/maternityRoutes.js#L366).
The September 30 working notes, source snapshots, Git blob/hash manifest and
`openapi-operations.json` are coordinator-held evidence and are not included in
this snapshot. The four inspected operations come from the pinned
[OpenAPI document](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/apps/backend/src/docs/openapi.json).

Existing test source inspected includes actor spoof protection and distinct
delivery performer (`maternityRoutesActorContext.test.js:141`), delivery races
(`maternity-atomicity.deep.test.js:1194`), birth identity/consent atomicity
(`maternity-birth-identity.deep.test.js:225,320,522`), APGAR revision/no-op behavior
and combined subject separation (`maternity-newborn-postnatal-atomicity.deep.test.js:347,725`).
These demonstrate existing assertions, not current passing execution. During the
September 30 review, no clinical writes, tests, full CI, migrations, shared
database/container operations, real PHI, publication, merging, deployment or
activation were used. Only the two confirmed review artifacts and session-owned
working evidence were written. Preparing this repository snapshot does not rerun
or recertify that review or its historical test receipts.

### Durable request replay: separate engineering prerequisite

Merely adding shared HTTP idempotency middleware would not close this gap.
It may replay a cached response without rerunning in-service infant/performer
checks; default server-error handling releases the claim even when an ANC visit
has already committed; expiry allows insert-only actions to run again. The
existing lab command ledger demonstrates an atomic pattern but is not a generic
maternity ledger or authorization to reuse lab-specific response semantics.

A reviewed maternity command design must persist request identity, payload
fingerprint, exact clinical result and canonical evidence inside the clinical
transaction. It must recover the prior result after a lost response or process
restart, without reminting an infant identity or duplicating consent/guardian
links. Replays must still prove current tenant, actor, patient and relevant
infant/performer authority. A different legitimate assessment must remain a new
command, rather than being collapsed by clinical-content similarity.

Candidate insert-once scope: pregnancy registration, labour admission,
partograph, delivery, newborn, postnatal visits and immunisation review.
ANC/Apgar/supplement amendments require their own reviewed replay contract, not
an immutable cache that accidentally suppresses later revisions.

Acceptance must include concurrent replay, changed-payload rejection, crash
after commit, generic-cache expiry, precommit rollback, postcommit alert failure,
revoked access, cross-tenant/actor collision, and exactly two subject-separated
canonical pairs for a both-scope postnatal visit. Any new command relation needs
coordinator allocation and both tenant policies; no migration number is claimed
by this document. This prerequisite remains open and is not included in the
three narrow application repairs from the September 16 review; their merged
status is recorded above.

## Authority sources

- July 13 `obgyn-journey-controlled-parallel-plan.md`: coordinator-held evidence;
  not included in this snapshot.
- July 14 artifact `obgyn-d7-decision-record.md`: coordinator-held evidence;
  not included in this snapshot.
- July 17 `obgyn-d6-decisions-draft.md`: coordinator-held evidence;
  not included in this snapshot.
- [Canonical clinical timeline](https://github.com/Bahuleyandr/VH-Health-Platform/blob/a38055b8d2f3e2215ccc17338f6e199d0a063685/docs/CANONICAL_CLINICAL_TIMELINE.md)
  at the recorded main SHA.

Missing signatures are explicit remaining work, not a reason to label the
maternity programme complete or to discard the implemented engineering repairs.
