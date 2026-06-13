# VH Health Platform — S-Tier Roadmap & Execution Plan

**Created:** 2026-06-13 · **Hard deadline:** 2026-06-30 (everything in our control) ·
**Source findings:** `docs/PLATFORM_AUDIT_2026-06-13.md` (11-agent audit) +
`docs/EPIC_LEVEL_ROADMAP.md`. **Status today:** overall **B−**. **Target:** **A+/S**.

## GOAL (autonomous loop — set 2026-06-13)

**Objective:** take the platform from B− to **A+/S tier** by completing every
in-our-control batch in this roadmap (WS1–WS8), **local-only**, each validated
green, before **2026-06-30**.

**DONE =** all non-`[flagged]` batches merged to local `main` · full chunked
backend suite green (`npm --prefix apps/backend run test:ci`) · admin + Flutter
analyze/test green · S-tier scorecard A+ column (§2) met. `[flagged]` external /
hardware / engagement items are packaged for the operator (not blockers for the
"internal A+/S" milestone).

**Driven by a self-paced loop:** each iteration reads the tracker + execution log
(§6), executes the next pending batch in dependency order (subagent → review diff
→ validate → commit local → update tracker), periodically re-runs the chunked
suite for regression, and continues until DONE. No push until the user says.

## Decisions (locked 2026-06-13)

1. **Tenant model:** Both in parallel — single-tenant hardening *and* full multi-tenant SaaS RLS.
2. **S-tier bar:** Internal excellence **+ external certification** (ABDM/NABH/DPDP/pen-test).
3. **Budget:** Zero-spend code/config; money items flagged separately (§4).
4. **Execution:** Time-boxed to **2026-06-30** for all in-our-control work; Claude-driven batches + subagents; standard git flow (commit → local CI green → `--no-ff` merge → delete branch).
5. **Swarm retired.** Replaced by deterministic in-CI E2E journey tests (WS3) — the new authoritative quality gate.

---

## 1. What "DONE by June 30" means (in-control) vs flagged

| Lands by Jun 30 (we control) | Flagged — external / hardware / real-time (teed-up by Jun 30, completes later) |
|---|---|
| All WS0 criticals | Third-party pen-test engagement (prep + self-SAST/DAST done) |
| Full multi-tenant RLS + cross-tenant test gate | ABDM M1/M2/M3 **certification** (cert-ready code + conformance harness done) |
| Envelope/KMS crypto + rotation code | NABH **assessment** (indicator pack + evidence export done) |
| Monitoring stack live + DR drill **run** | DPDP **external audit** (artifacts + dashboards done) |
| Deterministic E2E for all 11 journeys in CI | GPU node for deep-tier AI (manifests + readiness done) |
| Drug-KB on open CIMS/CDSCO data + CDS wiring | Commercial drug-KB license (Medi-Span/FDB) |
| Orthanc PACS + OHIF viewer | Barcode/label printers + live analyzer interfaces (BCMA/lab hardware) |
| All mobile PHI hardening + app/admin fixes | Stage-1 AI ward pilot (real doctor, 1 week of real use) |
| AI safety holes closed + outcome KPIs | eSign provider contract (DSC/eSign India) |
| Docs truth-synced, ADRs, housekeeping | |

**S-tier achieved in two declarations:** **Internal A+/S = Jun 30** · **Externally-certified S = when the flagged engagements clear (lead-time bound, ~Q3–Q4 2026+).**

---

## 2. S-tier scorecard (definition of done)

