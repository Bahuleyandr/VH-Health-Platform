# NL-12 Assurance And Scale Plan

**Date:** 2026-07-07
**Survey base:** `github/main` at `4d6836cb`
**Status:** Docs-only design plan for NL-12; no code, migrations, manifests, or runtime behavior changed.
**Program:** NL-12 assurance and scale: ISO 27001/SOC 2 program, pen-test execution, ABDM M1-M3 certification, NABH indicator exporter, SIEM export, cross-site DR replica, 500-bed k6 profile with SLO re-baseline, accessibility completion, SLSA-L3 finish, and zero-trust network.

## 1. Boundaries And Non-Goals

- This plan is NL-12 only. The roadmap defines NL-12 as the assurance and scale program, including ISO 27001/SOC 2, pen-test execution, ABDM M1-M3, NABH exporter, SIEM export, cross-site DR, 500-bed load profile, accessibility completion, SLSA-L3 finish, and zero-trust network (`docs/NEXT_LEVEL_ROADMAP.md:231-235`).
- NL-11 owns productization surfaces such as the developer portal, white-label packaging, public SMART/FHIR writes, HL7/interface-engine work, and legacy-HIS migration tooling (`docs/NEXT_LEVEL_ROADMAP.md:224-229`). NL-12 can define assurance evidence and export formats for those surfaces, but does not build the portal or integration engine.
- NL-12 owns NABH indicator content and assessor export acceptance. NL-6 kept department-specific statutory registers, while the cross-department NABH indicator/export pack is reserved for NL-12 (`docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md:30-34`).
- Certification logos, formal auditor opinions, external pen-test completion, NABH assessor acceptance, and ABDM sandbox credentials are operator or third-party ceremonies. They should not block inert build work that prepares evidence, exports, preflight scripts, or checklists. The repo already uses a two-declaration model: internal code-ready work first, externally certified status only after external engagements complete (`docs/adr/ADR-003-external-certification-cert-ready-zero-spend.md:27-40`, `docs/adr/ADR-003-external-certification-cert-ready-zero-spend.md:53-71`).
- CNPG's three in-cluster replicas are high availability, not cross-site disaster recovery. The DR runbook explicitly says HA replicas do not cover ransomware, destructive SQL, site disaster, or storage-layer loss; those require off-site backup and restore capability (`docs/DR_RESTORE_DRILL.md:7-11`).
- This plan does not flip Kyverno to Enforce, migrate the cluster CNI, activate Cloudflare Access policies, run k6 against production-like infrastructure, run the first DR drill, or engage auditors. It defines build slices and operator checklists so those acts become controlled ceremonies.

## 2. Headline Survey

| Workstream | What already exists | NL-12 gap |
|---|---|---|
| NABH indicator exporter | Snapshot table, tenant RLS, compute/snapshot/list routes, and CSV export exist. | Assessor-approved pack, accepted `NABH_AUDIT_EXPORT` evidence row, final indicator mapping, and export acceptance workflow are not complete. |
| SIEM and audit evidence | Hash-chained clinical audit, append-only audit guards, identity audit events, alert webhooks, outbound webhook delivery, 180-day Loki retention config, and evidence ledger controls exist. | There is no normalized SIEM export cursor, transport contract, PHI redaction policy, or accepted `SIEM_ALERTS_ONCALL` evidence pack. |
| 500-bed load and SLOs | k6 "hospital day" script and backend SLO alerts exist. | Current k6 profile is a 40/25/5 VU baseline, not a 500-bed evidence profile or re-baseline package. |
| DR | CNPG sync replicas, R2 WAL/base backups, restore-drill runbook, and clinical invariant checks exist. | Cross-site DR replica/failover design and the first timed operator drill are not complete. |
| Accessibility | Staff font scaling is wired, and machine-verifiable staff a11y tests cover live regions, reduce motion, and text scaling. | Manual NVDA/TalkBack/VoiceOver passes, broader forms/focus order, contrast, and PDF accessibility remain open. |
| SLSA and supply chain | SBOM, blocking image vuln/secret scan, signed image path, digest pin checks, and Kyverno verify policy exist. | Verify-before-pin, base-image digest pinning, non-optional signing, and Kyverno Enforce readiness remain. |
| Zero-trust network | Cloudflare Tunnel, default-deny NetworkPolicy baseline, and controlled egress patterns exist. | Cloudflare Access policy, Cilium L7 posture, and per-tenant network isolation evidence are not finished. |
| ABDM, ISO/SOC 2, pen-test | Cert-ready packages, ABDM preflight, and pen-test readiness pack exist. | Owner credentials, external engagements, certification suite booking, and recurring control evidence are not complete. |

