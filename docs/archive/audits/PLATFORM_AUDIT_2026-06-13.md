# VH Health Platform — Full-Stack Professional Audit (2026-06-13)

**Method:** 11 specialised read-only audit agents (backend architecture, backend
security, database/migrations, clinical AI, observability/reliability, admin
portal, patient app, staff app + core, testing/CI, infra/DevOps, docs/governance)
swept the monorepo in parallel. Every finding is evidence-backed with `file:line`
citations verified against current `main` (`07c2dc37`), not against the (27–55 day
stale) planning docs. Scope: ~260K LOC — backend 336 services / 98 AI services /
307 SQL migrations, admin 95 pages, patient 59K LOC, staff 120K LOC, 109 k8s
manifests, 58 docs.

**Working-tree note:** an in-flight security sweep (`SECURITY_SWEEP_2026-06-13.md`
+ ~25 modified files) was present during the audit. All work was read-only; the
sweep was not disturbed. Some "still open" security items below are explicitly
the sweep's own deferred items, independently re-verified.

---

## 1. Bottom line

> **The *capability* is genuinely impressive and ahead of mid-market hospital
> systems. The platform is *not yet production-grade* — the gap is not features,
> it's (a) incomplete tenant isolation, (b) unproven DR/monitoring, (c)
> supply-chain enforcement that exists but isn't wired in, (d) mobile PHI
> hardening, and (e) a milestone-tracking process that has collapsed. The
> recurring pattern across every domain is "built but not proven in production,"
> with documentation that systematically overstates "done."**

| Axis | Grade | One-line |
|---|---|---|
| **Capability / feature depth** | **A−** | EHR + India revenue cycle + 103-module governed AI substrate; broad and deep |
| **Code & architecture quality** | **B** | Mature hardening patterns, but a few systemic anti-patterns (see §4) |
| **Security & compliance** | **B−** | Strong controls; tenant isolation + crypto posture + a couple of auth holes drag it |
| **Production-readiness (ops)** | **C+** | Monitoring/DR/supply-chain are designed but not deployed/proven |
| **Governance / milestone tracking** | **D+** | Swarm stopped 21 days, tracker frozen, feature-freeze violated |
| **OVERALL** | **B− / "strong build, not yet production-proven"** | |

### The three things that block "production-grade" today

1. **Tenant isolation is incomplete and runs as a superuser in prod.** Four
   agents independently hit the same wall: only ~70–80 of ~267 `tenant_id` tables
   carry an RLS policy (DB-1); interactive `$transaction` callbacks and the
   read-replica path aren't auto-scoped (SEC-3); and prod connects to Postgres as
   the **superuser** `vhhealth` (which bypasses non-FORCE RLS) because the
   `vhhealth_runtime` NOSUPERUSER role only exists in the dalekdefender test
   overlay (INF-4, INF-8). Today's single-tenant India launch masks it; it is a
   **population-wide cross-tenant PHI-leak risk before tenant #2** and one of the
   11 milestone journeys (`cross-tenant-rls`) is exactly this.

2. **The "monitoring + DR + supply-chain" story is documentation, not running
   infrastructure.** Prometheus/Alertmanager/Loki are **not deployed by GitOps**
   (no ArgoCD Application renders them; alert/backup secrets are `.example`-only,
   REL-1); the **DR restore drill has never been run** so RPO/RTO are aspirational
   (REL-2); the **Kyverno image-signature admission policy exists but isn't wired
   into the kustomization** so unsigned images face no gate (INF-1); and prod
   image digests are all-zeros placeholders requiring a manual step (INF-2).

3. **The 2026-06-16 milestone is unmeasurable and will be missed.** The swarm has
   been **stopped for 21 days**, `GOAL_2026-06-16.md` is frozen at its May-16
   baseline, the `findings/in-flight/` directory the goal counts against **doesn't
   exist**, and ~561 commits of Pillar A–G *feature* work merged to main **during
   a declared feature freeze** with no decision record (DOC-1/2/3). The gate needs
   3 consecutive green swarm ticks; 3 days remain and the swarm isn't running.

---

## 2. Domain scorecard

