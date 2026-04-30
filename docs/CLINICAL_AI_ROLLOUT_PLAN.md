# Clinical AI Rollout Plan

**Status:** drafted 2026-04-30 (single session). Ready for review and phased
execution. Nothing in this doc has been built yet beyond what's already on
`main` from the multi-agent / workflow-graph / discharge-compose work.

**Audience:** anyone picking this up in a future session — Claude, the
project owner, or a teammate.

**One-sentence summary:** the multi-agent clinical AI substrate is
production-ready on the backend; the rollout problem is now about *who
uses it, on what device, and over which network* — not about new AI
features.

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

### Phase 0: Split clinical-AI routes into `/control/*` + `/clinical/*` (backend, ~1 day)

**Why first:** the foundation everything else builds on. Backend-only,
no infra changes. Reversible.

**Scope:**
- Refactor `apps/backend/src/routes/admin/clinicalAiRoutes.js` from one mount into two:
  - `/api/v1/clinical-ai/control/*` — governance, model registry, drift canary, audit, agent lifecycle, prompt registry, break-glass. Gated by current `requireClinicalAiControl` (ADMIN | SUPER_ADMIN | IT_*).
  - `/api/v1/clinical-ai/clinical/*` — generate, list-my-reviews, sign / edit / reject, view-my-pending-drafts, fetch compose tree (when caller is the assigned reviewer). Gated by a new `requireClinicalRole` (DOCTOR | NURSING_STAFF | LAB_STAFF | PHARMACY_STAFF | OBSTETRICIAN | etc.)
- Move route files: `coreClinicalRoutes.js`, `dischargeComposeRoutes.js`, `careOperationsRoutes.js` either route-by-route or by splitting each.
- Keep `/api/v1/admin/clinical-ai/*` as a thin alias to `/control/*` for one release so existing admin UI keeps working without changes.
- Update existing tests; add tests covering the new RBAC matrix.

**Validation:**
- Existing admin UI keeps working (alias mount).
- New clinical-role test cases pass.
- `npm run lint` clean, all unit tests pass, schema-drift clean.

**Risks:**
- The RBAC matrix has many roles; getting it wrong silently broadens access. Solution: explicit allowlist, deny-by-default, exhaustive role tests.

### Phase 1: Internal ingress + IngressClass (infra, ~2–3 days)

**Why second:** unlocks the LAN deployment without changing the apps.

**Scope:**
- Add a second `ingress-nginx` Helm release in `infra/kubernetes/overlays/prod/` configured as `internal` IngressClass, bound to a private IP.
- Hospital network team adds DNS for `clinical.<hospital>.local` → internal LB IP. (Their work; document the requirement.)
- Add `Ingress` manifests for `/api/v1/clinical-ai/clinical/*` only, with `ingressClassName: internal`.
- Patient + admin ingresses keep `public` → Cloudflare Tunnel path.
- Document the dalekdefender mirror (test rig) for LAN testing pre-prod.

**Validation:**
- `curl https://clinical.dalekdefender.hippocampus-monitor.ts.net/api/v1/clinical-ai/clinical/...` works from the tailnet.
- Same path returns 404 from outside the tailnet.
- Admin + patient flows unaffected.