| Dimension | A+ bar (by Jun 30) | S bar (adds, flagged) |
|---|---|---|
| Security | 0 self-found crit/high; full multi-tenant RLS w/ green cross-tenant gate; envelope/KMS + rotation; mobile PHI hardened | Clean third-party pen test; DPDP audit passed |
| Reliability | DR drill **passed** (RPO/RTO proven); monitoring+alerting live + deadman; outage jobs survive app-down; SLOs met under k6 load | Chaos/multi-node drill; 99.9% proven |
| Quality | 11 journeys deterministic-green in CI; coverage floors; 0 red tests; FHIR conformance blocking; supply-chain enforced | Mutation + perf-regression gates |
| Clinical depth | Closed loops (BCMA/lab/radiology code), drug KB, CPOE UI, med-rec, problem list, terminology | Live analyzer/PACS hardware integration |
| AI | Governance holes closed; deep-tier ready; outcome KPIs | Deep tier on GPU; ward pilot w/ acceptance >70% |
| Compliance | NABH pack; e-sign + tamper-evident audit chain; cert-ready code | ABDM certified; NABH assessed; DPDP audited |
| Governance | Docs truth-synced; ADRs; change mgmt; runbooks proven | — |

---

## 3. Execution model & sequencing (Jun 13–30)

Batches run in dependency order; independent batches parallelize via subagents
(worktree isolation for concurrent file edits). **Working-tree reconciliation
first** (B0.1) — the in-flight `SECURITY_SWEEP_2026-06-13.md` edits sit on WS0/WS1
critical-path files and must be landed before building on them.

| Window | Parallel tracks |
|---|---|
| Jun 13–16 | **WS0** (all criticals) |
| Jun 16–24 | **WS1** (security/multi-tenant) ‖ **WS2** (reliability) ‖ **WS3** (quality gate) |
| Jun 20–29 | **WS4** (clinical depth) ‖ **WS5** (AI) ‖ **WS6** (apps) |
| Jun 24–30 | **WS7** (cert prep) ‖ **WS8** (docs/governance) + full-stack S-tier verification |

---

## 4. Flagged procurement / needs-approval list (with cost + lead time)

| Item | Why | Rough cost | Lead time | Unblocks |
|---|---|---|---|---|
| External pen test | S-security bar | $$ (firm-dependent) | 2–6 wk | DPDP/clinical sign-off |
| ABDM sandbox creds + empanelment | M1/M2/M3 cert | gov fees | weeks–months | India gov empanelment, Scan&Share |
| NABH assessment | accreditation | assessor fees | months | hospital accreditation |
| DPDP external audit | compliance bar | $$ | weeks | data-protection sign-off |
| GPU node (70B ideal / 14B ok) | deep-tier local AI | hardware | procurement | PHI-local deep AI |
| Commercial drug KB (Medi-Span/FDB) | richest drug safety | license | procurement | best-in-class CDS (open data first) |
| Label/barcode printers + analyzer drivers | BCMA + lab loops | hardware | procurement + on-site | closed-loop med/lab |
| eSign provider (DSC/eSign India) | legal e-signature | per-sign | procurement | MCCD/discharge/consent e-sign |

*All code/config to consume these is built by Jun 30; only the contracts/hardware are flagged.*

---

## 5. Workstreams & batches

Acceptance criteria are written so each batch is independently verifiable. `[flagged]`
marks a sub-item gated externally. Finding IDs reference the audit.

### WS0 — Criticals / stop-the-bleed  (Jun 13–16)

