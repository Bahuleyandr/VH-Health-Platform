# VH Health Clinical Service Continuity — Implementation Plan

**Status:** cross-review draft — do not execute

**Design authority:** `docs/superpowers/specs/2026-07-28-clinical-service-continuity-design.md`

**Review baseline:** `5407259b9311fd3a610d9890328186703199385f`

**Baseline commit time:** `2026-07-28T12:35:12+05:30`

## 1. Execution rules

1. Obtain the cross-review verdict before runtime implementation. Cross-review
   does not authorize a clinical workflow change. C0A may begin only after
   C0.2 and the affected C0.3 rows are frozen and clinical governance plus
   every affected departmental owner approve the restrictive classification,
   an immediately usable paper/local-draft fallback, and the required
   C-D3/C-D7 decisions. Every later slice requires its relevant C-D1 through
   C-D13 decisions.
2. Re-fetch main and re-derive all anchors, open PRs, live-cluster state, and
   the next free migration number at each slice kickoff. This plan reserves no
   migration number.
3. One non-overlapping slice per worktree/PR. Infrastructure, backend,
   Staff/client, and operator activation work must not share an unreviewed PR.
4. All runtime code lands inert. No deployment, DNS change, production secret,
   live cluster mutation, continuity activation, backup-lock change, or drill
   against real PHI is authorized by this plan.
5. Domain services remain authoritative. Do not write care-pathway,
   canonical-timeline, audit, task/SLA, or clinical state from the client.
6. Unknown actions fail closed. Do not invent clinical timings, freshness,
   access windows, medication rules, or recovery thresholds.
7. Never clear unresolved offline or reconciliation evidence during rollback.
8. Every slice gets its own detailed design delta, exact file ledger, test
   list, rollback, and coordinator content review before build.
9. Every new or extended continuity table must reject absent/default tenant
   scope, enforce facility-belongs-to-tenant integrity, use tenant-aware
   uniqueness and indexes, enable and force row-level security, grant only
   least privilege, define retention, and pass cross-tenant/role tests. Every
   facility, incident, patient, encounter/admission, task, policy,
   domain-resource, and evidence reference enforces same-tenant and, where
   applicable, same-facility ownership through composite foreign-key/unique
   constraints or a documented equivalent database constraint; application
   validation alone is insufficient. RLS uses pinned tenant context for
   privileged/background workers, with fail-closed direct-SQL and worker
   tests.
10. Database changes use additive expand/contract sequencing. Rollback disables
    new readers/writers but never drops receipts, policy, audit, queue, paper,
    incident, reconciliation, or readiness evidence.

## 2. C0 — evidence and owner decisions

### C0.1 Live-state evidence pack

- Read-only capture of:
  - repository and deployed release/digests;
  - Kubernetes/RKE2, CNPG operator, PostgreSQL, storage classes, PVC
    placement, ingress controllers, services, Cloudflare tunnels, DNS,
    certificates, and certificate rotation;
  - control-plane endpoint and etcd topology;
  - monitoring/Alertmanager, backup schedules, R2 target/retention, latest
    successful restore, UPS/generator, switch, and ISP evidence;
  - NTP/time sources and device clock-trust posture.
- Compare live facts with:
  - `infra/kubernetes/**`;
  - `infra/ansible/**`;
  - `docs/GO_LIVE_ACTIVATION_CHECKLIST.md`;
  - `docs/DR_RESTORE_DRILL.md`;
  - `docs/DEPLOYMENT_GUIDE.md`;
  - `docs/HARDWARE_REQUIREMENTS.md`.
- Mark every fact as repository target, live verified, absent, or unknown.

**Proof:** signed inventory with commands/artifacts redacted of credentials and
PHI. No production state change.

### C0.2 Clinical action and route inventory

- Enumerate every Staff offline enqueue call. The census at the review baseline
  found eight call sites (five physical/final actions, authoritative note
  creates via `POST /emr/notes`, vitals via `POST /health/records`, and the
  note-draft autosave); C0.2 must re-derive and classify all of them, and the
  classification of each `/emr/notes` note type (intake/output, shift handover,
  emergency note, wound care, and the rest) is a departmental-owner decision.
  Include the patient app's dormant `MutationQueue`
  (`apps/patient/lib/core/offline/mutation_queue.dart` —
  `enqueueOrExecute` has zero call sites; `replayQueue` is wired at startup to
  run after a later emitted transition to online) and decide removal or
  classification.