## 3. Grounded Survey

### 3.1 NABH Indicator Exporter

Migration 286 created `nabh_indicator_snapshots` for frozen assessor-period numbers, with tenant, period, indicator code, label, value, numerator, denominator, unit, JSON details, computed actor, and a unique `(tenant_id, period_start, period_end, indicator_code)` key (`apps/backend/src/migrations/286_nabh_indicators.sql:11-29`). The table is tenant RLS-enabled and forced (`apps/backend/src/migrations/286_nabh_indicators.sql:31-50`), and the migration records the intent: computed indicators from admissions, MAR, safety reviews, lab/radiology/pharmacy timestamps, critical-alert acknowledgements, and infection cases (`apps/backend/src/migrations/286_nabh_indicators.sql:3-7`).

The backend service computes AMA/LAMA discharges, medication safety interventions per 1000 administrations, lab TAT, radiology TAT, critical lab alert acknowledgement time, HAI rate per 1000 patient-days, device-associated HAI per 1000 device-days, and incident counts (`apps/backend/src/services/quality/nabhIndicatorService.js:49-235`). It also snapshots available indicators with upsert semantics and exports a CSV row per indicator (`apps/backend/src/services/quality/nabhIndicatorService.js:261-310`). The route exposes `/api/v1/quality/nabh` for quality, leadership, and admin roles, including compute, CSV, snapshot, and list endpoints (`apps/backend/src/routes/quality/nabhRoutes.js:1-22`, `apps/backend/src/routes/quality/nabhRoutes.js:40-76`).

The NABH compliance pack expects QPS indicators for HAI, medication error, AMA/LAMA, TAT, incidents, RCA, and patient satisfaction, plus IMS backup/audit/confidentiality controls (`docs/compliance/B7.2-NABH.md:63-90`). It already records the critical gap: the DR drill is unproven and `NABH_AUDIT_EXPORT` has not yet been accepted in `india_compliance_evidence` (`docs/compliance/B7.2-NABH.md:195-205`).

### 3.2 Audit Chain, SIEM, And Security Evidence

Clinical audit events are hash chained by database trigger with per-tenant advisory locking, a shared SQL hash function, and backfilled history (`apps/backend/src/migrations/282_audit_hash_chain_esign.sql:3-19`, `apps/backend/src/migrations/282_audit_hash_chain_esign.sql:45-98`). The document-integrity service verifies the chain by recomputing the trigger-maintained hash and checking prev-hash linkage (`apps/backend/src/services/clinical/documentIntegrityService.js:239-290`). Migration 324 then makes existing audit tables append-only at the database layer, with an explicit maintenance bypass and a narrow superuser boundary (`apps/backend/src/migrations/324_audit_chain_hardening.sql:3-39`, `apps/backend/src/migrations/324_audit_chain_hardening.sql:54-119`).

Identity federation also has an append-only audit surface. `identity_audit_events` captures realm, protocol, provider, event type, outcome, actor/local subject hashes, request metadata, IP address, user agent, and JSON details, then blocks UPDATE and DELETE and forces RLS (`apps/backend/src/migrations/357_tenant_identity_providers.sql:236-264`, `apps/backend/src/migrations/357_tenant_identity_providers.sql:281-312`). The app can send high/critical alert webhooks with debouncing (`apps/backend/src/services/alerting/alertService.js:6-39`), and the integration webhook delivery service has a queued, signed, retried, SSRF-pinned outbound path with audited attempts and stale in-flight reaping (`apps/backend/src/services/integrations/webhookDeliveryService.js:1-22`, `apps/backend/src/services/integrations/webhookDeliveryService.js:172-193`, `apps/backend/src/services/integrations/webhookDeliveryService.js:398-420`).