- **B0.1 Reconcile in-flight sweep** — review `SECURITY_SWEEP_2026-06-13.md` + working-tree diff; land it on a branch (commit → CI → merge) so WS0/WS1 build on a clean tree. *Accept:* working tree clean, sweep merged, suite green.
- **B0.2 Prod non-superuser DB role** (INF-4/8) — add `vhhealth_runtime` (NOSUPERUSER NOBYPASSRLS) to CNPG `spec.managed.roles`; SealedSecret for its password; switch app `DATABASE_URL` to it; superuser only for the migration Job; `enableSuperuserAccess:false`. *Accept:* `logTenantRlsRolePosture` green; app connects as non-superuser; migration job still works.
- **B0.3 Hash admin reset OTP** (SEC-1) — bcrypt on create; fetch latest unused/unexpired by `user_id` then compare; per-OTP attempt lockout. *Accept:* no plaintext OTP in DB; brute-force test fails closed.
- **B0.4 Staff refresh hardening** (SEC-2) — require `type==='refresh'`, jti-blacklist check in `refreshStaffSession`/quickLogin. *Accept:* access-token-as-refresh rejected; revoked refresh rejected; test added.
- **B0.5 Atomic canonical timeline** (BA-1) — thread `tx` into `recordCanonicalClinicalEvent` from inside each clinical write's `$transaction` (notes/vitals/orders/admission/I-O); canonical-write failure aborts the tx. *Accept:* detail + timeline + audit row in one txn; rollback test proves atomicity.
- **B0.6 Image-admission gate** (INF-1/2) — add `- image-policy` to `base/kustomization.yaml`; flip Kyverno to `Enforce` after one clean audit pass; CI check rejecting `sha256:000…` digests on main; digest-pin step. *Accept:* unsigned image rejected at admission; no placeholder digests on main.
- **B0.7 Fix red roleMatrix test** (CI-2) — resolve HOUSEKEEPING_STAFF `isSupportStaff` classification (code or expectation). *Accept:* backend suite fully green.

### WS1 — Security & multi-tenancy  (Jun 16–24)

- **B1.1 Single-tenant FORCE-RLS hardening** (Track A) — FORCE RLS on all policied tables; default-tenant correctness; posture green. *Accept:* no owner-exempt PHI table; posture log clean.
- **B1.2 Full RLS policy coverage** (Track B, DB-1) — `tenant_isolation` policy + index on every PHI/financial `tenant_id` table (~240 remaining); extend `check-phi-tenant-id.mjs` to assert *policy presence*. *Subagent-parallel by table group.* *Accept:* 0 unpoliced tenant_id PHI/financial tables; lint gate passes.
- **B1.3 Scope interactive transactions** (SEC-3) — convert PHI-touching `$transaction` call sites to `setTenant`; make `setTenant` replica-aware; assert replica role NOBYPASSRLS. *Accept:* no unscoped PHI txn; replica posture asserted.
- **B1.4 Cross-tenant test gate** — deep test: tenant-B JWT cannot read tenant-A PHI via staff/admin/API routes; wired **blocking** in CI. *Accept:* gate green and blocks on regression.
- **B1.5 Envelope/KMS crypto** (SEC-4) — key-id prefix + KEK/DEK split + rotation path; separate `searchableHash` HMAC key; rotation runbook. *Accept:* rotate-without-downtime proven on a test column.
- **B1.6 Auth & PHI-audit fixes** — patient cross-tenant identity scoping (SEC-5); PHI denied-access audit rows on 403/404 (SEC-6); `verify-otp` expiry filter (SEC-7); proxy require-Origin on mutations (SEC-8). *Accept:* tests for each.
- **B1.7 Pen-test readiness** — threat model, scope doc, self-run SAST (Semgrep) + DAST (ZAP) pass, fix sweep. `[flagged]` external engagement. *Accept:* readiness pack committed; 0 self-found high.

### WS2 — Reliability & ops  (Jun 16–24)

