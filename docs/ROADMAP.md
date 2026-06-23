# VH Health Platform — Consolidated Roadmap

**Single source of truth for pending work. Last reconciled: 2026-06-22.**

This file consolidates every open item from the planning docs that previously
lived scattered across `docs/` (EPIC roadmap, S-tier roadmap, AI feature-gap
backlog, the 2026-06-16 goal, the clinical-AI rollout/enablement plans, the
remediation plans/work-order, the execution log, and the tenant-RLS gap
analysis). Those source docs are now in [`archive/`](archive/) — see
[§8](#8-archived-source-docs).

**Code/CI state:** `main` @ `502fc033`; GitHub CI (Backend + Smoke E2E +
Canonical) green; the S-tier program (WS0–WS8) and the full multi-tenancy
program are **code-complete**. **[§0](#0--engineering-remediation-backlog-2026-06-22-codebase-audit) is the front of queue** — the 2026-06-22 full-codebase audit found real engineering work (13 adversarially-confirmed High findings) that ranks **ahead** of the operator/external gates in §1–§8 (which remain the go-live-execution + external/procurement tail). Step-by-step execution runbooks remain **live at `docs/`** (linked inline).

## Legend

| Tag | Meaning |
| --- | --- |
| `[OPERATOR]` | A human runs it against the live cluster/providers — the code/config is ready. |
| `[EXTERNAL]` | Third-party / government engagement (certification, pen test, audit). |
| `[PROCUREMENT]` | Hardware or commercial-license purchase. |
| `[CODE]` | Genuinely-unwritten code. Deferred-by-design / customer-pull unless flagged otherwise. |

---

## 0 — Engineering remediation backlog (2026-06-22 codebase audit) `[CODE]`

Front of queue. Evidence + per-finding fixes: **[`CODEBASE_ANALYSIS_2026-06-22.md`](CODEBASE_ANALYSIS_2026-06-22.md)** (13 confirmed High / ~60 Medium / ~30 Low / ~85 upgrade opportunities — multi-agent deep read, every High adversarially verified). Being executed here as a **TDD sweep** (branch → failing deep test → fix → local gate → CI → merge), highest-risk first. Tick boxes as workstreams merge.

### Tier 0 — go-live blockers (the 13 Highs, bundled "fix-once-helps-many")

**✅ ALL 8 workstreams / 13 Highs DONE** (TDD, branch `fix/audit-t0-backend`, 2026-06-22). Each item below carries its merge SHA + any sub-item explicitly carried to T1/T2.

- [x] **WS-A — NEWS2 / deterioration end-to-end** `2ed348da` — **W1-H4** escalateNews2 now routes through the results-inbox producer (assigned, ack-tracked, DUTY-role fallback, loud on no-task) + **W2-H2** staff vitals screen renders a colour-coded NEWS2 banner (≥threshold) with an escalation-response affordance.
- [x] **WS-B — Wrong-patient hard-stop** `958baa3a` — **W2-H1** a patient/drug-right mismatch on `administer-with-scan` is now a non-overridable 409 hard-stop (`MAR_PATIENT_MISMATCH`/`MAR_DRUG_MISMATCH`) server-side + a red re-scan-only panel client-side. _Carried → T1:_ the shared positive-ID read-back header / manual-vitals `patient_id`.
- [x] **WS-C — Money: lock + idempotency** `81d04305` — **W1-H2** V1 `recordPayment` now reads+checks+writes under `FOR UPDATE` + mig-340 unique `(tenant_id, transaction_ref)` → 409 on replay; **W1-H3** PMJAY `claim_paid` is one locked tx with a paid≤approved guard + idempotent floater bump. _Carried → T1:_ cashDrawer cross-session (M5), idempotency-keys sweep cron (M11), retire V1 onto billingV2.
- [x] **WS-D — Cross-tenant + step-up** `0e4300d7` — **W1-H6** denial-risk AI now tenant-scopes the `insurance_claims` read; **W1-H1** `requireSuperAdminStepUp` on every admin-management route; **W3-H2** `TENANT_BASE_HOST` set in prod configmap + fail-closed in `validateEnv`. _Carried → T1:_ device/session `tenant_id`, edge XFF allowlist.
- [x] **WS-E — Interop injection** `44437a0d` — **W1-H7** `encodeHL7Field` (inverse of `decodeHL7Escapes`, CR/LF→hex) applied to every interpolated outbound HL7 text field. _Carried → T1:_ SSRF DNS-rebind `resilientFetch` (M17).
- [x] **WS-F — Migration scale-safety** `1511567d` — **W1-H5** per-file `@no-transaction` / `@statement_timeout` escape hatch in the runner (CONCURRENTLY + uncapped heavy DDL). _Carried → T1/T2:_ rewrite the applied tenant-backfill migs into chunked `NOT VALID`→`VALIDATE` + go-live build-time docs.
- [x] **WS-G — Governance flags** `a7b6c76f` — M13 patient-chatbot enable-gate (`startConversation`/`sendMessage` → 403 when module disabled) + M14 immutable safety-classification keys (`surface`/`risk`/…) stripped from tenant overrides. _Carried → T2:_ make `decisionSupportOnly`/`patientFacing` load-bearing (M15, `[S]`); _→ T1:_ chat prompt-injection fence (M16).
- [x] **WS-H — Deploy/DR/observability (infra)** `ee500a7f` — **W3-H1** removed the 4 rejected ingress `configuration-snippet`s (headers are controller/Helmet-owned); **W3-H3** CNPG nightly backup namespace → `vhhealth-platform`; **W3-H4** `/metrics` accepts the monitoring token via `Authorization: Bearer` + ServiceMonitor `authorization` block (operator step: provision the `vhhealth-monitoring-token` Secret in the prometheus namespace). kustomize-build validated.

### Tier 1 — hardening (the ~60 Mediums + ~30 Lows)

**Backend-medium progress (TDD, merged to main, full `postgres` gate each):**
- ✅ **M1** OTP attempt-counter atomic + **M2** timing-safe legacy compare · **M9** wire canary cron + **M11** wire idempotency-sweep cron · **M18** deviceController 500 + **M19** terminal JSON 404 — batch 1 (`main 73b9a2a0`).
- ✅ **M4** lock tpa_claims decision+settlement FOR UPDATE · **M3** cap login-2FA-challenge attempts (mig 341) · + de-flaked the hl7-ssrf-guard gate flake — batch 2 (`main 1563bc17`).
- ✅ **M6** order-state TOCTOU (atomic `updateMany`-guarded transitions in orderEntryService) · **M7** med-rec administered-dose in MAR snapshot — batch 3 (`main 397c41a3`).
- ✅ **M16** patient-chat prompt-injection fence (`fencePatientQuestion`/`looksLikePromptInjection`) · **M10** webhook `in_flight` stale-reaper + cron — batch 4 (`main 1d8093a1`).
- ✅ **M8** explicit `tenant_id` on `user_active_sessions` + `devices` (FORCE-RLS default-tenant fallback) — batch 5 (`main 2190b23f`).
- ✅ **M13/M14** (patient-chatbot enable-gate + immutable module classification) shipped in T0 WS-G.
- ✅ **Surgical backend Mediums COMPLETE** (M1–M4, M6–M11, M13, M14, M16, M18, M19 — 16 shipped, each TDD'd + full `postgres` gate + merged both remotes).
- ⏳ **Remaining backend = refactors/epics (own design passes):** **M5** cash `billing_payments.cash_drawer_session_id` stamping (deferred for its exact fix), **M12** process-global breaker → per-tenant/observable, **M17** SSRF one shared `resilientFetch`, **M20** admin god-router split, **M15** make `decisionSupportOnly`/`patientFacing` load-bearing `[S→T2]`.
- ⏳ **Wave-2/3 frontend + infra Mediums** (below) not yet started.

Per-finding detail in the analysis doc's Medium/Low tables. Clusters: **auth** (OTP attempt-counter TOCTOU + timing-`===`, 2FA-challenge counter, fail-open revoke-all) · **reliability** (webhook `in_flight` reaper, idempotency-keys sweep, revive the orphaned canary, breaker scoping, dead-letter/Redis/outbox alerts) · **data/RLS** (registerDevice tenant_id, an `ON CONFLICT`-vs-unique-index CI guard) · **clinical** (order-state TOCTOU, med-rec administered-dose, critical-vital routing) · **AI-gov** (prompt-injection on the chat input, RAG `flag`-verdict re-check) · **interop/crypto** (X25519 low-order reject, per-tenant ABDM token cache) · **api** (terminal 404 handler, deviceController helper misuse, admin god-router extraction) · **frontend** (CSP `unsafe-eval`, off-host PHI download scheme check, a11y/Semantics + i18n review-gate, offline queue for clinical writes, typed DTOs, single-WS, white-label theming) · **infra** (scope ingress secret read + east-west NetworkPolicies, PgBouncer pool sizing, SBOM attest + verify-before-pin + base-image digests, Loki 180d, Ollama PDB, monitoring auto-sync).

### Tier 2 — S-tier upgrade epics (the ~85 opportunities → ~12 programs; each gets a brainstorm→design→plan cycle first)
1. **Double-entry money ledger** (DB-enforced invariants, integer paise) · 2. **Terminology spine** (RxNorm/SNOMED + licensed DDI engine) · 3. **Typed event/outbox bus** · 4. **Real-time-first dashboards** (the WS fabric exists, used in 1 tile) · 5. **Single OpenAPI → Dart + admin-TS contract pipeline, CI drift-gated** · 6. **Governed AI-integration program** (agentic workflows, copilot surfaces, output-injection detector, drift→auto-rollback, terminology auto-coding) · 7. **White-label theming** (all 3 clients) · 8. **Observability / SLOs** (Prometheus exposition + the missing alert tier + 180-day retention via object-store Loki+Thanos) · 9. **Offline-first clinical capture** · 10. **Accessibility program** · 11. **Supply-chain → SLSA-L3** (cosign attest SBOM, verify-before-pin, digest-pin everything, Kyverno hardening Enforce) · 12. **Least-privilege network/RBAC + Cloudflare Access** (Zero-Trust admin, Cilium L7, per-tenant NetworkPolicy, edge-as-Terraform).

---

## 1. Go-live activation `[OPERATOR]` — blocks first real-PHI deployment

Owned by the live checklist: **[`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md)** (45 unchecked boxes — tick with date/initials as completed).

- **Seal the least-privilege DB role.** Seal `vhhealth-pg-runtime` to a `NOSUPERUSER`/`NOBYPASSRLS` role, re-seal the backend `DATABASE_URL` to it, then flip RLS enforcement live and confirm `GET /health/metrics` returns `tenant_rls.ok=true`. (Code + guard shipped — `logTenantRlsRolePosture()`; this is the runtime verification, GO-LIVE Phase B/E.)
- **Migration Job (Phase D2).** Confirm the PreSync migration Job applies `309`/`310`/`311` under the superuser URL and reports `Complete`, not `Error`.
- **Supply-chain enforce.** Install Kyverno, create the cosign public-key Secret, flip the `verifyImages` policy **Audit → Enforce** after a clean cycle.
- **DR drill.** Run the timed PITR restore drill, record RPO/RTO (`DR_RESTORE_DRILL.md`).
- **Monitoring activation.** Bring the alerting stack up end-to-end with a deadman proof; add per-route-family RED dashboards + on-call rota.
- **Backups.** Verify the first AES256-encrypted R2 backup succeeds; add off-site WAL archiving / PITR.
- **Downtime.** Provision the shared LAN downtime-mirror volume (`DOWNTIME_PROCEDURE.md`).

## 2. Secret rotation & supply chain `[OPERATOR]`

Owned by the live checklist: **[`SECURITY_HARDENING_CHECKLIST.md`](SECURITY_HARDENING_CHECKLIST.md)** (Roadmap A7 + A8). Code enforces presence (`validateEnv.js` crashes on missing secrets); rotation is operator-side.

- Rotate every provider secret on the live cluster: `JWT_SECRET`, API keys (+ per-client), DB passwords (`vhhealth`/`vhhealth_readonly`/`qa_writer`), Cloudflare R2, Firebase SA / Twilio / SMTP / Sentry, and the signed-integration secrets (`HL7_INBOUND_SHARED_SECRET`, `ABDM_CALLBACK_SECRET`).
- Run `npm run security:audit-secret-encryption` and rotate/backfill every reported legacy secret-bearing DB row.
- Purge local secret-bearing artifacts (`.env` backups, logs, `pg.log`) + run the `gitleaks` range scan on the operator machine.
- Re-enter Forgejo Actions secrets after rotation; set the 180/365-day rotation calendar + a monthly dependency-PR triage slot.

## 3. External engagements `[EXTERNAL]`

- **ABDM certification.** Obtain NHA sandbox creds (`ABDM_CLIENT_ID/SECRET`, callback secret), register the bridge, run M1/M2/M3 with NHA observers, mark the `india_compliance_evidence` rows verified. Substrate (FIDELIUS-equivalent crypto, callback HMAC/replay guard, gateway) is built. → **[`ABDM_READINESS.md`](ABDM_READINESS.md)**.
- **Penetration test.** Schedule + run the engagement; the RoE + STRIDE + probe-list pack is ready. → **[`PENTEST_READINESS.md`](PENTEST_READINESS.md)**.
- **NABH / DPDP / CERT-In.** NABH assessment; DPDP data-inventory + DSR dry-run + counsel sign-off; CERT-In registered POC + incident tabletop (≤6h). → **[`india-deployment-readiness.md`](india-deployment-readiness.md)**.
  - ⚠️ **One concrete platform gap (not paperwork):** CERT-In requires **180-day** Indian-jurisdiction log retention; current Loki retention is ~30 days. Needs an archive/SIEM layer or increased primary retention before go-live.

## 4. Procurement `[PROCUREMENT]`

- GPU node + `nvidia-device-plugin` for the deep-tier (local-Ollama) AI path (gates §5 G1).
- Commercial drug-knowledge-base license (Medi-Span / FDB) for production interaction checking.
- Barcode/label printers + lab-analyzer (ASTM/HL7) driver bring-up on real hardware.
- eSign / DSC provider contract (gates the discharge/MCCD/consent signing stack in §6).

## 5. Clinical-AI productionization

The 99-module governed AI substrate is built but **every module still ships `enabled=false`** (decision-support-only, zero production clinical use). Turning it on is sequenced — see archived [`CLINICAL_AI_ROLLOUT_PLAN.md`](archive/CLINICAL_AI_ROLLOUT_PLAN.md) and the live enablement mechanics in archived [`CLINICAL_AI_ENABLEMENT_PLAN.md`](archive/CLINICAL_AI_ENABLEMENT_PLAN.md) (toggle via `clinical_ai_tenant_modules`, **not** the seed flag).

- **G1 — Deep tier on real GPU** `[PROCUREMENT]` (see §4). Manifests + `CLINICAL_AI_DEEP_*` wiring done.
- **G2 — Stage-1 ward pilot** `[OPERATOR]`. Run the med-rec + aftercare pilot with a real doctor for a week, capture the signed evidence pack. Preflight + evidence tooling shipped (PR #330 runs it strict in CI). → `PER_TENANT_ROLLOUT_PLAYBOOK.md`.
- **G3 — Outcome scoreboard** ✅ **shipped** (`54084db6`, `/dashboard/clinical-ai/scoreboard`). Pending: feed it real pilot data; wire data-driven enable/disable.
- **G4 / G6 / G7 / G8** — loop-pair modules with closed loops; OPD ambient/voice pilot; put eval/drift/bias on a scheduled cadence with alerting; gate patient-facing multilingual AI behind G2/G3.
- **AI feature backlog** `[CODE, deferred-by-design]` — ~21 single-module wrappers unbuilt + ~10 partials (second-opinion, personalized-care-plan, lab-order-suggestion, ECG/echo explainers, prescription-instruction, pharmacy-substitute, formulary-optimization, duplicate-document, research/publication assistants, personal-health-twin, continuous-monitoring, ICU-predictive, symptom→specialty router, Beers geriatric warning, WhatsApp bot, RPM agent, FHIR-mapping assistant, uncertainty-checker). Sequenced by customer pull. Full list in archived [`AI_FEATURE_GAP_BACKLOG.md`](archive/AI_FEATURE_GAP_BACKLOG.md).

## 6. Deferred-by-design code gaps `[CODE]`

Not blockers for the core platform; build as customer demand surfaces.

- **FHIR R4 write endpoints** — only read/export today; no `POST`/`PUT` for Patient/Observation/Encounter/MedicationRequest (+ conformance statement).
- **Live HL7v2 interface engine** — parser/generator + interop replay store exist; standing up a Mirth-class surface emitting ADT/ORM/ORU to the hospital's existing systems is integration work.
- **Provider credentialing & privileging module** — white-space (registration numbers, privilege/expiry alerts).
- **NABH quality-indicator pack exporter** — indicators exist piecemeal; no consolidated exporter.
- **eSign/DSC signing stack** on discharge summaries / MCCD / consent (the tamper-evident hash chain on `clinical_audit_events` is done — mig 324; signing needs the §4 provider).
- **Minor security hardening** — M-5: drop `text/plain`/`text/csv`/`text/rtf` from the upload allowlist (`uploadConfig.js:17`, HTML-as-text XSS gap); ADM-2: remove `unsafe-eval` from the admin CSP (`apps/admin/src/middleware.ts:201`, pending Sentry/workbox eval removal).
- **Staff-app accessibility execution** — run `SCREEN_READER_TEST_PLAN` + add staff font-scaling.
- **Depth (partial, demand-driven)** — scheduling optimization (provider templates / waitlist auto-fill / resource booking / overbook), patient-portal result-release-hold rules + longitudinal lab trends + dependent proxy consent, outbreak/infection-control workbench end-to-end, RDC-lite research CRFs, dental/ophthalmology/dialysis depth.

## 7. Recently shipped (reference — **not** pending)

So this roadmap isn't misread: the following landed and are verified in-repo (full provenance in archived [`ROADMAP_EXECUTION_LOG.md`](archive/ROADMAP_EXECUTION_LOG.md)). Several were listed as "missing" in the old EPIC roadmap.

- S-tier WS0–WS8 + full multi-tenancy (per-tenant RLS, edge routing, admin portal, Flutter) — code-complete.
- E1 staff CPOE order composer (`0a2341cc`); E2 staff i18n + Malayalam partial (`6d6c6a1f`).
- F1/F2 analytics warehouse + dbt marts (`9eb448d8`, `dbt build 52/52`) — see `ANALYTICS_WAREHOUSE.md`.
- G3 per-module AI outcome scoreboard (`54084db6`).
- BCMA closed-loop, lab ASTM/analyzer interfaces, PACS (Orthanc)+OHIF+DICOM-MWL manifests, transfusion safety, oncology/chemo, problem list, terminology service, real drug-KB engine, formal med-rec, downtime packs, k6 load profiles, canonical doctor resolver.
- The 2026-06-16 "11 deterministic journeys green" goal (now in-CI under `apps/backend/src/tests/journeys/`).
- 2026-06-13 + 2026-06-18 platform-audit remediations; 2026-06-10 security work order (P0–P3 code complete).

## 8. Archived source docs

The detailed planning docs this consolidates are in **[`archive/`](archive/)** (kept for provenance; not the source of truth for current work — use this file):

`EPIC_LEVEL_ROADMAP.md` · `S_TIER_ROADMAP.md` · `AI_FEATURE_GAP_BACKLOG.md` ·
`GOAL_2026-06-16.md` · `CLINICAL_AI_ROLLOUT_PLAN.md` ·
`CLINICAL_AI_ENABLEMENT_PLAN.md` · `PLATFORM_REMEDIATION_PLAN.md` ·
`ROADMAP_EXECUTION_LOG.md` · `REMEDIATION_WORK_ORDER_2026-06-10.md` ·
`GAP_ANALYSIS_TENANT_RLS.md` · `LIVE_DALEKDEFENDER_DRIFT_REMEDIATION.md`

**Live runbooks that remain authoritative at `docs/`** (referenced above, not archived):
[`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md) ·
[`SECURITY_HARDENING_CHECKLIST.md`](SECURITY_HARDENING_CHECKLIST.md) ·
[`RELEASE_READINESS.md`](RELEASE_READINESS.md) ·
[`FIRST_TRIAL_DEPLOYMENT_READINESS.md`](FIRST_TRIAL_DEPLOYMENT_READINESS.md) ·
[`india-deployment-readiness.md`](india-deployment-readiness.md) ·
[`ABDM_READINESS.md`](ABDM_READINESS.md) ·
[`PENTEST_READINESS.md`](PENTEST_READINESS.md)
