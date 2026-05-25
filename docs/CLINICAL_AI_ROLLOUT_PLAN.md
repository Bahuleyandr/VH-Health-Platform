# Clinical AI Rollout Plan

**Status: ALL PHASES SHIPPED + ALL MODULE TIERS SHIPPED** (2026-04-30 → 2026-05-01).
Substrate, delivery, parallel/optional rollout work, *and* the full
Tier A–H module catalogue all on `main`.

### Rollout phases (this doc) — all shipped

- ✅ **Phase 0** — route + RBAC split.
- ✅ **Phase 1** — LAN-only internal Ingress for `/clinical-ai/clinical/*`.
- ✅ **Phase 2** — Flutter clinician screens (API client + review queue + draft detail).
- ✅ **Phase 3** — Flutter web Dockerfile + nginx + cluster manifest set.
- ✅ **Phase 4** — Ollama in-cluster deep tier + backend `CLINICAL_AI_DEEP_*` env.
- ✅ **Phase 5** — admin sidebar nav entry + auto-resume scheduler for governance-paused runs.

### Module catalogue (`AI_FEATURE_GAP_BACKLOG.md`) — all shipped

Beyond the rollout phases, the prioritised AI feature catalogue closed
between 2026-04-30 evening and 2026-05-01:

| Tier | Scope | Modules | Migration |
|---|---|---|---|
| A | Patient explainers | 5 | (earlier) |
| A remainder | Fastest-win assistants | 10 | 133 |
| B | Surgical / OR vertical | 8 | 116 |
| C | P0/P1 clinical assistants | 16 | 134 |
| D | Emergency / triage vertical | 9 | 135 |
| E | Patient-facing engagement | 13 | 136 |
| F | Interoperability | 5 | 137 |
| G | Public / population health | 5 | 138 |
| H | Operational forecasting | 8 | 139 |

The Tier A-H build produced 79 modules; the current registry has
**92 modules total** as of the 2026-05-25 governance-hardening branch,
all governed via `clinical_ai_modules` / `clinical_ai_generations` /
`clinical_ai_reviews`, all decision-support-only, all enabled=false by
default. See `AI_FEATURE_GAP_BACKLOG.md` for the per-module ledger and
remaining ~21 long-tail catalogue items.

What's left is hospital-side configuration work that this repo can't do:
hospital DNS pointing `clinical.<hospital>.local` at the internal ingress
LB IP, hospital intermediate CA loaded into step-ca-internal, GPU node
provisioned + nvidia-device-plugin DaemonSet installed, and the per-tenant
backend ConfigMap patched with the deep-tier env vars. Each is documented
in the relevant phase below.

**Rollout work that follows from "all tiers shipped":**

- **Governance hardening rollout** — the 2026-05-25 branch adds strict
  review-role enforcement, two-person approval for risky module changes,
  eval evidence gates, explicit schema-unavailable failures, and visible
  fallback/blocked/schema badges in the admin UI.
- **Per-tenant rollout playbook** — which modules to enable for which
  hospital pilot, in what order. See [`PER_TENANT_ROLLOUT_PLAYBOOK.md`](PER_TENANT_ROLLOUT_PLAYBOOK.md).
- **Local-Ollama deep-tier pilot** — Tier B/C/D/F-bundles (CRITICAL-tier
  modules) for PHI-never-leaves-building deployment. Phase 4 wired the
  env vars; the GPU node provisioning is hospital-side.

**Audience:** anyone picking this up in a future session — Claude, the
project owner, or a teammate.

**One-sentence summary:** the multi-agent clinical AI substrate is
production-ready on the backend; the rollout problem is now about *who
uses it, on what device, and over which network* — not about new AI
features.

**Companion docs (read alongside this one):**
- [`HEALTHCARE_AI_SPEC_AUDIT.md`](HEALTHCARE_AI_SPEC_AUDIT.md) —
  audit of the codebase against an external 38-section healthcare-AI
  build spec; verdict matrix per section + Phase A–F remediation
  roadmap (~16 weeks). **Entity / infra layer.**
- [`AI_FEATURE_GAP_BACKLOG.md`](AI_FEATURE_GAP_BACKLOG.md) —
  audit of a ~250-feature user-facing AI catalogue against the 92
  registered modules; tier-A/B/C/… build order + 5 substrate-level
  safety holes (S1–S5) to fix first. **Module / feature layer.**