- For each action, record endpoint, method, domain owner, physical-versus-draft
  meaning, patient/encounter identity, occurrence-time support, idempotency
  middleware, optimistic concurrency, actor authorization, canonical
  timeline/audit behavior, SLA/outbox behavior, and current replay result.
- Compare implementation with:
  - `canonicalClinicalPlatformService.getDowntimePolicy`;
  - `docs/CANONICAL_CLINICAL_TIMELINE.md`;
  - `docs/DOWNTIME_PROCEDURE.md`.
- Produce the proposed default-deny registry and list every contradiction.

**Proof:** zero unclassified queue call sites and explicit P0 list for actions
to quarantine before any pilot.

### C0.3 Hospital-area and client-platform impact matrix

- Assess ward, ED, OPD, theatre/OR, ICU/NICU/PICU, maternity, cath lab,
  dialysis, pharmacy, laboratory, and blood bank independently.
- For every area, define the minimum read pack, action procedure, paper form,
  identity method, recovery owner, integration dependency, and drill.
- Mark each area included, manual-only, or excluded; the final hospital-wide
  claim may cover only included/approved areas.
- Decide Android, Windows/desktop, browser/web, and iOS separately. Do not
  assume browser storage can reuse the SQLite queue or approve browser PHI
  caching without its own security design.

**Proof:** no unnamed clinical area or client platform is implicitly covered.

### C0.4 Owner decision dossier

- Put C-D1 through C-D13 into a signable decision record.
- Name clinical, nursing, pharmacy, lab, blood-bank, registration/HIM,
  operations, infrastructure, security, privacy/legal, patient-experience,
  product/release, and executive owners.
- Record approved values/policies without editing them into code prematurely.

**Exit gate:** external cross-review approves the design; all decisions required
for the first proposed cohort are signed; no P0 fact is disputed or unowned.

## 3. C0A — immediate safety containment

This is the first code tranche after cross-review **and** the affected
C0.2/C0.3 plus C-D3/C-D7 owner gates above. It is not authorized by
architecture review alone.

Likely surfaces:

- existing prescription, drug-chart, MAR, specimen, and transfusion offline
  enqueue helpers and screens;
- `packages/vhhealth_core/lib/services/connectivity_sync_service.dart`;
- `packages/vhhealth_core/lib/services/offline_queue.dart`;
- `apps/staff/lib/core/services/auth_service.dart`;
- `apps/staff/lib/features/nursing/screens/nursing_notes_screen.dart` and
  `apps/staff/lib/features/nursing/screens/vitals_screen.dart`;
- the conflict-discard predicates in
  `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart`;
- `apps/staff/lib/core/widgets/session_revocation_listener.dart`

Tasks:

- add only the minimal backward-compatible local queue migration needed to
  represent and display typed `needs_review`; defer the full envelope and
  replay state machine to C4;
- stop new known-policy-conflicting physical/final action enqueue and
  auto-replay, including authoritative clinical-note creates;
- preserve and move existing affected rows to visible `needs_review`;
- stop every queue-clearing path — explicit logout, server-pushed session
  revocation, and any other `clearQueue` caller — from deleting unresolved
  clinical work, for any device user;
- surface exhausted/skipped rows; until C4 supplies trustworthy predecessor
  and ordering metadata, one blocked/exhausted legacy row stops its entire
  safely scoped drain rather than assuming later rows are independent;
- keep rows with unknown tenant, facility, owner, encryption version, or
  dependency scope in `needs_review`; never auto-drain them;
- assign every retained row to a named interim reconciliation owner with a
  governed handoff procedure; a badge alone is not recoverability;
- remove generic one-tap deletion for physical/final clinical evidence;
- add no new offline-eligible action.

