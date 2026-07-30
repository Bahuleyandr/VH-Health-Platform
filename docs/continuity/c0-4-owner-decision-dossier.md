# C0.4 Clinical Service Continuity Owner Decision Dossier

**Status:** C-D1, C-D2, C-D3, C-D4, C-D6 (full record and fallback-principal partial record), C-D7 (decision table and needs_review addendum), C-D9, C-D13, and the C-D10 retention partial record were countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner; the three delegated C-D2 values were ratified on the same date; C-D5, C-D8, C-D11, C-D12, and the non-retention portions of C-D10 remain open

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

On 2026-07-30, Dr Bahuleyan S, Medical Director & Accountable Owner, countersigned as the single accountable owner across the roles listed for each recorded decision; per-department signatures may be added later without invalidating this record.

## 2. Decision records

### C-D1 — service tiers, RTO, and RPO

> **Recommendation:** rank workflows by patient-safety consequence, then assign
> owner-approved recovery and data-loss objectives per tier. Do not use one
> number for the entire hospital.

**Required sign-off roles:** executive, clinical safety, operations,
infrastructure.

| Owner-input field | Value |
|---|---|
| Decision | All clinical workflows are Tier 1. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | All clinical workflows are Tier 1. Every clinical workflow receives the same top-tier protection objectives; no clinical function is assigned a weaker recovery-time or data-loss objective than another. Only administrative functions — billing, reporting, and analytics — are placed in a lower tier. Recovery EXECUTION order remains dependency-driven (infrastructure, then database, then authentication, then clinical services) because components cannot be restored simultaneously; that ordering is a physical constraint of recovery and is not a statement that any clinical workflow matters less. Numeric recovery-time targets are not fixed here: the first timed restore drill produces the measured figures, which are then ratified through this dossier. Data-loss objective for clinical data is the platform's existing synchronous-replication posture — committed writes are flushed to at least two of three database nodes before acknowledgement. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-30 — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | pending — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

### C-D2 — minimum cached dataset and freshness

> **Recommendation:** cache the minimum data needed for safe immediate care,
> display field-level unknown/source/freshness, and fail closed when a
> safety-critical field exceeds its approved age.

**Required sign-off roles:** clinical specialties, nursing, pharmacy, lab/blood
bank, privacy.

| Owner-input field | Value |
|---|---|
| Decision | The C-D2 minimum cached dataset and freshness policy below is approved. — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | **TIERS —** Safety-critical (must be present; fail closed to an explicit spoken unknown when stale or unrecorded; never silently defaulted): patient identity for the two-identifier bedside check (name + MRN/UID + date of birth); allergies; code status; medications due; active medication orders; recently administered medications (12-hour lookback — engineering-proposed, mirrors the existing `MAR_WINDOW_HOURS` system value applied backward) — engineering-proposed under the owner's 2026-07-28 delegation; RATIFIED 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner; unresolved critical results. Context tier (always timestamped, never blocking): bed/location; attending doctor; diagnosis/chief complaint; latest vitals + NEWS2 with recorded-at; recent released results; care team.<br><br>**UNKNOWN-STATE WORDING —** Unknown is always spoken: "Allergy status UNKNOWN — not recorded" (never NKDA); "Code status NOT RECORDED — confirm per hospital policy" (never silently full code). Display parity rule: an unknown safety field must never render less prominently than a known positive finding.<br><br>**FRESHNESS —** Packs regenerate every 15 minutes (existing cron); every screen and printout shows generation DATE + time in the facility's LOCAL timezone with the zone named (correcting the current UTC rendering); every safety-critical field carries its own recorded/last-reviewed timestamp (the vitals principle applied uniformly); between 15 minutes and 24 hours data shows a visible age badge and nothing pretends to be live; at 24 hours (existing `PACK_EXPIRY_HOURS`) the pack is EXPIRED — the app refuses to present it as current and directs staff to paper and phone. Owner rationale recorded: the program's recovery objective keeps any outage under 24 hours; no historical-reference display mode is approved. Printed packs are self-invalidating: each carries "Generated &lt;date time TZ&gt; — NOT VALID AFTER &lt;date time TZ&gt;, then use paper and phone."<br><br>**DELIBERATE EXCLUSION —** Blood group is excluded from all packs: transfusion decisions must never be made from cached data; the blood-bank verification process owns that truth.<br><br>**PER-AREA FLOORS —** Wards: the full set above. Paediatric/NICU/PICU: additionally latest weight + recorded date in the safety tier. Isolation precautions: included where a structured field exists; free text is never scraped into the safety tier (engineering-proposed under delegation) — engineering-proposed under the owner's 2026-07-28 delegation; RATIFIED 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner. ED: the per-patient safety fields plus the arrival/triage board including triage category, arrival time, and time-in-department. OPD: today's appointment list plus allergies and active medications, including patient phone numbers for outage communications, with a "destroy after clinic day" handling line on the printed sheet (engineering-proposed under delegation; privacy owner countersigns) — engineering-proposed under the owner's 2026-07-28 delegation; RATIFIED 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner. Exact ED/OPD producer shapes are confirmed when C3 builds them; this decision sets the floor. — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-28 — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | pending — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