Compliance seeding already recognizes security monitoring, audit logs, SIEM, incident response, 180-day log retention, and `SIEM_ALERTS_ONCALL` as evidence controls (`apps/backend/src/migrations/300_india_deployability_controls.sql:125-139`, `apps/backend/src/migrations/300_india_deployability_controls.sql:275-286`). Loki is configured for 180-day retention but the docs call out the operator activation caveat: until the overlay is synced, retention remains an activation precondition (`infra/kubernetes/base/monitoring/loki-values.yaml:48-65`, `docs/india-deployment-readiness.md:206-230`).

NL-12 should therefore not invent audit collection from scratch. It should add a normalized SIEM export contract, cursor/dead-letter evidence, PHI redaction rules, transport choices, and acceptance artifacts that prove critical/high security events reach the on-call path.

### 3.3 500-Bed Load Profile And SLO Re-Baseline

The current k6 script models "a hospital day in 20 minutes": OPD registration rush, medication-administration pulls, and admin dashboard polling (`apps/backend/loadtest/hospital-day.js:1-18`). The full profile peaks at 40 OPD VUs, 25 MAR VUs, and 5 dashboard VUs, with p95 read latency below 400 ms, p95 write latency below 800 ms, and error rate below 1 percent (`apps/backend/loadtest/hospital-day.js:38-70`). The README says the full profile is about 20 minutes against a production-shaped environment, never laptop Postgres, and results should be re-baselined after infrastructure changes and before pilots (`apps/backend/loadtest/README.md:31-48`).

The observability layer has a backend availability SLO of 99.95 percent with multi-window burn alerts (`infra/kubernetes/base/monitoring/backend-slo.yaml:1-5`, `infra/kubernetes/base/monitoring/backend-slo.yaml:34-59`). The on-call runbook ties latency breaches to slow-query logs, CNPG pressure, and the latest k6 baseline, and it warns that 99.95 percent on one backend Deployment may need either a lower target or stronger rollout topology if routine deploys page (`docs/RUNBOOK_ONCALL.md:25-35`, `docs/RUNBOOK_ONCALL.md:189-201`).

NL-12's 500-bed work is therefore a new capacity profile and evidence pack, not just "run the existing script harder." It needs a synthetic-bed census model, department mix, shift changes, ward med-pass concurrency, admin dashboard fan-out, seeded synthetic patients only, Grafana/SLO snapshot capture, and a re-baseline decision record.

### 3.4 Backup, Restore, And Cross-Site DR

The production CNPG manifest is a three-instance PostgreSQL 17 cluster with one synchronous standby, zone anti-affinity preference, continuous WAL archiving to R2, daily full backups, 30-day retention, and AES256 backup upload requests (`infra/kubernetes/base/cnpg/cluster.yaml:1-21`, `infra/kubernetes/base/cnpg/cluster.yaml:35-40`, `infra/kubernetes/base/cnpg/cluster.yaml:318-349`, `infra/kubernetes/base/cnpg/cluster.yaml:423-435`). It also exposes replication-lag metrics (`infra/kubernetes/base/cnpg/cluster.yaml:371-395`). The deployment guide diagrams three cloudflared pods, backend/admin, a three-replica CNPG cluster, and R2 offsite backup (`docs/DEPLOYMENT_GUIDE.md:23-38`).

The restore drill targets RPO <= 5 minutes and RTO <= 60 minutes, but it is a timed operator drill with sign-off still to be filled (`docs/DR_RESTORE_DRILL.md:15-22`). The runbook includes R2 hardening tasks, render/apply steps for a drill cluster, recovery timing, clinical invariant checks, and a backend healthcheck against the drill database (`docs/DR_RESTORE_DRILL.md:26-41`, `docs/DR_RESTORE_DRILL.md:124-175`). The deployment guide still lists "Offsite DR cluster" as a future/adjacent item (`docs/DEPLOYMENT_GUIDE.md:556-562`).

NL-12 should split this into two tracks: build a reproducible cross-site replica/failover design and evidence template, while the operator selects a site, network path, jurisdictional storage posture, and drill window.

### 3.5 Accessibility Completion