**Gate:** regression tests prove no affected row auto-drains or disappears on
logout/discard/retry exhaustion, and existing data remains recoverable. C0A is
not operationally reversible into the known-unsafe auto-replay behavior. Code
rollback preserves every row and keeps affected actions disabled until each
action passes the signed registry and conformance gate.

## 4. C1 — truthful HA and deployability

Split C1 into independently reviewable PRs based on the live-state result.

### C1.1 CNPG, image, and backup target correction

Likely surfaces:

- `infra/kubernetes/base/cnpg/cluster.yaml`
- `infra/kubernetes/base/cnpg/kustomization.yaml`
- `infra/kubernetes/base/cnpg/operator.yaml`
- `infra/kubernetes/base/cnpg/scheduled-backup.yaml`
- `infra/kubernetes/apps/kustomization.yaml`
- `infra/kubernetes/apps/backend/backup-cronjob.yaml`
- `infra/kubernetes/apps/backend/backup-verification-cronjob.yaml`
- production overlays and deployment/restore documentation

Tasks:

- reconcile intended PostgreSQL version with a supported CNPG operator and a
  tested upgrade/restore path;
- resolve the pgvector image requirement and the operator-ConfigMap/cluster
  PostgreSQL version contradiction;
- pin every production image to a verified immutable digest and record
  provenance for the exact deployed release;
- replace literal runtime placeholders with the repository's approved secret
  or rendering mechanism;
- remove duplicate or contradictory backup schedules;
- correct source and destination credentials/least privilege;
- upgrade verification from object age to checksum, decryption, CNPG metadata,
  and scheduled disposable restore proof.

**Gate:** production render contains no unresolved placeholder, tag-only
image, or unresolved image reference; QA restore reaches application-level
clinical reads; no version/upgrade contradiction.

### C1.2 Control-plane, storage, and scheduling continuity

Likely surfaces:

- `infra/ansible/roles/rke2_server/**`
- `infra/ansible/inventories/**`
- `infra/kubernetes/base/cnpg/cluster.yaml`
- production storage overlay
- `docs/DEPLOYMENT_GUIDE.md`
- `docs/PRODUCTION_DB_HARDENING.md`

Tasks:

- implement and prove the approved highly available Kubernetes API endpoint;
- harden pod/data spread to match actual node/storage failure domains;
- decide and execute the storage migration only after hardware/operator proof;
- exercise node, control-plane leader, database primary, and storage failure.

**Gate:** no normal operator/join/failover path depends on one named node; one
node/database-member loss meets owner-approved behavior.

### C1.3 Monitoring activation

Likely surfaces:

- `infra/kubernetes/base/monitoring/**`
- `infra/kubernetes/apps/backend/service-monitor.yaml`
- runbooks and activation checklist

Tasks:

- wire Alertmanager secrets and correct namespaces;
- prove scrape, rule evaluation, notification, dead-man path, pack freshness,
  database, backup, and continuity alerts;
- retain monitoring evidence outside the failed site where required.

**Gate:** synthetic alerts reach named operators and resolve; CI syntax is not
accepted as live proof.

## 5. C2 — full hospital-LAN service

### C2.1 Private ingress and address

Likely surfaces:

- `infra/kubernetes/base/ingress-nginx/ingress-nginx.yaml`
- a dedicated internal-controller base/overlay
- `infra/kubernetes/apps/backend/ingress-clinical-internal.yaml`
- `infra/kubernetes/apps/backend/ingress.yaml`
- network/DNS/certificate runbooks

Tasks:

- deploy a distinct internal controller/class and redundant private address;
- give it separate service-account, election, ConfigMap, Service/VIP, and
  source-IP identities rather than cloning the public controller;
- ensure the controller cannot be reached from unapproved networks;
- route every approved Staff API, WebSocket, upload/download, and
  health/continuity surface;
- use exact active API hosts, including tenant `<slug>-api` hosts, or an
  equivalent fail-closed Host/tenant gate; preserve SNI/Host end to end;
- keep Staff web and API host/path routing unambiguous;
- strip untrusted forwarded/Cloudflare headers and preserve source IP through
  the approved load balancer;
- implement clinical-VLAN ACLs, network policies, TLS, body/rate limits, logs,
  and health checks equivalent to the bypassed public edge controls.