| Domain | Grade | Headline strength | Headline gap |
|---|---|---|---|
| Backend architecture | B | Error-leak sanitiser, DB circuit breaker, clean Prisma cutover | Canonical-timeline writes not atomic (BA-1) |
| Backend security | B− | HS256 allowlist, fail-closed revocation, RBAC-throws-at-boot, SSRF guard, MFA | Plaintext admin reset OTP (SEC-1), staff refresh type-confusion (SEC-2), RLS gaps (SEC-3) |
| Database & migrations | B+ | Atomic/idempotent migrations, archive-before-drop, deep RLS posture introspection | ~240 tenant_id tables unpoliced (DB-1), statement_timeout unwired (DB-2) |
| Clinical AI | B+ | Real two-person approval, eval/drift/bias gates, prompt-injection gate, 103 modules | Unknown-module → enabled (AI-1), patient surface unbuilt (AI-2), regex-only defenses (AI-4) |
| Observability / reliability | B− | Real circuit breaker, webhook DLQ, downtime ward packs, CNPG HA + WAL→R2, full k8s hardening | Monitoring stack not GitOps-deployed (REL-1), DR drill never run (REL-2) |
| Admin portal | B+ | httpOnly-cookie BFF, nonce CSP, default-deny RBAC w/ CI gate, Sentry PHI scrub | `unsafe-eval` in CSP (ADM-2), prod debug fetch handle (ADM-1) |
| Patient app | B+ | SPKI cert pinning, AES-GCM offline cache, single-flight refresh, full 5-lang l10n | App Check inactive (PAT-1), `_isLoading` dead (PAT-3), no FLAG_SECURE (PAT-6) |
| Staff app + core | B+ | Exemplary shared core, real CPOE+MAR/BCMA, canonical-timeline-correct client | No FLAG_SECURE (STF-1), weak override-reason gate (STF-2), 42% screens English-only (STF-5) |
| Testing & CI/CD | B− | Strong backend suite (RLS/RBAC/adversarial), coherent Forgejo CI | Flutter ~13% file coverage (CI-3), FHIR conformance advisory (CI-1), a known-red test (CI-2) |
| Infra / DevOps | B− | GitOps, CNPG HA, default-deny NetworkPolicy, pod hardening, sealed secrets | Image admission not wired (INF-1/2), prod = superuser DB (INF-4), local-path storage (INF-5) |
| Docs / governance / milestone | D+ | Excellent commit hygiene, high-quality triage artefacts, clinical-grade doc breadth | Milestone tracking collapsed (DOC-1/2/3); docs overstate reality everywhere |

---

## 3. Consolidated severity register

Counts after de-duplication across agents (cross-cutting items counted once):

| Severity | Count | Definition |
|---|---|---|
| **CRITICAL** | 4 | Deploy-blocker or unmeasurable-milestone; fail-closed or latent-but-severe |
| **HIGH** | ~24 | PHI/patient-safety/availability risk; must close before pilot |
| **MEDIUM** | ~30 | Real defects/posture gaps; close during pilot-hardening |
| **LOW** | ~20 | Hygiene, hardening, doc drift |

### CRITICAL

