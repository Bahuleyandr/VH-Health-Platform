# Go-Live Activation Checklist — VH Health Platform

**Created 2026-06-14.** Single ordered runbook for taking the platform from
"all in-our-control code complete + green" (the S-tier roadmap state as of
2026-06-14) to a production-enforced pilot deploy.

Everything below is **operator / cluster work** — the code, migrations, and
manifests are already committed and on `main`. Each step flips a control from
"manifest-ready" to "live + verified". **Order matters** where noted: secrets
before the first app deploy; digest pins before ArgoCD syncs apps; the
non-superuser DB role before (or with) the backend rollout, or RLS enforcement
breaks at runtime.

> Status legend per item: tick `- [ ]` → `- [x]` with **date / operator
> initials** once verified against the live system. Mirror completions into
> [`SECURITY_HARDENING_CHECKLIST.md`](SECURITY_HARDENING_CHECKLIST.md).

Companion runbooks (this file sequences them; they hold the detail):
- [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) — end-to-end deploy mechanics
- [`PHASE0_OPERATOR_ACTIONS_2026-06-10.md`](PHASE0_OPERATOR_ACTIONS_2026-06-10.md) — security-remediation operator items (referenced inline below; do not duplicate)
- [`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md) — timed PITR restore drill
- [`PENTEST_READINESS.md`](PENTEST_READINESS.md) + `compliance/` — external engagement packages
- [`CLINICAL_AI_KNOWLEDGE_CURATION.md`](CLINICAL_AI_KNOWLEDGE_CURATION.md) — RAG knowledge import
- [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md) — procurement spec

---

## Phase A — Pre-flight (cluster substrate exists)

Confirm the platform substrate is installed before any app activation. None of
this is app-specific; it's the GitOps + data foundation.

- [ ] **A1.** 3-node RKE2 cluster reachable; `kubectl get nodes` all `Ready`. (date / initials): ______
- [ ] **A2.** ArgoCD installed and the `apps` + base Applications are registered, but **auto-sync paused** until B/C below land (so fail-closed placeholders don't block the first sync). `argocd app get vhhealth-apps`. (date / initials): ______
- [ ] **A3.** Sealed-secrets controller installed; you can `kubeseal` against this cluster's public cert. (date / initials): ______
- [ ] **A4.** CloudNativePG operator installed; the `vhhealth-pg` Cluster CR is present (PG17, 3 replicas). (date / initials): ______
- [ ] **A5.** Cloudflare Tunnel → ingress-nginx path provisioned (zero inbound firewall ports). (date / initials): ______

---

## Phase B — Seal secrets (BEFORE first app deploy)

The non-superuser DB role is the load-bearing one: RLS enforcement is already
turned **on** in the manifests (`configmap.yaml` `AUTH_ENFORCE_TENANT_RLS:
"true"` + `AUTH_TENANT_RLS_RUNTIME_ROLE: "vhhealth_app"`), so the app **must**
connect as a `NOSUPERUSER NOBYPASSRLS` role or every `tenant_isolation` policy
is silently bypassed. Full detail: PHASE0 §1 (readonly) + §8 (runtime role).

- [ ] **B1.** Seal `vhhealth-pg-runtime` (basic-auth, user `vhhealth_runtime`, strong random pw) per `base/cnpg/runtime-credentials.sealed-secret.yaml.example`; commit (drop `.example`). CNPG `managed.roles` reconciles the role pw from it. *(PHASE0 §8.1)* (date / initials): ______
- [ ] **B2.** Re-seal `vhhealth-backend-env` with:
  - `DATABASE_URL` → `postgresql://vhhealth_runtime:<pw>@vhhealth-pg-rw…/vhhealth?sslmode=require` (same pw as B1)
  - `DATABASE_SUPERUSER_URL` → owner DSN (migration Job only)
  - `DATABASE_READ_URL` → CNPG RO pooler endpoint (`base/cnpg/poolers.yaml`) — **not** the placeholder, so analytics/dashboards stop falling back to primary
  *(PHASE0 §8.2; read-replica note in `apps/backend/CLAUDE.md` → Database Resilience)* (date / initials): ______
- [ ] **B3.** Seal `vhhealth-pg-readonly` (rotates the predictable initdb pw — every already-bootstrapped cluster still has the literal `set-in-sealed-secret`). *(PHASE0 §1)* (date / initials): ______
- [ ] **B4.** Seal the remaining prod app secrets: `JWT_SECRET`, per-client `API_KEY_*`, R2 creds, Firebase service account, `SENTRY_DSN`, `MCP_BEARER_TOKEN` (≥32 chars — server refuses shorter). (date / initials): ______
- [ ] **B5.** Set `HL7_FEED_HOST_ALLOWLIST` to the partner-HIS hostnames (defense-in-depth on the SSRF guard). *(PHASE0 §4)* (date / initials): ______
- [ ] **B6.** **SUPER_ADMIN 2FA step-up** (audit 2026-06-18 — SUPER_ADMIN un-scoped bypass). The admin-portal control planes (`/api/v1/admin`, `/api/v1/admin/gamification`, `/api/v1/system`, `/api/v1/logs`) now mount `requireSuperAdminStepUp`: a `SUPER_ADMIN` who relies on the role's blanket RBAC bypass must additionally hold a **2FA-verified** session (JWT `mfa:true`, stamped only by the admin TOTP enrollment-confirm / login challenge-verify paths) or the route returns **403 `SUPER_ADMIN_MFA_REQUIRED`**. Normal `ADMIN`s are unaffected. Before relying on admin-portal access:
  - [ ] Set `REQUIRE_MFA_FOR_SUPER_ADMIN: "true"` in `configmap.yaml` so every super-admin login forces TOTP enrollment/challenge (pairs the login gate with the step-up gate). (date / initials): ______
  - [ ] Ensure **every** `SUPER_ADMIN` account has TOTP enrolled via `POST /api/v1/auth/admin/mfa/{setup-enroll,setup-confirm}` (mounted **outside** the guarded namespaces, so enrollment/recovery is always reachable even when a super-admin is currently blocked). A super-admin without TOTP cannot reach the admin portal. (date / initials): ______
  - [ ] Smoke-check: a super-admin password-only token gets 403 `SUPER_ADMIN_MFA_REQUIRED` on `/api/v1/system`; the same admin after completing the TOTP challenge passes. (date / initials): ______

---

## Phase C — Bootstrap image digest pins (BEFORE ArgoCD syncs apps)

`infra/kubernetes/apps/kustomization.yaml` pins all three app images by
`@sha256` — the committed values are **all-zeros fail-closed placeholders**
(pods can't pull them). Resolve real digests before the first `apps` sync.

- [ ] **C1.** Build + sign + push the first images (GH Actions `release-images.yml`, or tag `backend-v…`/`admin-v…`/`staff-web-v…`). (date / initials): ______
- [ ] **C2.** `GHCR_TOKEN=<read:packages> COSIGN_PUBLIC_KEY=<public key> node scripts/update-prod-digests.mjs --tag backend-v<v> --expected-digest sha256:<from that release run> --tag admin-v<v> --expected-digest sha256:<…> --tag staff-web-v<v> --expected-digest sha256:<…>` (each digest from its release run's image-ref.txt artifact / summary — prod refuses tag-only pins, audit finding #20) → verify signatures, commit "chore(prod): bootstrap H11 digest pins" → push. *(PHASE0 §5)* (date / initials): ______
- [ ] **C3.** Future releases auto-update the pin block via `release-images.yml`; `release-pin-digests.yml` is the manual repair path. (noted)

---

## Phase D — First sync / deploy (dependency-ordered)

Resume ArgoCD auto-sync (A2). The order CNPG → migration Job → backend is what
makes RLS enforce cleanly on first boot.

- [ ] **D1.** CNPG Cluster reconciles: `vhhealth_runtime` role created (from B1), `enableSuperuserAccess: false` applied, **and the owner `vhhealth` carries `bypassrls`** (granted via `managed.roles` so the migration can apply through FORCE RLS). ⚠️ `managed.roles` is reconciled on the **CNPG operator's own loop**, NOT as an ArgoCD sync-wave — so on a fresh cluster the `bypassrls` attribute can lag behind the PreSync migration Job. **Manual fallback check before letting D2 proceed:** `kubectl cnpg psql vhhealth-pg -- -c "SELECT rolbypassrls FROM pg_roles WHERE rolname='vhhealth'"` **must return `t`**. If it's `f`, wait for the CNPG operator to reconcile `managed.roles` (check operator logs) — do NOT force the migration through. (date / initials): ______
- [ ] **D2.** PreSync **migration Job** runs all `src/migrations/*.sql` using `DATABASE_SUPERUSER_URL` — including **309** (BCMA scan timestamps), **310** (GUC-reading `tenant_id` defaults on 379 policied tables — needs owner to ALTER), **311** (knowledge curation columns). Confirm the Job is `Complete`, not `Error`. (date / initials): ______
  - **Ordering gate (security-review HIGH #6 — closes the fresh-cluster race).** The Job has a `wait-owner-bypassrls` **initContainer** that BLOCKS until `SELECT rolbypassrls FROM pg_roles WHERE rolname='vhhealth'` returns `t` (polls every 5s, hard 5-min timeout), so the migration can never start while the owner is still `NOBYPASSRLS` — without it, the Job could race CNPG's async `managed.roles` reconcile and 42501 partway through (000_baseline does `SET row_security=off`; migs 237/272 `ALTER … FORCE ROW LEVEL SECURITY`). On timeout the initContainer exits non-zero with `owner bypassrls not reconciled by CNPG — check managed.roles` and the Job fails **at the gate**, loudly and diagnosably, instead of half-applying migrations. If you see this timeout, run the D1 manual fallback check above. Verify the gate ran: `kubectl -n vhhealth logs -l batch.kubernetes.io/job-name=vhhealth-backend-migrate -c wait-owner-bypassrls --prefix` should end with `… has bypassrls=t … — proceeding to migrate`. (Select on the controller-set job-name label, not `job/<name>`: the Job runs `restartPolicy: Never`, so a failed run leaves up to three retained attempt pods and `logs job/<name>` shows only one arbitrary attempt.)
  - **Config must be PreSync-phase, and it now is.** ArgoCD completes every PreSync hook before applying ANY Sync-phase resource — sync waves order within a phase, not across phases. The Job therefore takes its config from `vhhealth-backend-migration-config` (`migration-config.yaml`, a PreSync hook at wave `-2`), NOT from the runtime `vhhealth-backend-config`, which is Sync-phase and does not exist yet at this point of a fresh sync. Until this was fixed the Job could not start on a fresh namespace at all: `CreateContainerConfigError` is a *Waiting* reason, so the Job never failed, never retained a pod, and was finally killed at `activeDeadlineSeconds` leaving **no pods and no logs** — and the Sync phase that would have created the missing ConfigMap was itself gated on this hook, so re-syncing reproduced it. `scripts/validate-kubernetes-manifests.mjs` now fails the render if any PreSync hook hard-requires a Sync-phase object. If D2 ever shows a Job stuck with no pods, check `kubectl -n vhhealth describe job vhhealth-backend-migrate` for `DeadlineExceeded` and the pod events for `CreateContainerConfigError` before assuming a database problem.
- [ ] **D3.** Backend Deployment rolls out, connecting as `vhhealth_runtime`. `/health/ready` green. (date / initials): ______
- [ ] **D4.** Admin + staff-web rollouts healthy; ingress serves `https://api.vhhealth.app` and the admin portal. (date / initials): ______

> **Staging-first strongly recommended:** run D1–D4 against the `staging`
> overlay (or dalekdefender test rig) before prod, so migration 310's
> 379-table `ALTER … DEFAULT` and the runtime-role cutover are proven on a
> non-patient cluster first. See PHASE0 §2 for the dalekdefender pipeline.

---

## Phase E — Verify RLS enforcement at runtime (the audit's #1 blocker)

Static review can't prove tenant isolation is live. Run these against prod
*after* D. All four must pass. *(PHASE0 §3 + §8.4)*

- [ ] **E1.** Env gates: `kubectl -n vhhealth-platform exec deploy/vhhealth-backend -- sh -c 'echo $NODE_ENV $AUTH_ENFORCE_TENANT_RLS'` → `production true`. (date / initials): ______
- [ ] **E2.** Connection-role posture: `kubectl cnpg psql vhhealth-pg -- -c "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('vhhealth','vhhealth_app','vhhealth_runtime','vhhealth_readonly');"` → all `f`/`f`. (date / initials): ______
- [ ] **E3.** Boot guard: backend boot log says **`Tenant RLS posture OK — isolation will enforce`** (`logTenantRlsRolePosture` in `src/lib/prisma.js`), effective role `vhhealth_app` via `SET LOCAL ROLE`, connection role `vhhealth_runtime` — and did NOT log the "SUPERUSER/BYPASSRLS … silently bypassed" error. (date / initials): ______
- [ ] **E4.** `OTP_CONFIG.devMode` and `ENABLE_DEV_AUTH` are **OFF** in prod. (date / initials): ______
- [ ] **E5.** Smoke the multi-tenant property the `cross-tenant-rls` CI journey asserts: a tenant-B token cannot read tenant-A PHI; an insert under tenant B lands `tenant_id=B` (migration 310). (date / initials): ______

---

## Phase F — Admission-control hardening (Kyverno)

`base/image-policy/kyverno-verify-images.yaml` is wired into the base
kustomization in **Audit** mode. *(PHASE0 §6)*

- [ ] **F1.** Install Kyverno ≥ 1.12 (command in the policy file header; the ansible bootstrap does **not** install it yet). (date / initials): ______
- [ ] **F2.** Run `node scripts/check-kyverno-enforce-readiness.mjs --live --context <prod-context> --since-hours 24 --min-pass-results 3` and attach the clean Audit-mode output plus raw PolicyReport/ClusterPolicyReport evidence. (date / initials): ______
- [ ] **F3.** Follow [`KYVERNO_ENFORCE_READINESS.md`](KYVERNO_ENFORCE_READINESS.md) for the operator-only `Audit` to `Enforce` flip, server-side dry-run, observation, and rollback window. Flipping before a clean audit cycle risks a cluster-wide pod-admission outage. (date / initials): ______

---

## Phase G — Reliability: monitoring live + DR drill passed

These are the audit's blocker #2 (monitoring/DR not running) and the roadmap's
Jun-30 reliability gate.

- [ ] **G1.** Monitoring stack (`base/monitoring/`) deployed and **scraping**: Prometheus targets up, Grafana dashboards render, Alertmanager + deadman alert firing-path tested. (date / initials): ______
- [ ] **G2.** Confirm outage-critical CronJobs run independently of the backend: `downtime-pack`, `backup-verify`, `canary` (B2.3) — and the `OutageCriticalCronFailing` alert wires to real metrics. (date / initials): ______
- [ ] **G2a.** Confirm ward downtime packs are actually **produced**, not merely that their job succeeds: `WardDowntimePacksMissing` reads a non-absent `vhhealth_ward_downtime_pack_wards_missing`, an occupied ward with no pack raises it, and generating a pack clears it. (`WardDowntimePacksStale` was retired 2026-08-04 — a CronJob-liveness rule cannot see a sweep that succeeds having published nothing; see [`DOWNTIME_PROCEDURE.md`](DOWNTIME_PROCEDURE.md#why-generation-may-produce-nothing).) (date / initials): ______
- [ ] **G3.** Nightly CNPG backup to R2 succeeds with `encryption: AES256` + object-lock/versioning (check the Backup CR status). *(PHASE0 §7.2)* (date / initials): ______
- [ ] **G4.** **Run the timed DR drill** ([`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md)): PITR restore into a scratch namespace, measure RPO/RTO vs targets, run clinical-invariant checks, file the artifact in `docs/qa-findings/`. (date / initials): ______
- [ ] **G5.** k6 load test meets SLOs (roadmap reliability A+ column). (date / initials): ______

---

## Phase H — Downtime LAN mirror (REL-5 infra half)

The manifests and edge package are held. Completing these receipts does not
authorize a sync, flag flip, service enablement, or production activation.
Use [`runbooks/CONTINUITY_EDGE_MIRROR.md`](runbooks/CONTINUITY_EDGE_MIRROR.md)
for the exact operator sequence.

- [ ] **H1. Durable publication RWX evidence.** The operator has selected a
  StorageClass only after
  [`C1_2_STORAGE_PLACEMENT_GATE.md`](C1_2_STORAGE_PLACEMENT_GATE.md) records
  `PLACEMENT QUALIFIED / CHANGE APPROVED`, pre-created the
  `vhhealth-continuity-publication` RWX PVC, and attached one evidence packet
  containing all of the following. (date / initials): ______
  - [ ] StorageClass, CSI driver/version, PV, PVC, encryption-at-rest, reclaim
    policy, expansion, and backup/restore evidence.
  - [ ] Concurrent RWX proof from pods scheduled on separate nodes; this must
    demonstrate one coherent view rather than node-local `hostPath` behavior.
  - [ ] The production UID/GID and filesystem-permission receipt proving the
    generator can write while the backend identity can read but cannot write.
  - [ ] Capacity, storage-failure, node-failure, detach/remount, and post-remount
    integrity evidence with named pass/fail results.
  - [ ] The source SSH hostname/fingerprint and forced-command read-only pull
    principal; no shell, forwarding, write, delete, or tenant-root listing.
  - [ ] Named infrastructure, security, privacy, and clinical owners.
  - [ ] A reviewed Kustomize diff showing the CronJob read/write mount, backend
    read-only mount, `/var/lib/vhhealth/continuity`,
    `DOWNTIME_MIRROR_DIR`, and
    `CLINICAL_CONTINUITY_PACKS_ENABLED=false`.
- [ ] **H2. Independent edge activation packet.** C-D4 and C-D10 are
  countersigned; the schema-v2 policy receipt supplies approved access and
  retention values; LUKS2 data/log mounts, distinct source-pull/log-upload/TLS
  credentials, location-scoped logging identities, trusted clock, image
  digests, anti-rollback bootstrap floors, and the completed activation
  receipt have passed the package preflight. The exact facility/unit edge URLs
  have been installed through the managed terminal launcher. (date / initials): ______
- [ ] **H3. Outage and legacy-sunset drill.** With backend, database,
  Kubernetes path, Cloudflare, and internet unavailable, an authorized terminal
  retrieved and printed the exact facility/unit edge pack while wrong audience,
  revoked certificate, expired grant, stale/rolled-back set, and corrupt or
  partial set attempts failed closed. Recovery uploaded and ingested the signed
  access-log chain. Legacy `/downtime/static` bookmarks were inventoried,
  migrated, observed through the agreed coexistence window, and retired only
  under a signed change receipt. Attach timings, evidence, rollback result,
  owners, date, and initials. (date / initials): ______

---

## Phase I — Clinical data load

- [ ] **I1.** Stand up the deep-tier embedder (B5.4). The Ollama manifests are HELD at `infra/kubernetes/held/clinical-ai-deep-tier/` and composed by nothing, so this is an explicit operator activation, not a sync: provision + label the GPU node, render and apply that held directory per its `README.md`, pull a model, and let the fail-closed `PreSync` preflight hook pass. Then set `CLINICAL_AI_EMBED_URL` / the deep-tier bindings. (date / initials): ______
- [ ] **I2.** Import hospital-owned knowledge into the RAG KB: `node apps/backend/scripts/knowledge-curation-import.mjs` (formulary / antibiogram / protocols) → review the `pending` queue → approve. Imports stay dark to retrieval until `curation_status='approved'`. ([`CLINICAL_AI_KNOWLEDGE_CURATION.md`](CLINICAL_AI_KNOWLEDGE_CURATION.md)) (date / initials): ______
- [ ] **I3.** Load the real hospital formulary + antibiogram data (the starter KBs in migration 311 are flagged placeholders). (date / initials): ______
- [ ] **I4.** **[flagged — licensed]** Import a commercial drug-interaction KB (Medi-Span / FDB) if procured; `drugKnowledgeBaseService` + migration 277 are ready for the feed. (date / initials): ______

---

## Phase J — External engagements (Externally-certified S)

Not blockers for an internal pilot; required for the "externally-certified S"
bar. Packages are cert-ready in `docs/compliance/`. *(WS7)*

- [ ] **J1.** ABDM certification (B7.1 package). (date / initials): ______
- [ ] **J2.** NABH assessment (B7.2 package). (date / initials): ______
- [ ] **J3.** DPDP external audit (B7.3 package). (date / initials): ______
- [ ] **J4.** Third-party penetration test ([`PENTEST_READINESS.md`](PENTEST_READINESS.md)); feed findings to the backlog (DSAR export, consent-withdrawal UX, breach dispatch already registered as gaps). (date / initials): ______

---

## Done-definition

**Internal A+/S (pilot-ready):** Phases A–I complete + verified; the
deterministic 11-journey gate green in CI on the deployed `main`; E (RLS), F
(Kyverno Enforce), G4 (DR drill passed), G1 (monitoring live) all ticked.

**Externally-certified S:** Phase J cleared.