**Tests:**

- production Kustomize render;
- controller-class ownership;
- default and tenant host/path routing, unknown Host 404, and default-tenant
  fail-closed tests;
- TLS hostname, chain, SPKI-pin, rotation, and expiry tests;
- guest/patient network and external reachability negative tests;
- `X-Forwarded-For`, `CF-Connecting-IP`, and related header-spoof tests;
- one-controller-pod and one-node failure.

### C2.2 Split-horizon DNS and client readiness

Likely surfaces:

- hospital DNS/operator artifacts;
- `packages/vhhealth_core/lib/config/api_config.dart`
- `packages/vhhealth_core/lib/config/security_config.dart`
- `packages/vhhealth_core/lib/services/connectivity_service.dart`
- `packages/vhhealth_core/lib/services/connectivity_sync_service.dart`
- Staff connection-state UI and tests

Tasks:

- preserve every active API hostname and return the private address only on
  managed clinical VLANs/SSIDs; guest/patient networks keep public resolution;
- deploy redundant local resolvers and test resolver failure;
- inventory shipped pins and select the security-approved certificate/trust
  model; do not assume Cloudflare edge keys or rotation are operator-controlled;
- explicitly resolve same-host union-pin risk versus separate-host trust
  separation, then prove current/next overlap and rotation without locking out
  stale clients;
- add a low-information authenticated readiness contract that proves expected
  endpoint identity, tenant routing, backend/database readiness, policy
  compatibility, server time, and route kind;
- prove staff password/PIN and any approved SSO/identity-provider fallback
  behavior without weakening normal authentication;
- use debounce/hysteresis; do not burn retry counts during startup probes;
- show transport and continuity lifecycle separately.

**Gate:** physically remove the public route and complete the owner-approved
Staff login/read/write/audit journeys entirely over LAN; restore public routing
without endpoint/user intervention. Repeat with complete private
VIP/controller failure while the public route is healthy, stale A/AAAA,
private-DNS/DoH/VPN bypass, warm HTTP/WebSocket connections, and loss of one
and all local resolvers.

## 6. C3 — independent signed read-only continuity

### C3.1 Pack correctness and governance

Likely surfaces:

- `apps/backend/src/services/downtime/wardDowntimePackService.js`
- `apps/backend/src/config/downtimeConfig.js`
- downtime routes/middleware
- `apps/backend/src/migrations/<next-free>_*.sql`
- `apps/backend/prisma/schema.prisma`
- base continuity-policy/signing-key governance service and admin surface
- downtime service/deep/tenant tests

Tasks:

- create the append-only policy-version, signing-key, revocation,
  canonical-serialization, approval, and monotonic anti-rollback substrate
  needed to govern pack freshness and access; C3 may not use an unattached
  policy string or ad hoc signing configuration;
- extend `downtime_snapshots` for facility/location, schema/policy version,
  watermark, hash/signature, publish time, and freshness metadata;
- replace default-tenant behavior with explicit tenant/facility enumeration;
- namespace all files and indexes;
- fail the job on missing required coverage;
- represent allergy, code status, identity, and missing data truthfully;
- define ED and OPD pack producers from their authoritative sources;
- define canonical serialization, key ID, offline trust-root distribution,
  current/next rotation, revocation, monotonic anti-rollback, compromised-key,
  and uncertain-clock behavior;
- add append-only publication/evidence and RLS/tenant tests.

**Gate:** multi-tenant test proves no collision/leak; empty/partial census,
unknown allergy/code status, temporary identity, signature failure, and stale
pack fail visibly. Pack coverage and approved manual fallback are proved for
every hospital area marked included or manual-only in C0.3; ward/ED/OPD
evidence is not treated as hospital-wide proof.

### C3.2 Durable publication and independent edge mirror

Likely surfaces:

- backend deployment and downtime CronJob volumes;
- a held edge-mirror manifest/automation package;
- static route and publishing scripts;
- monitoring/rules/runbooks

Tasks:

- publish through atomic signed manifests to durable shared storage;
- pull to an independently powered/read-only edge server with separate
  credentials;