### C-D3 — offline action matrix

> **Recommendation:** adopt the conservative initial registry in section 5.4.
> Keep orders as local drafts and use controlled paper/back-entry for physical
> medication, specimen, transfusion, admission/transfer, and similar actions
> until each domain proves a stronger offline contract.

**Required sign-off roles:** clinical governance and every affected
departmental owner.

| Owner-input field | Value |
|---|---|
| Decision | The registry was approved as-is covering all eight surfaces. — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | the design §5.4 conservative registry plus the C0.2 §6 proposed default-deny rows are the approved classification, covering all eight census surfaces (five physical/final actions, authoritative `/emr/notes` creates for every note category, vitals, note-draft autosave). — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-28 — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

### C-D4 — offline authentication and revocation risk

> **Recommendation:** normal auth over LAN; device-bound local unlock only for a
> recently authorized named user; no shared generic account; read-only emergency
> access by default; owner-approved revocation-risk window.

**Required sign-off roles:** security, privacy, clinical operations, HR/identity
owner.

| Owner-input field | Value |
|---|---|
| Decision | The C-D4 offline authentication and revocation-risk policy below is approved. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | Normal backend authentication applies whenever the backend is reachable, including over the LAN. During a full backend outage, a named staff member who successfully authenticated within the last 12 hours may unlock the cached read-only continuity pack on their own device using a device-bound PIN or biometric. Twelve hours is chosen to cover one full shift plus handover. Access is read-only; no offline write, acknowledgement, or clinical action is permitted. No shared or generic downtime account is authorized. The accepted revocation risk is stated explicitly: a staff member whose access is revoked mid-shift retains read access to already-cached data until the 12-hour window lapses. Emergency access beyond this is not authorized by this decision. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-30 — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | pending — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

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
| Decision | Two-key incident authority. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | Two-key incident authority. One named operational incident commander declares and runs a downtime incident. The clinical safety lead independently co-attests closure. Both signatures are required before an incident can close, and an incident cannot close while owner-defined safety-critical items remain unresolved. Offline declaration uses pre-provisioned, one-use signed facility incident packets containing an unused incident UUID and a reserved paper-item range; identifiers printed before an outage are never described as bound to a newly generated incident. Duplicate commanders, split-brain declarations, lost or revoked ranges, and incident merge or alias must be handled without rewriting history. Roles are recorded now; names at countersignature. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-30 — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | pending — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

#### Partial record (2026-07-28) — fallback reconciliation principal (C0A)

Offline rows whose capture owner is unknown (deleted account, null legacy owner)
are assigned to the clinical-safety-lead role as the fallback reconciliation
principal. Stored as the stable role code `role:clinical_safety_lead`, supplied
through the tenant-specific C0A configuration with no production default; the
localized role label is displayed; no staff name is persisted; the named
individual is resolved at reconciliation time. This is not a new backend RBAC
role. All other C-D6 fields remain OWNER INPUT. — recorded by engineering from
the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner

### C-D7 — logout, user switching, and unresolved work

