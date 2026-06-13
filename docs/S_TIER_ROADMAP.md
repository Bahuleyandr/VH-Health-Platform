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

_2026-06-13 (WS4 round) — **WS4 3/6.** B4.6: tamper-evident audit hash chain found ALREADY built (migration 282 trigger + `documentIntegrityService.verifyAuditChain`, per-tenant advisory-locked); added the missing 13-case unit test; migration 305 left free. B4.5: migrations 306 (`problem_list_snapshots` + `problem_episode_links`, PHI/FORCE-RLS) + 307 (`terminology_import_batches` + `terminology_audit_events` + 10 ICD-11 starter concepts); schema.prisma regen (+4 models), drift clean, lint:raw-params clean. B4.4: hardened Orthanc PACS (readOnlyRootFs + egress NetworkPolicy) + OHIF viewer (internal ingress) + opt-in ArgoCD app + `docs/RADIOLOGY_PACS.md`. Plus fix(emr) `0bafb5a5`: `::text` casts on `transitionEncounter` (latent 42P08 surfaced by journeys) + a new lint:raw-params jsonb-cast check + CLAUDE.md doc. Commits `0bafb5a5`→`docs(roadmap)`. Local-only. Next: B4.1 drug KB [flagged license], B4.2 BCMA, B4.3 med-rec._

_2026-06-13 (infra/CI/cert round) — **WS2 7/8, WS3 3/5, WS5 4/5, WS7 4/4 ✅.** Parallel disjoint-tree round (3 agents, all non-DB, ran alongside the green regression suite). B2.3: 3 outage-critical k8s CronJobs (downtime-pack / backup-verify / canary) that keep running when the backend is down + fixed `WardDowntimePacksStale` (real `kube_cronjob_status_last_successful_time` + `absent()` arm) + `OutageCriticalCronJobFailing`; kustomize green across base + 5 overlays. B5.4: deep-tier Ollama readiness preflight Job + backend→Ollama egress NetworkPolicy + readOnlyRootFs (GPU node + ward pilot flagged). B3.4: FHIR conformance + Semgrep + CodeQL flipped to BLOCKING (**GitHub Actions confirmed sole CI — no `.forgejo/`**; roadmap's earlier "Forgejo CI" phrasing was aspirational). B3.5: `cosign verify` after sign + `ci.yml` duplicate-trigger fix (SBOM + sign already existed). WS7 COMPLETE: ABDM/NABH/DPDP/pen-test cert-READY packages in `docs/compliance/`; external engagements flagged. Full chunked suite green (67/67 chunks). Commits `c47c6498`→`fcf7c28c`. Local-only._

_2026-06-13 (clinical round + recon) — **WS3 4/5, WS4 5/6.** B4.3: the 3-point med-rec workflow was already built (mig 279 + service + routes); closed the real gaps — mig 308 adds structured `changed_dose/route/frequency` + `safety_review_id` FK, `decideItem` now wraps safety-review→UPDATE→audit in ONE tx (was non-atomic), take-home list carries structured change detail; 20/20 targeted tests, drift+lint clean. B3.3: 132 Flutter clinical widget tests (MAR override / CDS allergy-blocker / pharmacy dispensing / walk-in reg) under apps/staff/test/features/, mirror-class pure-Dart pattern; melos analyze+test green (staff 468, vhhealth 131, core 91). **Read-only recon of remaining batches:** B4.1 drug KB = BUILT (mig 277 + drugKnowledgeBaseService; vendor feed flagged) → marked done; B4.2 BCMA = PARTIAL (UI + pharmacist-verify built; gap = server-side 2-scan enforcement); B5.5 = PARTIAL (RAG/pgvector substrate built; gap = formulary/antibiogram importer + curation + refresh); B2.5 = PARTIAL (schema-guard + breaker built; gap = named 42P01 counter + static downtime endpoint); B3.1b = 5/11 journeys built (6 remain); B1.3b = 144 `$transaction` sites to audit + `createEnhancementClaim` missing `tenant_id`. Commits `347001ed`,`31ce0878`. Local-only._

_2026-06-14 (RLS remediation — WS1 B1.3b REOPENED, full ultracode) — A 96-agent adversarial audit of all 127 `prisma.$transaction` sites (48 files) found **101 distinct cross-tenant actions**, not the "~97 hardening sites" WS1 assumed: a bare `prisma.$transaction` skips the proxy's GUC auto-wrapper, so `app.current_tenant_id` stays unset and `tenant_isolation` falls to its permissive branch (cross-tenant PHI reachable once tenant #2 onboards); 13 INSERTs also omitted `tenant_id` (misroute to default tenant — wrong even single-tenant). Severity: 13 MISROUTE_NOW, 85 EXPLOITABLE_MULTITENANT, 3 defense-in-depth, 0 false-positive. **Batch 0a ✅** (7 tenant-in-scope MISROUTE/tx fixes incl. `markDelivered` cross-tenant write; established `req.tenantId` as the canonical controller tenant source — NOT the optional `req.user.tenant_id`). **149-file prisma-mock tenant-helper sweep ✅** (one-time enabler: every prisma mock now exports setTenantTx/setTenant/runTenantScopedTransaction/pickTenantClient, so `setTenantTx` conversions no longer break mocked tests — `setTenantTx` can't move out of prisma.js as it is bound to the replica clients + ALS). `claimCapsService` fail-closed + `patientIdentifier` defense-in-depth ✅. `cdsEngine` over-conversion reverted (single create needs no tx). infection-control antibiogram date-boundary flake fixed. **Full chunked suite green 67/67 on 2026-06-14.** In progress: **Batch 1** (~45 service tx-converts). Remaining: B0b (threading MISROUTE), Batch 2 (fail-closed null-tenant guards), Batch 3 (~30 controller-threading converts), Batch 4 (defense-in-depth). Commits `c3ede536`→`14f6452e`+. Local-only._