- serve without backend, database, Kubernetes, Cloudflare, or internet;
- replace monitoring-token fallback and shared static credentials with the
  approved dedicated, scoped downtime access mechanism;
- prohibit a global all-tenant index; scope authorization to exact
  tenant/facility/unit/device and support independent revocation;
- encrypt edge storage and append tamper-evident local access logs for later
  upload when central audit is unavailable;
- purge obsolete PHI according to signed retention;
- alert on pack age, signature, coverage, and replication failure.

**Gate:** stop backend and database, isolate internet, and retrieve/print packs
from the edge server; corrupt/unsigned/partial sets are rejected.

### C3.3 Staff continuity cache

Likely surfaces:

- shared secure storage/cache services;
- a new Staff continuity-pack client/repository;
- ward, ED, OPD, and global navigation/status UI;
- localization, accessibility, and widget tests

Tasks:

- prefetch signed approved packs while online;
- encrypt content and sensitive metadata;
- verify signature and bind tenant/facility/user/device/policy;
- reject valid-but-rolled-back manifest versions and compromised/revoked keys;
- display exact source, generated time, freshness, unknown state, and
  read-only status;
- support local device unlock per approved policy;
- add device-loss wipe and cross-user/cross-tenant negative tests.

**Gate:** every client platform marked included in C0.3 passes its own
airplane-mode/app-restart test and shows only the correct user's
current-enough signed data; stale/corrupt/wrong-tenant data fails closed.
Manual-only and excluded platforms are named in the release claim.

## 7. C4 — safe-capture substrate and load-bearing policy

### C4.1 Queue envelope and state machine

Likely surfaces:

- `packages/vhhealth_core/lib/services/offline_queue.dart`
- `packages/vhhealth_core/lib/services/connectivity_sync_service.dart`
- offline badge/status/reconciliation UI and tests

Tasks:

- add client event, identity, occurrence, policy, revision, expiry,
  ordering key/sequence, predecessor, supersession, command fingerprint, hash,
  and review metadata;
- give every capture an always-present device-generated `capture_session_id`;
  `incident_id` is optional until an authorized hospital incident is declared,
  and later linkage is append-only reconciliation metadata that never changes
  command identity;
- persist the client event, idempotency key, action ID, and fingerprint before
  the first network attempt and reuse them after an ambiguous/lost response;
  if this durable persistence fails, do not send the mutation;
- store action ID rather than an executable arbitrary endpoint/method;
- encrypt/authenticate the whole envelope or bind all metadata as associated
  data; version encryption/schema and quarantine failed authenticated decrypts;
- add leased `in_flight`, `retry_wait`, `applied`, `needs_review`, and
  draft-only `superseded/cancelled` states;
- use “quarantine” only as plain-language shorthand for `needs_review` with a
  typed reason, never as another durable state;
- coalesce only approved logical drafts; never coalesce append-only
  observations;
- classify authentication, authorization, not-found/gone, validation,
  conflict, rate-limit, server, and network outcomes explicitly;
- stop on failed predecessor/session; honor retry guidance;
- preserve unresolved data across logout/user switch;
- replace generic discard with reasoned reconciliation/handoff.

**Gate:** app restart, lost 2xx, duplicate request, expired token, max retry,
unknown action, failed predecessor, wrong user, wrong tenant, policy
supersession, clock rollback, corrupted ciphertext, legacy row, disk-full, and
schema/app upgrade tests produce no silent skip/loss.

### C4.2 Extend policy with action-registry and backend enforcement

Likely surfaces:

- a new migration and regenerated Prisma schema;
- continuity policy service/routes/admin governance surface;
- route wrapper or replay/back-entry enforcement middleware;
- canonical platform downtime-policy compatibility endpoint

Tasks:

- extend the C3 append-only policy substrate with action-registry versions,
  checksums, compatibility rules, and approvals;
- bind the signed audience to tenant, facility, role/capability, device posture,
  action schema, minimum app version, key ID, issue/expiry times, and
  supersession/revocation epoch;
- define canonical serialization, offline trust roots, key rotation/revocation,
  monotonic anti-rollback, compromised-key, and uncertain-clock behavior;
