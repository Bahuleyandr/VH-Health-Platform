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
- ✅ **M5** (cash-drawer "double-count") investigated → **FALSE POSITIVE** (2026-06-23, 2 independent adversarial verifiers): unreachable given `uq_cash_drawer_sessions_open` (≤1 open session per cashier+shift ⇒ strictly sequential) + insert-time `collected_at`. Documented the soundness invariant in `closeSession`; proof in the analysis doc Medium table. No money-path rewrite (would add under-count regression risk for a non-bug). Optional future `cash_drawer_session_id` stamp only if shared multi-cashier drawers land.
- ✅ **M17** SSRF DNS-rebind TOCTOU closed — new `safeFetch` validates AND pins the socket to the validated IPs (undici `connect.lookup`); migrated HL7/webhook/ABDM egress; also realizes the "one resilientFetch" upgrade — batch 6 (`main 21f0847e`).
- ✅ **M12** DB circuit breaker scoped per-client (primary vs replica) — a replica outage no longer browns out primary; `circuitBreakerStatus().byTag` adds per-client observability. Rejected the audit's "per-tenant" framing (breaker only counts infra failures). — batch 7 (`main 345bbb62`).
- ✅ **M20** admin god-router split — `routes/admin/index.js` 697→152 lines, 37 handlers extracted to `dashboardController.js` through the success()/error() envelope (behaviour-preserving) — batch 8 (`main 2a1b1aca`).
- ✅ **BACKEND audit remediation COMPLETE** — all 13 Highs + all 20 backend Mediums resolved (M5 = proven false positive; M15 deferred to T2 below). 8 TDD batches, each full-`postgres`-gated + merged both remotes.
- ⏳ **M15** make `decisionSupportOnly`/`patientFacing` load-bearing — `[T2]` governance epic (careTeam-enforce *oracle* hazard around flipping those guards → needs a design cycle, see [[project_vh_health_careteam_enforce_oracle]]).
- ✅ **Infra Mediums — safe/bounded subset DONE** (2 kustomize-validated batches, deploy HELD): **b1** (`main c83d3c23`) Ollama PDB + Loki 30d→180d (CERT-In) + canary/backup-verify synthetic-check staleness alerts; **b2** (`main ba736444`) PgBouncer max_db_connections 150→80 (2×80<200, was exhausting `max_connections`) + monitoring ArgoCD Apps `automated`→manual-sync.
- ⏳ **Infra Mediums — DEFERRED (real tradeoffs, need operator/topology confirmation — NOT "surgical"):** CNPG anti-affinity `preferred`→`required` + topologySpread `ScheduleAnyway`→`DoNotSchedule` (**unschedulable on a single-zone 3-node cluster** if kept on zone topology — needs node-topology call + CNPG rollout-friction awareness); `allow-app-to-platform` NetworkPolicy narrowing + backend egress `0.0.0.0/0` scoping (**connectivity risk** — a wrong rule breaks the data path); ingress-nginx SA cluster-wide-secrets scope (TLS cross-ns risk); `nginx-internal` IngressClass has no controller; two overlapping ScheduledBackups (may be intentional daily+nightly — needs CNPG-strategy call); digest-pin floating tags (needs registry digest resolution); Kyverno hardening backstop (enforce-mode blast radius); cosign-attest/SBOM + verify-before-pin (CI-pipeline changes); minSync=1 double-standby write-block.
- ⏳ **Other cross-stack remainder (needs user steer / design cycles):** Wave-2/3 frontend (Flutter/Next.js) Mediums; the 12 T2 epics.
- ⏳ **Wave-2/3 frontend + infra Mediums** (below) not yet started.

Per-finding detail in the analysis doc's Medium/Low tables. Clusters: **auth** (OTP attempt-counter TOCTOU + timing-`===`, 2FA-challenge counter, fail-open revoke-all) · **reliability** (webhook `in_flight` reaper, idempotency-keys sweep, revive the orphaned canary, breaker scoping, dead-letter/Redis/outbox alerts) · **data/RLS** (registerDevice tenant_id, an `ON CONFLICT`-vs-unique-index CI guard) · **clinical** (order-state TOCTOU, med-rec administered-dose, critical-vital routing) · **AI-gov** (prompt-injection on the chat input, RAG `flag`-verdict re-check) · **interop/crypto** (X25519 low-order reject, per-tenant ABDM token cache) · **api** (terminal 404 handler, deviceController helper misuse, admin god-router extraction) · **frontend** (CSP `unsafe-eval`, off-host PHI download scheme check, a11y/Semantics + i18n review-gate, offline queue for clinical writes, typed DTOs, single-WS, white-label theming) · **infra** (scope ingress secret read + east-west NetworkPolicies, PgBouncer pool sizing, SBOM attest + verify-before-pin + base-image digests, Loki 180d, Ollama PDB, monitoring auto-sync).