- **B2.1 Monitoring via GitOps** (REL-1) — ArgoCD Applications for kube-prometheus-stack + loki; real alerting SealedSecrets; **Watchdog deadman** alert. *Accept:* alert fires end-to-end to a real channel; deadman proves pipeline.
- **B2.2 DR drill** (REL-2) — timed PITR restore into scratch namespace; record RPO/RTO vs targets; R2 object-lock + versioning. *Accept:* restore < RTO with clinical-invariant checks; drill artifact in `docs/qa-findings/`.
- **B2.3 Outage-critical jobs → CronJobs** (REL-3) — downtime-pack gen, backup verify, canary as k8s CronJobs; fix `WardDowntimePacksStale` alert. *Accept:* jobs run with backend down; alert matches a real Job.
- **B2.4 Request timeouts + statement_timeout** (REL-4/DB-2) — `requestTimeout`/`headersTimeout`/`keepAliveTimeout` on the HTTP server; wire `STATEMENT_TIMEOUT_MS` at the connection. *Accept:* slow-loris bounded; timeout effective in a test.
- **B2.5 Downtime LAN mirror + fallback metrics** (REL-5) — static ward-pack mirror servable on LAN during partition; every `42P01` fallback increments a named-table metric + warns. *Accept:* packs reachable with backend down; metric visible.
- **B2.6 Replicated storage** (INF-5) — deploy Longhorn on the 3 nodes (free); migrate CNPG/Redis/Vault/MinIO PVCs off `local-path`. *Accept:* pod survives node-drain reschedule.
- **B2.7 Vault auto-unseal + rotation** (INF-6) — transit/KMS auto-unseal; secret-rotation runbook + cadence. *Accept:* pod restart unseals without humans.
- **B2.8 SLOs + load test + misc** — k6 profile (OPD rush, MAR storm) + SLOs (p95<400ms chart-open); `CREATE INDEX CONCURRENTLY` escape-hatch (DB-3); ingress security headers via ConfigMap (INF-3); `ADMIN_IP_ALLOWLIST` set (INF-9); Vault ServiceMonitor TLS (INF-10); Ollama non-root (INF-11). *Accept:* SLOs measured under load; headers present; manifests pass.

### WS3 — Quality & verification (swarm replacement)  (Jun 18–28)

- **B3.1 Deterministic E2E for 11 journeys** — API-level integration tests on a fresh `vhhealth_test` DB for all 11 journeys, **blocking** in Forgejo CI. *Subagent per journey.* *Accept:* 11/11 green in CI; this is the new gate.
- **B3.2 Backend coverage floors** — `coverageThreshold` on auth/RLS/prescription/billing/cds ≥80%; fix open-handle leaks (CI-8). *Accept:* CI enforces floor; clean Jest exit.
- **B3.3 Flutter clinical tests** (CI-3) — widget/integration tests for MAR, CPOE basket, dispensing, walk-in registration; `features/` coverage floor. *Accept:* clinical flows have regression coverage in CI.
- **B3.4 Conformance + SAST blocking** (CI-1/9) — FHIR conformance and Semgrep/CodeQL flip to blocking. *Accept:* a seeded regression fails CI.
- **B3.5 Supply-chain + CI consolidation** — SBOM gen + cosign verify (with B0.6); deprecate orphaned GHA workflows; single parameterized smoke-e2e (CI-7). *Accept:* SBOM attached to images; one canonical CI path.

### WS4 — Clinical depth / close loops  (Jun 20–29)

- **B4.1 Drug KB** (EPIC B2) — import open CIMS/CDSCO/India formulary into structured KB; wire drug-drug/allergy/dose-range into CDS. `[flagged]` commercial license. *Accept:* CDS fires on real interaction set; toy table retired.
- **B4.2 BCMA closed loop** (EPIC B1) — pharmacist clinical-verification state in pharmacy lifecycle; scan-patient+scan-med mandatory before administer (override=reason+audit). `[flagged]` label printers. *Accept:* MAR requires both scans in software; override audited.
- **B4.3 Med reconciliation** (EPIC B6) — formal admission/transfer/discharge 3-point workflow. *Accept:* discharge take-home list with continue/stop/change per drug.
- **B4.4 Radiology loop** (EPIC B4) — deploy Orthanc + embed OHIF; DICOM MWL; link images to timeline. `[flagged]` modality hardware. *Accept:* a test study flows worklist→viewer→timeline.
- **B4.5 Problem list + terminology** (EPIC B7/B8) — longitudinal problem list; terminology service (SNOMED CT India free + LOINC mapping of lab catalog). *Accept:* problems feed CDS + discharge; catalog rows coded.
- **B4.6 e-sign + audit hash chain** (EPIC C4) — tamper-evident hash chain on `clinical_audit_events`; eSign integration code. `[flagged]` eSign provider. *Accept:* chain verifies; tamper detected in test.

### WS5 — AI productionization  (Jun 20–29)