The staff accessibility audit was structural and did not run a real screen-reader pass (`apps/staff/docs/ACCESSIBILITY_AUDIT.md:12-20`). The screen-reader test plan says machine-verifiable cases now run automatically for toast live regions, reduce motion, and text scaling, but S1/S2/S4-S7 and S10-S12 still require a human with NVDA/TalkBack (`apps/staff/docs/SCREEN_READER_TEST_PLAN.md:14-38`). Staff font scaling now composes the OS text scale with an in-app 12-22 point preference through `MediaQuery` (`apps/staff/lib/main.dart:475-489`), backed by clamped pure functions (`apps/staff/lib/core/utils/font_scale.dart:1-39`) and tests for loading live regions, toast live regions, and composed text scaling (`apps/staff/test/a11y/screen_reader_plan_test.dart:1-18`, `apps/staff/test/a11y/screen_reader_plan_test.dart:136-145`, `apps/staff/test/a11y/screen_reader_plan_test.dart:172-214`).

Remaining documented gaps include focus order on long forms, color contrast audit, and tagged PDF accessibility (`apps/staff/docs/SCREEN_READER_TEST_PLAN.md:338-350`). The earlier audit also calls out recording announcements, prefix-icon semantics, reduce-motion behavior, hard-coded pill text, focus rings, and tagged PDF generation as follow-up work or evidence surfaces (`apps/staff/docs/ACCESSIBILITY_AUDIT.md:50-116`, `apps/staff/docs/ACCESSIBILITY_AUDIT.md:140-163`).

NL-12 should finish accessibility as an evidence program: automate the machine-checkable cases across staff, patient, and admin; schedule by-ear passes; record device/screen-reader/browser matrix evidence; and define PDF/tagging acceptance for assessor-facing exports.

### 3.6 SLSA-L3 Finish

The container supply-chain workflow builds backend, admin, and staff-web images. Backend still uses a tag-style base-image build arg (`NODE_IMAGE=mirror.gcr.io/library/node:22-alpine`) rather than a digest-pinned base image (`.forgejo/workflows/container-supply-chain.yml:38-52`). The workflow installs pinned Syft/Trivy versions, generates an SBOM, and blocks on Trivy CRITICAL/HIGH vulnerabilities and secrets (`.forgejo/workflows/container-supply-chain.yml:85-116`). Registry push and cosign signing are optional depending on configured secrets (`.forgejo/workflows/container-supply-chain.yml:131-156`).

The production digest guard fails on main if prod image digests are missing or still all-zero placeholders (`scripts/check-prod-digests-pinned.mjs:4-16`, `scripts/check-prod-digests-pinned.mjs:107-140`). The digest update script resolves released image tags to immutable digests and writes the kustomization entry (`scripts/update-prod-digests.mjs:4-20`, `scripts/update-prod-digests.mjs:97-147`). From that code path, NL-12 should infer the verify-before-pin gap: digest resolution is currently a registry HEAD and YAML write, not a cosign verification gate before accepting the digest.

Kyverno image verification is wired but intentionally starts in Audit mode. The policy verifies app-image signatures, supports both GitHub keyless and Forgejo key-based signatures, mutates/verifies digests, and requires a clean audit cycle plus public-key Secret before Enforce (`infra/kubernetes/base/image-policy/kyverno-verify-images.yaml:1-21`, `infra/kubernetes/base/image-policy/kyverno-verify-images.yaml:35-81`).

### 3.7 Zero-Trust Network

The cluster already has a default-deny NetworkPolicy baseline with explicit allows for DNS, metrics, ingress, and per-workload egress; the file notes that NetworkPolicy enforcement requires a capable CNI (`infra/kubernetes/base/_common/network-policies.yaml:1-22`). Monitoring and security namespaces have controlled egress examples that exclude private ranges for internet-bound receivers and Cloudflare/ACME access (`infra/kubernetes/base/_common/network-policies.yaml:217-243`, `infra/kubernetes/base/_common/network-policies.yaml:391-449`).