- preserve compatibility for old clients while returning a signed policy;
- bind each action ID to its authoritative method, handler, and schema at the
  server; never trust a client-stored endpoint/method as authority;
- evaluate action, actor, tenant/facility, current server policy, and endpoint
  class in shadow, then make the backend check fail-closed before facility
  activation;
- reject unknown/forged versions; evaluate a capture-time valid but now
  expired/superseded/revoked version against current compatibility and either
  apply through an explicit rule or move it to owned `needs_review`;
- audit every denied/review outcome without logging PHI payloads.

Shadow mode gathers compatibility evidence only. Before any facility receives
an active capture policy, the backend becomes fail-closed for the exact
approved facility/action set. With the facility still inactive, enable
boundaries in this order: backend denial, drain, enqueue, then UI presentation.
Clients below the minimum safe version and unknown actions are refused
readiness. Client enforcement is never the security boundary.

**Gate:** in active-mode tests, direct HTTP attempts cannot bypass the
registry; cross-tenant, role, replay, downgrade, anti-rollback,
key-compromise, and tamper tests pass without stranding valid captured work.

### C4.3 Staff action-registry enforcement

Likely surfaces:

- shared continuity policy/action models;
- `ConnectivitySyncService`;
- all existing enqueue call sites;
- Staff status/sync UI

Tasks:

- enforce policy before display/enqueue/drain after C4.1 transport exists;
- convert prescriptions, drug-chart orders, and similar work to explicit local
  drafts requiring online review;
- ensure `local_draft_only` never calls an authoritative create/sign/order
  endpoint; any synchronized draft uses a separately registered draft-store
  action whose receipt proves storage only, while finalization requires a new
  online user action, current authorization, and current clinical safety
  checks;
- keep specimen/transfusion/MAR automatic replay disabled until separately
  approved;
- inventory old app versions, require the minimum safe version before active
  enforcement, and migrate legacy rows visibly;
- add proactive offline blocks for critical acknowledgement, result/sign-off,
  prescription sign, encounter sign/lock, discharge, and security actions;
- remove misleading empty-success UI during failed critical-inbox load.

**Gate:** route inventory and executable conformance test agree exactly; no
current call site can enqueue outside the registry.

## 8. C5 — vertical replay, paper back-entry, and reconciliation

Activate one approved action at a time through client capture, drain, atomic
receipt, domain mutation, audit/outbox, reconciliation, and UI evidence.

### C5.1 Replay receipt and domain route conformance

Likely surfaces:

- new replay-receipt migration/model/service;
- idempotency middleware and every approved replay route;
- vitals, I/O, note/handover domain services;
- canonical timeline/audit/outbox tests

Tasks:

- make `(tenant_id, client_event_id)` unique and compare the canonical command
  fingerprint on duplicate; the fingerprint covers action/method binding,
  stable capture actor and role snapshot, tenant/facility, patient/encounter,
  capture session, any incident ID present at capture, occurrence time,
  policy/schema, ordering identity, and canonical payload;
- before revealing receipt existence/status or returning either an exact
  duplicate or original outcome, re-authorize the current caller, tenant,
  patient/resource visibility, facility, and replay capability;
- authorize and append-audit the current replay actor separately from the
  stable capture actor; a different replay actor requires an approved handoff;
- claim/finalize the receipt, authoritative domain mutation, canonical
  timeline/audit, required SLA state, and outbox event in one tenant
  transaction; return the original typed outcome on an exact duplicate;
- roll back the domain mutation if the receipt, canonical timeline/audit,
  SLA, or outbox write fails; a transport `2xx` or `202` is not `applied`
  without the matching committed typed receipt;
- reject replay eligibility when the domain handler cannot use the
  caller-supplied transaction;
- do not treat the expiring, response-finalized generic idempotency table as
  this command-effect guard;
- keep the first applied result non-rearmable through the owner-approved
  outage, app-return, paper-reconciliation, and audit horizon, then retain a
  compact immutable tombstone for the approved deduplication horizon;
- never remove a receipt/tombstone while its command can still be
  replay-eligible; after the horizon, an old command fails closed to
  `needs_review`, and an exact duplicate of compacted evidence returns an
  authorized typed `already_applied` tombstone outcome rather than a full
  historical response;
