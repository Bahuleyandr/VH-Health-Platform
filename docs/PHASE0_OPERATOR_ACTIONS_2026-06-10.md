# Phase-0 Operator Actions — Security Remediation 2026-06-10

Companion to `docs/PLATFORM_SECURITY_AUDIT_2026-06-10.md` and
`docs/REMEDIATION_WORK_ORDER_2026-06-10.md`. These are the **HUMAN** items
from Phase 0 — they require access to the running cluster / GitHub / Tailscale
admin and **cannot be completed from code alone**. The corresponding code and
manifest changes are already committed; each item below flips a finding from
"code/manifest ready" to "closed".

Status legend: each item ends with a checkbox — tick it (with date + operator
initials) when verified against the live system.

---

## 1. H10 — Rotate the `vhhealth_readonly` password on every running cluster

**Why:** until 2026-06-10 the manifest set this PHI-reading role's password to
the literal `'set-in-sealed-secret'` at initdb. initdb SQL never re-runs, so
**every already-bootstrapped cluster still has the predictable password** even
after the manifest fix. The role can `SELECT` every table, and pg_hba accepts
scram from all RFC-1918 space.

**Manifest state (done):** `infra/kubernetes/base/cnpg/cluster.yaml` now
creates the role `NOLOGIN` with no password at initdb and manages it via
`managed.roles` with `passwordSecret: vhhealth-pg-readonly`.

**Operator steps (per cluster — prod + dalekdefender + any staging):**

1. Generate and seal the secret as described in
   `infra/kubernetes/base/cnpg/readonly-credentials.sealed-secret.yaml.example`
   (basic-auth secret `vhhealth-pg-readonly`, username `vhhealth_readonly`,
   strong random password, `cnpg.io/reload: "true"` label).
2. Commit the sealed file, let ArgoCD sync (or `kubectl apply`).
3. Confirm the operator reconciled the role and the OLD password no longer
   authenticates:
   ```bash
   kubectl cnpg psql vhhealth-pg -- -c \
     "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname='vhhealth_readonly';"
   # then from any in-cluster pod:
   PGPASSWORD='set-in-sealed-secret' psql -h vhhealth-pg-rw -U vhhealth_readonly vhhealth -c 'SELECT 1'
   # MUST fail with auth error
   ```
4. Re-point every dashboard/export consumer at the new credential (delivered
   via SealedSecret/Vault — never chat or email).
5. Record completion in `docs/SECURITY_HARDENING_CHECKLIST.md`.

- [ ] Done (date / initials): ______

## 2. H12 — dalekdefender deploy pipeline (policy + host hardening)

**Workflow state (done):** `.github/workflows/deploy-dalekdefender.yml` no
longer SSH-builds. It builds on the GitHub runner, pushes immutable
`dalek-<sha>` tags, blocks on Trivy CRITICAL/HIGH, signs with keyless cosign,
**verifies** the signature against the workflow's own OIDC identity, and the
SSH step only pins the deployments to the verified `@sha256` digest. It no
longer writes any Kubernetes Secret and no longer needs docker/k3s-ctr sudo.

**Operator steps:**

1. **GHCR pull access on the rig:** add a read-only GHCR token to
   `/etc/rancher/k3s/registries.yaml` on dalekdefender (or make the two
   `vh-health-platform-*` packages public — policy decision).
2. **Narrow sudoers:** the deploy user's `/etc/sudoers.d` entry should now
   allow ONLY the root-owned `/usr/local/sbin/vhhealth-gha-deploy` wrapper.
   The wrapper validates GHCR digest refs and commit SHA from stdin before it
   runs the limited `kubectl set image`, `kubectl set env`, and
   `kubectl rollout status` operations in namespace `vhhealth`. Remove docker /
   `k3s ctr` / blanket kubectl.
3. **Tailscale ACL:** restrict `tag:gha-deploy` to `dalekdefender:22` only
   (no other devices/ports). Verify in the Tailscale admin console.
4. **Sentry DSNs:** the workflow no longer patches `vhhealth-backend` /
   `vhhealth-admin` Secrets. Set `SENTRY_DSN` once on the rig via the overlay
   Secret (SealedSecret preferred) — confirm it survives a deploy.
5. **PHI policy decision (escalate):** confirm NO real patient data exists on
   the dalekdefender rig (DB, MinIO, logs, backups). If any is found, treat as
   an incident: isolate, purge, and document. Keep the rig firewalled from
   production networks and label it clearly as a test rig.
6. First run after merge: watch the workflow end-to-end (build → scan → sign
   → verify → pin) and confirm both rollouts go healthy.

- [ ] Done (date / initials): ______

## 3. Phase-0 runtime verification (H3 gates + DB role posture)

**Why:** tenant-RLS enforcement and the RLS-bypass boot guard are
runtime-dependent. Static review cannot prove they're active in prod.

**Checks (run against the production cluster):**