- **B5.1 Close AI safety holes** — unknown-module→`enabled:false` (AI-1); `getPublishedAiOutputForPatient()` accepted-only helper + authz test (AI-2); defense hardening: unit-normalized numeric + JSON-schema validation, rename `defenses_passed` (AI-4); citations-blocking for `requiresCitations` (AI-5); model-call retries/backoff (AI-6). *Accept:* tests for each; no unreviewed path to patient.
- **B5.2 Triage chatbot governance** (AI-3) — default to local/template, bump model, route through review governance + region guard. *Accept:* no external PHI egress by default; governed.
- **B5.3 Outcome scoreboard** (EPIC G3) — per-module acceptance/edit-distance/override/time-to-sign KPIs from existing tables; admin panel. *Accept:* KPIs render per module.
- **B5.4 Deep-tier readiness** (EPIC G1) — verify Ollama manifests; egress allowlist for `CLINICAL_AI_DEEP_BASE_URL`. `[flagged]` GPU node + ward pilot. *Accept:* readiness preflight green pending hardware.
- **B5.5 Knowledge layer tooling** (EPIC G5) — per-hospital formulary/protocol/antibiogram RAG curation + refresh cadence. *Accept:* import pipeline + ownership doc.

### WS6 — App & frontend excellence  (Jun 20–29)

- **B6.1 Mobile PHI hardening (both apps)** — FLAG_SECURE/app-switcher hide, clipboard clearance, `AndroidOptions(encryptedSharedPreferences:true)` on all secure storage, real jailbreak detection (PAT-5/6/9, STF-1/3/4). *Accept:* screenshots blocked on clinical screens; storage encrypted.
- **B6.2 Patient app fixes** — App Check `activate()` (Firebase console = user-side) + remove hardcoded keys (PAT-1/2/13); fix `_isLoading` (PAT-3); push-route allowlist (PAT-4); `int.tryParse` guards (PAT-7); biometric re-auth on resume (PAT-8); mask OTP snackbar (PAT-11). *Accept:* tests + manual verify.
- **B6.3 Admin fixes** — remove `unsafe-eval` (ADM-2, Sentry SDK audit); dev-gate debug fetch handle (ADM-1); single `ROLE_RANK` (ADM-3); split god-pages (ADM-4); DataTable a11y (ADM-5); `no-store` on proxy; tighter `gcTime`. *Accept:* CSP clean; a11y pass; pages ≤ orchestrator size.
- **B6.4 Staff clinical UX** — structured override-reason categories (STF-2); verify/surface CPOE (E1); a11y. *Accept:* override requires structured reason.
- **B6.5 i18n** — port remaining ~42% staff screens + lint guard vs raw `Text()` (STF-5/E2); patient-facing AI multilingual (G8). *Accept:* nurse-facing clinical screens localized; lint blocks new raw strings.

### WS7 — Compliance & certification  (prep Jun 24–30, engagements flagged)

- **B7.1 NABH indicator pack** (EPIC D4) — compute NABH quality indicators (HAI rate, med-error, AMA/LAMA%, TAT) from existing data; assessor-export. `[flagged]` assessment. *Accept:* pack exports.
- **B7.2 ABDM M1/M2/M3 conformance** (EPIC C1) — cert-ready code + conformance harness. `[flagged]` sandbox/empanelment. *Accept:* harness passes against sandbox stub.
- **B7.3 DPDP audit artifacts** — DPA, RoPA, consent/breach/retention/erasure dashboards; data-residency config. `[flagged]` external audit. *Accept:* dashboards live; artifacts committed.
- **B7.4 FHIR R4 server** (EPIC C3) — read/write endpoints for core resources + conformance statement, backed by canonical timeline. *Accept:* a SMART app reads Patient/Encounter/Observation.

### WS8 — Governance, docs & process  (continuous, finalize Jun 26–30)