The Ansible default currently sets `rke2_cni: canal`, described as flannel plus Calico NetworkPolicy, with Cilium as an alternative (`infra/ansible/roles/rke2_server/defaults/main.yml:21-23`). That makes Cilium L7 a real NL-12 migration decision rather than an already-complete fact. Cloudflare Tunnel is present with three replicas, outbound-only connectivity, origin TLS verification, api/admin ingress rules, wildcard tenant host preservation, rolling updates, and a digest-pinned cloudflared image (`infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml:1-11`, `infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml:43-99`, `infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml:113-159`).

NL-12 should add Cloudflare Access policy-as-code, IdP group mapping, break-glass process, Cilium L7 migration plan, and per-tenant network-policy evidence without disrupting the existing default-deny base.

### 3.8 ABDM, ISO/SOC 2, And Pen-Test

The ABDM readiness document says substrate is largely built, but certification is gated on owner onboarding and sandbox evidence (`docs/ABDM_READINESS.md:5-8`). Built surfaces include ABHA linking, care contexts, consent artifacts, gateway/token handling, callback authenticity/replay guard, SSRF guard on HIP data-push URL, and hash-chained consent/PHI audit (`docs/ABDM_READINESS.md:13-27`). Blockers include sandbox credentials, bridge registration, byte-level M2 encryption interop sign-off, certification suite execution, and evidence ledger rows with `evidence_uri`, `verified_by`, and `verified_at` (`docs/ABDM_READINESS.md:28-61`).

The ABDM compliance package maps M1, M2, and M3 requirements, including M2 encrypted HI push and SSRF guard and M3 consent request/fetch/dashboard controls (`docs/compliance/B7.1-ABDM.md:29-50`, `docs/compliance/B7.1-ABDM.md:103-148`). The gap register keeps owner-side credentials, M2 dry run, FHIR conformance, HIU UAT, evidence rows, and M3 scheduling open (`docs/compliance/B7.1-ABDM.md:170-180`). The preflight script similarly states that NHA/ABDM sandbox signup, credentials, bridge registration, and certification suites cannot be done from the repo (`apps/backend/scripts/abdm-preflight.mjs:4-13`).

For ISO 27001/SOC 2, the India readiness doc frames the program as a practical control pack, not a code switch: asset inventory, access reviews, change management, vulnerability SLAs, external pen-test or signed exception, vendor due diligence, and incident postmortem evidence (`docs/india-deployment-readiness.md:327-341`). The same doc warns that formal SOC 2 Type II and ISO 27001 certification require external audit/certification if a buyer requires the logo (`docs/india-deployment-readiness.md:373-382`).

The pen-test pack is ready for external engagement scheduling, with scope/rules, infrastructure boundaries, and a handoff note to external testers (`docs/PENTEST_READINESS.md:1-12`, `docs/PENTEST_READINESS.md:42-62`, `docs/PENTEST_READINESS.md:281-283`). The B7.4 package adds the formal pre-engagement checklist and makes clear that the external engagement and accepted `VAPT_OR_SIGNED_EXCEPTION` evidence row are still open (`docs/compliance/B7.4-PENTEST.md:1-18`, `docs/compliance/B7.4-PENTEST.md:136-145`, `docs/compliance/B7.4-PENTEST.md:279-314`).

## 4. Buildable Vs Operator Split