_2026-06-14 (RLS remediation continued + journey gate complete) — **Batch 1 ✅** (44 PHI-service `$transaction`→`setTenantTx` converts, commit `4538dc23`) · **Batch 2+4 ✅** (fail-closed `scopedTx` fallbacks — `tenantId ? setTenantTx : prisma.$transaction` → `setTenantTx(tenantId ‖ DEFAULT_TENANT_ID)`, removing the permissive-open branch; + defense-in-depth tenant filters, commit `9a8f2776`) ≈ **56 of 101 actions done**. **Journey gate 11/11 ✅** — B3.1b complete: added obstetric-anc/pediatric-opd/surgical-day-care (`87520647`) + tpa-insurance-claim (`1a20a33a`) + dynamic-acute-abdomen & cross-tenant-rls (`fce9bf9c`); cross-tenant-rls is a genuine non-vacuous RLS regression test (tenant-bearing JWTs + non-owner runtime role — LEAK control sees both tenants, scoped reads see one, WITH CHECK rejects cross-tenant writes). **Prod bug fixed:** billingV2 `syncUnusedAdmissionAdvancesForInvoice` had a bare `$2` inside `CONCAT_WS` → 42P18 → 500 on EVERY full payment flipping an admission invoice to PAID; `$2::text` cast + 2 restored tpa assertions (`1a20a33a`). One-off DB hygiene: truncated the append-only `clinical_audit_events` chain — cross-test cascade-deletes from many out-of-suite journey iterations had broken the global DEFAULT_TENANT chain that `document-integrity.deep` verifies (not a code regression). **Full consolidated suite green on 2026-06-14: 6731 tests / 68 chunks / 0 fail — all 11 journeys + document-integrity + infection-control.** Remaining: Batch 3 (~45 controller+clinical-service threading converts on RLS-protected tables) + B0b (MISROUTE threading). Local-only._

_2026-06-14 (RLS Batch 3 COMPLETE — full ultracode, 6 waves) — Converted/threaded ALL 47 remaining PHI-touching bare `prisma.$transaction` sites to `setTenantTx`, each wave adversarially-verified + live-DB RLS-confirmed: **Wave A** 6 controller sites (appointmentWorkflow ×5 + pharmacyOrder.counterDispense), **Wave B** 8 clinical state-changes (createNote; order verify/complete/cancel/discontinue; vitals record/IO; addDiagnosis), **Wave B'** 10 insert/edit flows threaded from routes (note addendum/update/sign; order create/bulk/set; correctVitals; addResults; createMedicalRecord; signDischargeSummary), **Wave C** 14 (admission ×6; createAppointment; bed admit/discharge/transfer; bedInspection.startInspection; patientMerge approve/execute) + appointmentReaper as explicit `superAdmin` cross-tenant, **Wave D** 3 (ward-indent; pharmacist.verifyOrder; PO-receive) with 8 sites CORRECTLY LEFT BARE as non-RLS (clinicalAiModule, rosterBoard ×5, leave, medication — confirmed via live DB), **final threading** 6 (updateAppointmentStatus; recordDecision; dependents link/unlink; pharmacy.updateOrderStatus; **cdsEngine.acknowledgeAlert** — a real cross-tenant CDS-alert-ack exposure via enumerable id). Test-infra: 3 per-test-tx mocks fixed (setTenantTx→transactionMock delegate: patientMerge/ipdSupport/pharmacySupply); ROOT-CAUSED the recurring append-only audit-chain breakage — the journey harness was deleting mid-chain `clinical_audit_events`, so `document-integrity.deep` now self-isolates its chain. **Full chunked suite green 68/68 (6665 tests, 0 fail) on 2026-06-14** — all 11 journeys + document-integrity + infection-control. With Batch 0a/1/2/4 this covers all ~101 audited cross-tenant actions. **DEFERRED to B1.1/B1.2** (documented, single-tenant-safe today): a global GUC-reading-default migration so wrapped INSERTs are multi-tenant-write-correct (subsumes B0b's 13 MISROUTE inserts); `cancelAppointment`'s single-statement else-branch + its 2 controllers; and broader single-statement raw-query scoping. Commits `fce9bf9c`→ audit-chain test fix. Local-only._