These three together are the navigation map. This doc = *how to deploy
what's built*. Audit = *what to build at infra/entity level*. Backlog
= *what to build at AI-module level*.

---

## 1. Where we are (as of 2026-04-30)

Six commits landed on `main` this session, building up the multi-agent
substrate from a single proposal to a fully wired meta-workflow with
admin UI:

| Commit | Scope |
|---|---|
| `079ce54b` | Cross-run **decision memory** + **deep/quick model tier** + **differential debate** |
| `29943bd3` | **Workflow graph runner** with checkpoint resume + pause/resume; `generateAdmissionAiDraft` refactored as a 14-node graph |
| `4afa33e0` | **Subgraph composition** — `ctx.runSubgraph`, `parent_run_id` linkage, idempotent resume |
| `91a3e207` | `discharge_summary_compose` **meta-workflow** (orchestrates med rec + aftercare + discharge readiness + clinical coding subgraphs) |
| `583a2ec1` | **Backend routes + admin UI** wireup — POST/GET/resume on `/api/v1/admin/clinical-ai/discharge-compose`, plus a Next.js admin page at `/dashboard/clinical-ai/discharge-compose` |

What this gives you on `main` today:

- ~70 single-purpose clinical AI services, all rule-authoritative + decision-support-only
- A graph runner that supports crash-resume, pause-for-approval, and nested subgraphs
- A reviewer-facing draft → review → sign-off pipeline (`clinical_ai_reviews`)
- Decision memory that learns from reviewer behaviour across runs
- A roll-up "discharge package" workflow with safety-band aggregation
- An admin web page that lets admins drive composes and inspect run trees
- All of it gated behind `requireClinicalAiControl` (ADMIN | SUPER_ADMIN | IT_*)

What this **doesn't** give you yet:

- Any way for a doctor or nurse to use it from the bedside or workstation
- Any way to run clinical traffic without it traversing Cloudflare's edge
- Any local-LLM deployment (the deep tier is wired but unused)
- Any voice/ambient input path into the multi-agent system (services exist; not bridged)

---

## 2. The architectural pivot

> **The multi-agent substrate is done. The remaining work is delivery —
> getting it onto the right surface for each audience and onto the right
> network for compliance + latency.**

Two design decisions frame everything else:

### Decision A: Three surfaces, split by who does the work

| Audience | Surface | What they do |
|---|---|---|
| **Admin / IT / SUPER_ADMIN** | `apps/admin` (Next.js web, current) | Govern the AI: model registry, drift canary, agent lifecycle, audit, compose run trees, prompt registry, break-glass |
| **Doctor / Nurse / Lab / Pharmacy** | `apps/staff` (Flutter — Android + iPad + Windows + macOS + Linux + **web**, currently empty for AI) | Use the AI on patients: generate drafts, review their queue, sign / edit / reject, voice input |
| **Patient** | `apps/patient` (Flutter, existing) | Receive published aftercare instructions, teach-back, family updates after clinician sign-off |

`apps/staff` is the underused asset. It's already a Flutter app shipping
to Android tablets via the dalekdefender pipeline. The same codebase
compiles to Windows desktop, macOS, Linux, and **web** — meaning a doctor
at a workstation opens `https://clinical.<hospital>.local` in any browser
and gets the full app, no install. One codebase, six deployment targets,
zero IT-procurement friction for the workstation case.

### Decision B: Split-ingress, LAN-only clinical traffic

Current architecture routes all traffic through Cloudflare Tunnel →
`ingress-nginx` → cluster. Patient + admin should keep that path.
**Clinical traffic should not.** Standard EMR-vendor pattern (Epic,
Cerner, etc.) keeps clinical sessions on the hospital LAN — the
arguments are real:

- Latency: doctor click → response in ~30ms over LAN vs 150–400ms via Cloudflare round-trip
- PHI doesn't traverse a third party's network even encrypted (DPDP / HIPAA business-associate framing)
- Survives upstream internet outages (ward documentation keeps working)
- Smaller attack surface (no public DNS pointing to clinical endpoints)