### Tier 2 — S-tier upgrade epics (the ~85 opportunities → ~12 programs; each gets a brainstorm→design→plan cycle first)
1. **Double-entry money ledger** (DB-enforced invariants, integer paise) — 🟢 **IN PROGRESS.** Spec `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md`. **Phase 1 (substrate engine) DONE** (`main b1358af7`): 4 tables (accounts/entries/postings/balances), integer paise, 3 DB-enforced invariants (deferred net-to-zero balanced trigger; deferred no-negative → overpayment/advance-overdraw/over-refund uncommittable; append-only), `postLedgerEntry` chokepoint, 7 invariant deep tests, full gate green. Plan `docs/superpowers/plans/2026-06-23-money-ledger-phase1-substrate.md`. **Phase 2a (wire AR + cash receipts) DONE** (`main dc2c5d4c`): `issueInvoice` + `collectPayment` post-commit best-effort ledger entries (CLAUDE.md Phase-1.5 pattern — can't break the live money path); `ledgerPostings.js` movement→entry helpers; deep test proves ledger mirrors legacy AR through issue→pay; full gate green. Plan `docs/superpowers/plans/2026-06-23-money-ledger-phase2a-wire-ar-receipts.md`. **Phase 2b (cutover + reconciliation) DONE** (`main 1eae7186`): `applyArOpeningBalances` (opening AR = current amount_due, idempotent + double-count guarded) + operator cutover script + `reconcileLedger` (AR==amount_due, trial balance Σ==0, unwired detection) + per-tenant 30m reconciliation cron. Plan `docs/superpowers/plans/2026-06-23-money-ledger-phase2b-cutover-reconcile.md`. **Phase 3a (advances + payment reversal) DONE** (`main aeab243d`): `collectAdvance`→PATIENT_ADVANCE, `settleAdvance`→PATIENT_ADVANCE→PATIENT_AR, `reversePayment`→PAYMENT_REVERSAL, all post-commit best-effort; deep test mirrors the advance lifecycle + reversal. Plan `docs/superpowers/plans/2026-06-23-money-ledger-phase3a-advances-reversals.md`. **Phase 3b (GST tax split + refunds) DONE** (`main ddab904b`): `issueInvoice` splits REVENUE/(total−tax)+TAX_PAYABLE; `approveRefund`→credit REFUNDS_PAYABLE/debit PATIENT_AR|PATIENT_ADVANCE; `markRefundPaid`→debit REFUNDS_PAYABLE/credit CASH|BANK. Plan `…phase3b-tax-refunds.md`. **Phase 3c (insurance two-step) DONE** (`main 8e2b012c`): `recordClaimDecision` approval shifts PATIENT_AR→INSURANCE_AR; `collectPayment` mode=INSURANCE settles BANK←INSURANCE_AR (not PATIENT_AR — no double-credit). Plan `…phase3c-insurance.md`. **Tail (movement-complete) DONE** (`main 3b008e76`): `markPaymentLinkPaid` tx-path posts the BANK payment; INSURANCE reversal posts credit BANK/debit INSURANCE_AR. **▶ The shadow ledger is now MOVEMENT-COMPLETE — every money movement (issue, all payment modes incl. payment-link + insurance, reversals, advances collect/settle, refunds approve/pay, GST tax split, insurance two-step) posts a balanced double-entry, all post-commit best-effort.** **Phase 5a (GL report endpoints) DONE** (`main 344526ed`): 5 finance-gated read-only report fns (`ledgerReportsService.js`) + routes `/api/v1/admin/ledger/{trial-balance,ar-aging,insurer-aging,cash-position,daily-collection}`; 5 deep tests; full 89-chunk gate green. Plan `…phase5a-backend.md`. **Phase 5b (admin GL UI) DONE** (`main 039ada19`): finance-gated `/dashboard/billing/ledger` page — typed `@/lib/api/ledgerReports.ts` client, 5 collapsible sections (trial balance + balanced badge, patient/insurer AR aging, cash position by drawer, daily collection w/ date range), `useReport` hook, nav entry under Administration; tsc+eslint clean, 440 admin tests, next build green (route in manifest). Plan `…phase5b-admin-ui.md`. **▶ Phase 5 COMPLETE.** Remaining: **Phase 4 (flip authoritative) — gated on production reconciliation evidence, deferred** (the only open ledger phase). · 2. **Terminology spine** (RxNorm/SNOMED + licensed DDI engine) · 3. **Typed event/outbox bus** · 4. **Real-time-first dashboards** (the WS fabric exists, used in 1 tile) · 5. **Single OpenAPI → Dart + admin-TS contract pipeline, CI drift-gated** — 🟢 **Phase 1 DONE** (`main 79be4946`). Epic spec `docs/superpowers/specs/2026-06-24-openapi-contract-pipeline-design.md` (5 phases, D1–D10 decisions). **Phase 1 (canonical spec + path-set drift gate)** plan `…openapi-phase1-canonical-spec-drift-gate.md`: rebuilt ONE regenerable `apps/backend/src/docs/openapi.json` from the live Express-5 router (registration-time Router-prototype capture in `scripts/generate-openapi.mjs` + pure `scripts/openapi/buildSpec.mjs`; 2612 paths/2953 ops, deterministic code-unit sort, spectral-clean), collapsed 6 forked spec files to it, repointed both `/api-docs` loaders + spectral + `openapi:generate`/`openapi:check`, added `scripts/check-openapi-drift.mjs` (regenerate+diff, mirrors Prisma schema-drift) wired into backend CI (after `prisma generate`) + Forgejo schema-policy-drift + lefthook pre-push. **Route-collision cleanup DONE** (`main c93e096c`): the 11 surfaced param-equivalent collisions resolved **11→0** (param-name unification via rename-on-destructure + 2 phone-in-URL removals incl. a new JWT-derived `GET /investigations/my`; 8-agent investigation found most were non-bugs). **Phase 2 (spec→vhhealth_core) DONE** (`main aa888dcc`): `packages/vhhealth_core/swagger/openapi.json` is now a byte-identical, drift-gated copy of the canonical (`scripts/sync-openapi-to-core.mjs` + `scripts/check-core-spec-sync.mjs`, gated CI+Forgejo+lefthook); killed the stale `api.yaml` fork + untracked the dead generated Dart client (−51K lines net). Plan `…openapi-phase2-spec-propagation.md`. **Phase 3 (admin path-drift gate + pipeline hygiene) DONE** (`main 1c88a303`): jest subset gate `apps/admin/src/__tests__/lib/api-config-spec-subset.test.ts` asserts every hand-curated `API_ENDPOINTS` leaf ⊆ canonical spec `paths` (param-normalized, with an allowlist for router nav-bases + non-`/api/v1` infra) — surfaced + fixed **19 drifted admin paths** (incl. 3 LIVE 404s actively called: `doctors.workloadAnalysis`→`/doctors/admin/workload-analysis`, `auth.generateOtp`→`/auth/otp/request-otp`, `auth.verifyOtp`→`/auth/otp/verify-otp`) and dropped **12 fictional `/routes`/mis-segmented leaves**; pinned `openapi-typescript@7.13.0` (exact; overrode its stale `typescript@^5` peer to root TS6 — tool runtime is TS6-compatible, proven by the codegen smoke), redirected `generate:types`→gitignored `src/lib/openapi.generated.ts` + `git rm`'d the dead 0-importer `api-types.generated.ts` mirror, added a CI codegen smoke (after `npm run lint`) so the spec stays generatable. **KEY DISCOVERY:** the gate work uncovered a **Phase-1 enumerator bug** — `scripts/generate-openapi.mjs` missed `wrapAsync`-wrapped sub-routers (the wrapper has no `.stack`), so the entire `/users/*` + `/lookup/*` family was ABSENT from the spec; fixed by tagging the wrapper with `__wrappedFn` (`routeWrapper.js`) + an `asRouter` unwrap in the `use()` capture (2613→2636 paths). Gates: admin tsc + 441 jest + next build green; backend lint + spectral 0-err + openapi-drift 0 + core-sync 0. Plan `…openapi-phase3-admin-path-gate.md`. **Remaining Phases 4–5: Dart client gen; typed per-subsystem payloads.** (Known follow-up: `PROTECTED_ROUTES` + `install-api-fetch-guard.ts` still carry pre-existing dead `/…/routes` literals with their own test coverage — outside this gate's scope.) · 6. **Governed AI-integration program** (agentic workflows, copilot surfaces, output-injection detector, drift→auto-rollback, terminology auto-coding) · 7. **White-label theming** (all 3 clients) · 8. **Observability / SLOs** (Prometheus exposition + the missing alert tier + 180-day retention via object-store Loki+Thanos) · 9. **Offline-first clinical capture** · 10. **Accessibility program** · 11. **Supply-chain → SLSA-L3** (cosign attest SBOM, verify-before-pin, digest-pin everything, Kyverno hardening Enforce) · 12. **Least-privilege network/RBAC + Cloudflare Access** (Zero-Trust admin, Cilium L7, per-tenant NetworkPolicy, edge-as-Terraform).

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
