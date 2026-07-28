# C0.4 Clinical Service Continuity Owner Decision Dossier

**Status:** C-D3 and C-D7 owner statements recorded by engineering from the owner's 2026-07-28 statement; countersignature pending — all other decisions remain open

**Repository baseline:** `d52daac2c60eb921b327c80c886f35f6e603b528`

**Baseline commit time:** `2026-07-28T13:56:41+05:30`

**Authority:** [clinical service continuity design §11](../superpowers/specs/2026-07-28-clinical-service-continuity-design.md#11-owner-decisions-and-recommendations) and [implementation plan C0.4](../superpowers/plans/2026-07-28-clinical-service-continuity.md#c04-owner-decision-dossier)

## 1. Purpose and completion rule

This dossier records the C-D1 through C-D13 decisions required before the
continuity program may treat any associated policy or value as approved. The
recommendations and sign-off roles below are transcribed from the design
authority; they are not approvals.

Engineering must not complete, infer, preselect, or narrow any owner-input
field. A decision is complete only when every required role has supplied
traceable approval and the decision record contains the approved policy or
values. Verbatim, attributed scribing of an owner-supplied statement does not
constitute engineering completion or countersignature.

## 2. Decision records

### C-D1 — service tiers, RTO, and RPO

> **Recommendation:** rank workflows by patient-safety consequence, then assign
> owner-approved recovery and data-loss objectives per tier. Do not use one
> number for the entire hospital.

**Required sign-off roles:** executive, clinical safety, operations,
infrastructure.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D2 — minimum cached dataset and freshness

> **Recommendation:** cache the minimum data needed for safe immediate care,
> display field-level unknown/source/freshness, and fail closed when a
> safety-critical field exceeds its approved age.

**Required sign-off roles:** clinical specialties, nursing, pharmacy, lab/blood
bank, privacy.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D3 — offline action matrix

> **Recommendation:** adopt the conservative initial registry in section 5.4.
> Keep orders as local drafts and use controlled paper/back-entry for physical
> medication, specimen, transfusion, admission/transfer, and similar actions
> until each domain proves a stronger offline contract.

**Required sign-off roles:** clinical governance and every affected
departmental owner.

| Owner-input field | Value |
|---|---|
| Decision | The registry was approved as-is covering all eight surfaces. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Approved values or policy | the design §5.4 conservative registry plus the C0.2 §6 proposed default-deny rows are the approved classification, covering all eight census surfaces (five physical/final actions, authoritative `/emr/notes` creates for every note category, vitals, note-draft autosave). — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Owner names and roles | clinical governance + each affected departmental owner; names at countersignature. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Decision date | 2026-07-28 — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Approval or signature references | recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |

### C-D4 — offline authentication and revocation risk

> **Recommendation:** normal auth over LAN; device-bound local unlock only for a
> recently authorized named user; no shared generic account; read-only emergency
> access by default; owner-approved revocation-risk window.

**Required sign-off roles:** security, privacy, clinical operations, HR/identity
owner.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D5 — downtime patient identity and new arrivals

> **Recommendation:** use the C-D6-approved pre-provisioned signed incident
> packet or independently verifiable declaration plus unique paper-item
> identifiers, explicit temporary identity, two-identifier bedside checks where
> available, and later governed merge/match. Never silently create a duplicate
> permanent identity or treat an unknown identifier as verified.

**Required sign-off roles:** registration/HIM, ED, nursing, clinical safety,
privacy.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D6 — incident authority and reconciliation ownership

> **Recommendation:** name one operational incident commander and one clinical
> safety lead. Pre-provision an independently verifiable offline declaration
> method and incident UUID. Require both leads to attest recovery closure; assign
> every unresolved item to a role and named owner.

**Required sign-off roles:** hospital operations, medical leadership, nursing
leadership, IT/security.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D7 — logout, user switching, and unresolved work

> **Recommendation:** never silently delete pending clinical work. Preserve it
> encrypted and owner-bound; block ordinary logout or require an explicit,
> audited handoff/reconciliation path.

**Required sign-off roles:** clinical operations, security, privacy,
workforce/UX owner.

| Owner-input field | Value |
|---|---|
| Decision | BLOCK ordinary logout while the signed-in user has unresolved offline clinical rows; forced/server-pushed revocation PRESERVES rows encrypted and owner-bound (no wipe) for later reconciliation. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Approved values or policy | BLOCK ordinary logout while the signed-in user has unresolved offline clinical rows; forced/server-pushed revocation PRESERVES rows encrypted and owner-bound (no wipe) for later reconciliation. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Owner names and roles | clinical governance + each affected departmental owner; names at countersignature. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Decision date | 2026-07-28 — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Approval or signature references | recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |

### C-D8 — external interface stop/restart

> **Recommendation:** define per-interface high-water marks, duplicate handling,
> stop/restart order, ownership, and whether late data may notify or alter an SLA.
> No retrospective patient alert without approved policy.

**Required sign-off roles:** each interface/domain owner, clinical safety,
operations.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D9 — secondary site and data location

> **Recommendation:** select restore-only, cold, warm, or hot secondary-site
> recovery from the signed business-impact assessment. In all cases activate
> immutable off-site backup and prove restore first.

**Required sign-off roles:** executive, finance/procurement, security,
privacy/legal, infrastructure.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D10 — break-glass, retention, device loss, and communications

> **Recommendation:** keep electronic break-glass blocked offline initially;
> use separately approved emergency read-only access and independent
> communications. Define policy, pack, cache, journal, receipt/tombstone,
> replay-attempt, paper, incident, reconciliation, and readiness-evidence
> retention together with the maximum server replay-eligibility window. The
> deduplication tombstone horizon must never be shorter than any interval in
> which the command can still be accepted. Define remote-wipe behavior
> explicitly.

**Required sign-off roles:** clinical governance, security, privacy/legal,
operations.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D11 — activation cohort and evidence

> **Recommendation:** one facility and one suitable unit first, beginning in
> shadow. Owners set the evidence window, spacing, freshness, no-go, and rollback
> criteria.

**Required sign-off roles:** clinical, operations, privacy, security,
product/release.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D12 — patient portal behavior

> **Recommendation:** during outage, show only previously released cached data
> with a prominent last-updated state; do not accept high-risk patient mutations
> offline; publish an approved support/communication message.

**Required sign-off roles:** clinical, patient experience, privacy,
communications, product.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

### C-D13 — LAN hostname, certificate, pin, and trust boundary

> **Recommendation:** prefer same-host split-horizon for the first LAN slice
> because the current clients, tenant resolution, tokens, WebSockets, and retry
> model assume one origin. Approve it only after inventorying the pins in every
> shipped client and explicitly accepting or eliminating public/internal
> union-pin risk with a rehearsed certificate rotation. If security rejects that
> trust union, a separate LAN hostname requires a reviewed endpoint state
> machine and mutation-idempotency proof before activation.

**Required sign-off roles:** security, infrastructure/network, privacy,
product/release.

| Owner-input field | Value |
|---|---|
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

## 3. C0A gate evidence freeze

This is an attributed scribing record. It does not edit, reorder, or authorize
the C0A gate language.

| Freeze field | Recorded value |
|---|---|
| Recorded main SHA | `a84635b529aae6bbe7f8dac53bd237412eeb357b` — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Confirmed departmental fallback | department-specific paper form sets are confirmed in place per affected department — OPD prescription pads, inpatient drug charts, MAR sheets, laboratory requisition forms, blood-bank verification slips, nursing note forms. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Frozen C0.2 and C0.3 evidence | C0.2 (the full §2 inventory and the §8 six-family quarantine list) and the C0A-affected C0.3 rows (OPD, wards/inpatient, laboratory, blood bank — their fallback/action-procedure cells filled with decision 3 above, attributed) are FROZEN for C0A at the recorded main SHA `a84635b529aae6bbe7f8dac53bd237412eeb357b`. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| Remaining C0.3 owner input | All other C0.3 owner-input cells remain open for later slices. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |
| C0A scope boundary | vitals remains OUTSIDE the C0A scope per C0.2 §8. — recorded by engineering from the owner's 2026-07-28 statement; countersignature pending |

## 4. Dossier closure

| Owner-input field | Value |
|---|---|
| Decision IDs approved in this dossier | OWNER INPUT — engineering must not fill |
| Unresolved decision IDs | OWNER INPUT — engineering must not fill |
| Cross-decision conditions or dependencies | OWNER INPUT — engineering must not fill |
| Operational incident commander acknowledgement | OWNER INPUT — engineering must not fill |
| Clinical safety lead acknowledgement | OWNER INPUT — engineering must not fill |
| Dossier approval date | OWNER INPUT — engineering must not fill |