- record retry/lease/decision attempts as append-only evidence rather than
  overwriting the first-applied receipt;
- require stable route idempotency and optimistic concurrency in addition to
  the receipt;
- accept validated occurrence time separately from central recorded time;
- carry occurrence time, recorded time, client event, and causation through
  outbox/projectors;
- establish an explicit `occurred_at` contract on the outbox row or payload and
  normalize every `created_at`-reading path in all five projectors before any
  replayed event family activates; OP, emergency, diagnostic, and referral
  currently rely on it, while inpatient also reads it and alone additionally
  consumes `payload.occurred_at` for one event family;
- prohibit direct pathway state writes and prevent an unsigned draft from
  creating patient-visible canonical events, settling task/SLA work, notifying,
  or advancing a pathway;
- make late-arrival notification/SLA/pathway behavior policy explicit.

**Gate:** every approved route passes one conformance suite for atomicity,
actor, tenancy, occurrence/recorded time, idempotency, lost response,
fingerprint mismatch across every bound field, policy supersession,
concurrency, replay, canonical/audit/SLA/outbox, draft non-advancement, and
UCP projection behavior. It additionally proves:

- a committed online command whose response is lost is not repeated when that
  same pre-persisted command later enters the queue;
- receipt, domain, audit/SLA, and outbox failures roll back as one unit;
- duplicate logical effects cannot escape through different outbox row IDs;
- `202`, malformed `2xx`, and a success response without the matching typed
  receipt remain unresolved;
- a late event does not retroactively start/settle an SLA, transition a
  pathway, or notify unless its signed event-family rule explicitly says so;
- draft coalesce/finalize races and legacy-client returns cannot turn drafts
  or physical-action rows into automatic final writes.

### C5.2 Paper back-entry and reconciliation workbench

Likely surfaces:

- incident/reconciliation migrations and services;
- dedicated domain back-entry endpoints;
- Staff and/or Admin recovery workbench;
- paper form/identifier assets and runbooks

Tasks:

- create the tenant/facility-scoped incident header as a compare-and-swap
  current projection while recording every declaration, mode/owner change,
  recovery milestone, and closure attestation in append-only clinical audit;
- commit each incident compare-and-swap update and append-only audit event in
  one tenant transaction; importing an offline declaration atomically stores
  the immutable signed declaration, audit event, and resulting projection;
- support the owner-approved offline declaration flow: a pre-provisioned or
  independently signed authority issues a collision-resistant incident UUID,
  devices and paper use that exact ID, and declaration evidence is imported
  and reconciled after recovery;
- implement the C-D6-selected identifier method. The recommendation is
  pre-provisioned, one-use signed facility incident packets containing an
  unused incident UUID and reserved paper-item range; do not claim that a
  newly generated incident can bind identifiers printed before it existed;
- drill duplicate commanders, split-brain declarations, lost/revoked ranges,
  and incident merge/alias without rewriting command history;
- capture original actor/time, back-entry actor, reviewer, evidence, patient and
  encounter matching, and domain-specific validators;
- give each paper item immutable
  `(tenant_id, facility_id, incident_id, paper_item_id)` identity; in one
  tenant transaction, claim/finalize a command-effect receipt, record the
  retrospective domain fact, canonical timeline/audit, and required outbox
  evidence;
- re-authorize duplicate lookups/returns; exact duplicates return the previous
  authorized outcome, while a fingerprint mismatch becomes owned
  `needs_review`;
- ensure back-entry records the retrospective fact and never re-performs the
  physical medication, specimen, transfusion, transfer, or other transition;
- build typed needs-review/identity/interface queues;
- reuse `tasks` for assignment/SLA/escalation and write every reconciliation
  decision to the existing append-only clinical audit rather than creating a
  second task or workflow engine;
- prevent incident closure with unresolved owner-defined safety items;
- reconcile every issued, used, voided, lost, and unused paper identifier,
  every device-journal high-water mark, and every enabled interface high-water
  mark before closure;
- preserve append-only decisions and exact authoritative-resource links.

