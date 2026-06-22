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
program are **code-complete**. **Almost nothing below is blocked on more core
platform code** — the bulk is operator go-live execution and external
engagements. Step-by-step execution runbooks remain **live at `docs/`** (linked
inline); this file is the *index of what's left*, not a replacement for them.

## Legend

| Tag | Meaning |
| --- | --- |
| `[OPERATOR]` | A human runs it against the live cluster/providers — the code/config is ready. |
| `[EXTERNAL]` | Third-party / government engagement (certification, pen test, audit). |
| `[PROCUREMENT]` | Hardware or commercial-license purchase. |
| `[CODE]` | Genuinely-unwritten code. Deferred-by-design / customer-pull unless flagged otherwise. |

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