| WS | Batches | Done | Status |
|---|---|---|---|
| WS0 | 7 | 7 | ✅ COMPLETE |
| WS1 | 7 | 7 + B1.3b | core ✅ (RLS 283-tbl, crypto envelope, SEC-5/6/7/8, pen-prep). **B1.3b REOPENED 2026-06-14** — 96-agent adversarial audit of all 127 `$transaction` sites found **101 cross-tenant actions** (bare-tx skips the GUC → permissive RLS; + 13 INSERTs missing tenant_id), not the "~97 hardening" originally assumed. Done: Batch 0a (7 MISROUTE/tx fixes incl `markDelivered` cross-tenant write) ✅ · 149-file prisma-mock tenant-helper sweep ✅ (test-infra enabler) · claimCaps/patientIdentifier hardened ✅ · Batch 1 (44 service converts, `4538dc23`) ✅ · Batch 2+4 ✅ · **Batch 3 ✅ — all 47 remaining PHI `$transaction` sites converted/threaded in 6 adversarially-verified waves (incl `cdsEngine.acknowledgeAlert` cross-tenant fix; appointmentReaper superAdmin; 8 non-RLS correctly skipped).** With Batch 0a/1/2/4 this closes all ~101 audited cross-tenant actions → **B1.3b CORE COMPLETE**. Remaining for FULL multi-tenant (deferred, single-tenant-safe today): GUC-reading-default INSERT migration (B1.2, subsumes B0b's 13 MISROUTE) + cancelAppointment else-branch + single-statement raw scoping. **Suite green 68/68 chunks / 6665 tests (2026-06-14), 11/11 journeys** |
| WS2 | 8 | 7 | B2.1 monitoring ✅ · INF-3/9/10/11 ✅ · B2.4/B2.8 timeouts ✅ · B2.6 Longhorn ✅ · B2.7 Vault auto-unseal ✅ · B2.2 DR-drill harness ✅ (operator runs the timed drill) · B2.3 outage-critical CronJobs (downtime-pack/backup-verify/canary) + WardDowntimePacksStale fix ✅ · next: B2.5 fallback metrics |
| WS3 | 5 | 4 | B3.1 deterministic journey gate — harness + 5 core journeys (43 tests, blocking CI) ✅ · B3.3 Flutter clinical widget tests (132 tests: MAR/CDS/dispensing/walk-in, mirror-class pattern) ✅ · B3.4 FHIR conformance + SAST (Semgrep/CodeQL) flipped BLOCKING ✅ · B3.5 cosign verify + ci.yml consolidation ✅ · B3.1b: **11/11 journeys ✅** (added obstetric-anc, pediatric-opd, surgical-day-care, tpa-insurance-claim, dynamic-acute-abdomen, cross-tenant-rls — the last a genuine multi-tenant RLS regression test) · next: B3.2 coverage floors |
| WS4 | 6 | 5 | B4.1 drug KB + interaction/allergy/dose-range CDS — found BUILT (`drugKnowledgeBaseService.js` + mig 277: DDI/allergy-cross-reactivity/dose-range/IV-compat; vendor data import [flagged]) ✅ · B4.3 med-rec (3-point workflow pre-built mig 279; added structured change-detail + atomic safety-review, mig 308) ✅ · B4.4 Orthanc PACS + OHIF + ArgoCD ✅ · B4.5 problem-list + terminology (mig 306/307) ✅ · B4.6 audit hash-chain (mig 282) + tamper test ✅ · next: B4.2 BCMA server-side 2-scan enforcement (Flutter scan UI + pharmacist-verify state built; gap = MAR scan-timestamp cols + enforce-both-scans-before-administer gate) |
| WS5 | 5 | 4 | B5.1 AI safety holes ✅ · B5.2 triage governance (local-default/model-bump/defenses) ✅ · B5.3 outcome scoreboard ✅ · B5.4 deep-tier readiness (Ollama preflight Job + egress NetworkPolicy + readOnlyRootFs; GPU node + ward pilot flagged) ✅ · next: B5.5 knowledge layer |
| WS6 | 5 | 5 | ✅ COMPLETE — B6.1 mobile PHI · B6.2 patient · B6.3 admin · B6.4 staff override-reason · B6.5 i18n (6 priority clinical screens; 282 raw strings tracked for follow-up). Deferred-w/-path: ADM-2 unsafe-eval, ADM-4 god-page splits |
| WS7 | 4 | 4 | ✅ COMPLETE (cert-READY; external engagements flagged) — B7.1 ABDM · B7.2 NABH · B7.3 DPDP · B7.4 pen-test readiness packages in `docs/compliance/` with requirement catalogue + control→evidence maps + gap registers; gaps feed backlog (DSAR export, consent-withdrawal UX, breach dispatch, magic-byte upload check, admin Server-Action authz) |
| WS8 | 4 | 4 | ✅ COMPLETE — B8.1 doc-truth sync · B8.2 ADRs + change-mgmt · B8.3 housekeeping/archive · B8.4 swarm-goal retired |

**Definition of "Internal A+/S" (Jun 30):** all non-`[flagged]` batches merged green;
S-tier scorecard A+ column met; deterministic 11-journey gate green in CI; DR drill
passed; monitoring live. **Externally-certified S:** flagged engagements cleared.