```
  Patients (internet) ──► Cloudflare Tunnel ──┐
                                              │
  Admin/IT (often off-site) ─► Cloudflare ────┤──► ingress-nginx (public)
                                              │       │
                                              │       └─► backend, patient API, admin
                                              │
                                              ▼
                                       ┌────────────┐
                                       │  RKE2      │
                                       │  cluster   │
                                       └────────────┘
                                              ▲
                                              │
  Hospital wifi ──► clinical.hospital.local ──┘──► ingress-nginx-internal (LAN-only)
                                                      │
                                                      └─► backend (clinical routes only)
```

Same RKE2 cluster, two `IngressClass` resources (`public` + `internal`),
two ingress-nginx Helm releases. Each route's manifest declares which
class. Clinical routes get `internal` and bind to a hospital-LAN IP only.

For legitimate off-LAN clinician access (doctor reviewing charts from
home), **Tailscale** is the bridge — the laptop joins the hospital
tailnet and reaches the LAN ingress as if on-site. Already used in dev
for the dalekdefender rig; same pattern in prod. No public exposure,
no VPN concentrator.

---

## 3. What this unlocks

### Aggressive local-LLM routing for the deep tier

`localLlmClient.js` already supports Ollama and has a deep/quick tier
split (commit `079ce54b`) plus a regional egress guard
(`CLINICAL_AI_EXTERNAL_REGIONS`). With the cluster on a hospital LAN we
can:

- Stand up an Ollama node in the cluster (or a beefy GPU box on the same VLAN)
- Route the deep tier (`discharge_summary`, `medication_reconciliation`, `abnormal_result_triage`, `obstetric_risk_assistant`) to it
- Set `CLINICAL_AI_ALLOW_EXTERNAL=false` for the tenant
- **PHI never leaves the hospital building** — not even to Anthropic / OpenAI

This is the architecture that compliance teams will actually approve.
The framework was designed for exactly this.

### Voice-driven clinical workflows on the tablet

The bridge between `voiceSoapService` / `ambientDocumentationService` /
`ambientDiarizationService` and the multi-agent system isn't built. With
clinicians on Flutter tablets, "tap mic → speak chart → AI drafts" is a
real path. Not in this rollout's MVP, but a clear next step.

---

## 4. Phased delivery

Each phase is independently shippable. Each leaves the system in a
running state — none requires a "we're committing forever" call. The
public ingress stays in place throughout; we can flip clinical traffic
back to it if any phase breaks.

### Phase 0: Split clinical-AI routes into `/control/*` + `/clinical/*` (backend, ~1 day) — ✅ SHIPPED 2026-04-30