1. **Env gates** on the backend deployment:
   ```bash
   kubectl -n vhhealth-platform exec deploy/vhhealth-backend -- \
     sh -c 'echo NODE_ENV=$NODE_ENV AUTH_ENFORCE_TENANT_RLS=$AUTH_ENFORCE_TENANT_RLS'
   ```
   Required: `NODE_ENV=production` **and/or** `AUTH_ENFORCE_TENANT_RLS=true`.
   (`src/config/tenantRlsConfig.js` enables enforcement on either.)
2. **Connection-role posture** — the prod CNPG app role must NOT be
   SUPERUSER/BYPASSRLS:
   ```bash
   kubectl cnpg psql vhhealth-pg -- -c \
     "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
       WHERE rolname IN ('vhhealth','vhhealth_app','vhhealth_readonly');"
   ```
   All three must show `f` / `f`.
3. **Boot guard active:** confirm the backend boot logs (or
   `/health/metrics`) show the RLS posture check from
   `src/lib/prisma.js` (`verifyTenantRlsPosture`) ran and did NOT log the
   "SUPERUSER/BYPASSRLS — every tenant_isolation policy is silently bypassed"
   error, and that the guard has not been disabled via env override.
4. **Also verify** `OTP_CONFIG.devMode` and `ENABLE_DEV_AUTH` are OFF in prod
   (audit §5).
5. Record all four results (values + date) in
   `docs/SECURITY_HARDENING_CHECKLIST.md`.

- [ ] Done (date / initials): ______

## 4. H4 follow-up — HL7 feed host allowlist (recommended)

The SSRF guard now always blocks loopback/private/link-local/metadata
targets, and `HL7_FEED_HOST_ALLOWLIST` (backend env) optionally restricts
outbound HL7 feeds to an exact operator-approved host list. **Set this in
production** to the known partner-HIS hostnames. Note: subscription
management is already restricted to integration-admin roles
(`canManageIntegrations` in `routes/hl7/hl7FeedRoutes.js`), so the audit's
"if any staff can call createSubscription" severity escalation does not apply.

- [ ] Allowlist set in prod (date / initials): ______

## 5. H11 — Bootstrap the digest-pin block before the next ArgoCD sync

`infra/kubernetes/apps/kustomization.yaml` now pins all three app images by
`@sha256` digest. The committed digests are **all-zeros fail-closed
placeholders** — pods cannot pull them. Before the ArgoCD `apps` Application
next syncs, resolve the currently-deployed releases:

```bash
GHCR_TOKEN=<read:packages PAT> node scripts/update-prod-digests.mjs \
  --tag backend-v<current> --tag admin-v<current> --tag staff-web-v<current>
git commit -am "chore(prod): bootstrap H11 digest pins" && git push
```

Future releases update the block automatically via
`.github/workflows/release-pin-digests.yml` (GitOps write-back). If ArgoCD
auto-sync is aggressive, pause the `apps` Application until the bootstrap
commit lands.

- [ ] Real digests committed (date / initials): ______

## 6. M16 — Enable Kyverno image-signature verification

`infra/kubernetes/base/image-policy/kyverno-verify-images.yaml` verifies
keyless-cosign signatures at admission, keyed to the release workflows' OIDC
identity. It is **not yet wired into the base kustomization** because Kyverno
must be installed first:

1. Install Kyverno ≥ 1.12 (see the file header for the command).
2. Add `- image-policy` to `infra/kubernetes/base/kustomization.yaml`.
3. Watch one full sync in Audit mode, then flip
   `validationFailureAction: Audit → Enforce`.

- [ ] Enforcing (date / initials): ______

## 7. M14 / M13 / L11 / M17 — remaining infra operator steps

1. **M14** — repoint the Tailscale Funnel (or host proxy) for vh-mcp-postgres
   at a `kubectl port-forward` (the Service is now ClusterIP + deny-all
   NetworkPolicy); rotate `MCP_BEARER_TOKEN` to ≥32 chars (the server now
   refuses shorter tokens at boot).
2. **M13** — after the next nightly backup, confirm barman-cloud succeeded
   with `encryption: AES256` against R2 (check the Backup CR status). If R2
   rejects SSE, escalate — do not remove the directive silently.
3. **L11** — MinIO metrics now require a JWT: generate with
   `mc admin prometheus generate <alias>` and configure the scrape config.
   `vhhealth-records` objectLock applies to NEW installs only — on the
   running cluster, create a locked bucket and migrate objects, then swap
   the bucket name in backend config.
4. **M17** — on dalekdefender, run the updated
   `overlays/dalekdefender/rls-runtime-role.sql`, set a password for
   `vhhealth_runtime`, and repoint the backend Secret's DATABASE_URL at it
   (superuser DSN stays migration-only).
5. **L1** — access-token TTL defaults dropped (patient 7d→1h, staff 8h→1h).
   If prod env pins `JWT_EXPIRES_IN`, update it deliberately; expect a
   one-time re-login wave when deployed.
6. **M9** — after the next admin-portal deploy, smoke-test the dashboard
   with devtools open: the CSP is now nonce-based from middleware; report
   any CSP violity errors before rollout completes.

- [ ] All recorded in SECURITY_HARDENING_CHECKLIST (date / initials): ______
