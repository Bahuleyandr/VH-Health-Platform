# VH Health Platform — Consolidated Roadmap

**Single source of truth for pending work. Last reconciled: 2026-08-25.**

This file consolidates every open item from the planning docs that previously
lived scattered across `docs/` (EPIC roadmap, S-tier roadmap, AI feature-gap
backlog, the 2026-06-16 goal, the clinical-AI rollout/enablement plans, the
remediation plans/work-order, the execution log, and the tenant-RLS gap
analysis). Those source docs are now in [`archive/`](archive/) — see
[§8](#8-archived-source-docs).

**Code/CI state:** Audit #3 P0-P10 is merged, but the prior "engineering
complete" conclusion was overstated. A live re-read at `github/main` @
`831dbc86c` found residual messaging, recovery, scheduler, payroll, patient,
Admin, Staff Web, and device-gateway gaps. They are consolidated on
`fix/audit3-residual-remediation`; they are not counted as merged until the
single protected PR lands. See the
[`2026-08-11 Audit #3 corrected residual reconciliation`](archive/audits/PLATFORM_AUDIT_2026-08-11_RECONCILIATION.md)
for the per-finding matrix, evidence, rating, and activation limits. A code
merge does not authorize deployment or activation.

> **2026-07-05 — next chapter:** §0's engineering backlog (Tier 0/1/2) is complete.
> The forward **build** program now lives in
> [`NEXT_LEVEL_ROADMAP.md`](NEXT_LEVEL_ROADMAP.md) (enterprise-grade programs
> NL-1–NL-12, waves A–D); its §2 absorbs this file's remaining T2/§5/§6 code items.
> §§1–4 of THIS file remain the authoritative operator/go-live track.

> **2026-08-13 — Audit #3 correction:** P0-P10 closed most findings, not all.
> The consolidated residual branch closes the remaining code-actionable paths
> and strengthens fail-closed holds. Live identity/session inspection, runtime
> DB-role proof, migration-660 retention disposition, signed release digests,
> Forgejo parity, and environment drills remain operator-owned.

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
1. **Double-entry money ledger** (DB-enforced invariants, integer paise) — 🟢 **IN PROGRESS.** Spec `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md`. **Phase 1 (substrate engine) DONE** (`main b1358af7`): 4 tables (accounts/entries/postings/balances), integer paise, 3 DB-enforced invariants (deferred net-to-zero balanced trigger; deferred no-negative → overpayment/advance-overdraw/over-refund uncommittable; append-only), `postLedgerEntry` chokepoint, 7 invariant deep tests, full gate green. Plan `docs/superpowers/plans/2026-06-23-money-ledger-phase1-substrate.md`. **Phase 2a (wire AR + cash receipts) DONE** (`main dc2c5d4c`): `issueInvoice` + `collectPayment` post-commit best-effort ledger entries (CLAUDE.md Phase-1.5 pattern — can't break the live money path); `ledgerPostings.js` movement→entry helpers; deep test proves ledger mirrors legacy AR through issue→pay; full gate green. Plan `docs/superpowers/plans/2026-06-23-money-ledger-phase2a-wire-ar-receipts.md`. **Phase 2b (cutover + reconciliation) DONE** (`main 1eae7186`): `applyArOpeningBalances` (opening AR = current amount_due, idempotent + double-count guarded) + operator cutover script + `reconcileLedger` (AR==amount_due, trial balance Σ==0, unwired detection) + per-tenant 30m reconciliation cron. Plan `docs/superpowers/plans/2026-06-23-money-ledger-phase2b-cutover-reconcile.md`. **Phase 3a (advances + payment reversal) DONE** (`main aeab243d`): `collectAdvance`→PATIENT_ADVANCE, `settleAdvance`→PATIENT_ADVANCE→PATIENT_AR, `reversePayment`→PAYMENT_REVERSAL, all post-commit best-effort; deep test mirrors the advance lifecycle + reversal. Plan `docs/superpowers/plans/2026-06-23-money-ledger-phase3a-advances-reversals.md`. **Phase 3b (GST tax split + refunds) DONE** (`main ddab904b`): `issueInvoice` splits REVENUE/(total−tax)+TAX_PAYABLE; `approveRefund`→credit REFUNDS_PAYABLE/debit PATIENT_AR|PATIENT_ADVANCE; `markRefundPaid`→debit REFUNDS_PAYABLE/credit CASH|BANK. Plan `…phase3b-tax-refunds.md`. **Phase 3c (insurance two-step) DONE** (`main 8e2b012c`): `recordClaimDecision` approval shifts PATIENT_AR→INSURANCE_AR; `collectPayment` mode=INSURANCE settles BANK←INSURANCE_AR (not PATIENT_AR — no double-credit). Plan `…phase3c-insurance.md`. **Tail (movement-complete) DONE** (`main 3b008e76`): `markPaymentLinkPaid` tx-path posts the BANK payment; INSURANCE reversal posts credit BANK/debit INSURANCE_AR. **▶ The shadow ledger is now MOVEMENT-COMPLETE — every money movement (issue, all payment modes incl. payment-link + insurance, reversals, advances collect/settle, refunds approve/pay, GST tax split, insurance two-step) posts a balanced double-entry, all post-commit best-effort.** **Phase 5a (GL report endpoints) DONE** (`main 344526ed`): 5 finance-gated read-only report fns (`ledgerReportsService.js`) + routes `/api/v1/admin/ledger/{trial-balance,ar-aging,insurer-aging,cash-position,daily-collection}`; 5 deep tests; full 89-chunk gate green. Plan `…phase5a-backend.md`. **Phase 5b (admin GL UI) DONE** (`main 039ada19`): finance-gated `/dashboard/billing/ledger` page — typed `@/lib/api/ledgerReports.ts` client, 5 collapsible sections (trial balance + balanced badge, patient/insurer AR aging, cash position by drawer, daily collection w/ date range), `useReport` hook, nav entry under Administration; tsc+eslint clean, 440 admin tests, next build green (route in manifest). Plan `…phase5b-admin-ui.md`. **▶ Phase 5 COMPLETE.** Remaining: **Phase 4 (flip authoritative) — gated on production reconciliation evidence, deferred** (the only open ledger phase). · 2. **Terminology spine** (RxNorm/SNOMED + licensed DDI engine) · 3. **Typed event/outbox bus** · 4. **Real-time-first dashboards** — 🟢 **ALL 13 ADMIN SLICES DONE + MERGED** (`main bf9d225a`, 2026-06-29) — the scout-ranked admin backlog is EXHAUSTED. Shipped: beds, ED, operations, OR-board, ICU, clinical-alerts/code-blue, lab, microbiology, incidents, dialysis, blood-bank, radiology, doctor-queue. THREE consumer patterns (event `useRealtimeInvalidation` / snapshot `useRealtimeData` / live-feed `useRealtimeChannel`) + THREE emit-layers (route / service-chokepoint / controller). Per-slice specs/plans under `docs/superpowers/{specs,plans}/2026-06-2{7,8,9}-realtime-dashboards-*`. Deploy HELD; live WS push verified manually only (no WS in jsdom). _History (slice 1):_ ★ The "used in 1 tile" framing was WRONG: the WS fabric is mature (backend `broadcast`/`sendToUser` + Redis fan-out + tenant filter + channel RBAC; admin `useRealtimeChannel` ticket hook; Flutter `RealtimeClient`) and several channels are LIVE (`staff:clinical-alerts`, `staff:code-blue`, `staff:beds`+`admin:beds`, `staff:handovers`, `admin:kpi`). The real gap = dashboards still POLL instead of subscribing. Slice 1 shipped the reusable pattern: `apps/admin/src/hooks/useRealtimeInvalidation.ts` (subscribe a channel → invalidate react-query keys on each event) + converted the admin Beds dashboard from 60s polling to subscribing to the already-broadcast `admin:beds` (zero backend change) with a dynamic poll fallback (5-min safety poll while live, 60s when WS down) + a ●Live/○Polling indicator. Spec/plan `…2026-06-27-realtime-dashboards-beds*`. Gate: type-check 0, lint 0, jest 447/447, next build ✓; final review APPROVE. **Live push verified MANUALLY** (no WS in jsdom; deploy HELD) — automated tests cover the hook/cadence/indicator only. **Follow-on (only remaining real-time work):** the Flutter clinical boards (Patient Command Board, vitals — their `RealtimeClient` is ready, need new channels). All admin dashboards are done. · 5. **Single OpenAPI → Dart + admin-TS contract pipeline, CI drift-gated** — 🟢 **Phase 1 DONE** (`main 79be4946`). Epic spec `docs/superpowers/specs/2026-06-24-openapi-contract-pipeline-design.md` (5 phases, D1–D10 decisions). **Phase 1 (canonical spec + path-set drift gate)** plan `…openapi-phase1-canonical-spec-drift-gate.md`: rebuilt ONE regenerable `apps/backend/src/docs/openapi.json` from the live Express-5 router (registration-time Router-prototype capture in `scripts/generate-openapi.mjs` + pure `scripts/openapi/buildSpec.mjs`; 2612 paths/2953 ops, deterministic code-unit sort, spectral-clean), collapsed 6 forked spec files to it, repointed both `/api-docs` loaders + spectral + `openapi:generate`/`openapi:check`, added `scripts/check-openapi-drift.mjs` (regenerate+diff, mirrors Prisma schema-drift) wired into backend CI (after `prisma generate`) + Forgejo schema-policy-drift + lefthook pre-push. **Route-collision cleanup DONE** (`main c93e096c`): the 11 surfaced param-equivalent collisions resolved **11→0** (param-name unification via rename-on-destructure + 2 phone-in-URL removals incl. a new JWT-derived `GET /investigations/my`; 8-agent investigation found most were non-bugs). **Phase 2 (spec→vhhealth_core) DONE** (`main aa888dcc`): `packages/vhhealth_core/swagger/openapi.json` is now a byte-identical, drift-gated copy of the canonical (`scripts/sync-openapi-to-core.mjs` + `scripts/check-core-spec-sync.mjs`, gated CI+Forgejo+lefthook); killed the stale `api.yaml` fork + untracked the dead generated Dart client (−51K lines net). Plan `…openapi-phase2-spec-propagation.md`. **Phase 3 (admin path-drift gate + pipeline hygiene) DONE** (`main 1c88a303`): jest subset gate `apps/admin/src/__tests__/lib/api-config-spec-subset.test.ts` asserts every hand-curated `API_ENDPOINTS` leaf ⊆ canonical spec `paths` (param-normalized, with an allowlist for router nav-bases + non-`/api/v1` infra) — surfaced + fixed **19 drifted admin paths** (incl. 3 LIVE 404s actively called: `doctors.workloadAnalysis`→`/doctors/admin/workload-analysis`, `auth.generateOtp`→`/auth/otp/request-otp`, `auth.verifyOtp`→`/auth/otp/verify-otp`) and dropped **12 fictional `/routes`/mis-segmented leaves**; pinned `openapi-typescript@7.13.0` (exact; overrode its stale `typescript@^5` peer to root TS6 — tool runtime is TS6-compatible, proven by the codegen smoke), redirected `generate:types`→gitignored `src/lib/openapi.generated.ts` + `git rm`'d the dead 0-importer `api-types.generated.ts` mirror, added a CI codegen smoke (after `npm run lint`) so the spec stays generatable. **KEY DISCOVERY:** the gate work uncovered a **Phase-1 enumerator bug** — `scripts/generate-openapi.mjs` missed `wrapAsync`-wrapped sub-routers (the wrapper has no `.stack`), so the entire `/users/*` + `/lookup/*` family was ABSENT from the spec; fixed by tagging the wrapper with `__wrappedFn` (`routeWrapper.js`) + an `asRouter` unwrap in the `use()` capture (2613→2636 paths). Gates: admin tsc + 441 jest + next build green; backend lint + spectral 0-err + openapi-drift 0 + core-sync 0. Plan `…openapi-phase3-admin-path-gate.md`. **Phase 5 (typed payloads) — MONEY SLICE DONE** (`main e6f521b1`): typed request/response payload schemas across the WHOLE money/billing surface (~75 endpoints) via per-subsystem overlay modules (`scripts/openapi/schemas/money.mjs` + `_helpers.mjs`) merged at generate-time, a two-layer contract gate (static ajv `openapiMoneyContracts.test.js` + live `assertData`/`assertResponse` woven into deep tests, **8 suites / 77 tests**), and an admin Data-only alias (`openapi-data.ts` `ApiData`/`ApiBody`). Covered: GL ledger (5), V1 billing (9), V2 invoices (14), V2 payments/advances/refunds (12), V2 cash-drawer + payment-links (12), billing-masters (15). Money-type rules pinned by the live tests: Prisma Decimal→JSON **string**, JS-computed totals→**number**, `*_minor`→**integer** (BigInt safe-int→number). Admin GL ledger client now consumes spec-derived `ApiData` types; generated `openapi.generated.ts` gitignored + pre-hook-regenerated. Spec/plan `…2026-06-24-openapi-phase5-money-typed-payloads*`. **Phase 4 (Dart client gen) DONE** (`main d131fe00`): revived the dead Dart codegen — `melos run codegen` (driver `scripts/codegen.mjs`) regenerates a COMPILING chopper client (`Openapi`) from the byte-synced `packages/vhhealth_core/swagger/openapi.json`; the one FHIR `$everything` path that breaks chopper_generator (Dart `$`-interpolation) is dropped via generator-native `build.yaml` `exclude_paths` with a no-silent-truncation drop report (`scripts/codegen.mjs`); barrel + `VHAuthInterceptor` aligned to the real generated names; compose smoke test (`test/api_client_compose_test.dart`); codegen+analyze gated in BOTH GitHub (`_reusable-flutter-workspace.yml`) and Forgejo (`scripts/ci/flutter.mjs`) Flutter CI, ordered after format/before analyze+test. Generated client stays gitignored (no committed baseline; CI regenerates); apps unmigrated (still VHHttpClient — pipeline-only). Also pinned the core spec to LF (`packages/vhhealth_core/.gitattributes`) so the byte-sync gate is stable on Windows + tall-style-formatted 6 pre-existing drifted Dart files so the Flutter format gate is green; full fresh-state gate verified (format→codegen→analyze→test all green). Spec/plan `…2026-06-25-openapi-phase4-dart-client*`. **Phase 5 (typed payloads) — APPOINTMENTS SLICE DONE** (`main 8c3749b6`, 2026-06-26): first non-money slice — the whole `/api/v1/appointments/*` surface typed (49/53 ops; 4 intentionally generic: legacy `POST /appointments`, `/admin/test`, `/test`, `DELETE /{id}`) via `scripts/openapi/schemas/appointments.mjs` + the now-**generalized** static gate (`openapiMoneyContracts.test.js`→`openapiContracts.test.js`, iterates all overlays) + a new `appointment-analytics-contract.deep.test.js` + live `assertResponse` in `appointment-deep.test.js`. Authored from REAL controller returns (the plan's stated shapes were often wrong — controllers WRAP `data:{appointment,…}`); LOOSE `additionalProperties:true` for the rich/variable rows. **Also fixed 6 BROKEN admin endpoints** (analytics/capacity/bulk-update-status/override-book/resolve-conflict/bulk-delete) that 500'd on pre-existing SQL bugs (bad cols, whereClause-mid-JOIN, $-param collision, missing NOT-NULL INSERT cols, array-as-$1), + **migration 346** (`appointment_archive` PHI table + RLS). **Spectral fix:** Spectral 6.x (nimma) CRASHES on a `null` enum VALUE → committed enums kept null-free, null-acceptance moved into the test-only `ajvReadySpec()/toAjv()` (this had left main's backend CI red from the money `payment_method` null-enum). Dart codegen+analyze green against the new spec. Spec/plan `…2026-06-25-openapi-phase5-appointments*`. **Appointments admin-query correctness + admin-client adoption DONE** (`main aefdee52`, 2026-06-26): value-TDD fixed the silently-wrong admin analytics (lowercase-status READS → UPPERCASE per `appointmentConfig.js`; raw-SQL joins corrected to `doctors.user_id = appointments.doctor_id`; `/conflicts` reworked to a same-day `appointment_time::time` 30-min near-slot window) and adopted spec-derived `ApiData` types in `apps/admin/src/lib/api/appointments.ts` (hybrid-kept the LOOSE SLA/queue blocks; surfaced+fixed a `token_number` string-vs-number drift + latent sort bug). **Phase 5 (typed payloads) — DISCHARGE SLICE DONE** (`main 09436b1f`, 2026-06-26): the whole `/api/v1/discharge-summaries/*` surface typed (10 ops) via `scripts/openapi/schemas/discharge.mjs` authored from the real service SELECTs (overlay `a86afdda`) + the generalized static gate + a new `discharge-summaries-contract.deep.test.js` weaving live `assertResponse` over the full `draft→ready_for_signoff→signed→delivered` lifecycle (10/10 ops, test `df0d2f8b`). LOWERCASE status enum (NOT the appointments UPPERCASE), two DISTINCT section schemas (runtime `DischargeSection` vs template `DischargeTemplateSection`), LOOSE `SELECT *` detail (`DischargeSummary`) + strict reduced LIST projections (pending 9-key, patient 8-key — both ≠ detail and ≠ each other). Scout→build+2-reviewer→deep-test+audit workflows; gates lint + openapi:check + check-core + spectral(0 err) + static gate + deep test all green. **Phase 5 (typed payloads) — PAYROLL SLICE DONE** (`main 59f05138`, 2026-06-26): the WHOLE payroll surface typed — admin `/staff/admin/payroll/*` + hr self-service `/staff/hr/payroll/*`, **47 typed ops across 7 sub-domains** (runs/payslips, salary-config, salary-revisions, separations, queries-compliance, hr-self-service) + 4 intentionally generic (3 CSV exports + 1 PDF-redirect download) via `scripts/openapi/schemas/payroll.mjs` + the generalized static gate + a live `payroll-contract.deep.test.js` asserting each distinct response schema against real payloads. Per-field Decimal discipline (Decimal column→**string**, JS-computed→**number**, bigint COUNT→**integer**). Built scout(5-reader)→2-pass build+2-reviewer→hr sub-domain→deep-test as workflows. **★ The live contract test surfaced + fixed 5 REAL production bugs** (a `staffAccessDecisionService` UUID regex missing the `[0-9a-f]{3}-` group → rejected EVERY RFC-4122 UUID → 403 on every `staffUid`-targeted staff route; payroll run processing 0 staff [non-existent `staff_attendance.status/date` cols + a `{rows:[]}` object-catch the for-of couldn't iterate]; three 500s on hr-sign/admin-sign/issue/approveFnF from non-existent `approved_by/at`+FnF cols; `applyRevision` raw-param `vals`→`...vals` 08P01) + 2 contract bugs (13 `@db.Date` fields deserialize to date-time strings; bigint COUNTs serialize as JS numbers). Gates: regression sweep 18/18, openapi:check + check-core + spectral(0 err) + lint green. (The same UUID_RE typo also lives in `src/routes/admin/forecastRoutes.js` — untouched, a known follow-up.) **Phase 5 (typed payloads) — EMR SLICE DONE** (`main d6d40d22`, 2026-06-26): the WHOLE `/api/v1/emr/*` clinical namespace typed — **116 ops across 6 sub-domains** (admission-detail, admission-mgmt, notes-diagnosis, orders, observations, MAR) via `scripts/openapi/schemas/emr.mjs` (~3.4k lines) + the generalized static gate + a live `emr-contract.deep.test.js` driving the clinical lifecycle (admit→vitals→note→order→diagnosis→discharge-prep, 5/5). All 116 keyed (99 typed + 17 AI-content ops as typed-envelope+loose-draft, none non-JSON). jsonb→object, null-free clinical enums, admission ops ALSO aliased onto `/api/v1/admissions/*`. Built scout(7-reader)→6-pass build+2-reviewer→deep-test as workflows. **★ The live contract test caught 7 REAL overlay bugs** (free-form columns `admission_type`/`note_type` wrongly enum-constrained — no DB CHECK; `BED_STATUS` too narrow vs the real `beds_status_check`; `floor` int-vs-string; `onset_date`/`resolved_date` date-vs-date-time). **★ KNOWN FOLLOW-UP — MAR alias-mount spec-path artifact:** the 23 `/emr/mar/*` ops are typed at generator-emitted `/emr/mar/mar/*` paths that **404 live** — `/api/v1/emr/mar` is an ALIAS mount of the canonical `/api/v1/clinical/mar/*` router with a runtime `req.url='/mar'+...` rewrite (app.js ~835-858), so the generator double-counts the `mar` segment. Drift gate passes (generator self-consistent); only a live hit reveals it. Affects `/emr/mar/*` + `/nursing/mar/*` aliases. **▶ FIXED (`main 776b8945`):** the generator now SKIPS rewrite-alias mounts — the rewrite middleware self-marks `__openapiSkipMount`, and the generator tracks the marked prefix across calls (Express 5 splits a multi-handler `app.use` into one `router.use` PER handler, so the marker + the child router arrive in separate calls at the same prefix). Dropped the 26 orphaned MAR ops from the emr overlay → the EMR slice is now **90 typed `/emr/*` ops**. Runtime aliases still SERVE (`mar-aliases.test.js` 6/6); only the bogus spec paths are gone; canonical `/api/v1/clinical/mar/*` (9 ops, untyped) preserved — typing it is a future clinical-slice concern. Gates: deep test 5/5 + static 3/3 + openapi:check + check-core + spectral(0 err) + lint all green. **Phase 5 (typed payloads) — CLINICAL-AI SLICE DONE** (`main 0ef6815f`, 2026-06-27) — **the final Phase-5 slice, so Phase 5 typed-payloads is COMPLETE.** The whole clinical-AI namespace typed — **750 keyed ops** (control 365 + admin-alias 365 dual-mounted under `/api/v1/clinical-ai/control` **and** `/api/v1/admin/clinical-ai`, + 20 `/clinical-ai/clinical`) across **14 sub-domains** via `scripts/openapi/schemas/clinicalAi.mjs` (15 build commits) + the generalized static gate + a live `clinical-ai-contract.deep.test.js`. **0 generic-`Success` responses, 73 schemas, 0 null-in-enum.** ~300 LLM/jsonb governance ops share intentionally-LOOSE envelopes (`ClinicalAiDraftResponse`/`ClinicalAiReviewDecisionResponse`/`ClinicalAiCountListResponse`) — module-enablement-gated (3-layer `clinical_ai_tenant_modules`) + LLM-dependent, so **statically validated only** (contract gate key→route + ajv-compile; reviewer-verified loose envelope), not live-asserted. The ~40 **strict DETERMINISTIC** schemas (outcome-scoreboard nullable `*_pct`/`*_minutes` metrics, ROI, KB CRUD, blood-bank inventory, biomed/model/agent registries) authored from real DB CHECKs + SELECT projections. Built scout(decompose)→3-build-pass(T0–T14)→2-reviewer(both APPROVE)→live-deep-test as workflows. **Live deep test 8/8 over the reachable strict subset** — the key check: empty-tenant outcome-scoreboard returns every rate-field `null` with counts `0`, validating the nullable-metric-vs-integer split. **0 contract bugs** (overlay correct first pass). **Also reconciled a drift** the notifications `/:phone` 410-deprecation stubs had left on `main` (live routes added, spec not regenerated). Gates: deep test 8/8 + static 3/3 + openapi:check 0-drift + check-core 0 + spectral(0 err) + lint all green. **▶ The OpenAPI contract pipeline epic (Phases 1–5) is now fully landed** — every backend HTTP surface (money, appointments, discharge, payroll, EMR, clinical-AI) carries typed request/response payloads behind a two-layer (static-ajv + live-assert) drift-gated contract. **Follow-up tail CLEARED (`main` chore/openapi-tail-and-discharge-tx, 2026-06-27):** billing.ts AR-aging/claim-queue adoption was ALREADY done (money.mjs types both → `ArAgingResponse`/`ClaimQueueResponse`; `billing.ts:75-80` derives all six types from `ApiData<>`); the `ClinicalAiLongitudinalRiskRow.overall_score` nullable→non-null tighten landed (`c5d0437f`); A2's `saveDischargeSummary` is now tx-wrapped + tx-aware-publish (`c5d0437f`, mirrors signDischargeSummary, proven by `discharge-save-outbox-atomicity.deep.test.js`). **Canonical `/api/v1/clinical/mar/*` (9 ops) NOW TYPED (`dc421f09`)** — new `scripts/openapi/schemas/clinicalMar.mjs` overlay (MarRecord/MarDueItem/MarVerifyResult, `status` free-form so plain-string not enum) + live `clinical-mar-contract.deep.test.js` (9/9, full lifecycle schedule→administer/miss/hold→lists→5-rights verify→administer-with-scan, 0 contract bugs). **▶ EVERY backend HTTP surface is now typed — the OpenAPI contract-pipeline epic is 100% COMPLETE, no contract-pipeline tail remains.** (Known follow-up: `PROTECTED_ROUTES` + `install-api-fetch-guard.ts` still carry pre-existing dead `/…/routes` literals with their own test coverage — outside this gate's scope.) · 6. **Governed AI-integration program** (agentic workflows, copilot surfaces, output-injection detector, drift→auto-rollback, terminology auto-coding) · 7. **White-label theming** (all 3 clients) · 8. **Observability / SLOs** — 🟢 **ALERT-TIER CODE DONE** (`main 1a459b8d`, 2026-06-27). The reliability machinery (event_outbox drain/dead-letter, webhook + notification backlog, WS fan-out, DB circuit breaker) was flying blind — now instrumented as Prometheus metrics + alerted. Spec/plan `…2026-06-27-observability-alert-tier*`. **Backend (TDD'd + QA-cluster-verified):** `src/observability/metricPrimitives.js` (Histogram/Counter/Gauge extracted) + `reliabilityMetrics.js` — 8 DB-derived gauges via a 20s unref'd in-process collector (started in `bin/www.js`) + 3 inline counters (`ws_broadcast_dropped_total{reason}`, `ws_fanout_subscriber_errors_total`, `event_outbox_dead_lettered_total`) wired at the WS/outbox event sites; appended to `/metrics`. **Infra-as-code (promtool/JSON structure-validated, NOT live-fired — deploy HELD):** `backend-reliability-alerts.yaml` (12 alerts incl. the 2 previously-unalerted safety counters), `backend-slo.yaml` (99.95% availability, multi-window multi-burn-rate 14.4×/6×), RED + reliability Grafana dashboards-as-code (sidecar ConfigMap), `validate-monitoring.mjs` + CI promtool gate. Final review APPROVE (metric-name cross-check clean — no dead alerts). **★ This reframed the ROADMAP's "missing alert tier" — RED/infra/DB alerting + Alertmanager routing (Discord/PagerDuty) already existed; the gap was the app reliability signals.** `ws_broadcast_dropped_total` is justified as a WS-reliability signal on its own (NOT a BEAM commitment — BEAM stays undecided). **Remaining:** operator activation (Alertmanager secret URLs, confirm Grafana sidecar import) = go-live step; 180-day retention via object-store Loki+Thanos (Loki already raised to 180d in config) + the missing alert routing secrets are deferred operator items. · 9. **Offline-first clinical capture** — 🟢 **SLICE 1 (MAR) DONE** (`main ee39fe27`, 2026-06-27). ★ The "no offline queue" framing was WRONG: a mature offline-write stack already exists in `packages/vhhealth_core` (`OfflineQueue` encrypted sqflite + idempotency-key, `ConnectivitySyncService` auto-drain-on-reconnect, `VHHttpClient` chokepoint, `OfflineSyncBadge`/`SyncStatusSheet` conflict UI) — the gap was the clinical write SCREENS aren't wired to it. Slice 1 wired the bedside MAR/BCMA flow: `SecureBlobCodec` (shared AES-GCM) + `MarOfflineCache` (encrypted, staff-scoped due-dose cache, primed from the due-meds list) + `mar_five_rights` (client-side 5-rights — a faithful weaker-or-equal port of the server's `evaluate5Rights`, so the nurse gets the SAME safety check offline). Backend `administer-with-scan` accepts a bounded bedside `administered_at` (time-right vs it + recorded; **dedup unchanged** — `uniq_mar_administered_dose` mig 327 + row-id FSM still prevent double-administration). Offline path: verify-from-cache → enqueue → "pending sync"; **hard-stop (patient/drug mismatch) NEVER enqueues** (two independent guards). MAR conflicts surface loud (clinical copy + confirm-on-discard) — never a silent drop. Spec/plan `…2026-06-27-offline-mar*`. Gate: core flutter 121/121, staff 488, backend MAR jest 18/18, analyze+lint clean; final review APPROVE (5 safety gates verified). **Live offline→drain round-trip verified MANUALLY** (no airplane-mode in CI; deploy HELD). **▶ SLICE 2 (drug-chart medication orders) DONE** (`main d740758e`, 2026-06-27): wired `DrugChartScreen._saveDraftRow` to queue a single inpatient med order offline. `POST /emr/orders`→idempotency `required:true` (bulk/apply-set unchanged); a pure `dispositionForStatus` broadens the sync-drain conflict set {409,422}→{400,403,409,422} so a CDS-blocker/device-posture rejection on drain is a LOUD conflict, not a silent retry-then-drop (also strengthens MAR — 409/422 preserved); `ConflictRow` gained `/emr/orders` clinical copy + confirm-on-discard; shared `buildInpatientMedicationOrderBody` keeps the offline body byte-identical to online; **phone-mode NEVER enqueues** (`buildOfflineOrderIntent` device guard — clinical order writes are desktop/tablet-only, mirroring backend `rejectMobileClinicalWrite`). Spec/plan `…2026-06-27-offline-cpoe*`. Gate: core flutter 128/128, staff 495, backend idempotency deep test 2/2 + emr-contract 7/7, analyze+lint clean; final review APPROVE (5 safety invariants verified). Live offline→drain MANUAL; deploy HELD. **▶ SLICE 3 (e-Rx) DONE** (`main efbadf44`, 2026-06-27): queue a TEXT e-prescription (`POST /prescriptions/create`) from the prescribing screen offline. Near-clone of CPOE — reused `dispositionForStatus`/`enqueue`/`ConflictRow` unchanged. **NO backend flip** (route stays `required:false`): `VHHttpClient.multipart` sends no Idempotency-Key, so flipping would 400 the online handwritten-photo path, and the queue's stable key already dedups drains under `required:false` (proven by a regression deep test). Shared `buildPrescriptionBody` (byte-identical online/offline; reproduces the EXACT online body — NO `admission_id`/`visit_type`; `override` online-only) + pure `buildOfflineRxIntent` (**phone-mode NEVER enqueues**) + `ConflictRow` `/prescriptions` clinical copy + `_submit` offline branch (SKIPS the CDS pre-flight; HONEST "will be safety-checked on sync" toast, never "safe"; photo Rx stays online-only). Gate: core flutter 132/132, staff 503, backend prescription 16/16, analyze+lint clean; final review APPROVE (5 safety invariants). Spec/plan `…2026-06-27-offline-erx*`. **▶ OFFLINE CLINICAL-WRITE TRILOGY COMPLETE (MAR + CPOE + e-Rx).** Follow-ons: offline e-sign/pharmacy/PDF (post-drain online steps); the multipart-Idempotency-Key change to close the pre-existing online photo keyless-dup. · 10. **Accessibility program** · 11. **Supply-chain → SLSA-L3** (cosign attest SBOM, verify-before-pin, digest-pin everything, Kyverno hardening Enforce) · 12. **Least-privilege network/RBAC + Cloudflare Access** (Zero-Trust admin, Cilium L7, per-tenant NetworkPolicy, edge-as-Terraform).

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
  - ⚠️ **One concrete platform gap (not paperwork):** CERT-In requires **180-day** Indian-jurisdiction log retention; Loki primary retention is now configured to 180 days (`infra/kubernetes/base/monitoring/loki-values.yaml`). Before go-live, still prove PVC capacity/backup and/or add object-store archive/SIEM retention for durable evidence.

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
- **Minor security hardening** — ✅ **M-5 + ADM-2 DONE** (`main 8281c995`, 2026-06-27): M-5 dropped `text/plain`/`text/csv`/`text/rtf` from the global upload allowlist (`uploadConfig.js`; HTML-as-text stored-XSS — clinical-AI doc-intake keeps text/* via its OWN admin-only MIME sets, so non-breaking); ADM-2 dropped `unsafe-eval` from the PRODUCTION admin CSP (`middleware.ts buildCsp`; dev keeps it for Next HMR; nonce+strict-dynamic backstop intact). Gated: backend upload tests 11/11, admin middleware 79/79.
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

## Explicitly parked (once-over 2026-08-23 — recorded so audits stop re-discovering them)

- **Bed-inspection endpoints** (`bedInspectionRoutes`): parked. Superseded by
  the fuller "Bed inspections" entry later in this file, which is canonical —
  this one said "manual-only sweep", but an hourly `expire-bed-inspections`
  cron does exist (it only expires rows, never creates them). Do not
  re-report as a gap.
- **Admin god-page rule**: 14+ pages exceed the documented split threshold
  (worst: death-certification, clinical-ai [half-migrated], continuity-
  reconciliation). The rule stands; the splits queue here rather than in the
  once-over train.
- **Patient portal list offline caching** (bills/TPA/messages/lab-orders):
  cachedGet conversion requires outage-controller scaffolding in the HTTP-
  mock widget tests — deferred with the health-summary trio done.
- **SMS config tables RLS**: excluded from migration 726 until
  smsProviderConfigService wraps its raw calls in setTenantTx (see
  prisma/SCHEMA_NOTES.md).
- **Per-tenant lab critical thresholds + reference ranges** (tenancy re-audit
  2026-08-24): there is **no operator path to configure
  `lab_critical_thresholds`**. Verified: the only `INSERT INTO
  lab_critical_thresholds` outside tests are migrations 151 and 193, both of
  which seed the **default tenant only**; no service, controller, route or
  admin screen writes the table, and `src/tests/unit/tenantProvisioningRegistry.test.js`
  now fails if one appears. So any tenant other than the founding one holds zero
  thresholds and `evaluateCriticalThreshold` answers every lookup `matched:false`
  — a CRITICAL lab result never raises an alert there, silently.

  **Auto-copy was attempted and withdrawn — do not retry it.** Two rounds of
  review shipped a backfill of the default tenant's rows into every tenant, and
  each tripped a different rejection on the lab **result-recording** path:
  round 1's `(loinc_code, test_code)` guard let a copied row tie a tenant's own
  row at `evaluateCriticalThreshold`'s best match rank (`LAB_CRITICAL_POLICY_MISMATCH`
  / `threshold_ambiguous`); round 2's table-empty guard removed that tie and
  exposed the real coupling — `lab_critical_thresholds` and `lab_reference_ranges`
  are two halves of one policy that must agree, and
  `labPanelService.assertCriticalPolicyAgreement` throws on any disagreement
  (`policy_presence` when only one side is configured, `threshold_unit` when the
  units differ). Copying thresholds without matching reference ranges therefore
  **rejected lab results in every backfilled tenant** — worse than the silent
  non-alert. Migration 728 and the provisioning registry no longer carry the
  table, for the backfill and for `createTenant` alike.

  **What the real fix needs**, and why it is parked rather than queued: the two
  tables must be built together, with clinical sign-off on the critical limits,
  the reference intervals **and** the units they are expressed in — these are
  tied to a hospital's analyzers and patient population, so one hospital's
  potassium limits are not a safe default for another. Scope: an operator write
  path (service + admin screen + audit) covering both tables, plus a
  provisioning story for a new tenant that starts empty rather than inheriting.
  `lab_reference_ranges` is already parked on the same guard test's list for the
  same reason.

  **Until then the absence is observable, not silent** (this is the part that
  shipped): `evaluateCriticalThreshold` counts every lookup on
  `vhhealth_lab_critical_threshold_lookups_total{outcome="matched"|"unmatched"}`,
  and the canary check (`src/utils/canaryHealthCheck.js`) reports
  `lab_critical_threshold_coverage` — the active tenants holding no thresholds
  at all, warned by name.
  
  The split lives in the canary rather than on the result-recording path for a
  specific reason: every caller of `evaluateCriticalThreshold` passes its open
  transaction, and a failed statement aborts that transaction — an earlier
  revision probed there, and a probe failure would have surfaced as 25P02 on
  the next write, i.e. observability stopping a lab result from being recorded.
  The lookup therefore issues no extra statement (pinned by a call-count
  assertion, since a mocked rejection cannot reproduce a real aborted
  transaction). Alert on `lab_critical_threshold_coverage` being non-zero:
  those tenants can never raise a critical lab alert.

## Explicitly parked (re-audit lane J, 2026-08-24 — admin surfaces that could not finish their own workflow)

- **Feature-flag console + `feature_flags` table — decision: RETIRE, do not
  wire.** `services/featureFlags/featureFlagService.js#isEnabled()` has zero
  call sites, so the table (migration 148), the SUPER_ADMIN CRUD routes
  (`routes/admin/featureFlagRoutes.js`) and the `/dashboard/feature-flags` page
  together form a control that changes nothing: an operator reaching for it
  mid-incident gets a silent no-op. Wiring was considered and rejected on two
  grounds. (a) *There is no flag to wire.* No migration seeds a row and the
  console's name field is free-form, so "one real gate per flag the console
  offers" is undefined — the console offers whatever an operator types. Worse,
  `isEnabled()` treats an unknown flag as `false`, so bolting a gate onto a
  working path would switch that feature **off for every tenant on deploy**.
  (b) *The table is the wrong shape and the codebase already said so twice.* It
  has no tenant column and a process-wide cache, so one tenant's toggle would
  move every tenant; migration 429 says "…and never use the global
  feature_flags table" and migration 351 says "The global feature_flags table
  is insufficient: coverage/readiness differ per tenant". Every switch the
  product actually wants is per-tenant and already exists — entitlements
  (`admin.feature_flags` is itself one), `engagement_settings.enabled` /
  `.emergency_stop`, kiosk settings, composition-search settings, plus env kill
  switches for infrastructure. There is no flag left for this table to own.

  **Shipped now** (the part that fits inside the backend service layer): the
  service states its own inertness rather than implying an effect. `getFlags()`
  stamps every row `inert: true` / `runtime_effect: 'none'` / `runtime_note`; a
  cache refresh that finds rows warns once that they gate nothing; an upsert
  warns, at the moment the operator flips something, that the flip is a no-op.
  `WIRED_FEATURE_FLAGS` (currently empty) is the one list a future gate must
  join for a flag to stop calling itself inert.

  **Also shipped** (round 3, closing the "the console still looks functional on
  screen" gap this entry used to describe): the admin page now consumes that
  metadata instead of ignoring it.
  `apps/admin/src/app/(with-auth)/dashboard/feature-flags/page.tsx` no longer
  says "Manage dynamic feature rollout across the platform"; it banners how many
  flags gate nothing — quoting the server's own `runtime_note` — splits the
  table into "Stored value" and "Runtime effect" columns, labels an inert row's
  control "Store as on/off" rather than "Enable", and confirms a write to an
  inert flag as *"Stored value updated … no runtime behaviour changed"* instead
  of "Flag toggled". A flag that ever joins `WIRED_FEATURE_FLAGS` reads as
  "Gates a code path" with no further change to the page, and a server that
  sends no metadata reads as "Not reported" — the page never guesses in either
  direction. Pinned by
  `apps/admin/src/__tests__/dashboard/feature-flags/page.test.tsx`.

  **Still open**, and parked rather than queued because retirement spans the
  admin portal and the packaging catalog and needs one owner call (delete the
  console, or leave it read-only):
  1. `apps/admin/src/app/(with-auth)/dashboard/feature-flags/page.tsx` — the
     page now tells the truth, but it is still a CRUD console for a table
     nothing reads. Deleting it, or dropping the write controls, is the owner
     call.
  2. `apps/admin/src/lib/navConfig.ts`, `routePolicy.ts`, `proxyPermissions.ts`
     — drop the entries if the page goes.
  3. `routes/admin/featureFlagRoutes.js` + `featureFlagValidator` in
     `validators/sharedValidators.js` — remove with the page, then regenerate
     the OpenAPI spec.
  4. Entitlement key `admin.feature_flags` (`services/entitlements/
     entitlementService.js`, catalog rows in migration 433) — retiring it is a
     packaging change, so this is the piece that most needs the owner decision.
  5. A forward-only migration dropping `feature_flags` — **last**, and only
     after 1–4 ship.

- **Patient gamification / step-rewards loop — parked: the server halves exist,
  both ends have no UI.** `routes/gamification/adminGamificationRoutes.js`
  (milestone CRUD + `POST /vouchers/:code/redeem`, mounted
  `/api/v1/admin/gamification`) has no caller in the admin portal — no page, no
  `lib/api` client, no `proxyPermissions` entry — and the mount's
  `ADMIN_ROUTE_ROLES` (SUPER_ADMIN|ADMIN) + `requireSuperAdminStepUp` +
  `adminIpAllowlist` chain puts it out of reach of the staff app, which is
  where a pharmacy or front-desk role would actually redeem a voucher. The
  `/api/v1/rewards/*` router (`routes/steps/stepRewardsRoutes.js`) is likewise
  caller-less — the patient app talks only to `/gamification/*`.

  The loop is broken at **both** ends, and the start is the harder one:
  - *Cannot start.* `adminGamificationRoutes` is the only write path to
    `health_milestones`, and no migration seeds that table — the only
    `INSERT INTO health_milestones` outside tests is that router's own, at
    `routes/gamification/adminGamificationRoutes.js:71`. Every tenant therefore
    holds an empty reward catalog: `GET /gamification/milestones` returns
    nothing and `POST /gamification/milestones/:id/claim` has nothing to claim.
  - *Cannot close.* `pointService.claimMilestone` mints a `voucher_code` into
    `health_milestone_claims`, and `POST /admin/gamification/vouchers/:code/redeem`
    is the only thing that can burn it — unreachable from a counter.
  - *A third orphan rides along.* `/rewards/badges/check`,
    `/rewards/leaderboard/monthly` and the ADMIN-gated `/rewards/issue-monthly`
    write real discount-bearing rows into `step_rewards`, and nothing calls
    them, so no monthly reward is ever issued.

  **Not wired in this pass, deliberately.** Making it honest needs a product
  decision before it needs code: the reward catalog is commercial policy (what
  a milestone is worth, who funds the discount, how long it lives) and
  redemption is a counter workflow. Guessing either would be exactly the
  speculative console this lane was told not to build.

  **What closing the loop would require**, smallest honest version:
  1. *Decide who owns the catalog.* Either seed a default `health_milestones`
     set per tenant at provisioning — noting the lab-thresholds precedent above,
     a blind cross-tenant copy is the wrong shape — or accept that gamification
     stays dark until an operator populates it, and say so in the patient UI.
  2. *Put redemption where redemption happens.* A voucher lookup + redeem
     action on the staff app's pharmacy/billing counter screen, which means the
     endpoint must move off the `/api/v1/admin` mount (IP allowlist + admin
     step-up) onto a staff-role route, or gain a staff-reachable twin.
  3. *A catalog editor* in the admin portal — a table and three fields on top
     of the CRUD that already exists. Only worth building after (1).
  4. *Schedule or drop `/rewards/issue-monthly`.* Either a `withJobLock` cron
     issues monthly winners, or the badge/leaderboard half retires with the
     rest of `/api/v1/rewards/*`.

  Until then the surface is honest in the code: `adminGamificationRoutes.js`
  carries a header saying it has no client and pointing here. Do not re-report
  "unused admin gamification routes" as a fresh finding.

## Explicitly parked (re-audit lane J, 2026-08-24 — caller-less clinical surfaces, plus the one alert that was fixed)

Companion to the admin-surface section above; these are the *clinical* halves
of the same sweep.

**The census below was re-derived on 2026-08-24 (round 2), not extended.**
Round 1 of this section missed three whole subsystems, which makes the method
the defect, not the list. The corrected method, stated so it can be re-run:

1. *Source set.* Every `/api/v1…` string passed as the first argument of an
   `app.use(...)` in `apps/backend/src/app.js`: 171 distinct strings, of which
   the bare `/api/v1` mount (`infrastructureRoutes`) is skipped, leaving
   **170 prefixes** to census. The matcher must allow the prefix to sit on its
   own line: several mounts, `/api/v1/surgical` among them, are written across
   multiple lines, and a single-line-only extraction drops them silently.
2. *Match.* For each prefix, either the absolute `/api/v1<prefix>` (the form
   the admin console uses) **or** `<prefix>` at the start of a string literal
   (the form the Dart clients use — they pass paths relative to a base URL
   that already carries `/api/v1`). Matching only the absolute form
   under-counts; matching the bare segment over-counts, e.g. the patient app's
   `/steps/rewards` would score as a caller of `/api/v1/rewards`.
3. *Client set.* `apps/staff/lib`, `apps/patient/lib`, `apps/admin/src`,
   `packages/vhhealth_core/lib` — **and `apps/device-gateway`**, which round 1
   did not name and which is the only caller of `/api/v1/ingest/cold-chain`.
4. *Exclusions.* The whole of `packages/vhhealth_core/lib/api/generated/`,
   plus `apps/admin/src/lib/openapi.generated.ts`. Round 1 named only
   `openapi.swagger.dart` and `openapi.generated.ts`, and that omission is
   what hid the three subsystems added below: the literal `/api/v1/...`
   strings live in `openapi.swagger.chopper.dart`, a
   `part of 'openapi.swagger.dart'` emitted for **every** path in the spec.
   Grep a prefix while excluding only the two named files and you get a hit
   for every surface on the platform — so any surface whose *only* hit is
   generated reads as "has a caller".
5. *Adjudicate the router, not the string.* A zero-hit prefix is not
   automatically a caller-less surface. Some prefixes are aliases of a router
   that is reachable elsewhere: `/api/v1/pharmacy-supply` mounts the same
   `routes/admin/pharmacySupplyRoutes.js` the admin console calls at
   `/api/v1/admin/pharmacy-supply`.

**Output: 47 of the 170 prefixes have no client hit.** Dispositions below sum
to those 47.

They do NOT prove the census complete. The prefix list was derived
mechanically from mount paths, and at least one real prefix — `/api/v1/documents`
— is absent from it, so the input set is known to be short. Read the buckets as
"every prefix this scan found", not "every prefix that exists"; a namespace
missing from the list carries no disposition and no verdict.

- **Not a router (2).** `/api/v1/auth/request-otp` and
  `/api/v1/auth/verify-otp` are App Check *middleware* mounts layered over
  paths `authRoutes` serves.
- **Parameterised mount path, invisible to a literal match (7).**
  `/api/v1/admissions/:admissionId/tpa-enhancement` and the six
  `…/witness-approvals/:id/approve` approval-host mounts. A caller interpolates
  the id, so the absence of a literal hit proves nothing about these.
- **Alias of a router reachable elsewhere (2).** `/api/v1/pharmacy-supply`
  (above) and `/api/v1/pharmacy-orders/inventory/v2`, which mounts the same
  router as `/api/v1/pharmacy/inventory/v2` — called by both the staff app and
  the admin console.
- **External / machine-to-machine by design (4).** `/api/v1/uhi` and
  `/api/v1/integrations/nhcx` (public signed gateway callbacks),
  `/api/v1/scim/v2` (IdP provisioning), `/api/v1/cds-services` (CDS Hooks,
  "consumed by external EHR systems" per `app.js`). No in-repo client is
  expected for any of them.
- **Already parked (4).** `/api/v1/admin/gamification` in the section above;
  `/api/v1/admin/surgical` (the deprecated 308 covered by the surgical entry),
  `/api/v1/research` and `/api/v1/rewards` below.
- **Documented below for the first time (3).** `/api/v1/paediatric`,
  `/api/v1/integrity`, `/api/v1/bed-inspections`.
- **Not adjudicated — the standing backlog for the next lane (25).**
  `/api/v1/abdm/enrolment`, `/api/v1/abdm/hiu`, `/api/v1/admin/uhi`,
  `/api/v1/adoption`, `/api/v1/billing/revenue-cycle`, `/api/v1/care-pathways`,
  `/api/v1/clinical-ai/control`,
  `/api/v1/clinical-continuity/activation-transitions`,
  `/api/v1/clinical/assessments`, `/api/v1/emr/mar`, `/api/v1/entitlements`,
  `/api/v1/front-desk/abdm/share-intakes`, `/api/v1/hl7-feeds`, `/api/v1/ipd`,
  `/api/v1/lab/release`, `/api/v1/nursing/mar`, `/api/v1/otp`, `/api/v1/pacs`,
  `/api/v1/patient`, `/api/v1/patient-access/break-glass`,
  `/api/v1/patient/chatbot`, `/api/v1/patient/virtual-ward`, `/api/v1/search`,
  `/api/v1/sessions`, `/api/v1/storage`. These are **named, not cleared** —
  each is a zero-hit prefix that nobody has yet checked for an alias mount, an
  internal caller, or a real gap. The next lane starts from this list rather
  than from scratch.

Two migrations come out of this work —
`src/migrations/730_ward_pharmacy_indent_notification_backlog_demotion.sql`,
described under the ward-indent section below, and
`src/migrations/731_hl7_feed_subscription_default_includes_transfers.sql`,
described under the outbound-HL7 section below. 729 was the previous highest.

### Outbound HL7 transfer feed — the DEFAULT is fixed, existing subscriptions must opt in `[OPERATOR]`

Round 2 of this lane added the outbound transfer event (`emitTransferAdt`,
ADT^A02, fired after a bed move commits) and shipped it unreachable:
`queueFeedMessage` fans out with `$type = ANY(message_types)`, and the platform
default for `hl7_feed_subscriptions.message_types` — both the column DEFAULT
from migration 283 and the fallback in `createSubscription` — listed A01, A03
and ORU^R01 only. Every feed created with platform defaults had the new emitter
fan out to **zero** subscriptions.

**Shipped:** migration 731 moves the column DEFAULT, and
`DEFAULT_FEED_MESSAGE_TYPES` in `src/services/hl7/hl7OutboundService.js` moves
the default the HTTP API actually applies, both to
`ADT^A01, ADT^A02, ADT^A03, ORU^R01` — the four types the platform emits
automatically. `src/tests/unit/hl7OutboundTransferAdt.test.js` pins the service
constant against the column default as projected into `prisma/schema.prisma`, so
the two cannot drift. A subscriber that must not receive transfers still passes
an explicit `message_types` at create time.

**Not shipped, and deliberately: existing subscriptions are not backfilled.**
`message_types` is the only stored record of what a downstream system agreed to
receive, and nothing in the row distinguishes "the operator accepted the
platform default" from "the operator chose exactly these three". Guessing wrong
is not a one-message mistake: an HL7 receiver that does not know a message type
answers with an application reject, `recordTransportOutcome` then marks the
message `reconciliation_required` / `held_owner_reconciliation`,
`applyAcknowledgementToCursorTx` moves that subscription's delivery cursor to
`paused_rejected`, and `claimPendingFeedMessages` refuses to claim **any**
further message for a subscription whose cursor is not `ready` (it also refuses
anything queued behind a message that is not acknowledged `aa`). One rejected
A02 therefore stops that subscriber's admissions, discharges and lab results
until an owner reconciles by hand. Enrolling a live third-party interface into a
message type it never agreed to is an interface-contract change, and it is not a
migration's to make.

**Operator action, per existing subscription that should receive transfers.**
First confirm with the receiving system's owner that it accepts ADT^A02 — see
the paragraph above for what happens if it does not. Then either:

1. Re-run the create/upsert API, `POST /api/v1/hl7-feeds/subscriptions`, with
   the same `name` and the full desired `message_types`. **Sharp edge:** that
   upsert overwrites `endpoint_url` and `auth_header` with whatever the request
   carries, and `auth_header` is encrypted at rest and never returned by
   `GET /subscriptions` — omitting it clears the credential with no way to read
   the old value back. Use this only if you still hold the endpoint's auth
   header. (There is no admin-console page for HL7 feeds; `/api/v1/hl7-feeds`
   is on the un-adjudicated caller-less list above.)
2. Otherwise add the type in place, which leaves the credential alone:

   ```sql
   UPDATE hl7_feed_subscriptions
      SET message_types = array_append(message_types, 'ADT^A02'),
          updated_at = NOW()
    WHERE tenant_id = '<tenant-uuid>'::uuid
      AND name = '<subscription name>'
      AND NOT ('ADT^A02' = ANY(message_types));
   ```

**Follow-up worth a separate change (not this lane's):** the credential-wiping
upsert in option 1 is a latent hazard independent of A02 — `createSubscription`
is the only write path for `message_types`, it is an upsert on `(tenant_id,
name)`, and it always writes `auth_header` from the request body. A dedicated
scope-update path (or a `COALESCE` that keeps the stored header when the field
is absent, with an explicit way to clear it) would remove the trap.

### Pharmacy ward indents — the alert is FIXED, the surface is QUEUED

What exists: live clinical writes auto-create `ward_indents` rows at status
`'requested'` — `orderEntryService.js` on every inpatient CPOE medication
order, and `admissionService.js` on every ER order carried into an admission,
both through `ipdSupportService.createWardIndentForClinicalMedicationOrder`.
The lifecycle that would move a row on (approve / reject / issue / receive) is
published on three prefixes — `/api/v1/pharmacy/ward-indents`,
`/api/v1/pharmacy-orders/ward-indents`, `/api/v1/ipd/ward-indents` — and has
**no caller in any client**. The staff app's `PharmacyScreen` covers the OPD
order queue, catalog, inventory and expiry alerts and has no ward-indent list;
the admin console's pharmacy dashboard has Overview / Orders / Catalog /
Expiry / Schedule-Register tabs and no indent tab. So the queue filled and
could never be worked.

The harm was not the rows — it was the page. The alert went out at priority
`HIGH` with the body *"Please review the pharmacy ward indent for
dispensing"*, and in the staff app `NotificationItem.isHighPriority` is true
for `HIGH`, which puts the row into the Safety Center feed beside SOS and
critical labs, on the 15-minute escalation ladder ("Escalates in N min if
unread" → "Escalated until acknowledged") — an escalation nobody could clear
by doing the work, because no screen did the work. Tapping it made that worse:
`_defaultRouteForType()` maps any type containing `PHARMACY` to `/pharmacy`,
where the indent is not visible.

**What shipped:** the alert is retained but demoted. It still names the drug
and the ward — it is the only system-generated pharmacy signal for an
inpatient medication order, so silencing it outright would have been a
clinical information regression — but it now goes out at `LOW`, titled "Ward
drug indent recorded", with a body that states the manual fallback instead of
instructing a screen that does not exist, and with
`data.dispatch_surface_available: false` so a client can tell "act on this"
from "for your information". `LOW` keeps it out of the Safety Center feed and
the notifications screen's "critical" filter. The auto-creation was
deliberately **not** gated: the rows are the only linkage between a clinical
order and pharmacy demand, `drugChartService` renders them back to ward staff
as each order's `pharmacy_status`, and gating would have meant adding a
conditional to two clinical write paths for no safety gain.

**The demotion is forward-only, so it needed a backlog migration.** The gate is
read at dispatch time: it decides the priority of rows written after it
deploys and cannot reach rows already in `notifications`. Left alone, every
pre-existing `WARD_PHARMACY_INDENT` row keeps both behaviours the demotion
exists to stop. (a) In the staff app they stay `isHighPriority` — and on this
type that flag is driven by **the priority column alone**: `isHighPriority` is
priority HIGH/CRITICAL *or* a type containing CRITICAL / EMERGENCY / SOS
(`notification_provider.dart:119-124`), and `WARD_PHARMACY_INDENT` contains
none of the three. So they remain in the Safety Center feed — which selects
`isHighPriority || isInvestigationAlert` (`safety_center_screen.dart:171`;
`isInvestigationAlert` is false here too, it matches LAB / INVESTIGATION /
CRITICAL_VALUE / RADIOLOGY, provider lines 136-141) — and in the notifications
screen's "critical" filter (`notifications_screen.dart:117`), with
`safetyEscalationLabel()` (`safety_center_screen.dart:41-48`) still rendering
"Escalates in N min if unread" and then "Escalated until acknowledged".
(b) On the server — the half round 1 never mentioned, and the strongest
argument for the demotion — `notificationService.runUnreadCriticalEscalation`
(`notificationService.js:747-837`), driven by the `*/10 * * * *`
`unread-critical-notification-escalation` cron in `src/utils/scheduler.js:910-912`,
selects *unread* rows older than `CRITICAL_NOTIFICATION_ESCALATION_MINUTES`
(default 15) whose `UPPER(priority)` is HIGH or CRITICAL **or** whose type is
LIKE one of `%CRITICAL%` / `%EMERGENCY%` / `%SOS%` / `%CODE_BLUE%` /
`%LAB_ALERT%` (`notificationService.js:763-770`). `WARD_PHARMACY_INDENT`
matches none of those five patterns either, so here too the priority column is
the only thing putting the row in the candidate set — which is precisely why
changing that one column is a sufficient fix. Every match writes a
`notification_events` `'auto_escalated'` row and pages ADMIN / SUPER_ADMIN with
a HIGH `CRITICAL_ALERT_ESCALATION` notification. Its `NOT EXISTS` guard
(`notificationService.js:772-777`) fires that at most once per notification, so
the backlog is bounded rather than a repeating page — but each
not-yet-escalated row still costs one admin escalation for an indent nobody can
dispense.

`src/migrations/730_ward_pharmacy_indent_notification_backlog_demotion.sql`
closes that. It sets `priority = 'LOW'` on every `WARD_PHARMACY_INDENT` row
that was dispatched while no surface existed (rows carrying
`data.dispatch_surface_available = true` are excluded, so replaying the file
after the dispensing release cannot silence a live alert), read and unread
alike — a read row left at HIGH would sit in the "critical" filter forever.
It changes **priority only**.

**What the operator sees after it runs**, for those pre-existing rows: they
leave the Safety Center feed and the notifications screen's "critical" filter
(both keyed on `isHighPriority`, now false); they stay in the list under
"all" / "unread" carrying the title and body that were actually delivered;
anywhere `safetyEscalationLabel()` still runs over one, an unread row reads
"Monitor until acknowledged" and a read row "Acknowledged" instead of an
escalation countdown; and `runUnreadCriticalEscalation` stops selecting them
altogether — `'LOW'` is not in `('HIGH','CRITICAL')` and the type matches none
of the five LIKE patterns — so no further `'auto_escalated'` events and no
further ADMIN / SUPER_ADMIN `CRITICAL_ALERT_ESCALATION` pages are raised for
ward indents. Escalations that already fired are untouched, including the HIGH
`CRITICAL_ALERT_ESCALATION` rows already sitting in admin feeds; the cron
excludes that type from its own candidate set (`notificationService.js:771`),
so those never escalate further either.

**How it runs** (rewritten in round 3, after review found the first draft
unsafe; lock behaviour corrected in round 4 and measured). The predicate is an
exact `type = 'WARD_PHARMACY_INDENT'`, which uses `notifications_type_idx`
(`000_baseline.sql:30736`). The first draft matched on
`UPPER(COALESCE(type,''))`, which that index cannot serve, so the file became a
full scan of one of the largest tables in the database — inside the PreSync
Job that gates the release. Measured with `EXPLAIN (ANALYZE, BUFFERS)` on a
throwaway PostgreSQL 17.9 fixture of 404,068 `notifications` rows (4,065 of
type `WARD_PHARMACY_INDENT`, 4,000 of them demotable): the old predicate read
9,648 buffers just to *find* its rows (400,065 removed by filter; 54,959
buffers and 303 ms for the whole single-shot UPDATE); the exact predicate found
them with a Bitmap Index Scan reading 6 index buffers plus 131 heap blocks, and
one 1,000-row batch took 12.8 ms. Treat the heap-block figure as
fixture-specific — it tracks how tightly the matching rows are clustered on
disk. The claim that carries is structural: the exact predicate's cost scales
with the number of *matching* rows, the `UPPER()` form's with the size of
`notifications`. The exact match is also *complete*, not merely cheaper: the
single writer stores `type` upper-cased and `priority` as exactly one of HIGH /
MEDIUM / LOW (`staffNotificationService.js:33-43`), and both columns are NOT
NULL, so the COALESCE wrappers were dead code.

The UPDATE is batched at 1,000 rows per transaction under `-- @no-transaction`,
so at most 1,000 row locks are held at any instant, no long-lived transaction
sits on `notifications`, and an interrupted run resumes where it stopped rather
than restarting. **Round 3's comment described the lock wait backwards**, and
that is now fixed in both the file and here. Once a batch holds its rows, a
concurrent writer (a staff mark-as-read) waits only for that batch — true. But
the other direction was the dangerous one: with a plain `FOR UPDATE`, a writer
that got there *first* makes the **migration** wait, and the appliers' session
`lock_timeout = '15s'` turns that wait into SQLSTATE 55P03, which aborts the
file and the PreSync Job — i.e. the release. Measured: one uncommitted
`SELECT … FOR UPDATE` on a single row in batch 3 blocked the migration for
15.1 s and killed it with 2,000 of 4,000 rows committed. The batch CTE now
takes `FOR UPDATE SKIP LOCKED`, and the same scenario completes in 65 ms.
**The trade, stated because it is real:** a successful run records the file and
it never runs again, so a row locked at the instant its batch is built *and*
still locked on the pass that ends the loop keeps its old priority for good.
The migration counts those and raises a WARNING naming the number; one leftover
costs one row in the Safety Center feed plus at most one admin escalation page,
against a blocked release for the alternative. The count query and the
one-statement `UPDATE` that finishes any leftovers are both in the migration's
header. Operator-visible consequences of the row-level change, all three
deliberate:

- Pre-existing rows keep the body that was actually delivered, *"Please review
  the pharmacy ward indent for dispensing"*, which names a screen that does not
  exist. Rewriting delivered message history — push included — is a bigger
  claim than this defect justifies, so old rows read differently from new ones.
- Pre-existing rows carry no `dispatch_surface_available` key at all. A client
  reading it must treat **absent as unknown**, not as `false`.
- `notification_events` is untouched: escalations that already fired stay in
  the audit trail with the HIGH priority they fired at snapshotted in
  `notification_priority`. The migration changes what the feed shows and what
  the cron will still pick up; it does not erase what happened.

**What is queued:** a worklist that calls the existing lifecycle endpoints.
The cheapest route is an admin-console tab — `api/v1/pharmacy` and
`api/v1/pharmacy-orders` are already on the `pharmacyAdminRoutes` proxy
allowlist, so no proxy change is needed — with a staff-app surface after it.
In the **same release** that ships it, the operator sets
`PHARMACY_WARD_INDENT_PUSH_ENABLED=true`, which restores the `HIGH` priority
and the dispatch wording with no code change
(`ipdSupportService.wardIndentDispatchSurfaceEnabled()`). The flag is
deliberately **not** declared in `validateEnv.js`: that schema is
`.unknown(true)`, and a `Joi.valid('true','false')` declaration would turn an
operator typo (`1`, `yes`, `on`) into a boot crash instead of leaving the safe
default.

**What the operator sees meanwhile**, and must plan around:

1. `ward_indents` keeps accumulating rows at `'requested'`. They are
   inspectable today via `GET /api/v1/pharmacy/ward-indents?status=requested`
   (allowlisted through the admin proxy) or directly in the DB.
2. Ward staff still see the per-order `pharmacy_status` on the inpatient drug
   chart; it reads `requested` and never advances.
3. Pharmacy staff still get one `WARD_PHARMACY_INDENT` notification per new
   indent, at `LOW`, naming the drug and the ward. Rows notified *before* this
   release are demoted to `LOW` by migration 730 but keep their original
   wording, so the feed carries two phrasings of the same alert. Nothing
   retires the old ones on a timer: no cron deletes `notifications` rows —
   the only age-based delete is the operator-triggered
   `DELETE /api/v1/admin/notifications/cleanup`
   (`adminNotificationService.cleanupNotifications`, line 663), so the two
   phrasings coexist until an admin runs that by hand.
4. **Inpatient ward-pharmacy charges are not billed from indents.**
   `billingV2Service` emits a `source_ref_type: 'ward_indent'` line only for
   indents at `'issued'` or `'received'`, so no such line is produced today.
   Inpatient drug charges must be raised by the existing manual/counter route
   until the lifecycle has a caller. This is a pre-existing consequence of the
   missing surface, not something this change introduced.

### Parked, not built (product decisions, not defect fixes)

- **Research registry** (`/api/v1/research`) — the entire router, all 12
  endpoints (`POST/GET /registries`, `POST/GET /registries/:id/forms`,
  `POST /forms/:id/publish`, `POST/GET /registries/:id/enrollments`,
  `POST /enrollments/:id/withdraw`, `PUT /forms/:id/responses`,
  `POST /responses/:id/submit`, `POST /responses/:id/verify`,
  `GET /registries/:id/export`) — has **zero callers** in any client. Missing:
  a consent-aware enrolment and CRF-capture console. Closing it needs a
  product decision that VH runs research registries at all, then that console
  plus an IRB/consent story behind `guardEnrollmentCreate` and the export
  path. Risk of leaving it: mounted behind clinical-staff RBAC with
  `patientAccessGuard` and `phiAccessLogger('RESEARCH')`, its only current
  effect is attack and audit surface — a PHI export endpoint no legitimate
  workflow uses. **Deleting** the router is a valid close and is cheaper than
  building the console.

- **Step-challenge rewards** (`/api/v1/rewards/*`) — six endpoints
  (`GET /badges`, `POST /badges/check`, `GET /vouchers`,
  `GET /leaderboard/monthly`, `GET /my-monthly-rank`, `POST /issue-monthly`),
  none called by any client, and no cron issues monthly rewards
  (`src/utils/scheduler.js` names nothing reward-related). The gamification
  entry in the section above covers the wider broken loop; two facts belong
  here specifically. (a) The admin proxy allowlist
  (`apps/admin/src/lib/proxyPermissions.ts`) carries **no `rewards` prefix**,
  so even a future console could not trigger issuance through it — closing
  this needs an allowlist entry as well as a page. (b) The patient app reads a
  **different endpoint entirely**: its "Your Rewards" tab calls
  `GET /api/v1/steps/rewards` (`stepsRoutes.js`), which selects the same
  `step_rewards` table that only the caller-less `stepRewardsRoutes.js`
  writes. So the tab is structurally always empty, and the reward tiers the
  leaderboard names ("Free consultation + 10% off pharmacy & investigations")
  are display text nothing issues. Risk of leaving it: a promise shown to
  patients that the platform cannot keep — a customer-trust issue, not a
  clinical one.

- **Surgical documentation** (`/api/v1/surgical`, plus the deprecated 308 from
  `/api/v1/admin/surgical`) — **20 of 21 endpoints are caller-less**. The one
  live caller is `PUT /surgical/safety/:scheduleId/:phase` (WHO checklist
  phases) from `apps/staff/lib/core/services/theatre_api_service.dart`. With
  no caller: the pre-op checklist (`GET/PUT /preop/:scheduleId`,
  `GET /preop`), intra-op notes and finalise (`POST/GET /intraop`,
  `PATCH /intraop/:id/finalize`), post-op notes and finalise
  (`POST/GET /postop`, `PATCH /postop/:id/finalize`), the anesthesia record
  (`PUT/GET /anesthesia/:scheduleId`, `PATCH /anesthesia/:scheduleId/finalize`),
  the implant registry (`POST/GET /implants`, `PATCH /implants/:id/remove`),
  complications (`POST/GET /complications`,
  `PATCH /complications/:id/acknowledge`, `PATCH /complications/:id/resolve`),
  and even `GET /safety/:scheduleId` — the read-back of the checklist the one
  live caller writes. Closing it needs an OT-staff surface for each phase of
  the perioperative record. Risk of leaving it: surgical documentation and the
  implant registry are medico-legal records with statutory retention; the
  hospital keeps them on paper while the platform holds an empty parallel
  schema, so any report built on these tables reads zero.

- **Maternity structured capture** — ANC visits, deliveries, newborn/APGAR and
  postnatal visits have no client. The staff app calls only labor and
  partograph (`/maternity/labor-admissions/active`,
  `/maternity/labor-admissions/:id`, `GET /maternity/partograph/labor/:id`,
  `POST /maternity/partograph`); the patient app calls only the portal
  endpoints (`/portal/maternity/` `timeline`, `packages`, `anc-advice`,
  `fetal-kicks`, `supplements/:id/reminder`). Nothing calls
  `POST /maternity/pregnancies`, `PATCH /maternity/pregnancies/:id`,
  `POST /maternity/anc-visits`, `POST /maternity/deliveries`,
  `POST /maternity/newborns`, `POST /maternity/newborns/:id/apgar` or
  `POST /maternity/postnatal-visits`. That is a statement about the *routes*:
  `maternity_pregnancies` itself does have a live writer elsewhere — see the
  correction immediately below.

  **Corrected 2026-08-24 (round 2).** The earlier text here said the patient
  ANC timeline "resolves to 'no active pregnancy' for every patient". That is
  factually wrong about the runtime, and the true symptom is worse.

  `maternity_pregnancies` has a live writer *outside* the maternity router. The
  admin console's walk-in dialog
  (`apps/admin/src/app/(with-auth)/dashboard/appointments/components/WalkInDialog.tsx`)
  shows an ANC block whenever the chosen department name contains
  `obgyn` / `obstetrics` / `anc` / `gyna`, **requires** an LMP date in that
  block, and posts it to `POST /api/v1/appointments/walk-in`.
  `appointmentWorkflowController.registerWalkIn` (the E-12 block, ~2245-2340)
  then inserts a `maternity_pregnancies` row at `status = 'ongoing'` —
  idempotent per patient, EDD derived from LMP, with the same canonical
  timeline + audit pair `maternityService.createPregnancy` writes. So for every
  OBGYN walk-in booked through the admin console a pregnancy row exists.

  **What the patient actually sees is therefore a populated screen with one
  section permanently missing, not an empty state.**
  `GET /api/v1/portal/maternity/timeline` →
  `getAncTimelineForPatient` → `getAncTimelineForPregnancy` fills the pregnancy
  header (gestational age, EDD), booked ANC appointments (from `appointments`),
  BP/weight captured on the general vitals screen (from `vitals_chart`),
  supplements auto-propagated from prescriptions (`maternity_supplements` via
  `maybePropagateAncSupplements`), carried-forward supplement courses from
  `e_prescriptions`, patient-logged fetal kicks, and an LMP-derived visit
  schedule — all from tables that *do* have live writers. The one thing that is
  structurally always empty is `maternity_anc_visits` — not because no code
  writes it, but because its only writer, `maternityService.recordAncVisit`
  (the `INSERT INTO maternity_anc_visits` at
  `services/maternity/maternityService.js:593`), is reachable from exactly one
  place, `maternityRoutes.js:99` serving the caller-less
  `POST /maternity/anc-visits`. No cron and no other service calls it. And
  `anc_timeline_screen.dart` renders the "visits so far" list only
  `if (visitsAsc.isNotEmpty)` (line 340), with no "not recorded here" marker
  and no `else` branch — so the
  clinical record of each antenatal visit (BP, weight, fundal height, fetal
  heart rate, Hb, urine albumin/sugar, IFA/calcium, TT dose) is simply absent
  from an otherwise live-looking tracker. An empty state says "nothing here";
  this says "here is your pregnancy, and no antenatal care was recorded".

  Two further consequences of the same asymmetry, both verified: the walk-in
  writer never *closes* an episode — only `recordDelivery` moves a pregnancy to
  `'delivered'`, and `POST /maternity/deliveries` has no caller — so the row
  stays `'ongoing'` indefinitely, including after the birth; and `high_risk` /
  `high_risk_reasons` are set only by `createPregnancy` and `updatePregnancy`,
  both caller-less, so the header's high-risk chip can never render for a
  walk-in-created pregnancy.

  Closing it needs staff capture screens for each ANC visit **and** for the
  delivery/closure transition first — the patient screen is already built and
  waiting on data. Risk of leaving it: a patient-visible feature that presents
  a permanently empty clinical record as though it were complete, an episode
  that never ends, and a maternity dataset (ANC coverage, delivery outcomes,
  APGAR, postnatal follow-up) that cannot be reported on.

- **Paediatric immunisations** (`/api/v1/paediatric`) — five endpoints
  (`GET /immunisations/catalogue`, `POST /immunisations/seed`,
  `GET /immunisations/patient/:patientUid`,
  `GET /immunisations/patient/:patientUid/due`,
  `POST /immunisations/:id/given`), all `requireStaffOrAdmin` behind
  `PAEDIATRIC_ROUTE_ROLES` + `patientAccessGuard('PAEDIATRIC_IMMUNISATION')` +
  `phiAccessLogger`, with **zero callers** in any client.

  Same harm shape as the maternity entry above.
  `services/paediatric/paediatricImmunisationService.js` is the *only* writer
  of `patient_immunisations` anywhere in the backend — the upsert in
  `seedScheduleForPatient` and the status update in `recordDose` — and both
  are reachable only from those routes. No cron calls either. So the table can
  only ever be empty in production.

  Its one production reader is live:
  `nicuPicuChartingService.getNicuPicuChartView` selects the patient's
  `scheduled` doses and returns them as `nicu.immunisations_due`, and
  `patientCommandBoardService` attaches that view as `icu_chart`
  (`services/emr/patientCommandBoardService.js:709-773`) to command-board rows
  backed by an active NICU/PICU `icu_admissions` row — for roles cleared to see
  the ICU chart, and capped at the first `ICU_CHART_ENRICH_LIMIT = 40` such
  rows per page (line 21) — which the staff app's patient command
  board renders through `NicuPicuChartPanel`
  (`apps/staff/lib/features/emr/widgets/nicu_picu_chart_panel.dart`). A live
  neonatal chart ships a field that is structurally always `[]`. Today
  `NicuPicuChartPanel` does not render `immunisations_due` — the only place
  that key appears in application code is where the backend produces it,
  `nicuPicuChartingService.js:1607` — so the emptiness is invisible rather than
  misleading — but the first client that renders it will read "nothing due"
  for every neonate.

  Do not confuse this with the newborn schedule, which **does have a client**:
  the admin console's Newborn immunisation page (`/dashboard/immunisations`)
  calls
  `/maternity/immunisations/*` and `/maternity/newborns/:id/immunisations*`,
  served by `services/maternity/immunisationService.js` against a different
  table, `newborn_immunisations`. `seedScheduleForPatient` links the two via
  `newborn_immunisation_id`, which is precisely why the paediatric half looks
  covered when it is not. Closing it needs a staff well-baby / paediatric
  immunisation screen. Risk of leaving it: any report over
  `patient_immunisations` reads zero, and `nicu.immunisations_due` is a
  permanently empty field on a live neonatal chart payload.

- **Document integrity** (`/api/v1/integrity`) — four endpoints
  (`POST /sign`, `GET /signatures/:id/verify`,
  `GET /signatures/:documentType/:documentId`, `GET /audit-chain/verify`)
  behind `requireRole(...CLINICAL_STAFF_ROLES)` +
  `phiAccessLogger('DOCUMENT_SIGNATURE')`, with **zero callers** in any client.

  This one is not an empty table. `clinical_document_signatures` has four
  internal writers through `documentIntegrityService.signDocument` /
  `signDocumentTx`: the encounter sign transition
  (`POST /api/v1/encounters/:id/sign` — verified live, the staff app reaches it
  via `clinical_platform_api_service.dart`'s `_transition(encounterId, 'sign')`),
  plus `diagnosticResultActionService`, `inpatientPathwayDomainService` and
  `referralClosedLoopService`. Signatures accumulate.

  **Split the four endpoints before judging them.** `GET /audit-chain/verify`
  is caller-less but *not* a safety gap: `scheduler.js` already runs
  `runAuditChainVerification` hourly under `withJobLock` — it recomputes the
  per-tenant chain on `clinical_audit_events` for every active tenant and fires
  a structured `AUDIT CHAIN TAMPER DETECTED` error log plus an
  `AUDIT_CHAIN_TAMPERED` security webhook on any break. The endpoint is an
  on-demand duplicate of a control that is already covered. Likewise
  `POST /sign` largely duplicates what the encounter route does internally.

  The real gap is the two **read** endpoints. `verifyDocumentSignature` and
  `listDocumentSignatures` have no caller anywhere — no client, no cron, no
  other service. So a signed clinical document's content hash is never
  recomputed after the moment of signing, and nothing in the product can show
  who signed a given document and when: the encounter sign response returns
  the signature it just created, and after that the record is write-only. Risk
  of leaving it: an e-signature nobody can re-verify is a claim rather than a
  control, and per-document tamper evidence — as distinct from the audit chain,
  which is watched — is never checked. Closing it needs a signature panel on
  the encounter / document view that calls
  `GET /integrity/signatures/:documentType/:documentId` and
  `GET /integrity/signatures/:id/verify`.

- **Bed inspections** (`/api/v1/bed-inspections`) — five endpoints
  (`POST /`, `POST /:id/decide`, `GET /patient/:patientUid/active`,
  `GET /appointment/:appointmentId`, `POST /expire-stale`), all
  `requireStaffOrAdmin` behind `BED_INSPECTION_ROUTE_ROLES`, with **zero
  callers** in any client.

  This is the D1 consumer-choice flow: staff record which beds were shown to a
  patient or attender and which one was chosen.
  `services/bed/bedInspectionService.js` is the only writer of
  `bed_inspections`, and its only entry points are those five routes plus the
  hourly `expire-bed-inspections` cron, which calls `expireStaleInspections()`
  — a sweeper that expires existing rows, never a source of new ones. So the
  table can only ever be empty.

  Worth recording because it is an operator-visible untruth: that cron's
  comment in `src/utils/scheduler.js` says it expires stale rows *"so the
  receptionist UI doesn't keep showing stale shortlists"*. There is no
  receptionist UI — nothing calls these endpoints. That comment has now been
  corrected in `scheduler.js` (the file was in scope after all, via a sibling
  change in the same wave), so the cron no longer claims a consumer it lacks.

  Risk of leaving it: a bed-choice record is the evidence that a patient was
  offered and accepted a bed class, which is what a billing dispute turns on.
  The hospital does this at the counter on paper while the platform holds an
  empty parallel record and an hourly job sweeping nothing. Closing it needs an
  inspection step inside the admission / bed-allocation flow.

- **Ask-a-Doubt staff replies — already fixed by an earlier lane; recorded
  here as the current true state.** `feedbackService.respondToFeedback`, its
  `getFeedbackById` permission helper and the `POST /api/v1/feedback/respond`
  route were **removed** in the re-audit I tenancy sweep. They wrote to
  `feedback_responses`, a table present in no migration, absent from
  `000_baseline.sql` and with no Prisma model, so every call raised 42P01 and
  surfaced as a 500 — the staff answer was never stored. The removal is pinned
  by `src/tests/unit/feedbackStaffReplyPathRemoved.test.js`, which fails if any
  service, controller or route names `feedback_responses` again. **Do not
  recreate the table.**

  What remains true after that work: patients can still submit Ask-a-Doubt
  questions
  (`apps/patient/lib/features/feedback/screens/ask_a_doubt_screen.dart` →
  `POST /api/v1/feedback`), and **there is still no path for staff to answer
  one**. Nothing anywhere writes `response_status = 'responded'`, so
  `responded_count` is structurally 0.

  **The admin console no longer advertises otherwise** (round 3). This entry
  previously ended by noting that `/dashboard/feedback` still rendered a
  "Response Rate" KPI reading 0% forever and a `responded_by` /
  `responded_at` block that could never populate — an operator reads a 0% KPI
  as "we answer nobody", not as "the product has no reply feature". Both are
  gone: the overview strip carries only the totals the backend can actually
  compute, the detail panel no longer reserves a "Response:" section, and the
  page's own comment records why. Pinned by
  `apps/admin/src/__tests__/dashboard/feedback/page.test.tsx`. The NPS tab keeps
  the one response rate this platform can measure, and that one is real.

  Closing the underlying gap still needs a response table with a forward-only migration, a staff
  compose surface **and** a patient-side render of the answer — all three or
  none, since the removed path had no read side either. Risk of leaving it:
  patients are invited to ask a question nobody can answer in the product;
  direct them to the NPS / service-recovery surface
  (`npsService.submitNpsResponse`), which is wired end to end.

## Explicitly parked (re-audit lane J, 2026-08-24 — patient notification dead-ends)

Three patient-facing notification paths reach the patient and then stop short of
a destination. They were found by the two source gates that now hold the line —
`src/tests/unit/patientPushFeedRowCensus.test.js` (every mechanism that can send
a patient a privacy-stripped push must also write the in-app row it points at)
and `src/tests/unit/patientInboxTypeRouting.test.js` (every `notifications.type`
written for a patient must be one `_handleNotificationTap` routes). Both gates
carry these three as an explicit, exact baseline: a fourth cannot join silently,
and fixing one of these fails the gate until its line is removed here and there.
They are parked rather than queued because each needs a decision or a surface
outside the backend lane that found them. **These entries are the park; the Jest
tables only point at them.**

Shared background, true of all three: `sendPushNotification` replaces the FCM
payload of every NORMAL-priority message with a generic *"You have a new update.
Open the app to view it."* landing on `/notifications`
(`sendPushNotification.js:36-43, :116-135`). The push deliberately carries no
readable content and no deep link, so the inbox row **is** the message, and the
row's `type` is the only thing that turns it back into a destination.

- **Diagnostic result ready — the push fires, the inbox row is never written.**
  `services/diagnostics/diagnosticResultPatientNotificationService.js` inserts
  straight into `notification_outbox` (raw SQL, inside the transaction that also
  writes the `diagnostic_result_patient_notifications` receipt) with
  `type = 'diagnostic_result_ready'`, the patient's uid as `recipient_id`, and a
  payload naming `route: '/portal/diagnostic-results'`.

  *What exists.* The outbox row, the drain, the push, the receipt, and — on the
  patient side — a real destination: `'diagnostic_result_ready'` **is** a case in
  `_handleNotificationTap` and pushes `/portal/diagnostic-results`. The type is
  also in `TYPE_TO_PREFERENCE_KEY` (→ `results_ready`), so a tenant that
  configures the in-app channel for results *does* get a routed row.

  *What is missing.* The default. With no tenant channel configuration,
  `resolveChannelsForOutboxRow` falls through to `legacyChannelsForOutboxRow`,
  which returns `['push']` for any row carrying a `recipient_id` — never
  `['inapp']` — and the drain writes a `notifications` row **only** when the
  resolved set contains `inapp`. The service writes none itself.

  *Patient-visible symptom.* The phone buzzes with "You have a new update",
  opens `/notifications`, and there is nothing new there. The report is sitting
  at `/portal/diagnostic-results` and nothing tells the patient so.

  *Shape of the fix.* One `recordPatientFeedNotification({ type:
  'diagnostic_result_ready', … })` next to the outbox insert (the helper is
  non-throwing by construction, so it cannot abort the clinical write). Parked
  because the release policy for diagnostic results is owned by the diagnostics
  lane — the outbox insert sits behind a `releaseDelayHours()` embargo and a
  release-state check, and adding a second patient-visible artefact to that path
  needs that owner's sign-off, not a drive-by edit.

- **Referral response ready — same shape, and no tenant setting can fix it.**
  `services/referral/referralClosedLoopService.js` inserts into
  `notification_outbox` with `type = 'referral_response_ready'` and payload
  `route: '/portal/referrals'`.

  *What exists.* The outbox row, the push, and the destination:
  `'referral_response_ready'` is a case in `_handleNotificationTap` and pushes
  `/portal/referrals`.

  *What is missing.* The row, permanently. Unlike the diagnostics case,
  `referral_response_ready` has **no entry in `TYPE_TO_PREFERENCE_KEY`**, so
  `preferenceKey` is null and `resolveChannelsForOutboxRow` returns the legacy
  `['push']` unconditionally. No tenant configuration exists that would make the
  drain write the in-app row.

  *Patient-visible symptom.* Identical: a content-free buzz into an empty inbox,
  while the referral update waits unannounced at `/portal/referrals`.

  *Shape of the fix.* Either `recordPatientFeedNotification({ type:
  'referral_response_ready', … })` beside the insert, or add the type to
  `TYPE_TO_PREFERENCE_KEY` so tenants can configure it — the second is a
  tenant-settings surface change (a new preference key appears in the admin
  console) and therefore a product decision, which is why this is parked with
  the first.

- **Engagement campaign — the row IS written, and it is inert on tap.** This is
  the other shape of dead end, and the only one of the three where the patient
  gets something in the inbox. `services/engagement/engagementCampaignService.js`
  queues `type = 'engagement_campaign'` with `data.channels = [row.channel]`,
  one channel per recipient row. `'inapp'` is an accepted engagement channel
  (`ENGAGEMENT_CHANNELS`), and `resolveChannelsForOutboxRow` has a dedicated
  branch that returns the campaign's own payload channels verbatim — so a
  campaign sent in-app reaches `dispatch()` with `['inapp']` and the dispatcher
  commits a `notifications` row typed `engagement_campaign`.

  *What is missing.* A `case 'engagement_campaign'` in `_handleNotificationTap`.
  Without one the row renders with its title and body and tapping it only marks
  it read.

  *Patient-visible symptom.* A campaign message that looks like every other
  inbox item and does nothing when tapped — worst for the recall campaigns,
  where the message is an instruction to act (`CAMPAIGN_TYPES` covers
  `appointment_recall`, `no_show_recall`, `feedback_nps_request`,
  `generic_follow_up_reminder`, `rpm_enrollment_reminder`) and the tap does not
  take the patient to the thing to act on.

  *Why it is not fixed here, stated accurately.* Until 2026-08-24 both gates
  dispositioned this as "another agent's file — the engagement module owns the
  fix". That is **no longer true**: this same working tree adds
  `routes/engagement/engagementListQueries.js` and three engagement GET routes.
  The honest reason is different. There are two candidate fixes and neither
  belongs to a backend notification lane. (a) Add the `case` in the patient app —
  out of scope for this lane, and it needs a destination decision: a campaign is
  arbitrary operator-authored content, so there is no single screen it is "about".
  (b) Remap the feed-row type through `TRANSPORT_TYPE_TO_FEED_TYPE` to something
  already routed — rejected outright, because pointing every campaign at, say,
  `/appointments` would make the tap tell the patient something the message does
  not say. The real question is a product one: should tapping a campaign have a
  destination at all (deep-link off `data.template_kind`, which the queue already
  carries), or is a campaign a read-only broadcast like the operator
  announcements the tap handler deliberately falls through? Answering that closes
  it; guessing at it is exactly the "operator-visible string claiming behaviour
  the code does not have" failure this re-audit exists to stop.

## Explicitly parked (re-audit lane J, 2026-08-24 — round 4: three decisions that were not this lane's to make)

Round 4 closed lane J by making claims match code rather than building a fourth
reachability path. Each item below was a decision an owner had to take; the code
described itself accurately in the meantime. **One of the three — the BCMA
wristband — was decided by the platform owner on 2026-08-25 and is now built;
its entry is kept here, marked `[DONE]`, so the decision sits with the question
it answers. Two remain parked.**

### BCMA wristband — DECIDED 2026-08-25 by the platform owner, and shipped `[DONE]`

*The decision, verbatim:*

> "Yes administrator should be able to print a wristband without break-glass,
> but such an action should be noted in logs for future audit if needed."

*What exists, and it works.* `GET /api/v1/bcma/wristband/:patientUid`
(`apps/backend/src/routes/clinical/bcmaRoutes.js`) returns the band payload as
JSON and, with `?format=html`, a self-contained printable document: a Code 39
rendering of the patient UID — the exact value the five bedside scan screens
expect — plus the three-way allergy strip. It carries its own
`Content-Security-Policy` (`default-src 'none'` plus one SHA-256-hashed inline
autoprint script), which `apps/admin/src/middleware.ts` deliberately does not
overwrite. The MAR round's "Print band" control
(`apps/admin/src/lib/bcmaWristband.ts`, used by `dashboard/mar/page.tsx`) links
to it through the portal proxy, which forwards the caller's own bearer.
`src/tests/bcma-closed-loop.deep.test.js` exercises the whole round trip against
the real database with a `NURSING_STAFF` token.

*The scope of the grant — one policy code, and only one.* Rather than widen
`PATIENT_CLINICAL_WORKFLOW_ACCESS` (which gates 27 sites across allergies,
assessments, clinical notes, CDS, encounters, med-rec, problem lists and care
pathways) or add it to `OPERATIONAL_ROLE_POLICIES` (which would have unblocked
every clinical-workflow surface for ADMIN), the route was given a policy code of
its own: **`patient.wristband.print`** (`PATIENT_WRISTBAND_PRINT` in
`services/security/accessPolicyRegistry.js`). Its gate surface is a deliberate
copy of the policy it replaced — same `patient_relationship_required` PHI level,
same capability groups, same relationship chain — so every actor who could print
a band before can still print one on exactly the same evidence, including the
clinical-authorship path (`findClinicalAuthorshipRelationship` was widened to
accept the new code for precisely that reason). The single behavioural
difference is `administrativeGrantForPolicy` in `accessDecisionService.js`: a
frozen set containing **one** policy code, admitting **two** roles (ADMIN,
SUPER_ADMIN).

Three properties keep it from leaking, each pinned by test:

1. **Keyed on the policy code**, so no other policy can match it. Adding a code
   to that set is a deliberate, reviewable act.
2. **Evaluated last**, after every relationship check has already failed. An
   administrator who genuinely holds a care-team / authorship / admission
   relationship is attributed to that relationship; a live break-glass session
   is still attributed to `break_glass`. The grant therefore only ever fires
   when there is provably no care relationship — which is exactly what the audit
   row claims.
3. **Nobody else moves.** A staff role with neither a relationship nor
   administrator status is refused exactly as before.

*Where the audit lands.* Two sinks, both append-only under migration 324:

| Sink | Written by | Row shape |
|---|---|---|
| `patient_access_audit_log` | the guard, automatically, on every decision | `tenant_id`, `patient_uid`, `actor_uid`, `actor_role`, `access_decision='allow'`, `access_source='role'`, `route`, `action='VIEW'`, `created_at`, and `metadata` carrying `policy_code='patient.wristband.print'`, **`administrative_access: true`** and `administrative_grant: 'administrator_no_relationship'` |
| `audit_logs` | the route, per print, best-effort | `action='wristband-print-administrative-access'`, `resource='patient_wristband'`, `resource_id=<patient uid>`, `uid`/`actor_uid`, `role`, `tenant_id`, `created_at`, and `metadata` carrying `patient_uid`, `care_relationship: 'none'`, `break_glass: false`, `discloses_patient_name`, `format`, `actor_raw_role` |

The compliance query is `SELECT … FROM patient_access_audit_log WHERE
metadata->>'administrative_access' = 'true'`; the second sink is the one with a
REST reader (`/api/v1/logs/audit`) and a UI (`/dashboard/system-logs`). A
relationship-backed nursing print records `access_source='admission'` and
`administrative_access: false`, and writes nothing to `audit_logs` — the two are
distinguishable by query, not by prose. The mount's `phiAccessLogger('BCMA')`
keeps writing the ordinary `hipaa_access_log` PHI-read row for every caller.
`actor_raw_role` exists because `jwtMiddleware` canonicalises SUPER_ADMIN to
ADMIN on `req.user.role`, so the shared audit columns say ADMIN for both.

*The audit cannot break the print.* A wristband is a bedside safety artifact on
a PHI read path, so the administrative write follows this repo's best-effort
convention twice over: `logAudit()` already swallows its own DB failure into the
Winston sink, and `recordAdministrativeWristbandAudit` additionally refuses to
propagate anything the helper itself could throw.
`src/tests/unit/wristbandAdministrativeAuditDurability.test.js` pins that a
throwing sink resolves rather than rejects, and that the failure is still loud
in the error log.

*Proof.* `src/tests/bcma-wristband-admin-access.deep.test.js` (10 tests, real
DB): ADMIN and SUPER_ADMIN print without break-glass and produce records in both
sinks; the nursing print still succeeds attributed to `admission` and is not
labelled administrative; `OT_NURSE` (which clears RBAC, the PHI bar and the
capability group, so the refusal comes from the relationship layer) is still
refused, as is a nurse against a patient she has no admission to; and the scope
proof — the same administrator session, in the same test, still gets **403** on
`GET /api/v1/allergies/patient/:patientUid/unified`, which runs
`PATIENT_CLINICAL_WORKFLOW_ACCESS`, while the nurse still gets 200 there. The
last test re-runs all four outcomes with `care_team_enforcement_mode=enforce`.

*A finding shipped alongside it.* The `/api/v1/bcma` mount in `app.js` carries
its own `patientAccessGuard('BCMA', { careTeamModeGoverned: true })`, and that
guard **never decides this request**: Express has not matched the route when a
mount-level middleware runs, so `:patientUid` is not in `req.params`, no patient
resolves, and `authorizePatientAccessRequest` returns `no_patient_context`
without evaluating a policy or writing a row — in shadow and in enforce alike.
Measured, not assumed: one wristband request writes exactly one
`patient_access_audit_log` row, and the deep suite asserts that count. Giving
that mount an explicit `policyCode` was tried and reverted rather than shipped,
because it would have been a control that can never fire; the mount line is
unchanged and now carries a comment saying so. The route's own guard is the sole
authority.

*The proxy-gate trigger, resolved.* The round-4 note in
`apps/admin/src/app/api/proxy/[...path]/route.ts` said: **"if the backend guard
is ever widened to admit administrators, this prefix needs a real gate."** It
has been, so the trigger fired and was answered: **no `PERMISSION_GATES` entry
is added.** Those gates scope ADMIN accounts by per-admin permission flag, and
the owner granted this capability to administrators as a class, not to a
flagged subset — a flag gate would silently re-impose a restriction the decision
removed, and none of the seven grantable flags describes wristband printing. The
control the owner asked for is the audit trail, and it is unconditional. Revisit
only if an owner asks for per-admin scoping of band printing specifically.

### Engagement campaigns — no requester/approver separation exists; building one is a feature `[CODE]`

*What the code does.* `approveCampaign`
(`apps/backend/src/services/engagement/engagementCampaignService.js`) loads the
campaign, checks the caller's **role** against `BROAD_APPROVAL_ROLES` (SUPER_ADMIN,
ADMIN, QUALITY_OFFICER, CMO, CNO, MEDICAL_SUPERINTENDENT) when
`approval_required_role = 'admin_quality'` and against `CARE_TEAM_APPROVAL_ROLES`
(those plus the doctor and ward-incharge roles) otherwise, then moves the row
`pending_approval → scheduled` and stamps `approved_by`/`approved_at` with
whoever called. It never reads `submitted_by` or `created_by`.
`submitCampaignForApproval` has no role gate of its own beyond the mount's
`ENGAGEMENT_ROUTE_ROLES`. So a caller holding an approving role can submit a
campaign and approve it themselves, and the platform records both stamps as the
same person.

*What was claimed.* Round 3 added three read endpoints and described them — in
the published OpenAPI spec, in `routes/engagement/engagementListQueries.js`, in
`routes/engagement/engagementRoutes.js`, and in the admin console's
`CampaignsPanel.tsx` and `engagement/page.tsx` — as closing "a broken two-person
control" for "the second approver, who is not the author". There is no such
control to break. The reads are a genuine fix for a genuine hole (a campaign was
addressable only by an id the caller already held, so no other session could open
it), and that is now all they say.

*Why the control is not built here.* Requester/approver separation is a policy
choice with real operational consequences: the columns already exist
(`engagement_campaigns.submitted_by`, `.approved_by`), so the code change is
small, but a single-clinician site or an out-of-hours recall would be unable to
send anything the moment it lands. The patient-merge two-person rule
(`services/patient/patientMergeService.js`) is the shape to copy — including its
handling of a NULL requester, which it refuses rather than waves through — but
whether engagement campaigns warrant it, and whether it should apply to both
`approval_required_role` tiers or only the broad one, is a product decision.

### ADT^A02 on first bed allocation — an interface-contract decision, so the capability string was narrowed instead `[CODE]` `[OPERATOR]`

*What was wrong.* `GET /api/v1/hl7/capability` advertised outbound `ADT^A02`
with `trigger: 'automatic on bed transfer; feed subscriptions listing ADT^A02'`.
`emitTransferAdt` has exactly one caller,
`admissionService.transferPatient`, reachable from `POST
/api/v1/admissions/{id}/transfer`, `POST /api/v1/emr/{id}/transfer` and `POST
/api/v1/beds/transfer`. The other path that puts a patient into a bed — `POST
/api/v1/admissions/{id}/assign-bed`, the emergency-exception allocation of a
first bed to a bedless admission — updates `admissions.ward` and `bed_number`
and writes a `bed_transfers` row with `from_bed_id = NULL`, and emits nothing.
"On bed transfer" therefore over-promised to any integrator sizing an interface
from the capability statement.

*Choice taken: narrow the string, do not wire the emitter.* The capability entry
now names the three endpoints that emit and states explicitly that
`assign-bed` does not. Wiring `emitTransferAdt` into `assignBedToAdmission`
would have been mechanically easy — a post-commit Phase 1.5 tail in its own
try/catch, the same shape `transferPatient` already uses, adding no failure mode
to the admission write. It was not done because the resulting message would be
wrong, not merely new: an A02 is the one ADT trigger defined by carrying **both**
locations (PV1-3 assigned, PV1-6 prior) and receivers reconcile a move by
diffing them (`services/hl7/hl7Transformer.js#transferToADT`). A first allocation
has no prior location, so it would ship an empty PV1-6 to systems that agreed to
receive transfers. Announcing it may well be right — but under which trigger
(A02 with an empty prior location, an A01 update, an A08) is an interface-contract
question for the receiving systems' owners.

*Sharp edge if it is ever wired.* Adding a message type to a live subscription is
itself an operator action with a documented failure mode — see "Outbound HL7
transfer feed — the DEFAULT is fixed, existing subscriptions must opt in" above:
one rejected message pauses that subscriber's cursor and stops its admissions,
discharges and lab results until an owner reconciles by hand.

## Explicitly parked (re-audit lane L, 2026-08-25 — documentation drift)

### Notification `/my` owner-path coverage — two bodiless test stubs, kept skipped and relabelled `[CODE]`

*What is wrong.* `apps/backend/src/tests/notification-my.test.js` carries two
`it.skip` cases — "should return notifications for the authenticated user" and
"should mark all notifications as read for the authenticated user" — whose
callbacks contain a single comment and nothing else. They are placeholders, not
disabled coverage. Un-skipping them would produce two vacuous green tests
asserting nothing, which is worse than the skip: the run would report the owner
path as covered.

*User-visible symptom if the gap bites.* Nothing in CI proves that a patient
with real notification rows can read them or mark them read. A regression that
made `GET /api/v1/notifications/my` return an empty list, or made
`PATCH /api/v1/notifications/my/mark-all-read` a no-op, would pass the whole
merge gate — the file's remaining cases only assert 401s and route shape, and
the two cases in `authorization.test.js` assert the *missing-user* 404 contract.
A patient would see an inbox that never fills, or unread badges that never
clear, with a green pipeline.

*Why it was not fixed in this lane.* The same defect in
`authorization.test.js` was fixed here, by writing the owner path properly in
`src/tests/appointment-record-owner-access.deep.test.js` (own tenant, own
fixtures, both halves asserted against the same rows). The notification pair
needs the same treatment — seeded notification rows keyed to the JWT-derived
phone, in a self-isolating tenant — which is a test to write, not a doc to
correct, and it is outside a documentation-drift lane's remit. The stubs stay
skipped; what changed is that `apps/backend/scripts/jest-skip-floor.json` now
says **BODILESS PLACEHOLDER** in both reasons, so the next reader is not misled
into un-skipping them.

*Shape to copy when it is built.* `appointment-record-owner-access.deep.test.js`
— including its teardown, which deletes the tenant-scoped PHI-access evidence
rows (`hipaa_access_log`, `patient_access_audit_log`) before the tenant row.
Deleting the tenant first fails `23503`, and the corpus's usual
`.catch(() => {})` would swallow that and leak the whole fixture silently.

---

## Explicitly parked (re-audit lane L, 2026-08-25 — the two cross-module pick-lists the linen/CSSD consoles depend on)

Lane L wired the linen-laundry and CSSD admin consoles to the endpoints that
populate them: every write on `/api/v1/linen-laundry` and `/api/v1/cssd` now has
a caller, and each one is reachable by exactly the roles that could already load
the board it belongs to, because `app.js` gates each router with a single
`requireRole` at the mount and neither service re-checks a role inside.

Two controls, however, need a value from a DIFFERENT module to name a foreign
key, and those two modules are gated differently. Both are wired and work for
the roles that hold both gates; for the rest the dialog renders the backend's
own refusal rather than an empty picker that would read as "nothing exists".
Closing the remaining gap is an authorization decision, so it was not taken
here.

### Linen cycle + par level need a ward list — `STORES_PURCHASE_INCHARGE` cannot read one `[CODE]`

*What is wrong.* `linen_ward_par_levels.ward_id` and
`linen_laundry_cycles.ward_id` are FKs to `wards`, and
`linenLaundryService.loadWard()` 404s an id it cannot find, so the ward must be
chosen from a list. The only list endpoint is `GET /api/v1/wards`, gated by
`BED_PARENT_ROUTE_ROLES` (and, for ADMIN accounts, by the `departmentManagement`
per-admin proxy flag). Comparing the two gates: of the 21 roles in
`LINEN_LAUNDRY_ROUTE_ROLES`, exactly one — `STORES_PURCHASE_INCHARGE` — is not
in `BED_PARENT_ROUTE_ROLES`.

*User-visible symptom.* A stores/purchase incharge can open Linen & Laundry, see
the board and configure item types, but "New cycle" and "Set par level" show
`Ward list unavailable — <the backend's 403>` and cannot be submitted. The same
applies to an ADMIN whose permissions were scoped down without
`departmentManagement`.

*The decision needed.* Either (a) add `STORES_PURCHASE_INCHARGE` to
`BED_PARENT_ROUTE_ROLES` — which widens a mount that also carries
`patientAccessGuard('WARD_BOARD')` and `phiAccessLogger`, so it is a PHI-scope
decision, not a convenience one; or (b) add a minimal, non-PHI
`GET /api/v1/linen-laundry/wards` (id + name for wards that have linen activity)
behind the linen gate the console already holds. (b) is the smaller blast
radius; both are owner calls.

### CSSD "Issue set" needs an OT case — seven CSSD roles cannot read the theatre schedule `[CODE]`

*What is wrong.* `set_issue_log.ot_schedule_id` is an FK to `ot_schedules` and
`cssdService.assertOtSchedule()` 404s an unknown id, so the case must be chosen.
The list is `GET /api/v1/theatre/today`, gated by `THEATRE_ROUTE_ROLES` plus
`patientAccessGuard('OPERATING_THEATRE')` and `phiAccessLogger`.
`THEATRE_ROUTE_ROLES` is a strict subset of `CSSD_ROUTE_ROLES`; the seven roles
in the CSSD gate and not the theatre gate are `COMPLIANCE_OFFICER`,
`DATA_PROTECTION_OFFICER`, `HR_STAFF`, `INFECTION_CONTROL_OFFICER`,
`PHARMACY_INCHARGE`, `QUALITY_OFFICER`, `STORES_PURCHASE_INCHARGE`.

*User-visible symptom.* Those roles can run the whole sterile-processing loop —
create sets, print labels, record loads, release or fail them, and move existing
issues through theatre-use / return / decontaminate — but the OT-case picker in
"Issue set" shows `OT schedule list unavailable — <the backend's 403>`, so they
cannot start a new issue. The roles who actually issue instruments at the
theatre door (`OT_INCHARGE`, `OT_NURSE`, `OT_STAFF`, anaesthetists, the doctor
tiers, `NURSING_STAFF`, `ADMIN`) hold both gates and are unaffected.

*The decision needed.* Whether infection-control and quality roles should see
the OT schedule at all. If yes, the honest fix is a non-PHI case list
(`id`, `procedure_name`, `ot_room`, `scheduled_date`, `scheduled_time` — no
`patient_uid`) exposed under the CSSD gate, not widening `THEATRE_ROUTE_ROLES`,
because `/theatre/today` returns `patient_uid` and `encounter_id` and is
PHI-logged for that reason.

*Deliberately NOT done here.* The console does not hide the "Issue set" control
for those roles. Duplicating the backend's access rules in the browser would
produce a second, drifting answer — the same reasoning recorded in
`apps/admin/src/lib/bcmaWristband.ts` for the wristband link. The backend stays
the single authority and the dialog shows what it said.

### `GET /api/v1/cssd/theatre/{otScheduleId}/warnings` stays caller-less — on purpose, not by omission `[CODE]`

*Why an audit will flag it again.* It is the one route on `cssdRoutes.js` with
no client after lane L, so a caller census will report it exactly the way the
other thirteen were reported.

*Why that is correct here.* It is a duplicate read, not a missing workflow.
`theatreService.getTodaySchedule()` calls the same
`cssdService.getOtSterilityWarnings()` in-process and returns the identical
payload inline as `cssd_warnings` on `GET /api/v1/theatre/today`, which is what
`dashboard/theatre` already renders. Adding a second round-trip for the same
data would give the theatre page two sources for one fact.

*How the exemption is kept honest.*
`apps/admin/src/__tests__/dashboard/cssd/router-coverage.test.ts` requires an
admin caller for every mounted CSSD route and exempts this one BY NAME with that
reason; a second case fails if the exemption ever stops matching a real route.
The linen twin has an empty exemption map. A future endpoint added to either
router without a caller fails the gate — that is the class-level guard, since
the client-path contract gate only checks the opposite direction (that a client
path is served).


## Explicitly parked (re-audit lane L, 2026-08-25 — patient-app privacy + localisation)

Three items surfaced while closing the patient app's backup/transfer leak, its
bypassable biometric lock, and the English-only ABHA enrolment wizard. Each is
recorded with the user-visible symptom, because each is a hole a reader could
otherwise mistake for "covered".

### iOS has no backup exclusion at all `[CODE]`

*What shipped in lane L.* Android now suppresses both extraction channels:
`android:allowBackup="false"` (API 26+, cloud Auto Backup and `adb backup`),
`android:fullBackupContent="false"` (API 26–30), and
`android:dataExtractionRules="@xml/data_extraction_rules"` (API 31+), whose
`<cloud-backup>` and `<device-transfer>` blocks both exclude all nine backup
domains the platform recognises — the four app-internal ones, `external`, and
the four device-protected (Direct Boot) twins.
`apps/patient/test/core/config/android_backup_rules_test.dart` fails if any of
the three attributes or any domain exclusion goes missing, and also if an
exclusion names a domain outside those nine (the platform ignores an
unrecognised domain silently).

*The gap.* `apps/patient/ios/` contains no equivalent. There is no
`NSURLIsExcludedFromBackupKey` applied to the offline PHI cache under the
application documents directory, and no explicit `kSecAttrAccessible…
ThisDeviceOnly` policy asserted for the Keychain items behind
`flutter_secure_storage`.

*User-visible symptom if the gap bites.* An iPhone restored from an iCloud or
encrypted-iTunes backup of the patient's old handset arrives with the cached
clinical records, and — depending on the Keychain accessibility class in force
— potentially the session credential too. This is the same defect that was just
fixed on Android, on the other platform.

*Why it was not fixed in this lane.* Verifying it requires a real iOS build and
a restore test; asserting it from a Dart guard is not possible the way the
manifest guard is. Writing an untested Swift/plist change and calling it fixed
would be worse than recording it.

### The Home dashboard is outside the biometric lock, by design `[CODE]`

*What shipped in lane L.* Five ungated sibling screens that rendered the exact
data classes the lock protects — `/refill` (the same
`/prescriptions/patient/my` payload as the gated Prescriptions tab),
`/pharmacy`, `/investigations`, `/vitals`, `/reminders` — are now wrapped in
`AppRouter._biometricGated`. Every router route is now classified in
`apps/patient/lib/core/navigation/biometric_gate_policy.dart` and
`apps/patient/test/core/navigation/biometric_gate_coverage_test.dart` fails if
the router and the policy disagree in either direction.

The denied pane also stopped being a dead end. It replaces the gated screen, so
that screen's AppBar and back button are never built — and all five of those
routes, like the whole `/portal/*` family, sit OUTSIDE the ShellRoute that draws
the bottom nav, so a patient who followed a deep link into one and was denied
had no control of any kind on screen. `BiometricGate`'s locked pane now carries
a back button when there is something to pop, plus **Go to Settings** (where the
lock is switched off, which is what ends a fail-closed denial rather than
deferring it) and **Back to Home**, both of which work from an empty back stack.

*The gap.* `/home` is deliberately **not** gated. `DashboardScreen` hosts the
SOS button and `BiometricGateService` fails closed, so a gate there would put
an emergency control behind a sensor that can deny. `/appointments`,
`/appointments/:id`, the two teleconsult routes and `/settings` are excluded for
the same family of reasons (time-critical care, and Settings being the only
in-app way to switch the lock back off).

*User-visible symptom if the gap bites.* With the lock on, someone holding the
unlocked handset still sees, on Home: a Today card that can name a lab test and
quote its abnormal flag (`labResultCard` in
`apps/backend/src/services/portal/patientPortalService.js` puts the test name in
the subtitle and `Flag: <abnormal_flag>` in the status), the header's snapshot
line reading `Dr. <name> - <date> at <time>`, and a stats strip with the
wellness score and cycle estimate. Following one of those cards does not
reliably re-close the record either: the lab-result card routes to the gated
`/portal/lab-results`, but the appointment card routes to ungated
`/appointments`, and the stats strip does not navigate at all — it expands
wellness detail in place, on Home.

*Why it was not "fixed" by partial redaction.* Redacting only the Today-card
subtitles would leave the header snapshot line's doctor name and the stats
strip in place while making the screen look protected — a partial fix that reads as a complete
one, which is the failure this lane exists to stop. Instead the boundary is
stated in the patient's own copy: the Settings toggle now carries
`settingsBiometricLockSubtitle`, which says in all five languages that Home,
appointments and video consultations stay unlocked.

*If it is picked up later,* the coherent version redacts every PHI-bearing
element on Home together — `command_center_today.dart`, `hero_snapshot_row.dart`
(fed by `DashboardScreen._appointmentSummary`, which is where the doctor's name
is composed), `stats_strip.dart`, and `health_insight_card.dart`, whose
`HealthInsightsStrip` renders inside the expanded wellness panel — behind one
resolved lock-armed flag, leaves SOS untouched, and updates
`settingsBiometricLockSubtitle` to match. (`next_visit_progress_widget.dart`
was named here in the first pass and does not belong: its only call site is
`features/gamification/widgets/overview_tab.dart`, i.e. `/health-points`, not
Home.)

### `abdm_screen.dart` is still hardcoded English outside the enrolment wizard `[CODE]`

*What shipped in lane L.*
`apps/patient/lib/features/abdm/widgets/abha_enrolment_flow.dart`, which
shipped as hardcoded English, now resolves every
user-visible string through `AppLocalizations` (`abhaEnrol*` keys, filled in
en/hi/ta/te/ml), as does the enrolment entry button
(`abdmCreateAbhaCta`). The file is now listed in
`apps/patient/test/i18n_guard_test.dart` so it cannot drift back, and
`apps/patient/test/features/abdm/abha_enrolment_l10n_test.dart` asserts the
localised copy renders and the old English literals are gone in all four
non-English locales.

The same widget also stopped dead-ending on `ABHA_ENROLMENT_IN_PROGRESS`. A
blocked start now asks `/portal/abdm/enrolment/status` which session holds the
one-live-session slot, cancels it, and starts again from the Aadhaar in the
form — rather than adopting the blocking session, which was started from a
number the app cannot see and cannot compare. `cancelEnrolment` was widened to
retire `otp_verifying` (a live status by the service's own `LIVE_STATUSES` and
by migration 707's partial unique index) whenever its verification claim is
older than the reclaim TTL, and to answer 409
`ABHA_ENROLMENT_VERIFY_IN_PROGRESS` rather than cancel under a verifier that
may still be inside the gateway call.

*The gap.* The rest of `apps/patient/lib/features/abdm/screens/abdm_screen.dart`
is still English-only: the two tab labels ("My ABHA", "Consent Requests"), the
existing-ABHA link form ("ABHA Number *", "ABHA Address (optional)", "Link
ABHA"), and the consent dialogs ("Grant", "Deny", "Revoke", `'$action
Consent?'`, `'Consent ${action.toLowerCase()}ed successfully'`).

*User-visible symptom if the gap bites.* A patient who has set the app to
Tamil, Telugu, Hindi or Malayalam can now create an ABHA in their own language,
but is still asked to **grant, deny or revoke consent** for sharing their
health records in English. Consent that the person cannot read is not
meaningful consent.

*Why it was not fixed in this lane.* Two reasons, both deliberate. The consent
strings are built by interpolating an English verb into an English sentence
frame (`'$action Consent?'`), so localising them is a restructure into
per-action keys, not a lookup swap. And ABDM consent wording is on the
`docs/TRANSLATION_REVIEW_TRACKER.md` high-risk list ("consent, ABDM/ABHA,
identity, and security copy") where a loose translation changes legal meaning —
the brief for this lane said to flag such strings rather than guess, so they are
flagged here instead of machine-translated into a consent dialog.

*Note on what did ship.* The `abhaEnrol*` translations in hi/ta/te/ml are an AI
first pass, consistent with every other non-English string in this app. Their
ARB metadata marks the Aadhaar/OTP identity strings `LEGAL/IDENTITY`, and
`docs/TRANSLATION_REVIEW_TRACKER.md` already carries patient hi/ta/te/ml as
"human clinical review: pending". "ABHA", "OTP" and the Aadhaar term are kept
in their standard forms in every locale rather than translated as common nouns.

## Explicitly parked (re-audit lane L, 2026-08-25 — patient routes a link cannot reach)

`DeepLinkService`'s allowlist is now a **partition** of `app_router.dart`'s
route table: `deep_link_route_table_test.dart` parses the router source and
fails unless every `GoRoute` path is either a link destination or carries a
reason in `DeepLinkService.unreachableByLinkRoutes`. That closed the class the
lane was pointed at — `/portal/discharge-summaries` (list and detail) and
`/portal/diagnostic-results/:id` were real screens that a `vhhealth://app/…`
link or a `route`-carrying push payload dead-ended on, purely because nobody
remembered to add them.

Four routes are dispositioned `needs-extra` rather than allowlisted, and that
disposition is a **product limitation, not a bug fixed**:

- `/appointments/:id`
- `/teleconsult/appointments/:appointmentId/lobby`
- `/teleconsult/appointments/:appointmentId/consult`
- `/period-tracker`

Each one's own `redirect` bounces it to a fallback (`/appointments`, `/home`)
unless `state.extra` carries typed args — `TeleconsultRouteArgs`,
`TeleconsultConsultArgs`, or `{eligible: true}`. A URL cannot carry `extra`, so
allowlisting them would ship a destination that can never show what the link
promises: the patient taps a notification about **one** appointment and silently
lands on the list of **all** of them, with no indication that the app went
somewhere else.

*Patient-visible symptom, stated plainly.* There is no way to deep-link a
patient to a specific appointment, to a teleconsult lobby, or into the period
tracker. Everything about a single appointment — including a "your teleconsult
starts in 10 minutes" push — can only reach `/appointments`.

*Shape of the fix.* Make the three appointment routes self-sufficient: fetch
the appointment (and its teleconsult lobby state) from the `:id` in the path
when `state.extra` is absent, instead of redirecting. That is a real change to
three route builders plus a loading/failure state each, and for the teleconsult
lobby it also needs a decision about what a patient should see when the link is
followed outside the join window. `/period-tracker` is different again: its
`eligible` flag is an eligibility judgement made by the caller, so making the
route self-sufficient means deciding where that judgement lives. Parked because
each is a design decision, not an omission — and because the honest partial
step, allowlisting the routes so the link "works", is precisely the silent
wrong-destination outcome above.

## Explicitly parked (re-audit lane L, 2026-08-25 — the offline notification badge reads zero)

Found while closing the offline-read class in the patient app, adjacent to the
lane's brief rather than in it, so it is recorded rather than guessed at.

`NotificationsScreen` reads `/notifications/my` through `ApiClient.cachedGet`,
so an offline patient opening the inbox sees their notifications from the
encrypted on-disk cache, labelled with an `OfflineBanner` as-of time.
`NotificationProvider.fetchUnreadCount` — which drives the bottom-nav badge —
reads the SAME path with the plain `ApiClient.get`, and its `catch` sets
`_unreadCount = 0`
(`lib/core/providers/notification_provider.dart`, `fetchUnreadCount`).

*Patient-visible symptom.* Offline, or during a hospital outage, the badge
disappears and reads "nothing new" while the very rows it counts are sitting in
the cache one tap away. Zero is not "unknown" — it is a specific claim the app
cannot support, and it is the claim most likely to stop a patient from opening
the screen that does have their unread results in it.

*Why it is parked rather than fixed here.* Two reasons, both about not making a
worse fix. First, the right offline value is a product decision, not a code
one: a stale count is truthful only if the surface says what it is as-of, and
the badge is a bare number with nowhere to say that — the alternatives are a
stale number, a dimmed/indeterminate badge, or hiding it, and picking one is a
design call. Second, `fetchUnreadCount` is the only remaining plain-client read
of a path another screen caches (checked exhaustively: every other
`ApiClient.cachedGet` path in `lib/` has no plain-`get` sibling), and it sits on
the app's realtime badge path, which
`test/core/providers/notification_badge_realtime_test.dart` pins — switching it
to the caching client also pulls the encrypted cache into that widget's test
async, which is exactly the change that must be made deliberately rather than
in passing.

*Shape of the fix.* Route `fetchUnreadCount` through the same cache entry
(`ApiClient.cachedGet('/notifications/my')`), keep the count derived from the
cached rows on failure instead of forcing zero, and decide how the badge
signals "as of your last sync". The `_feedFetcher` seam already on the provider
is where a test would inject it.