**Gate:** synthetic exercises for every included hospital area and client
platform cover disconnected incident declaration, identifier use, import,
patient/encounter matching, back-entry, review, and dual
clinical/operational closure with zero duplicate/abandoned facts or
mutable-history gaps. Every manual-only area proves its approved procedure;
every exclusion is named in the continuity claim.

## 9. C6 — integration recovery, DR, and activation

### C6.1 External dependency recovery

- inventory each integration's queue, acknowledgement, idempotency, high-water
  mark, retention, and replay semantics;
- define stop/restart ordering and ownership;
- prevent late data from silently generating retrospective alerts or patient
  notifications;
- add interface-gap reconciliation and dashboards.

**Gate:** every enabled integration identified in C0, including
LIS/laboratory, PACS/radiology, pharmacy, blood bank, identity/SSO, FHIR/ABDM,
and messaging, passes its outage/recovery drill or is explicitly excluded from
the release claim by signed owners.

### C6.2 Immutable backup and disaster recovery

- correct stale R2-lock documentation;
- trial bucket lock on a non-production bucket and obtain legal/security
  approval before production activation; locked objects are intentionally not
  rollback-deletable;
- enable approved bucket locks/retention through an operator-reviewed change;
- separate backup write, read/restore, and retention-removal authority;
- run disposable point-in-time restore and application clinical-read checks;
- select/build/test secondary-site recovery if signed RTO/RPO requires it;
- complete promotion, DNS/tunnel, secrets, verification, and failback runbooks.

**Gate:** timed restore/failover drill meets signed objectives; evidence is
available outside the affected site.

### C6.3 Facility rollout

- add an authoritative tenant+facility/cohort activation projection binding
  `off|shadow|active`, release, policy/pack versions, minimum client version,
  approvers, and rollback reason; absence means `off`, updates use
  compare-and-swap, and every transition writes append-only audit;
- add readiness evidence linked to that activation projection;
- deploy code inert;
- shadow one approved unit with synthetic/sanitized data;
- execute the complete failure matrix, staff training, and paper drill;
- activate only through named approvers and an immutable evidence packet;
- monitor the owner-defined clean streak and rollback criteria.

**Gate:** clinical, operations, privacy, security, product/release, and
executive sign-off. No automatic widening.

## 10. Cross-slice validation

Every applicable PR runs:

- repository formatting/lint/schema/OpenAPI gates;
- backend unit, deep authorization/tenancy, migration, route, journey, and
  conformance tests;
- Flutter format, analyze, unit/widget tests, localization and accessibility
  guards;
- production Kustomize render and policy tests;
- no-secret/PHI logging and static security gates;
- default-tenant rejection, facility/tenant integrity, `ENABLE` plus `FORCE`
  RLS, same-tenant reference constraints, pinned worker context,
  least-privilege grants, retention, and direct-SQL/worker
  cross-tenant/role database tests;
- exact changed-path test ledger in the PR;
- rollback rehearsal appropriate to the slice.

Manual evidence uses synthetic patients only until the real-PHI gate is
approved. Later device proof should include the attached Android phone for
airplane mode, stale cache, restart, re-authentication, queued draft, reconnect,
lost response, and conflict review.

## 11. First safe implementation tranche after approval

After C0 review and the decisions needed for the first cohort, the first code
tranche is **C0A, followed by independently reviewed C1 and C2 slices**. It is
not an expansion of offline clinical writes.

1. Freeze C0.2 and the affected C0.3 evidence and obtain the relevant signed
   clinical/departmental decisions, including usable fallback procedures.
2. Contain existing policy-conflicting auto-replay and silent queue loss while
   preserving every unresolved row for review.
3. Correct target deployability/HA contradictions found against the live
   state.
4. Build and prove the full LAN route with normal backend authority.

This first removes a present safety contradiction. The following C1/C2 work
then delivers the largest continuity gain with the smallest new clinical
semantic risk: an ISP or Cloudflare outage no longer removes the EMR from the
hospital, while all clinical writes still use the normal server, database,
authorization, canonical audit, and pathway rails.

Do not begin C4/C5 capture or replay until the C3 signed read-only layer works
and the action registry is clinically approved.
