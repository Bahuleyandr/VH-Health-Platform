# Clinical service continuity activation sequence

**Status:** sequencing and evidence map only. This document does not approve,
waive, deploy, activate, or widen any capability; the
[activation-readiness tracker](activation-readiness-tracker.md) remains the
authoritative gate list, and each linked runbook remains the execution
authority for its own procedure. [Tracker purpose and state
key](activation-readiness-tracker.md#clinical-service-continuity-activation-readiness-tracker)

**Scope:** the ordered path below starts when primary hardware is available and
ends when the first approved action and unit may enter enforcement. The three
general go-live documents supply the base-platform preflight only; their older
readiness summaries do not close any continuity tracker row.
[Go-live critical path](../GO_LIVE_CRITICAL_PATH.md#the-sequence),
[activation checklist](../GO_LIVE_ACTIVATION_CHECKLIST.md), and
[operator runbook rules](../GO_LIVE_RUNBOOK.md#rules-of-engagement)

**Use rule:** at every phase, check the cited tracker rows in place, execute the
linked runbook rather than copying commands from this sequence, retain its
named evidence, and obtain its named approvals. A merge, render, fixture, or CI
pass is never live activation evidence. [Tracker update
discipline](activation-readiness-tracker.md#update-discipline) and
[go-live evidence rules](../GO_LIVE_RUNBOOK.md#rules-of-engagement)

## Documentary stop lines before operational use

- **OPEN-QUESTION — C-D11 tracker reconciliation.** The
  [C4 tracker row](activation-readiness-tracker.md#c4-capture-activation) and
  [cross-cutting tracker row](activation-readiness-tracker.md#cross-cutting-gates)
  still describe C-D11 as open, while the
  [countersigned dossier status and record](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)
  say that C-D11 is countersigned and no owner decisions remain open. A newer
  merged tracker record must reconcile that conflict before this sequence is
  used as an operator checklist. [Tracker update
  discipline](activation-readiness-tracker.md#update-discipline)
- **OPEN-QUESTION — C-D13 runbook reconciliation.** The
  [C2.2 runbook header](c2-2-split-horizon-dns-runbook.md#c22-split-horizon-dns-operator-runbook)
  still labels C-D13 unsigned, while the
  [countersigned C-D13 record](c0-4-owner-decision-dossier.md#c-d13--lan-hostname-certificate-pin-and-trust-boundary)
  records the approved trust decision. Reconcile that stale header before the
  DNS procedure is authorized. [C2.2 preconditions](c2-2-split-horizon-dns-runbook.md#1-preconditions)

## C-D11 fixed operating boundary

The cohort and evidence bar below are quoted exactly from the countersigned
record; this sequence does not reinterpret either statement.
[C-D11 approved policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)

> The first activation cohort is one facility in its entirety — all units — entering shadow together. Shadow scope does not determine enforcement scope: because the action registry activates per facility with an exact enforced action-ID set, enforcement is staged by action and by unit independently of the facility-wide shadow, and no capability enforces before its own evidence passes.
>
> A cohort may leave shadow only when both of the following hold: at least fourteen days of shadow operation, and at least one planned downtime drill completed cleanly — continuity packs verified, the paper path exercised, and all captured work reconciled afterwards with nothing left unresolved. Elapsed time alone is never sufficient evidence.

— [C-D11 approved policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)

The rollback and approval rules below are also quoted exactly so that no
authority is weakened by summary.
[C-D11 approved policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)

> An activation is rolled back to paper or read-only immediately on any of: a patient-safety incident attributed to the capability; any silent failure — work lost, or a failure that raised no alert; or unreconciled work outliving its agreed window. In addition, the clinical lead of an affected unit may veto or halt an activation unilaterally, without justification.
>
> Moving a cohort from shadow to enforcement requires two keys: the accountable clinical owner and one operational or technical lead must both agree. Rolling back requires only one voice — any person holding a listed sign-off role, including the affected unit's clinical lead, may stop an activation alone. Advancing is deliberately harder than halting.

— [C-D11 approved policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)

## Phase A — qualify hardware and establish the held base platform

- **Preconditions.** Hardware is not accepted from a procurement target alone:
  satisfy the tracker row
  [“Open — primary hardware procurement and as-built placement”](activation-readiness-tracker.md#cross-cutting-gates),
  then complete the cluster, secrets, release-pin, dependency-ordered deploy,
  runtime-isolation, and reliability preconditions in the
  [activation checklist](../GO_LIVE_ACTIVATION_CHECKLIST.md#phase-a--pre-flight-cluster-substrate-exists).
- **Runbooks.** Execute the base-platform path in the
  [go-live critical path](../GO_LIVE_CRITICAL_PATH.md#the-sequence), the
  [activation checklist](../GO_LIVE_ACTIVATION_CHECKLIST.md), and
  [Go-Live Runbook Phases 0 and 1](../GO_LIVE_RUNBOOK.md#phase-0---inventory-and-freeze).
  Keep every continuity surface held. [Go-live Phase 0 held-surface
  check](../GO_LIVE_RUNBOOK.md#phase-0---inventory-and-freeze)
- **Evidence produced.** Retain the as-built hardware and placement receipt,
  exact release authority, cluster/GitOps state, signed image pins, runtime
  database-role proof, ingress health, and monitoring substrate evidence named
  by the base-platform documents. [Primary hardware tracker
  row](activation-readiness-tracker.md#cross-cutting-gates) and
  [Go-Live Phase 1 evidence gate](../GO_LIVE_RUNBOOK.md#phase-1---cluster-gitops-release-pins-and-policy-baseline)
- **Sign-off.** Hospital executive, finance/procurement, facilities, and
  infrastructure owners accept the hardware evidence; the release captain and
  platform-operations owner accept the frozen revision and platform baseline.
  [Primary hardware owning authority](activation-readiness-tracker.md#cross-cutting-gates)
  and [Go-Live Phase 0 owner](../GO_LIVE_RUNBOOK.md#phase-0---inventory-and-freeze)
- **Failure.** Stop before application or continuity activation, leave held
  components and flags at their defaults, and use the applicable base-platform
  rollback. [Go-Live Phase 0 rollback](../GO_LIVE_RUNBOOK.md#phase-0---inventory-and-freeze)
  and [Go-Live Phase 1 rollback](../GO_LIVE_RUNBOOK.md#phase-1---cluster-gitops-release-pins-and-policy-baseline)

## Phase B — collect the first signed C0.1 live-state evidence pack

- **Preconditions.** Phase A supplies an approved checkout, live read access,
  and a stable base platform; the tracker row
  [“Open — first real C0.1 evidence run”](activation-readiness-tracker.md#cross-cutting-gates)
  must be satisfied by an authorized live pass rather than a fixture replay.
- **Runbook.** Execute the
  [C0.1 runbook in order](c0-1-live-state-runbook.md#4-run-in-order) once from
  the approved SHA, complete the manual physical and public-edge section, then
  inspect, sign, and hand back both protected outputs through the approved
  evidence channel. [C0.1 safety boundary](c0-1-live-state-runbook.md#1-safety-boundary)
- **Evidence produced.** The output is the checksum-bound, signed full pack and
  separately reviewed redacted summary described by the runbook; a partial
  pack remains partial and does not convert unknowns into proof.
  [C0.1 inspect and sign](c0-1-live-state-runbook.md#step-4--inspect-and-sign)
  and [partial-run boundary](c0-1-live-state-runbook.md#5-what-a-partial-run-proves)
- **Sign-off.** The authorized infrastructure operator and every manual-
  evidence owner named in the pack sign the receipt; the tracker assigns this
  gate to those operators and owners. [C0.1 tracker
  row](activation-readiness-tracker.md#cross-cutting-gates)
- **Failure.** Preserve the first safe partial pack, keep failed or unavailable
  facts `unknown`, and stop each later phase whose required fact remains
  unproved. Do not broaden privilege or rerun ad hoc commands.
  [C0.1 partial-run rule](c0-1-live-state-runbook.md#5-what-a-partial-run-proves)

Phase B precedes the remaining infrastructure drills because the C0.1 runbook
explicitly supplies their live-state inputs; it unblocks C1.2, C1.3, C2.1, and
C6.2 without authorizing any of them. [C0.1 downstream
uses](c0-1-live-state-runbook.md#6-what-this-evidence-unblocks)

## Phase C — activate monitoring delivery and pass the C1.3 live drill

- **Preconditions.** Phase B must supply the live monitoring reality check,
  and the tracker row
  [“Open — monitoring delivery and live gate”](activation-readiness-tracker.md#c3-pack-edge-and-staff-cache-activation)
  must have its receiver credentials, real edge EndpointSlice, and named
  owners ready. The runbook's owner inputs and every hold point must be
  complete. [C1.3 owner inputs and hold
  points](../runbooks/C1_3_MONITORING_LIVE_DRILL.md#owner-inputs-and-hold-points)
- **Runbook.** Execute the
  [C1.3 monitoring live drill](../runbooks/C1_3_MONITORING_LIVE_DRILL.md),
  including live scrape, rule evaluation, delivery, acknowledgement,
  resolution, owning-rule smoke, and off-site Watchdog evidence. The disposable
  pipeline is preparation evidence only. [C1.3 status and
  authority](../runbooks/C1_3_MONITORING_LIVE_DRILL.md#status-and-authority)
- **Evidence produced.** Retain the release and image versions, rendered
  objects, target and rule state, receiver delivery identifiers, named
  acknowledgements, firing and resolution times, off-site heartbeat evidence,
  cleanup result, and hashes required by the runbook. [C1.3 evidence
  record](../runbooks/C1_3_MONITORING_LIVE_DRILL.md#evidence-record)
- **Sign-off.** Monitoring/on-call, infrastructure, continuity, database, and
  backup owners accept the gate, and each named recipient acknowledges its
  drill delivery. [Monitoring tracker
  authority](activation-readiness-tracker.md#c3-pack-edge-and-staff-cache-activation)
  and [C1.3 synthetic drill](../runbooks/C1_3_MONITORING_LIVE_DRILL.md#synthetic-scrape-to-resolution-drill)
- **Failure.** Stop the drill, do not advance to the next alert family, remove
  the temporary drill namespace, manually restore the prior approved pinned
  configuration, prove all targets and Watchdog recovered, and retain the
  failed receipt. [C1.3 rollback and
  cleanup](../runbooks/C1_3_MONITORING_LIVE_DRILL.md#rollback-and-cleanup)

## Phase D — complete immutable-backup and restore-only Phase 1

This phase is mandatory only when immutable off-site backup/DR is included in
the continuity release claim. If it is not claimed, record only the tracker's
explicit `not applicable` degradation and carry the separate C1.2 restore-proof
question below; do not run provider actions or invent a substitute capability.
[C6.2 optional-capability tracker
row](activation-readiness-tracker.md#c62-backupdr-phase-1-and-phase-2)

- **Preconditions.** Phase B supplies the backup and retention baseline, Phase
  C supplies the alert-delivery path reused by C6.2, and every tracker row from
  [“Phase 1 item 1 open” through “Phase 1 item 8 open”](activation-readiness-tracker.md#c62-backupdr-phase-1-and-phase-2)
  must be satisfied. The runbook's production hard stops remain mandatory.
  [C6.2 hard stops](../runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md#hard-stops)
- **Runbook.** Execute the
  [C6.2 R2 lock and restore-only drill](../runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md):
  complete the synthetic lock trial and authority separation before the timed
  disposable PITR; never treat its output as a warm-standby measurement.
  [Required lock-trial proof](../runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md#required-trial-proof)
  and [two objective rows](../runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md#two-objective-rows)
- **Evidence produced.** Retain the provider lock proof, credential-
  qualification receipts, timed restore record, clinical-read proof,
  checksum-bound off-site evidence pack, independent readback, cleanup receipt,
  and the separate restore-only objective row. Phase 1 is not accepted until
  C-D1 ratifies the measured figures. [C6.2 acceptance and
  cleanup](../runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md#acceptance-and-cleanup)
  and [C-D1 record](c0-4-owner-decision-dossier.md#c-d1--service-tiers-rto-and-rpo)
- **Sign-off.** The tracker-assigned legal, privacy, security, infrastructure,
  backup/recovery, database, application, clinical-safety, evidence-custody,
  executive, and operations owners accept their applicable receipts and the
  C-D1 ratification. [C6.2 Phase 1 tracker
  rows](activation-readiness-tracker.md#c62-backupdr-phase-1-and-phase-2)
- **Failure.** Stop Phase 1, retain the failed evidence, leave the scheduled
  proof and retention remover suspended, and do not begin site-specific warm-
  standby work. Locked objects are not promised as rollback-deletable.
  [C6.2 hard stops](../runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md#hard-stops),
  [lock rollback boundary](../runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md#required-trial-proof),
  and [Phase 2 activation holds](../runbooks/C6_2_WARM_STANDBY_PROMOTION_FAILBACK.md#activation-holds)

**OPEN-QUESTION — C1.2 restore-proof identity.** Phase D is placed before the
C1.2 fault drills because their common preflight requires a fresh backup plus
disposable restore proof. The records do not say whether only the accepted
C6.2 Phase 1 receipt may satisfy that row; if owners select a different
already-qualified proof, name and approve it before Phase E rather than
assuming equivalence. [C1.2 common
preflight](../runbooks/C1_2_HA_DRILL.md#5-common-preflight) and
[C6.2 Phase 1 tracker rows](activation-readiness-tracker.md#c62-backupdr-phase-1-and-phase-2)

## Phase E — qualify C1.2 control plane, data plane, and storage placement

- **Preconditions.** Phases A through D must provide the approved physical
  placement, signed live-state pack, live monitoring, and accepted backup/
  restore receipt. Every owner threshold, exact release qualification, rollback
  authority, quorum, capacity, synthetic-data, and storage row in the C1.2
  preflight must be complete before fault injection. [C1.2 governance and
  qualification](../runbooks/C1_2_HA_DRILL.md#2-governance-and-qualification-rule)
  and [common preflight](../runbooks/C1_2_HA_DRILL.md#5-common-preflight).
  The tracker remains the source gate for the
  [primary hardware evidence](activation-readiness-tracker.md#cross-cutting-gates).
- **Runbook.** Execute the
  [C1.2 HA drill](../runbooks/C1_2_HA_DRILL.md) and its linked
  [storage-placement gate](../C1_2_STORAGE_PLACEMENT_GATE.md); perform only the
  named, approved fault scenario and never use the drill as first proof of a
  new infrastructure release. [C1.2 activation
  boundary](../runbooks/C1_2_HA_DRILL.md#1-activation-boundary-and-pre-sync-warning)
- **Evidence produced.** Create one result record per drill with authority,
  approved thresholds, before/during/recovery timeline, synthetic data and
  checksum proof, measured outcome, findings, retained rollback point, and
  evidence location. [C1.2 result
  record](../runbooks/C1_2_HA_DRILL.md#10-result-record)
- **Sign-off.** The incident commander, change owner, database owner, storage
  owner, and application/clinical synthetic-QA owner accept the applicable
  threshold and result records. [C1.2 governance](../runbooks/C1_2_HA_DRILL.md#2-governance-and-qualification-rule)
- **Failure.** Any missing approval or preflight row is an abort or `NOT
  QUALIFIED`; any drill tripwire stops further injection and begins the
  runbook's named recovery. Preserve failed evidence and return to the last
  qualified revision or configuration. [C1.2 common
  preflight](../runbooks/C1_2_HA_DRILL.md#5-common-preflight),
  [result rule](../runbooks/C1_2_HA_DRILL.md#10-result-record), and
  [recovery invariants](../runbooks/C1_2_HA_DRILL.md#11-recovery-rollback-and-evidence-invariants)

## Phase F — prove private ingress, certificate trust, and split-horizon DNS

- **Preconditions.** Phase B's signed public-edge comparison and Phase E's
  qualified platform must be retained. Satisfy the tracker rows
  [“Satisfied as decision input — C-D13,” “Open — network activation
  inventory,” “Open — internal TLS production,” “Open — shipped-pin and
  client-fleet closure,” “Open — split-horizon resolver inputs and rollout,”
  and “Open — live comparison and acceptance drill”](activation-readiness-tracker.md#c21-internal-ingress-activation).
  Held route classes remain held. [C2.1 approvals and abort
  authority](../runbooks/C2_1_INTERNAL_INGRESS_DRILL.md#1-required-approvals-and-abort-authority)
- **Runbooks.** Execute the
  [C2.1 internal-ingress drill](../runbooks/C2_1_INTERNAL_INGRESS_DRILL.md)
  through acceptance first. Only then execute the
  [C2.2 split-horizon DNS runbook](c2-2-split-horizon-dns-runbook.md), because
  its preconditions require independently healthy C2.1 ingress, certificate,
  pins, resolver inputs, and named rollback authority.
  [C2.2 preconditions](c2-2-split-horizon-dns-runbook.md#1-preconditions)
- **Evidence produced.** Retain C2.1's approvals, revision/render, network and
  certificate ledgers, public/private probes, rejection and parity results,
  failover/outage results, redaction check, and rollback receipt, followed by
  C2.2's matching resolver renders, exact-host resolution, authenticated
  readiness, route-kind, cache, and rollback evidence. [C2.1 evidence
  workspace](../runbooks/C2_1_INTERNAL_INGRESS_DRILL.md#2-evidence-workspace)
  and [C2.2 readiness evidence](c2-2-split-horizon-dns-runbook.md#4-readiness-evidence)
- **Sign-off.** The authorized infrastructure operator and the network,
  security, privacy, application, clinical-continuity, and product/release
  owners accept the applicable C2.1, C2.2, and C-D13 evidence.
  [C2.1 tracker authority](activation-readiness-tracker.md#c21-internal-ingress-activation)
  and [C-D13 required roles](c0-4-owner-decision-dossier.md#c-d13--lan-hostname-certificate-pin-and-trust-boundary)
- **Failure.** Abort on a missing hold, public-path regression, unapproved
  route, certificate/pin mismatch, parity or rejection failure, or ambiguous
  VIP state. Close readiness and withdraw private DNS first, prove clients use
  the public route, then roll back C2.1 in the runbook order while preserving
  evidence. [C2.1 rollback](../runbooks/C2_1_INTERNAL_INGRESS_DRILL.md#12-rollback)
  and [C2.2 rollback](c2-2-split-horizon-dns-runbook.md#12-rollback)

## Phase G — provision signed packs, trust, Staff cache, and any claimed edge

- **Preconditions.** Satisfy the C3 tracker rows for
  [the countersigned C-D4/C-D10 input, signed policy and trust, held pack
  publication and delivery, Staff-cache posture, edge enrollment, monitoring,
  and enablement](activation-readiness-tracker.md#c3-pack-edge-and-staff-cache-activation).
  Phase E supplies the qualified H1 storage placement, and Phase C supplies
  monitoring delivery. [Edge ownership and hard
  prerequisites](../runbooks/CONTINUITY_EDGE_MIRROR.md#ownership-and-hard-prerequisites)
- **Runbook.** For the Staff-cache path, follow the cited C3 tracker rows and
  keep both client flags off until their exact policy, trust, facility/device,
  time, and release gates pass. **OPEN-QUESTION:** the authority set contains
  no Staff-cache activation runbook, so the tracker rows are gates rather than
  an executable enablement procedure; keep the flags off until a reviewed
  procedure exists. If the independent edge is included in the release claim,
  execute the
  [continuity edge mirror runbook](../runbooks/CONTINUITY_EDGE_MIRROR.md),
  beginning with held validation; its separately approved activation section
  is not approval from this sequence. [Held
  validation](../runbooks/CONTINUITY_EDGE_MIRROR.md#held-validation) and
  [separately approved activation](../runbooks/CONTINUITY_EDGE_MIRROR.md#separately-approved-activation)
- **Evidence produced.** Retain the tracker-required H1 storage packet,
  countersigned-policy receipt, trust and credential receipts, exact edge
  activation receipt when claimed, Staff build/fleet receipt, monitoring
  evidence, and the packet retrieval, printing, recovery, reconciliation, and
  legacy-sunset drill receipt. [C3 tracker
  rows](activation-readiness-tracker.md#c3-pack-edge-and-staff-cache-activation)
  and [edge outage acceptance
  drill](../runbooks/CONTINUITY_EDGE_MIRROR.md#outage-and-legacy-sunset-acceptance-drill)
- **Sign-off.** Clinical, privacy, security, infrastructure, IT/device,
  product/release, GitOps, monitoring/on-call, and continuity owners accept
  their applicable C3 receipts. [C3 tracker owning
  authorities](activation-readiness-tracker.md#c3-pack-edge-and-staff-cache-activation)
- **Failure.** A verification, trust, coverage, clock, log-volume, source, or
  policy failure follows the edge runbook's fail-closed disposition; keep the
  last still-valid verified set only where the runbook permits it, otherwise
  stop serving and use the approved printed fallback. Rollback preserves data,
  logs, floors, keys, policies, and receipts. [Edge failure
  handling](../runbooks/CONTINUITY_EDGE_MIRROR.md#verification-and-failure-handling)
  and [edge rollback](../runbooks/CONTINUITY_EDGE_MIRROR.md#edge-loss-rebuild-and-rollback)

The independent edge and C6.2 backup capabilities are claim-scoped rather than
universal enforcement gates: when either is not claimed, use only the explicit
`not applicable` degradation recorded by its tracker row and do not silently
substitute a new fallback. [C3 optional-capability
rows](activation-readiness-tracker.md#c3-pack-edge-and-staff-cache-activation)
and [C6.2 optional-capability
rows](activation-readiness-tracker.md#c62-backupdr-phase-1-and-phase-2)

## Phase H — establish C-D14 facility context and device enrollment

- **Preconditions.** Phase G's policy and trust path must be ready, the
  [C-D14 record and portal-role addendum](c0-4-owner-decision-dossier.md#c-d14--capture-side-facility-context-operating-model)
  must govern the exact cohort, and the C4 tracker rows for the compile-time
  hold, Staff facility resolver, IT/security duties, and device-loss controls
  must be resolved. [C4 activation tracker](activation-readiness-tracker.md#c4-capture-activation)
- **Runbook.** **OPEN-QUESTION:** no existing operator runbook in the cited
  authority activates facility context or enrolls the production fleet, while
  the tracker records a compile-time hard block and an unresolved Staff
  resolver. The tracker row
  [“Open — execute C-D14's IT/security duties”](activation-readiness-tracker.md#c4-capture-activation)
  names the work and owners, but it is not an executable activation procedure;
  stop until a reviewed runbook and the recorded blockers are closed.
- **Evidence produced.** The missing runbook must bind the authoritative
  staff-to-facility grant, fixed-device enrollment, stable installation/device
  proof, capture-purpose grant, mobile confirmation, session rotation, and
  original-facility binding receipts named by the tracker and C-D14; this
  sequence does not invent their format. [C-D14 approved
  policy](c0-4-owner-decision-dossier.md#c-d14--capture-side-facility-context-operating-model)
  and [C4 operator row](activation-readiness-tracker.md#c4-capture-activation)
- **Sign-off.** Hospital IT/security is the granting and device-lifecycle
  authority, with clinical operations and workforce oversight; the C-D14
  clinical, privacy, security/identity, IT/device, product/UX, and release
  roles remain the approval boundary. [C-D14 required roles and approved
  policy](c0-4-owner-decision-dossier.md#c-d14--capture-side-facility-context-operating-model)
- **Failure.** Leave facility context, enrollment, and capture unavailable.
  For an actual device-loss incident, execute only the bounded
  [C4 device-loss operator runbook](c4-device-loss-operator-runbook.md), keep
  the incident incomplete until every applicable external-control receipt is
  present, and do not treat capture-grant revocation alone as completion.
  [Device-loss completion ledger](c4-device-loss-operator-runbook.md#5-completion-ledger)

## Phase I — place the entire first facility into C4 shadow

- **Preconditions.** Phase H must be complete. Satisfy the C4 tracker rows
  [“Open — publish and stage the exact v3 authority,” the Staff release/fleet
  row, the C-D11 row, the C6.3 activation-projection row, and “Open — cohort
  activation evidence”](activation-readiness-tracker.md#c4-capture-activation).
  The facility-wide shadow and narrower action/unit enforcement boundary is
  the exact quoted C-D11 rule above. [C-D11 approved
  policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)
- **Runbook.** **OPEN-QUESTION:** the tracker says the C6.3 activation
  projection is not implemented, and no existing operator runbook records the
  transition into facility-wide shadow. Do not emulate it with a global flag,
  direct database change, or policy edit; wait for the reviewed projection and
  operator procedure required by the tracker. [C6.3 tracker
  row](activation-readiness-tracker.md#c4-capture-activation)
- **Evidence produced.** Once the missing procedure exists, retain the
  tracker-required synthetic/sanitized failure, paper, training, access,
  stale-policy, rollback, and monitoring evidence for the entire approved
  facility in shadow; no action may enforce during this phase.
  [Cohort-evidence tracker row](activation-readiness-tracker.md#c4-capture-activation)
  and [C-D11 cohort rule](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)
- **Sign-off.** The named C-D11 clinical, operations, privacy, security, and
  product/release roles, together with the release and clinical-operations
  operators named by the tracker, accept the shadow receipt.
  [C-D11 required roles](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)
  and [cohort-evidence tracker row](activation-readiness-tracker.md#c4-capture-activation)
- **Failure.** Stop, preserve the shadow evidence, and remain on paper or
  read-only. Apply the quoted C-D11 rollback and unilateral halt rules; this
  sequence supplies no exception. [C-D11 approved
  policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)

## Phase J — meet the C-D11 evidence bar and prove C5 one action at a time

- **Preconditions.** Phase I remains in shadow. Before any enforcement, satisfy
  the C5 tracker rows for signed area/platform classifications, per-action
  approval and conformance, paper/incident provisioning, and end-to-end
  reconciliation drills. [C5 activation
  tracker](activation-readiness-tracker.md#c5-replay-and-reconciliation-activation)
- **Runbook.** Use the
  [C5.2 paper back-entry and reconciliation build runbook](c5-2-paper-reconciliation-build-runbook.md)
  only for its validation and operator-sequence contract. **OPEN-QUESTION:** it
  explicitly remains validation-only, inert, and not production-ready, so it
  cannot serve as production activation authority until a reviewed production
  procedure and every tracker blocker land. [C5.2 status and
  scope](c5-2-paper-reconciliation-build-runbook.md#1-authority-and-scope)
- **Evidence produced.** For the selected owner-approved action, retain the
  complete client-capture, drain, typed receipt/effect, domain mutation,
  canonical timeline/audit, downstream-effect, reconciliation, and UI proof
  required by the tracker, plus the planned downtime drill evidence required
  by the exact C-D11 evidence-bar quotation above. [C5 one-action tracker
  rows](activation-readiness-tracker.md#c5-replay-and-reconciliation-activation)
  and [C-D11 approved policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)
- **Sign-off.** Clinical governance and the affected departmental/domain owner
  approve the action; backend/domain/release operators and clinical safety
  accept conformance; the operational incident commander, clinical safety
  lead, registration/HIM, affected departments, and infrastructure/security
  owners accept the paper and reconciliation drill. [C5 tracker owning
  authorities](activation-readiness-tracker.md#c5-replay-and-reconciliation-activation)
- **Failure.** Keep the action out of enforcement, preserve or hand off every
  unresolved item, and use the C5.2 forward-compatible rollback contract;
  never delete receipts, reset offsets, reopen evidence, or alter paper facts
  to force acceptance. [C5.2 rollback
  rehearsal](c5-2-paper-reconciliation-build-runbook.md#7-rollback-rehearsal)
  and [C-D11 rollback rule](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)

## Phase K — qualify every interface family included in the first claim

- **Preconditions.** Phase J must have proved the selected action. Satisfy the
  C6.1 tracker row
  [“Open — actual enabled-interface disposition and drills”](activation-readiness-tracker.md#c61-interface-recovery-activation)
  for every enabled connector/provider on which that action or its release
  claim depends, and retain a signed exclusion for every family omitted from
  the claim. C-D8 is the stop/restart and late-data authority.
  [C-D8 record](c0-4-owner-decision-dossier.md#c-d8--external-interface-stoprestart)
- **Runbook.** Reconcile the actual hospital set against the
  [C6.1 family inventory](c6-1-integration-recovery-inventory.md#2-coverage-reconciliation)
  and follow C-D8's adopted
  [stop/restart order](c6-1-integration-recovery-inventory.md#4-stop-and-restart-order-recommendation).
  For I05, the only cited operator procedure requires held messages to remain
  held; it is not a release runbook.
  [I05 interim procedure](c6-1-i05-held-message-operator-procedure.md#interim-operator-procedure)
- **Evidence produced.** Retain each claimed family's owner disposition,
  paused start, marker and count reconciliation, bounded reopen receipt,
  outage/recovery result, and signed exclusion where applicable, exactly as
  required by the tracker. [Enabled-interface tracker
  row](activation-readiness-tracker.md#c61-interface-recovery-activation)
- **Sign-off.** Each external interface/domain owner and operator accepts its
  family receipt, with the C-D8 accountable owner retaining accountability.
  [C6.1 tracker owning authority](activation-readiness-tracker.md#c61-interface-recovery-activation)
  and [C-D8 ownership](c0-4-owner-decision-dossier.md#c-d8--external-interface-stoprestart)
- **Failure.** Keep that family paused or held, omit it from the release claim,
  and use the tracker-recorded paper-packet, temporary-identity, and C5.2 back-
  entry degradation. Never infer replay-all, start-from-now, or send authority.
  [Enabled-interface tracker
  row](activation-readiness-tracker.md#c61-interface-recovery-activation)
  and [I05 authority boundary](c6-1-i05-held-message-operator-procedure.md#current-authority-boundary)

**OPEN-QUESTION — per-family activation procedures.** The authority set
contains an interim hold procedure for I05 but no executable activation
runbook for every other inventory family. A family without a reviewed operator
procedure remains outside the first release claim even when its inert substrate
is merged. [C6.1 activation tracker](activation-readiness-tracker.md#c61-interface-recovery-activation)
and [I05 required release slice](c6-1-i05-held-message-operator-procedure.md#required-release-slice)

## Phase L — enforce the first approved action in the first approved unit

- **Preconditions.** Phases A through K must be accepted for the selected
  action and every capability in its release claim. The exact C-D11 cohort and
  evidence bar quoted above must be satisfied, the tracker row
  [“Open — cohort activation evidence”](activation-readiness-tracker.md#c4-capture-activation)
  must pass, and the C6.3 activation-projection `OPEN-QUESTION` must be closed.
  [C-D11 approved policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)
- **Runbook.** **OPEN-QUESTION:** no existing operator runbook in the authority
  set executes the first `shadow`-to-`enforce` transition through the required
  activation projection. Do not substitute a direct policy, database, feature-
  flag, or deployment change. [C6.3 tracker
  row](activation-readiness-tracker.md#c4-capture-activation)
- **Evidence produced.** The future operator procedure must retain the accepted
  shadow and drill evidence, exact action/unit scope, signed policy and client
  posture, named approvals, activation result, monitoring state, and rollback
  point required by C-D11 and the tracker; this sequence does not invent a new
  receipt or threshold. [C-D11 approved
  policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)
  and [C4 activation tracker](activation-readiness-tracker.md#c4-capture-activation)
- **Sign-off.** Enforcement requires the two keys quoted above: the accountable
  clinical owner and one operational or technical lead. No broader shadow
  cohort makes a second action or unit enforce automatically.
  [C-D11 approved policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)
- **Failure.** Any quoted C-D11 tripwire or unilateral halt returns the affected
  activation to paper or read-only immediately; preserve the evidence and do
  not widen, retry, or advance another action until its own evidence passes.
  [C-D11 approved policy](c0-4-owner-decision-dossier.md#c-d11--activation-cohort-and-evidence)

## What is deliberately not sequenced here

- **Warm-standby Phase 2** is parked until accepted Phase 1 evidence, C-D1
  ratification, site/jurisdiction, procurement, link, trust, secrets, local
  C1.2/C2.1, monitoring, and drill inputs exist; it is not part of the first-
  action enforcement path. [Phase 2 tracker
  hold](activation-readiness-tracker.md#c62-backupdr-phase-1-and-phase-2) and
  [warm-standby activation holds](../runbooks/C6_2_WARM_STANDBY_PROMOTION_FAILBACK.md#activation-holds)
- The general go-live document's **optional/future** Vault and clinical-AI
  work is outside continuity activation unless a later release claim makes it
  a dependency. [Go-live optional/future
  section](../GO_LIVE_CRITICAL_PATH.md#optional--future-not-on-the-first-trial-path)
- The tracker-marked **OPEN-QUESTION** items are not silently ordered here:
  [Staff production facility resolver, unified device-loss orchestration, and
  C6.3 activation projection](activation-readiness-tracker.md#c4-capture-activation),
  plus [I03 recovery, C6.1-G, and the held-message release
  executor](activation-readiness-tracker.md#c61-interface-recovery-activation).
  Each stays a stop line until the tracker cites a newer merged record.
  [Tracker state key and update
  discipline](activation-readiness-tracker.md#clinical-service-continuity-activation-readiness-tracker)
- Any tracker row explicitly disposed as an optional capability remains
  claim-scoped; omission uses only that row's recorded degradation and is not
  evidence that the capability passed. [C3 optional-capability
  rows](activation-readiness-tracker.md#c3-pack-edge-and-staff-cache-activation),
  [C6.1 optional-capability row](activation-readiness-tracker.md#c61-interface-recovery-activation),
  and [C6.2 optional-capability
  rows](activation-readiness-tracker.md#c62-backupdr-phase-1-and-phase-2)