**What landed:**
- New `requireClinicalAiUse` middleware in `apps/backend/src/routes/admin/clinicalAi/shared.js` with the comprehensive `CLINICAL_AI_USER_ROLES_LIST` (union of every module's `reviewRoles[]` + ADMIN/SUPER_ADMIN catch-alls).
- New router `apps/backend/src/routes/admin/clinicalAi/clinicalUseRoutes.js` with the minimum-viable clinician surface: POST /admission-ai-draft, POST /discharge-compose, GET /discharge-compose, GET /discharge-compose/:runId, POST /discharge-compose/:runId/resume, GET /reviews (filtered to caller's role), PATCH /reviews/:id.
- Three mounts in `app.js`:
  - `/api/v1/admin/clinical-ai/*` — legacy alias gated by `CLINICAL_AI_CONTROL_ROLES` (admin UI keeps working unchanged).
  - `/api/v1/clinical-ai/control/*` — new canonical control-plane mount (same router, same gate).
  - `/api/v1/clinical-ai/clinical/*` — new clinical-use mount gated by `CLINICAL_AI_USER_ROLES_LIST`. The clinical mount intentionally skips `adminIpAllowlist` because clinicians come from arbitrary hospital workstations / tablets.
- 78 new unit tests in `src/tests/unit/clinicalAiRouteSplit.test.js` covering the full RBAC matrix + a drift guard that fails when any module's reviewRole isn't on the route allowlist.
- The clinical-AI route file directory stays at `routes/admin/clinicalAi/` — historical home; URL paths now decoupled from the directory.

**Why this design:** the route guard is the OUTER door (deny PATIENT, DELIVERY_STAFF, anonymous, unknown). The per-module `reviewRoles` filtering inside `clinicalAiWorkflowService.updateReview` and `listReviews` is the INNER door (real per-module filtering). Defense-in-depth; broad outer allowlist is intentional.

**Verified:** all 78 new tests pass; full backend unit suite stays green; npm run lint + raw-params + secrets:scan all clean.

**Not done in this phase (deferred to Phase 2 / 3):** the existing admin portal client still uses `/api/v1/admin/clinical-ai/*`. It does NOT need to change in Phase 0 — the alias keeps it working. When the apps/staff Flutter screens land in Phase 2, they'll target `/api/v1/clinical-ai/clinical/*`.

### Phase 1: Internal ingress + IngressClass (infra, ~2–3 days) — ✅ SHIPPED 2026-04-30

**What landed:**
- New manifest `infra/kubernetes/apps/backend/ingress-clinical-internal.yaml` — second `Ingress` resource with `ingressClassName: nginx-internal` exposing only `/api/v1/clinical-ai/clinical/*` (plus health probes). Public ingress at `api.vhhealth.app` is unchanged; control plane stays public.
- Default hostname `clinical.vhhealth.hospital.local` (overlay-overridable per environment).
- Cert: cert-manager `step-ca-internal` ClusterIssuer (already configured in `base/cert-manager/`). HSTS preload disabled because step-ca is private.
- Same security headers, body limits, and timeouts as the public ingress; rate limit raised slightly (1200 rpm vs 600) because clinicians legitimately generate many drafts per shift.
- Added to `infra/kubernetes/apps/backend/kustomization.yaml`. `kubectl kustomize` validates clean — both Ingresses emit with the right classes.

**Pre-existing infrastructure that made this trivial:**
- The `nginx-internal` IngressClass + Helm release was already defined in `base/ingress-nginx/ingress-nginx.yaml` (lines 215–242). Phase 1 just attached an `Ingress` resource to it.
- step-ca-internal ClusterIssuer was already configured.

**Hospital IT requirements (NOT done by Phase 1 — these are the things that gate real traffic):**
1. Hospital DNS: A or CNAME record `clinical.<hospital>.local` → internal-class ingress-nginx LB IP. Coordinate with hospital network team; they may want a different naming convention. Document the chosen hostname in the appropriate overlay's patch.
2. Hospital intermediate CA loaded into step-ca-internal so workstation browsers trust the cert without warnings.
3. Verify `ingress-nginx-internal` pods are reachable from the LAN (typically MetalLB or hostNetwork DaemonSet binding to a private interface IP).

**Verified:** `kubectl kustomize infra/kubernetes/apps/backend/` emits both Ingress resources with the correct `ingressClassName` values; no schema warnings.

**Not done in this phase (deferred):**
- Per-overlay hostname patches for prod / staging / dev — straightforward kustomize patch when the hospital DNS naming convention is decided.
- Dalekdefender mirror — the test rig uses tailscale-serve directly (separate concern); no ingress-nginx changes apply there.

### Phase 2: First Flutter clinician screen — review queue (~1 week) — ✅ SHIPPED 2026-04-30

**What landed:**
- New `apps/staff/lib/core/services/clinical_ai_api_service.dart` — typed Dart client for all seven `/clinical-ai/clinical/*` endpoints (admission draft, full discharge-compose CRUD + resume, list-my-reviews with role auto-filter, decideReview).
- `apps/staff/lib/features/clinical_ai/screens/clinical_ai_review_queue_screen.dart` — the queue: filter chips (Pending / Accepted / Edited / Rejected / All), pull-to-refresh, severity badges (critical + high counts) per row, tap-to-detail.
- `apps/staff/lib/features/clinical_ai/screens/clinical_ai_draft_detail_screen.dart` — the detail/sign view: critical-flag banner, full safety-flag list, JSON draft renderer with edit-mode toggle, four decisions (Accept / Accept-edits / Needs-revision / Reject with reason).
- Two new GoRouter routes added inside the existing ShellRoute: `/clinical-ai/queue` and `/clinical-ai/review/:reviewId`. Route push from the queue passes the row data via `extra:` so the detail screen renders immediately without a second round-trip.
- `flutter analyze` clean on the new code; no errors, no info-level lints.

**Decisions recorded in code:**
- Compose tree visualisation deliberately NOT rendered in this MVP — too complex for a small screen and lower-value than the per-module review flow. Defer until clinicians ask.
- Discharge-compose initiation flow also deferred — clinicians review drafts that are generated elsewhere; the "kick off a fresh compose" button is admin-portal-only for now.
- Critical safety flags surface as a red banner (matches the admin UI's pattern). Backend already routes these to a dead-letter status, so they shouldn't normally reach the queue, but the UI handles them defensively.

**Verified:** `flutter analyze` clean (0 issues). Build + sideload to dalekdefender APK pipeline is the next validation step (existing pipeline at `apps/staff/build/app/outputs/flutter-apk/app-debug.apk`; rebuild with `flutter build apk --debug --dart-define=API_URL=...`).

**Not done in this phase (intentional):**
- Sidebar nav entry pointing to `/clinical-ai/queue` — Phase 5 work; the route exists and is reachable via deep-link or programmatic navigation today.
- Voice input for draft generation — deferred to Phase 5+ (the existing ambient services aren't yet bridged to multi-agent draft generation).
- Per-role config gating in `lib/core/config/role_config.dart` — clinicians without any `reviewRoles` membership simply see an empty queue, which is correct behaviour. The role-config gate is cosmetic (hide nav entry from non-reviewers) and lands in Phase 5.

### Phase 3: Flutter web build + serve from cluster (~2–3 days) — ✅ SHIPPED 2026-04-30

**What landed:**
- `apps/staff/Dockerfile.web` — three-stage build (`flutter-build` → `asset-prep` → `nginx:1.27-alpine` runner). Bakes `--dart-define=API_URL=...` at build time so per-environment images point at the right LAN backend. Runs as non-root user `nginx` on port 8080 (no NET_BIND_SERVICE needed). Final image is ~30MB (alpine) carrying ~10MB of Flutter web assets.
- `apps/staff/nginx-staff-web.conf` — SPA routing (try_files → /index.html for GoRouter deep links), aggressive caching for hash-stamped Flutter outputs (1y immutable on `main.dart.js`, `flutter.js`, `/assets/*`, `/canvaskit/*`; `no-store` on index.html so ArgoCD rollouts pick up immediately), gzip + brotli, helmet-equivalent security headers, CSP that permits `connect-src 'self' wss: https:` for the API call from same-origin.
- New k8s manifest set under `infra/kubernetes/apps/staff-web/`:
  - `deployment.yaml` — 2 replicas, anti-affinity, runs as nginx user, read-only rootfs with tmpfs for `/var/cache/nginx`, `/var/run`, `/tmp`. Lightweight resource requests (25m CPU, 32Mi mem; 200m / 128Mi limits).
  - `service.yaml` — ClusterIP on port 80 → pod 8080.
  - `ingress.yaml` — `ingressClassName: nginx-internal`, same `clinical.<hospital>.local` hostname as the backend's clinical Ingress (Phase 1). Path-prefix discipline: backend Ingress claims `/api/v1/clinical-ai/clinical/*` and `/api/v1/health`, this Ingress claims `/` (the SPA itself); nginx-ingress most-specific-first matching keeps them co-located cleanly.
  - `hpa.yaml` — 2-6 replicas, scales on CPU at 60% utilisation (shift-change spike workload).
  - `pdb.yaml` — `minAvailable: 1` (rolling updates always keep one pod up).
  - `network-policy.yaml` — ingress only from `vhhealth-ingress` namespace + `ingress-nginx-internal` pods; egress empty (the pod has no legitimate outbound traffic).
- Added `staff-web/` to `infra/kubernetes/apps/kustomization.yaml` so ArgoCD picks it up alongside backend + admin.

**Verified:** `kubectl kustomize infra/kubernetes/apps/staff-web/` and `kubectl kustomize infra/kubernetes/apps/` both emit clean. All seven resources (Deployment, Service, Ingress, HPA, PDB, NetworkPolicy + namespace inheritance) have correct labels and selectors.

**What's NOT done (intentionally — small follow-up tasks, NOT blocking real traffic):**
1. CI workflow to build + push the staff-web image. Pattern: extend `.github/workflows/release-images.yml` with a third matrix entry mirroring backend/admin (build → trivy scan → cosign sign → push to ghcr). Tag scheme: `staff-web-v*` releases, `main-<sha>` per-push, `latest-staff-web` floating. Once the CI is in place, ArgoCD overlays for prod/staging pin to the tag.
2. Per-overlay image patches in `infra/kubernetes/overlays/{prod,staging,dev}` to pin a specific `staff-web-v*` tag (default in base is `latest-staff-web` for dev convenience).
3. Same hostname-patch story as Phase 1 — when hospital network team confirms the `clinical.<hospital>.local` naming convention, patch all three `clinical.vhhealth.hospital.local` references (backend Ingress + staff-web Ingress + Flutter `--dart-define=API_URL`).

**Risk audit (called out in plan; verified):** the staff app's `pubspec.yaml` uses `flutter_secure_storage` (web-supported via IndexedDB), `package:http` (web ✓), `go_router` (web ✓), `provider` (web ✓). No filesystem / camera / biometric plugins on the critical path for the clinical-AI screens. Voice / ambient-recording plugins are gated to mobile only via `kIsWeb` checks in the existing code.

### Phase 4: Local Ollama for the deep tier (~1–2 days infra + integration) — ✅ SHIPPED 2026-04-30

**What landed:**
- New manifest set under `infra/kubernetes/apps/ollama/`:
  - `statefulset.yaml` — single-replica StatefulSet with a 100GB volumeClaimTemplate for model weights, GPU node selector (`nvidia.com/gpu.present: "true"`) + GPU toleration, request/limit `nvidia.com/gpu: 1`, `OLLAMA_KEEP_ALIVE=30m` so models stay loaded between requests, generous startup probe (15-minute model-pull tolerance) → fast 30s probes thereafter.
  - `service.yaml` — both a headless `ollama-internal` service and a regular `ollama` ClusterIP service. The backend connects to `ollama-internal.vhhealth.svc.cluster.local:11434`.
  - `network-policy.yaml` — ingress allowed only from the backend pod; egress allowed for DNS + (during initial model pull) the public Ollama / HuggingFace registries. Strict overlays can drop the public-egress rule once the model is cached.
- Added `ollama/` to `infra/kubernetes/apps/kustomization.yaml` so ArgoCD picks it up.
- Backend `.env.example` updated with the deep-tier section: `CLINICAL_AI_DEEP_PROVIDER`, `CLINICAL_AI_DEEP_BASE_URL`, `CLINICAL_AI_DEEP_MODEL`, `CLINICAL_AI_DEEP_API_KEY`. The recommended values for an in-cluster Ollama deployment are inline-commented.

**How a hospital actually rolls this out:**
1. Cluster operator installs the `nvidia-device-plugin` DaemonSet (one-time, not in this repo).
2. ArgoCD syncs the new `apps/ollama/` manifests; the StatefulSet schedules onto a GPU node, pulls the chosen model on first run (5-15 minutes), and binds the PVC.
3. Cluster operator runs `kubectl exec -n vhhealth ollama-0 -- ollama pull <model>` once, OR adds an init container patch in their overlay to pre-pull. (Skipping this means the first inference call fetches; the StatefulSet's startupProbe is generous enough to absorb the wait.)
4. Backend ConfigMap / Secret patched with:
   ```
   CLINICAL_AI_DEEP_PROVIDER=ollama
   CLINICAL_AI_DEEP_BASE_URL=http://ollama-internal.vhhealth.svc.cluster.local:11434
   CLINICAL_AI_DEEP_MODEL=llama3:70b      # or qwen2.5:14b for smaller GPUs
   CLINICAL_AI_ALLOW_EXTERNAL=false       # locks down external egress for clinical traffic
   ```
5. Modules `discharge_summary` / `medication_reconciliation` / `abnormal_result_triage` / `obstetric_risk_assistant` (which already declare `model_tier: 'deep'` in `clinicalAiModuleService.js`) automatically route to Ollama on next generation.

**Validation criteria** (when a real GPU is available — NOT done in this PR because there's no test cluster with a GPU available locally):
- `clinical_ai_generations.metadata.tier` shows `'deep'` and `provider` shows `'ollama'` for the four flagged modules.
- Network egress logs / Cilium dropped-connection events show zero calls to `api.openai.com` / `api.anthropic.com` from the backend pod for clinical traffic.
- Latency budget: deep tier finishes under 30s per draft, ~5 minutes per 4-child compose.

**Risk audit:** if only an 8B / 14B GPU is available, drop `CLINICAL_AI_DEEP_MODEL=llama3:70b` to `llama3:8b` or `qwen2.5:14b`. The deep tier still routes through Ollama; you just lose some of the quality lift from the larger model. Quick tier still works regardless.

**Verified:** `kubectl kustomize infra/kubernetes/apps/ollama` emits StatefulSet + 2 services + NetworkPolicy clean. `kubectl kustomize infra/kubernetes/apps` (full app tier) composes including ollama with no conflicts.

### Phase 5: parallel/optional work — ✅ TWO ITEMS SHIPPED 2026-04-30, others remain optional

**What landed:**

1. **Sidebar nav entry** — `apps/admin/src/components/navigation/AdminNav.tsx` now lists "Discharge Compose" under the AI Governance group, gated by the same `CLINICAL_AI_CONTROL_ROLES` allowlist as the existing "Clinical AI" entry. Pointed at `/dashboard/clinical-ai/discharge-compose` (the page that's existed since the wire-up commit). Admins find it without typing the URL.

2. **Auto-resume scheduler** — `apps/backend/src/services/ai/workflowResumeScheduler.js`:
   - `runPausedWorkflowSweep()` polls `clinical_ai_workflow_runs` for `status='paused'`, looks up a registered handler for the `pause_reason`, calls the handler to check whether the gating condition has been met (e.g. governance approved), and calls `resumeWorkflow()` if yes.
   - `await_governance` handler queries `clinical_ai_approvals` for an approved row whose `payload @> {compose_generation_id: <run's compose id>}` and resumes if found.
   - Two registries (`registerWorkflowGraph`, `registerPauseReasonHandler`) so adding new graphs / new pause reasons is one line.
   - Wired into the existing cron in `apps/backend/src/utils/scheduler.js` at `*/30 * * * * *` (every 30s) with the standard `withJobLock('clinical-ai-workflow-resume', ...)` wrapper. Bounded at 25 resumes per tick.
   - Schema-missing safe — silently no-ops if `clinical_ai_workflow_runs` table doesn't exist (migration 109 not applied).
   - 9 new unit tests in `src/tests/unit/workflowResumeScheduler.test.js` covering empty queue, schema-missing, unknown workflow_key, unknown pause_reason, gate-passes-resume, gate-fails-no-resume, resume-failure-counted-distinctly, fan-out cap, handler-throws-treated-as-gate-blocked.

**Verified:** 1,305 backend unit tests pass (9 new + 1,296 existing, no regressions). `npm run lint` clean (eslint + raw-params + secrets). Admin lint clean.

**Items NOT shipped** (the rollout plan called these out as "parallel / optional"; deferred deliberately):
- **Voice-driven draft generation** — bridging `ambientDocumentationService` / `voiceSoapService` to the multi-agent draft path. Major value-add; 2-4 weeks of focused work; out of scope for Phase 5 hygiene work.
- **E2E Playwright coverage** for the admin discharge-compose page — mechanical follow-up.
- **Compose tree visualisation in Flutter** — defer until clinicians actually ask for it.
- **Manual fail-paused-run UI** — admin escape hatch for runs whose external gate will never fire. SQL UPDATE works for now.

---

## 5. What's explicitly NOT in scope

Pinned here so they don't drift in:

- **No Electron / native desktop installer.** Flutter Windows/macOS/Linux desktop builds plus Flutter web cover every reasonable workstation case from the same codebase. An Electron app adds a third UI surface for no benefit.
- **No autonomous AI actions.** Every draft remains rule-authoritative + decision-support-only. The clinician always signs. The compose workflow does not auto-publish.
- **No patient-side AI generation.** The patient app only displays *published* outputs (post-clinician-signoff). All AI happens server-side gated by clinical review.
- **No ABDM-specific redesign in this rollout.** ABDM integration stays where it is; clinical AI plugs into the existing chart context.
- **No new AI services beyond what's wired today.** The substrate is broad enough; the rollout is about delivery.
- **No multi-cluster split** (one clinical, one public). One cluster with two ingresses is sufficient at this stage. Revisit if/when clinical workload grows independent of patient-app workload.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| RBAC migration silently broadens access | Deny-by-default; exhaustive role-matrix tests in `src/tests/authorization.test.js` before merge |
| Hospital IT delays internal DNS / cert provisioning | Document the requirement in Phase 1; provide self-signed fallback with the hospital's intermediate CA |
| Flutter web plugin gaps | Audit `pubspec.yaml` early; gate web-incompatible features behind `kIsWeb` checks |
| Deep-tier model too large for available hardware | Tier is opt-in per module via `model_tier` setting; falls back to standard `CLINICAL_AI_*` env if `_DEEP_*` is unset (already in code) |
| Doctor doesn't actually use the Flutter screen | Phase 2 validation requires one real doctor running it for a week before scaling; iterate on what they hit, not what we imagined |
| LAN deployment breaks ABDM outbound calls | ABDM calls are server-side outbound from the cluster; LAN ingress only blocks inbound. Verify in Phase 1 staging. |
| Compose latency too high for clinician workflow | Each child runs 14 nodes; 4 children = ~56 LLM-or-rule calls. Profile in Phase 4; optimise context-fetch sharing if needed. |

---

## 7. Decisions still open

These should be resolved before Phase 0 starts. None are blocking *this
plan* — they're parameters of the implementation.

1. **Hostname convention** for the LAN ingress. `clinical.<hospital>.local`? `clinical.<hospital>.internal`? Whatever the hospital network team prefers — but lock it before Phase 1.
2. **First-pilot module set** for the Flutter review queue. Recommend: medication_reconciliation + patient_aftercare_instructions only, since those are the most-clinician-facing and the simplest review shapes. discharge_readiness involves admin and is less interesting for a doctor.
3. **Deep-tier model choice.** Depends on hospital GPU budget. 70B is ideal; 8B-or-13B is acceptable. Decide before Phase 4 procurement asks.
4. **Tailscale vs hospital VPN** for off-site clinician access. Recommend Tailscale (already in use for dalekdefender, simpler, identity-aware). Hospital may already have a VPN concentrator they prefer.
5. **Whether to keep admin portal on Cloudflare Tunnel or move it to LAN-only too.** Recommend: keep on Cloudflare. Admins are often off-site (procurement, IT-after-hours, executive review) and Tailscale-only is friction. But the option is open.

---

## 8. Cross-references

Code and architecture this plan depends on, all on `main`:

- **Backend services:**
  - `apps/backend/src/services/ai/workflowGraphRunner.js`
  - `apps/backend/src/services/ai/workflowCheckpointStore.js`
  - `apps/backend/src/services/ai/dischargeComposeService.js`
  - `apps/backend/src/services/ai/clinicalAiWorkflowService.js`
  - `apps/backend/src/services/ai/decisionMemoryService.js`
  - `apps/backend/src/services/ai/clinicalDebateService.js`
  - `apps/backend/src/services/ai/localLlmClient.js`
- **Backend routes:**
  - `apps/backend/src/routes/admin/clinicalAiRoutes.js` (top-level mount; the file Phase 0 refactors)
  - `apps/backend/src/routes/admin/clinicalAi/dischargeComposeRoutes.js`
  - `apps/backend/src/routes/admin/clinicalAi/coreClinicalRoutes.js`
- **Migrations:**
  - `108_clinical_ai_decision_memory.sql`
  - `109_clinical_ai_workflow_runs.sql`
  - `110_clinical_ai_workflow_subgraphs.sql`
- **Admin UI:**
  - `apps/admin/src/app/(with-auth)/dashboard/clinical-ai/page.tsx`
  - `apps/admin/src/app/(with-auth)/dashboard/clinical-ai/discharge-compose/page.tsx`
  - `apps/admin/src/lib/api/dischargeCompose.ts`
- **Infra:**
  - `infra/kubernetes/overlays/prod/` — current public ingress
  - `infra/kubernetes/overlays/dalekdefender/` — test rig (extend with internal-ingress overlay for Phase 1 validation)
- **Related docs:**
  - [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) — current public-ingress runbook
  - [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md) — relevant when sizing GPU for Phase 4

---

## 9. Session-to-session continuity

If you (Claude or someone else) pick this up in a new session:

1. **Read this doc first.** It is the source of truth for the rollout.
2. **Check `git log --oneline | head -20`** to see what's landed since this doc was written.
3. **Decide which phase to work on.** Phase 0 unblocks everything else.
4. **Update this doc** as phases ship — flip "drafted" to "Phase N in progress / shipped" at the top, add a "Status" column to section 4.
5. **Don't add new AI services.** The rollout is delivery-focused. New AI work belongs in a separate proposal.

The TauricResearch/TradingAgents-inspired multi-agent substrate is done.
The system is ready to be used. The remaining work is making it
*usable*, in the right places, by the right people, over the right
network.