| Workstream | Buildable slices | Operator checklist |
|---|---|---|
| NABH exporter | Finalize indicator dictionary, assessor CSV/JSON/PDF contract, evidence-ledger attachment workflow, sample snapshots, regression tests, and admin/quality route affordances. | Pick NABH assessor/export format, approve indicator definitions and periods, run first export review, attach accepted `NABH_AUDIT_EXPORT` evidence. |
| SIEM export | Add normalized event schema, export cursors, redaction/minimization policy, signed delivery or object-drop transport, replay/dead-letter evidence, and a smoke script that proves critical/high events reach the target. | Select SIEM/SOC provider, provide endpoint/credentials, define on-call routing, run incident tabletop, accept `SIEM_ALERTS_ONCALL` and `INDIA_LOG_RETENTION_180D` evidence. |
| 500-bed k6/SLO | Add a 500-bed synthetic profile, capacity assumptions, Grafana/SLO snapshot script, result template, and re-baseline decision record. | Provide production-shaped environment, synthetic patient pool, run window, allowed load ceiling, and sign-off on SLO target changes. |
| DR | Add cross-site replica/failover architecture, runbook deltas, evidence template, readiness preflight, and clinical invariant checklist for cross-site promotion. | Select DR site/cluster, network path, budget, RPO/RTO approver, storage jurisdiction, backup hardening, and first timed drill window. |
| Accessibility | Expand automated semantics/text-scale/reduce-motion coverage, add staff/patient/admin by-ear matrix, PDF accessibility acceptance criteria, and evidence capture template. | Assign NVDA/TalkBack/VoiceOver testers, approve devices/browsers, run by-ear ceremony, approve PDF accessibility policy. |
| SLSA-L3 | Add verify-before-pin, base-image digest pinning, required signing path, stricter SBOM evidence, Kyverno policy-report gate, and Enforce-readiness smoke. | Create Forgejo cosign public-key Secret, confirm tlog policy, approve Enforce flip after clean audit, and maintain signing secrets. |
| Zero-trust network | Add Cloudflare Access policy-as-code, IdP group mapping, break-glass docs, Cilium L7 migration plan, per-tenant NetworkPolicy design, and enforcement evidence. | Choose IdP groups, approve Cloudflare Access policies, schedule CNI migration, define break-glass owners, and validate hospital firewall posture. |
| ABDM/cert/pentest/ISO/SOC 2 | Add evidence dashboard/checklist updates, ABDM suite runbook, control-pack cadence, access-review template, and pen-test evidence intake flow. | Obtain ABDM credentials, register bridge/HIP/HIU, book M1/M2/M3, select ISO/SOC 2 auditor and pen-test firm, approve control owners. |

## 5. Recommended Slice Table

| # | Slice | Size | Migrations | Regulatory value | Demo value | Substrate readiness | Risks / notes |
|---|---|---|---:|---|---|---|---|
| NL12-1 | NABH indicator content and assessor export contract | M | 0-1 | Closes the path to `NABH_AUDIT_EXPORT` acceptance and QPS/IMS assessor review. | Quality officer can generate a period pack, inspect frozen indicators, and export assessor-ready files. | High: snapshot table, compute service, CSV route, and compliance pack exist. | Needs assessor-approved format; include patient satisfaction and RCA boundaries explicitly. |
| NL12-2 | SIEM export seam and on-call evidence | M | 1-2 | Supports CERT-In, ISO/SOC 2 control evidence, and `SIEM_ALERTS_ONCALL`. | Security lead can fire synthetic high/critical events and see delivery, retry, and evidence rows. | Medium: audit chain, identity audit, webhooks, alerting, Loki retention, and controls exist. | PHI minimization is the primary design risk; never export raw clinical payloads by default. |
| NL12-3 | 500-bed load profile and SLO re-baseline pack | M | 0 | Proves scale posture before pilot expansion and ties capacity to SLOs. | Operator can run a documented 500-bed synthetic load and attach Grafana/k6 evidence. | Medium: current k6 and SLO alerts exist, but profile is smaller. | Requires production-shaped infrastructure and synthetic data only. |
| NL12-4 | SLSA verify-before-pin and base-image digest closure | S-M | 0 | Reduces mutable-image and unsigned-image supply-chain risk before clinical go-live. | Release lead can show "verified, then pinned" evidence for each runnable image. | Medium: digest guard, update script, scans, signing, and Kyverno Audit policy exist. | Current signing can be skipped when secrets are absent; make release path fail closed before Enforce. |
| NL12-5 | Kyverno Enforce readiness gate | S | 0 | Converts signature verification from audit evidence to admission control safely. | Platform lead can show policy report clean cycle, secret presence, and a no-outage Enforce runbook. | Medium: policy is wired and intentionally Audit mode. | Enforce before clean audit can cause admission outage. |
| NL12-6 | Accessibility completion pack | M | 0 | Supports WCAG-style operational readiness, NABH IMS usability evidence, and staff safety. | Demo includes font scaling, live-region tests, screen-reader matrix, and PDF/accessibility checklist. | Medium: staff font scaling and some automated tests exist. | Manual by-ear passes and PDF tagging require real devices and owner scheduling. |
| NL12-7 | Cross-site DR replica and failover plan | L | 0 | Converts backup/restore posture into site-disaster readiness. | Infra owner can rehearse recovery with cross-site topology, clinical invariants, and RPO/RTO evidence. | Medium: CNPG/R2 backups and restore drill exist; offsite DR cluster is still future. | Hardware, bandwidth, jurisdiction, and failover DNS decisions are operator-bound. |
| NL12-8 | ABDM/certification evidence cockpit | M | 0-1 | Coordinates ABDM M1-M3, VAPT, ISO/SOC 2, and audit evidence without claiming external certification prematurely. | Owner sees open/accepted evidence rows, blockers, runbooks, and external engagement status. | Medium: readiness docs, preflight, and compliance packages exist. | Must keep "cert-ready" separate from "externally certified." |
| NL12-9 | Zero-trust network and Cloudflare Access policy pack | M-L | 0 | Hardens access plane, tenant isolation, and hospital network posture. | Demo shows Access policy, IdP groups, default-deny evidence, and CNI enforcement checks. | Medium: tunnel and NetworkPolicy base exist. | Cilium L7 requires migration planning because current Ansible default is canal. |