| ID | Title | Evidence | Note |
|---|---|---|---|
| INF-1 | Kyverno image-signature policy not in `base/kustomization.yaml` → unreachable; `validationFailureAction: Audit` | `base/image-policy/kyverno-verify-images.yaml:16` | Signing pipeline wired; **verification gate absent** |
| INF-2 | All prod app image digests are `sha256:000…` placeholders | `apps/kustomization.yaml:38-42` | Fail-closed (won't start) but needs manual `update-prod-digests.mjs` |
| DOC-1 | Goal tracker frozen at May-16; swarm stopped 21 days; `runs/latest-curation-queue.md` missing | `docs/GOAL_2026-06-16.md`, `2026-05-23-swarm-17h-triage.md:177` | Milestone unmeasurable |
| DOC-2 | Phase-0 feature freeze violated by Pillar A–G merges (~561 commits) with no decision record | `git log` 2026-06-09→11 | Main at unknown stability vs the 11 journeys |

### HIGH (grouped by theme)

**Tenant isolation (the systemic one)**
- **SEC-3** — Interactive `$transaction` callbacks + `prismaReadOnly`/`setTenant`-uses-primary are not tenant-scoped; permissive-when-GUC-unset. `prisma.js:240-247, 384`
- **DB-1** — ~240 of ~267 `tenant_id` tables have no `tenant_isolation` policy (incl. `billing_*`, `anesthesia_*`, `abdm_*`, `care_plans`). `000_baseline.sql`, migrations 075/236/238/239
- **INF-4** — `vhhealth_runtime` NOSUPERUSER role only in dalek overlay; **prod connects as superuser** → bypasses non-FORCE RLS. `base/cnpg/cluster.yaml:109`, `overlays/dalekdefender/rls-runtime-role.sql`
- **INF-5** — All prod PVCs on `local-path` (no replicated storage) → node loss = RTO gap for Redis/Vault/MinIO. `base/cnpg/cluster.yaml:176`
- **INF-6** — Vault in scaffold mode (Shamir, no auto-unseal, unused); no secret-rotation pipeline. `base/vault/vault.yaml:19-22`

**Auth / PHI**
- **SEC-1** — Admin password-reset OTP stored & matched in **plaintext** → admin-account-takeover → full PHI. `authService.js:394-438` *(sweep flagged M-4, did not fix)*
- **SEC-2** — Staff refresh accepts an **access** token (no `type==='refresh'`) and skips jti-blacklist → revocation bypass. `staffAuthService.js:513-558` *(sweep "documented" as L-1)*
- **BA-1** — Canonical clinical-timeline writes are **not atomic**: detail row commits, then timeline/audit row is best-effort *outside* the transaction. `clinicalNotesService.js:348-368`, `vitalsChartService.js:518-647`, `orderEntryService.js:684-714` — violates the platform's own "non-negotiable invariant"

**AI**
- **AI-1** — Unknown/typo'd `moduleKey` → `defaultModuleFor()` returns `enabled:true`, bypassing the enable gate. `clinicalAiModuleService.js:1899-1913`
- **AI-2** — Patient-facing "accepted-only" exposure is documented-as-enforced but **no patient read path exists** (surface unbuilt; invariant lives only in a comment). `patientExplainersService.js:27`

**Ops / observability**
- **REL-1** — kube-prometheus-stack + loki not GitOps-deployed; Alertmanager + R2-backup secrets `.example`-only → alerts may route nowhere, off-site backups may not run. `monitoring/chart-tracker.yaml:3`
- **REL-2** — DR restore drill never run; RPO/RTO unvalidated; R2 object-lock/versioning unconfirmed. `DR_RESTORE_DRILL.md:80-86`
- **INF-3** — `allow-snippet-annotations:false` silently voids all ingress security headers (HSTS/CSP/X-Frame). `base/ingress-nginx/ingress-nginx.yaml:94`

**Mobile PHI**
- **PAT-1** — Firebase App Check installed but `activate()` never called → OTP endpoint open to scripted abuse. `apps/patient/pubspec.yaml:69`, `main.dart`
- **PAT-2** — Firebase API keys hardcoded for web/iOS/macOS/Windows. `firebase_options.dart:44,64,73,82`
- **PAT-3** — `final _isLoading = false` → every double-submit guard is dead code; OTP can double-fire. `login_form.dart:53`
- **PAT-4** — Push-notification `route` accepted with only `startsWith('/')` → arbitrary in-app nav. `deep_link_service.dart:11-12`
- **STF-1 / PAT-6** — No `FLAG_SECURE` on either app → all PHI screenshot-able + live in app-switcher
- **STF-2** — Safety-critical MAR/allergy override reason gated only by `length>=5` ("aaaaa" passes). `mar_scan_screen.dart:349`, `cds_blocker_modal.dart:12`

**Testing / data**
- **CI-1** — FHIR conformance is `continue-on-error:true` → spec regressions merge silently. `_reusable-backend-fhir.yml:27`
- **CI-2** — `roleMatrix.spec.test.js` is a known-failing test (HOUSEKEEPING_STAFF mis-classified as support staff) — backend suite red since 2026-05-27. `backend-ci-78138460419.log`
- **CI-3** — Flutter ~13% file coverage; 0 widget/integration tests for any clinical surface (MAR, CPOE, dispensing, OT)
- **DB-2** — `STATEMENT_TIMEOUT_MS` is dead config; analytics runs on the **primary** (replica URL is a placeholder), bounded only by CNPG's 60s. `configmap.yaml:60`, `prisma.js:329-334`

**Governance**
- **DOC-3** — `findings/in-flight/` doesn't exist → the milestone's second prong is structurally unmeasurable
- **DOC-4** — `SESSION_HANDOFF.md` names a *different* active goal than `GOAL_2026-06-16.md` → new sessions pursue the wrong target
- **DOC-5** — Security operator-action items (RLS runtime role, key rotation, Kyverno) not tracked in the milestone's definition of done

*(Full MEDIUM/LOW lists per domain are in the agent reports; the most actionable
are folded into §6–§8 below.)*

---

## 4. Cross-cutting themes (the real insight)

These patterns recur across domains and are higher-leverage than any single fix.

1. **"Built, not proven."** Circuit breakers, DR design, downtime packs, image
   signing, the AI substrate, RLS scaffolding — all *engineered well* but not
   *enabled/verified in prod*. The single most valuable program-level move is a
   **"prove it" sprint**: run the DR drill, deploy the monitoring stack via
   GitOps, wire the Kyverno gate to Enforce, switch the DB connection to the
   non-superuser role, and restart the swarm.

2. **Tenant isolation is half-built (RLS as the only doc that's honest about it).**
   `GAP_ANALYSIS_TENANT_RLS.md` candidly says so; the code confirms it. Decide
   **Path A (own that it's single-tenant)** or **Path B (finish RLS coverage +
   non-superuser role + interactive-txn scoping)** *before* onboarding tenant #2.

3. **Silent-degradation / fake-success anti-pattern.** `42P01`/"table may not
   exist" graceful fallbacks in **149 files** (REL-5), fake-zero HR/finance
   dashboards (BA-2, violates their own CLAUDE.md rule), and the unknown-module→
   enabled default (AI-1) all turn real failures into invisible 200s. Instrument
   every fallback with a named-table metric; never return zeros as success.

4. **Mobile PHI client-hardening is the weakest security surface.** No
   screenshot/app-switcher protection on *either* app, PHI/ABHA to clipboard with
   no clearance, default `FlutterSecureStorage` options, inactive App Check,
   stubbed jailbreak detection. These are cheap, high-compliance-value fixes for
   DPDP/HIPAA.

5. **Docs systematically overstate reality.** Every agent flagged stale claims:
   model count (219 vs 527), module count ("92" vs 103), "all enabled=false"
   (false — 7 are on), stack (CLAUDE.md says PG15/raw-pg; it's PG17/Prisma),
   staff CLAUDE.md (describes 20 files; reality is 199), statement_timeout,
   read-replica routing, monitoring "Argo-managed." The docs are the navigation
   map and are currently misleading on load-bearing facts.

6. **Governance discipline lapsed under delivery pressure.** Commit hygiene is
   excellent, but the feature freeze was broken without a decision record, the
   swarm stopped, and the tracker froze. Process exists on paper; enforcement
   slipped.

---

## 5. AI integration — how far, and what's next

**How far (verified against code):** Further than almost any mid-market peer, and
the build is *real*, not scaffolding.
- **103 governed modules** (registry in `clinicalAiModuleService.js`; docs say
  "92") across Tiers A–H, on a uniform pipeline: structured draft →
  `runOutputDefenses` → persist `clinical_ai_generations` → enqueue
  `clinical_ai_reviews`.
- **Governance is genuinely implemented:** two-person approval enforces a
  *different* approver; risky field changes require approval + a recent **accepted
  eval run**; review RBAC fails closed; `critical` safety flags (PHI-leak,
  allergy-match) halt the queue before a draft reaches a reviewer;
  decision-support-only is structural (no autonomous actions).
- **Safety substrate (S1–S5) is real:** prompt-injection gate on ingest, seeded
  clinical protocols, bias telemetry sliced by age/sex/language/disease/facility,
  CDS Hooks adapter, regulatory-readiness pack exporter.
- **Provider wiring:** fully env-driven (`template`/`ollama`/`openai-compatible`/
  `openai`/`anthropic`). Default model `llama3.1:8b`; deep tier also local Ollama
  (PHI-never-leaves-building design). Anthropic path is correct
  (`/v1/messages`, `x-api-key`, `anthropic-version`); **no clinical module
  hardcodes a cloud model ID** — they come from env.
- **AI in the *build* process:** the swarm is an AI-driven QA harness (the
  `vh-health-qa` skill) that surfaced 100+ clinical-safety bugs no unit test would
  catch — a meaningful compensating control for thin Flutter coverage.

**The honest gap:** it's mostly *delivery + verification*, with a few real
*build* holes:
- **AI-2** — the patient-facing delivery surface is unbuilt; "delivery done" is
  overstated. Ship a single `getPublishedAiOutputForPatient()` helper that hard-
  filters `decision='accepted' AND status='draft'` and route all patient reads
  through it, with an authorization test.
- **AI-1** — unknown module → `enabled:true`. Flip the fallback to disabled.
- **AI-4** — `runOutputDefenses` is regex-heuristic only; numeric checks are
  literal-string (a "120 mg" vs "0.12 g" mismatch evades), schema validation is
  shallow, and `defenses_passed:true` is recorded as if "verified safe." Add
  unit-normalisation + real JSON-schema validation; rename the flag.
- **AI-3** — the patient triage chatbot defaults to external Anthropic on
  `claude-opus-4-6` (two releases behind `claude-opus-4-8`) and is *outside* the
  governed substrate (no defenses, no review). Default it to local/template, bump
  the model, and fold it into governance.
- **AI-5/6** — `requiresCitations` is non-blocking (uncited drafts can be
  accepted); model calls get one attempt then silent template-fallback (no
  retry/backoff).

**What more can be done (per their own Pillar G, which I confirm is accurate):**
deep tier on real GPU hardware → the by-the-book stage-1 ward pilot
(med-reconciliation + aftercare) → outcome instrumentation (acceptance/edit/
override KPIs from existing tables) → pair each AI module with its closed loop
(drug-KB ↔ stewardship, analyzer interfaces ↔ lab autoverification). **Don't build
new modules** — 103 exist; the work is delivery, evidence, and loop-pairing.

---

## 6. Monitoring & fallbacks (the user's explicit asks)

**Monitoring — code-level instrumentation is strong; the platform layer isn't
running.**
- *Instrumented well:* Sentry with PHI scrubbing + 100% trace sampling on clinical
  writes; Prometheus RED metrics per route; Winston structured logs with a PHI
  redaction backstop; slow-query log; `/health/live|ready|ping` probes;
  `*/5` canary + schema-drift detector.
- *Blind spots:* the **kube-prometheus-stack + Loki + Alertmanager are not
  deployed by GitOps** (REL-1) — so even when Prometheus rules fire, routing
  secrets are `.example`-only and alerts may go nowhere; `db_pool_*` gauges are
  hard-zeroed post-Prisma (dashboards flatline); Winston file retention (90d) is
  inert on a `readOnlyRootFilesystem`+emptyDir pod (only stdout→Loki survives);
  no business metrics (MAR-write success, queue depth) — only HTTP RED. **Add a
  Watchdog deadman alert** to prove the pipeline is alive.

**Fallbacks — genuinely good code-level resilience; weakest at total-outage and
unproven-DR.**

| Failure mode | Real fallback? | Evidence / gap |
|---|---|---|
| Backend pod dies | ✅ | 3 replicas, PDB minAvail 2, HPA 3–10, anti-affinity, graceful drain |
| DB primary fails | ✅ | CNPG sync-repl, unsupervised auto-failover; breaker fails fast |
| Outbound webhook/notification fails | ✅ | Exponential-backoff outbox + dead-letter (textbook) |
| Duplicate/retried writes | ✅ | Idempotency middleware (opt-in per route) |
| Redis/cache down | ✅ | Fail-open no-op cache |
| Backup/off-site | ✅ design | CNPG WAL+base→R2 AES256 + 6h sync — but creds `.example`, **drill never run (REL-2)** |
| Cloudflare tunnel drops | ⚠️ | 3–4 cloudflared replicas, but tunnel is the **sole** public ingress; no alternate path |
| Network partition (ward↔backend) | ⚠️ | Downtime ward packs are **real** (cron, read-only HTML) — but served *by the backend*; LAN static mirror is Phase-2, so a true partition falls back to **printed paper** |
| Model endpoint down | ✅ graceful | AI is advisory; degrades to template (but Ollama is `replicas:1` SPOF, no retry) |
| Disk full | ⚠️ alert-only | PVC alerts exist but may not route (REL-1); no auto-reclaim |
| Total backend outage | ❌ | All schedulers/canaries/downtime-pack generation are **in-process node-cron** — they die with the app, exactly when needed (REL-3); the `WardDowntimePacksStale` alert even targets a k8s Job that doesn't exist |

Also missing: **no HTTP server `requestTimeout`/`headersTimeout`** on the Node
server (REL-4) — slow-loris/hung-request protection relies solely on the DB
statement timeout.

---

## 7. Efficiency opportunities

- **DB-2/DB-3:** wire `statement_timeout` at the app layer + provision the read
  replica (analytics currently hits the primary); add a `CREATE INDEX
  CONCURRENTLY` escape-hatch so large-table index builds don't lock writes during
  deploys.
- **Backend N+1:** ~48 `await`-in-`for…of` DB loops (heaviest in `abdmService.js`,
  AI services); 100 `SELECT *` against an explicit-columns rule; confirm every
  `list*` endpoint enforces a max page size (unbounded lists = DoS risk).
- **AI cost/latency:** no model-call caching/retry; turn on cost telemetry
  (`CLINICAL_AI_*_COST_PER_MILLION_MINOR`) so the budget guardrails have real
  numbers.
- **Admin:** split remaining god-pages (`clinical-governance` 1594 LOC, `pcpndt`
  1295, `staff-roster` 1080); set a global `gcTime` to shrink the PHI-in-memory
  window; add `Cache-Control: no-store` on the BFF proxy.
- **Flutter:** convert long clinical/roster lists to `ListView.builder` (STF-7);
  split the 12K-line `app_strings.dart` and the 5K-line god-screens; consolidate
  the duplicated response-envelope unwrappers in core.
- **Warehouse (Pillar F):** Metabase reads OLTP today — move analytics to a
  read-replica-fed warehouse + dbt star schemas (already partly scaffolded).

---

## 8. What "EPIC-level" actually requires from here

Their own `EPIC_LEVEL_ROADMAP.md` is **accurate and well-sequenced** — keep it as
the north star. This audit sharpens the *next 0–2 weeks*:

### Phase 0′ — "Prove it" (this week, before any pilot)
1. **Restart the swarm** against current HEAD; run 3 ticks; update the tracker
   with dated snapshots. If 06-16 slips, record the slip + a revised date (DOC-1).
2. **Document the Pillar A–G scope decision** (what merged, why the freeze lifted,
   what validation was done) (DOC-2).
3. **Switch prod DB to the `vhhealth_runtime` non-superuser role** + add it to
   CNPG managed roles; set `enableSuperuserAccess:false` (INF-4/8).
4. **Hash the admin reset OTP** + fix the staff refresh type/jti check (SEC-1/2).
5. **Wire the Kyverno gate to Enforce** + populate real image digests (INF-1/2).
6. **Fix the red `roleMatrix` test** so the backend suite is green (CI-2).
7. **Make canonical clinical writes atomic** — thread `tx` into the timeline/audit
   write (BA-1).

### Phase 1 — Pilot-hard (0–3 months)
- Deploy monitoring stack via GitOps + Watchdog alert; **run the DR drill**;
  enable R2 object-lock; move outage-critical jobs to k8s CronJobs (REL-1/2/3).
- Mobile PHI hardening: FLAG_SECURE both apps, activate App Check, clipboard
  clearance, secure-storage options, real jailbreak detection (PAT/STF).
- Decide & execute the RLS path (DB-1); finish interactive-txn scoping (SEC-3).
- Remove `unsafe-eval` from admin CSP (ADM-2); populate `ADMIN_IP_ALLOWLIST`
  (INF-9); fix ingress security headers (INF-3).
- Build the patient AI-delivery helper + close AI-1/AI-4 (AI safety).
- Replicated storage class (Longhorn/Rook) (INF-5); commission external pen test.
- Flutter clinical test coverage for MAR/CPOE/dispensing (CI-3); make FHIR
  conformance blocking (CI-1).

### Phase 2+ — Close the loops & ecosystem
Per the roadmap: BCMA barcode loop, real drug KB, analyzer/PACS interfaces, ABDM
certification, NABH pack, terminology service, and the loop-paired AI enables.

---

## 9. Production-readiness verdict

**Not production-ready for real patient PHI today** — but the distance is short
and the blockers are concrete, not architectural. The engineering foundation is
strong enough that a focused 1–2 week "prove it + close the criticals" sprint,
followed by the pilot-hardening phase, gets this to a defensible first-pilot
posture. The danger is shipping on the *strength of the build* while the
*operational proof* (DR drill, monitoring routing, tenant isolation under a
non-superuser role, milestone evidence) is still on paper.

---

*Generated 2026-06-13 by an 11-agent parallel audit. Per-domain full reports
(with all MEDIUM/LOW findings and evidence) are available on request. This doc is
a point-in-time snapshot of `main@07c2dc37` with an in-flight security sweep in
the working tree.*
