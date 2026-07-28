# C0.4 Clinical Service Continuity Owner Decision Dossier

**Status:** owner-input draft — no decision or approval is recorded

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
values.

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
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

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
| Decision | OWNER INPUT — engineering must not fill |
| Approved values or policy | OWNER INPUT — engineering must not fill |
| Owner names and roles | OWNER INPUT — engineering must not fill |
| Decision date | OWNER INPUT — engineering must not fill |
| Approval or signature references | OWNER INPUT — engineering must not fill |

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

## 3. Dossier closure

| Owner-input field | Value |
|---|---|
| Decision IDs approved in this dossier | OWNER INPUT — engineering must not fill |
| Unresolved decision IDs | OWNER INPUT — engineering must not fill |
| Cross-decision conditions or dependencies | OWNER INPUT — engineering must not fill |
| Operational incident commander acknowledgement | OWNER INPUT — engineering must not fill |
| Clinical safety lead acknowledgement | OWNER INPUT — engineering must not fill |
| Dossier approval date | OWNER INPUT — engineering must not fill |