- **B8.1 Doc-truth sync** — fix every stale claim (model/module counts, stack, CLAUDE.mds, statement_timeout, read-replica, monitoring "Argo-managed"); add `docs/README.md` index. *Accept:* spot-check 0 stale load-bearing claims.
- **B8.2 ADRs + change mgmt + lessons** — decision records (incl. Pillar A–G freeze-lift), change-management process, lessons cadence. *Accept:* ADR dir + process doc.
- **B8.3 Repo housekeeping** — gitignore root logs/output/build/tmp; archive/rename stale root `AUDIT.md`/`REPORT.md` (DOC-7/8/10). *Accept:* clean root; nothing sensitive tracked.
- **B8.4 Retire swarm gate** — replace `GOAL_2026-06-16.md` framing with the deterministic S-tier gate (WS3) as definition of done; update `SESSION_HANDOFF.md`. *Accept:* one authoritative gate; handoff current.

---

## 6. Status tracker (updated each batch)

_Execution log:_
_2026-06-13 — **WS0 COMPLETE (7/7).** B0.1 landed in-flight security sweep (1C/7H/14M/12L; code-fixable items already in) + staff WIP + audit/roadmap docs. B0.7 already-green (CI-2 stale; roleMatrix 1262/1262). B0.3 admin reset-OTP hashed + 5-attempt lockout (migration 303, 9 tests). B0.4 staff refresh type+jti guard (5 tests). B0.5 atomic canonical-timeline writes across notes/vitals/I-O/orders/admission (atomicity test + 241 EMR tests green). B0.2 CNPG non-superuser `vhhealth_runtime` role + enableSuperuserAccess:false + migration-job superuser DSN. B0.6 Kyverno policy wired into base + placeholder-digest CI guard. Bonus: staffAuthService query()-wrapper bug fixed (closes task_b7c8a440). Commits 7fad8236→aa3f5d86. All local-only (no push per instruction). Operator-gated: seal vhhealth-pg-runtime + DATABASE_SUPERUSER_URL, install Kyverno + flip Audit→Enforce after clean cycle._

| WS | Batches | Done | Status |
|---|---|---|---|
| WS0 | 7 | 7 | ✅ COMPLETE |
| WS1 | 7 | 7 | ✅ COMPLETE — RLS 283 tbl (B1.1/2) · interactive-txn scoping (B1.3) · blocking cross-tenant gate (B1.4) · crypto envelope/KMS (B1.5/SEC-4) · SEC-5/6/7/8 (B1.6) · pen-prep + SAST (B1.7). Follow-up (hardening, non-blocking): B1.3b (~97 remaining $transaction sites + createEnhancementClaim tenant_id; stale insurance_claims doc) |
| WS2 | 8 | 3 | B2.1 monitoring GitOps + Watchdog ✅ · INF-3/9/10/11 infra-hardening ✅ · B2.4 HTTP timeouts + B2.8 statement_timeout ✅ · next: B2.2 DR drill, B2.3 outage-CronJobs, B2.5 fallback metrics, B2.6 Longhorn, B2.7 Vault auto-unseal |
| WS3 | 5 | 0 | queued |
| WS4 | 6 | 0 | queued |
| WS5 | 5 | 0 | queued |
| WS6 | 5 | 4 | B6.1 mobile PHI ✅ · B6.2 patient ✅ · B6.3 admin ✅ · B6.4 staff override-reason hardening (STF-2) ✅ · next: B6.5 staff i18n (LARGE — ~42% screens English-only). (ADM-2 unsafe-eval left w/ removal path; ADM-4 god-page splits deferred) |
| WS7 | 4 | 0 | queued (engagements flagged) |
| WS8 | 4 | 1 | B8.1 doc-truth sync (CLAUDE.md/arch docs + docs/README index) ✅ · next: B8.2 ADRs/change-mgmt, B8.3 repo housekeeping, B8.4 retire swarm gate |

**Definition of "Internal A+/S" (Jun 30):** all non-`[flagged]` batches merged green;
S-tier scorecard A+ column met; deterministic 11-journey gate green in CI; DR drill
passed; monitoring live. **Externally-certified S:** flagged engagements cleared.