**Risks:**
- Hospital IT may have opinions about adding internal DNS; coordinate early.
- Cert management for the internal cert (LetsEncrypt won't work for `.local`) — use cert-manager with a private CA, or self-signed with the hospital's intermediate CA.

### Phase 2: First Flutter clinician screen — review queue (~1 week)

**Why third:** validates the end-to-end path with a real screen one doctor can actually use.

**Scope (in `apps/staff`):**
- New screen: `lib/features/clinical_ai/review_queue/`
  - Lists `clinical_ai_reviews` where the current user is in the module's `reviewRoles`
  - Filterable by status / module / patient
  - Tap row → review detail with the draft, citations, safety flags, and accept/edit/reject actions
- New screen: `lib/features/clinical_ai/draft_detail/`
  - Renders the draft per module (discharge summary, abnormal result triage, etc.)
  - Surfaces critical safety flags as a red banner the doctor must dismiss before signing
  - Calls `PATCH /api/v1/clinical-ai/clinical/reviews/:id` with the decision
- API client module mirroring the admin's `lib/api/clinicalAi*.ts` but for the Flutter side.

**Validation:**
- Build APK, sideload to dalekdefender's test phone (the existing pipeline works).
- One doctor uses it for a week against the dalekdefender backend.
- Decision memory writes are visible in `clinical_ai_decision_memory` (validates the read+write loop end-to-end).

**Risks:**
- Mobile UX for compose tree is non-trivial — start with simpler single-module reviews (med rec, aftercare) and defer the full compose tree until Phase 3.

### Phase 3: Flutter web build + serve from cluster (~2–3 days)

**Why fourth:** adds the workstation experience without writing new UI code.

**Scope:**
- Add `flutter build web` to the staff app's CI.
- New container image `vhhealth-staff-web` serving the built static assets.
- New k8s manifest under `infra/kubernetes/apps/staff-web/` with `ingressClassName: internal`.
- Hospital DNS: `clinical.<hospital>.local` → staff-web service.
- Configure base URL via `--dart-define=API_URL=https://clinical.<hospital>.local`.

**Validation:**
- Browser at workstation hits `https://clinical.dalekdefender.hippocampus-monitor.ts.net/`, gets the staff app, can log in, can drive a review.
- Same URL fails from outside the tailnet.

**Risks:**
- Flutter web has rough edges for some plugins (e.g. native filesystem, biometric auth). Audit `apps/staff/pubspec.yaml` for plugins that don't support web; gate those features.

### Phase 4: Local Ollama for the deep tier (~1–2 days infra + integration)

**Why fifth:** unlocks the "PHI never leaves the building" guarantee.

**Scope:**
- Stand up an Ollama deployment in the cluster (or pin to a GPU node on the same VLAN).
- Pull a deep-tier-quality model (Llama-3-70B-Instruct, Qwen-2.5-72B, or similar) — sized to the available GPU.
- Configure environment:
  - `CLINICAL_AI_DEEP_PROVIDER=ollama`
  - `CLINICAL_AI_DEEP_BASE_URL=http://ollama-internal.vhhealth.svc.cluster.local:11434`
  - `CLINICAL_AI_DEEP_MODEL=llama3:70b` (or whichever)
  - `CLINICAL_AI_ALLOW_EXTERNAL=false`
- Smoke-test discharge_summary + medication_reconciliation + abnormal_result_triage end-to-end.

**Validation:**
- `clinical_ai_generations.metadata.tier` shows `'deep'` and `provider` shows `'ollama'` for relevant modules.
- Network egress logs show no calls to `api.openai.com` or `api.anthropic.com` for clinical traffic.
- Latency budget: deep tier should still finish under 30s per draft (~5 minute compose for 4 children).

**Risks:**
- 70B model on hospital hardware may not be feasible — sizing depends on what GPUs the hospital owns. If only 8B fits, the deep tier just routes to a slightly stronger 8B (still quality bump from quick-tier 8B due to better prompting / longer context).

### Phase 5+: parallel/optional work

Items that can land any time, in any order:

- **Sidebar nav entry** in admin portal pointing to `/dashboard/clinical-ai/discharge-compose` (currently the page exists but is unlinked).
- **Auto-resume scheduler** — a worker that polls `store.listPaused({ pause_reason: 'await_governance' })` and POSTs the resume endpoint when an approval row flips. Trivial; manual resume from UI works today.
- **Voice-driven draft generation** — bridge `ambientDocumentationService` / `voiceSoapService` to the multi-agent draft path. Major value-add; sized at 2–4 weeks of focused work depending on acoustic environment.
- **E2E Playwright coverage** for the admin discharge-compose page.
- **Compose tree visualization in Flutter** — the parent + children tree on a small screen. Defer until clinicians ask for it.

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