Recommended order: NL12-1, NL12-2, NL12-3, NL12-4, and NL12-5 first because they turn existing substrate into objective evidence quickly. NL12-6 can run in parallel with owner scheduling. NL12-7, NL12-8, and NL12-9 should start design immediately but will close only after operator choices are made.

## 6. Owner Decisions

1. Which NABH assessor/export format should be treated as canonical for the first accepted `NABH_AUDIT_EXPORT`?
2. Which SIEM/SOC target will receive high/critical events, and what transport is allowed: webhook, syslog, object drop, or agent pull?
3. Who owns CERT-In POC, incident commander, and on-call routing for the first tabletop?
4. What is the approved 500-bed capacity assumption: beds, active inpatients, OPD visits per day, nurses per ward, med-pass concurrency, and dashboard users?
5. Which production-shaped environment is approved for k6 full/500-bed runs, and when may it be loaded?
6. What is the DR site/cluster, network path, RPO/RTO approver, storage jurisdiction, and first drill window?
7. Which staff, patient, and admin devices/browsers/screen readers are in the accessibility sign-off matrix?
8. Which signing path is authoritative for production images: Forgejo key signing, GitHub keyless signing, or both?
9. When may Kyverno switch from Audit to Enforce, and who owns the rollback procedure?
10. Which Cloudflare Access IdP groups, break-glass identities, and per-tenant host policy are approved?
11. Who is the ABDM registration owner for credentials, bridge registration, HIP/HIU IDs, and M1/M2/M3 booking?
12. Which ISO 27001/SOC 2 auditor, pen-test firm, and evidence cadence will be used for buyer-facing assurance?

## 7. Risks And Watchpoints

- Evidence drift: the repo has several "ready" packages whose external ceremonies have not happened. NL-12 docs and UI must distinguish built substrate, owner-gated action, accepted evidence, and externally certified status.
- PHI over-export: SIEM and NABH exports must use minimized, redacted, purpose-specific payloads. Raw clinical events should not leave the platform by default.
- Admission outage: Kyverno Enforce before a clean audit cycle and public-key Secret verification can block pods cluster-wide.
- CNI mismatch: the NetworkPolicy comments mention Cilium L4/L7, but Ansible defaults to canal. NL-12 must make Cilium L7 an explicit migration, not an assumption.
- False capacity confidence: the current k6 profile is not a 500-bed proof. The 500-bed profile must run only on production-shaped infrastructure with synthetic data and attached Grafana evidence.
- DR theater: R2 backups and in-cluster replicas do not prove cross-site recovery. The first timed restore and cross-site replica drill need operator sign-off and clinical invariant checks.
- Accessibility incompleteness: automated semantics tests are necessary but not enough. Real screen-reader sessions and PDF export accessibility still need owner scheduling and evidence.
- Certification lead time: ABDM, NABH, VAPT, ISO 27001, and SOC 2 depend on external parties and can slip weeks or months even if all code is complete.