> **Recommendation:** never silently delete pending clinical work. Preserve it
> encrypted and owner-bound; block ordinary logout or require an explicit,
> audited handoff/reconciliation path.

**Required sign-off roles:** clinical operations, security, privacy,
workforce/UX owner.

| Owner-input field | Value |
|---|---|
| Decision | BLOCK ordinary logout while the signed-in user has unresolved offline clinical rows; forced/server-pushed revocation PRESERVES rows encrypted and owner-bound (no wipe) for later reconciliation. — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | BLOCK ordinary logout while the signed-in user has unresolved offline clinical rows; forced/server-pushed revocation PRESERVES rows encrypted and owner-bound (no wipe) for later reconciliation. — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-28 — recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | recorded by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

#### Addendum (2026-07-28) — needs_review release semantics

Pending and conflict rows always block ordinary sign-out. A needs_review row
blocks sign-out until the signed-in user records a per-row attested handoff
('reviewed — transferred to paper / handed to the reconciliation owner'),
storing the attestation actor UID and timestamp on the row. Attested rows stop
counting toward the sign-out block but remain preserved, visible, undeletable,
and undrainable; attestation is immutable once set. Forced/server revocation
and idle timeout are unchanged by attestation and preserve all rows. — recorded
by engineering from the owner's 2026-07-28 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner

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
| Decision | A warm standby second site is selected. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | A warm standby second site is selected: a continuously replicated secondary site that can be promoted on failure, targeting approximately one hour to service restoration and seconds of data loss. This does not displace the design's precondition — immutable off-site backup and a proven, timed restore must be activated and demonstrated first, and the warm site is built only on top of that evidence. Site selection, private connectivity, hardware and operating budget, data residency (India-first per the platform's deployment posture), the promotion and failback runbooks, and the timed failover drill remain executive, finance/procurement, security, privacy/legal, and infrastructure items. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-30 — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | pending — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

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

#### Partial record (2026-07-30) — retention

| Retention field | Value |
|---|---|
| Decision | The C-D10 retention policy below is approved. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | Continuity packs are purged 7 days after their signed expiry. Packs expire 24 hours after generation; the additional 7 days exists to cover reconciliation and incident review, after which the patient data is purged and never reconstructed. Edge access logs are retained for 365 days, reusing the platform's existing operational-audit retention baseline seeded in migration 576_audit_retention_policy_baseline.sql rather than introducing a new figure; the 2555-day and 3650-day clinical classes are deliberately not applied to these logs. These values are the signed retention inputs the C3.1 policy document and the C3.2 purge path require; absent them, activation remains blocked. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-30 — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | pending — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

Break-glass, device-loss, and communications fields remain OWNER INPUT —
engineering must not fill.

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
| Decision | The C-D13 LAN hostname, certificate, pin, and trust-boundary policy below is approved. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approved values or policy | Same-host split-horizon is adopted. The hospital-LAN route uses the existing step-ca-internal certificate authority; the tls/step-ca component is the selected option and tls/operator-held is not used. The client keeps ONE flat accepted-pin set containing both the Cloudflare public SPKI and the internal SPKI, with the current/next overlap requirement C2.2 adds. The union-pin risk is EXPLICITLY ACCEPTED, not eliminated: if the internal CA key were compromised, an attacker with network position could present an internal-CA certificate on the public route and the client would accept it. The risk is accepted as bounded because this is a single hospital operating its own certificate authority, and it is recorded here so it is visible at every future release and rotation. The Cloudflare custom-certificate alternative, which would eliminate the risk by serving one operator-held key on both routes, is rejected on cost (custom certificate upload requires a Cloudflare Business plan). A rehearsed certificate rotation and the shipped-pin overlap remain prerequisites for activation. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Owner names and roles | Dr Bahuleyan S, Medical Director & Accountable Owner, signing as the single accountable owner across the roles listed for this decision. — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Decision date | 2026-07-30 — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |
| Approval or signature references | pending — recorded by engineering from the owner's 2026-07-30 statement; countersigned 2026-07-30 by Dr Bahuleyan S, Medical Director & Accountable Owner |

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
