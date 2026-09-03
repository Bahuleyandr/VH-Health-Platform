# Go-Live Runbook

Status: **HELD operator activation sequence for a possible first production
pilot.**

This runbook turns the go-live board into one dependency-ordered evidence path.
It does not assume the code is deployed and it does not authorize any command.
As of 2026-09-02, the current status is STOP; see
[`GO_LIVE_READINESS_GAP_MATRIX.md`](GO_LIVE_READINESS_GAP_MATRIX.md). Every
write requires the named owner, exact target SHA/environment, approved change
window, rollback owner, and retained evidence. Missing input is a stop, not an
instruction for engineering to choose a value.

## Rules Of Engagement

- Run this once in QA, then once in production. Do not skip the QA rehearsal.
- Treat every command that writes to a cluster, database, tenant setting, IdP, DNS zone, or external integration as an operator action requiring the named owner.
- Do not attach secrets, PHI, raw IdP assertions, raw NHCX payloads, or private keys to the evidence packet. Attach redacted command output, signed owner approval, hashes, run IDs, and screenshots where appropriate.
- Keep rollback ready before each flip. If rollback cannot be run by the on-call operator without escalation, the step is not ready.
- Production ArgoCD Applications stay manual-sync. A merge, `OutOfSync` state,
  CI result, prepared Secret, or rendered manifest never authorizes a sync.
- Forward SQL migrations have no generic down path. Do not describe an image or
  DSN rollback as undoing schema/data changes.
- The production sequence is: cluster, release pins, tenant, identity, terminology and content, media, device gateway, NHCX, clinical flips, monitoring and DR, external certification, cutover.

## Evidence Packet Layout

Create an activation folder outside the repo, for example:

```powershell
$RunId = Get-Date -Format "yyyyMMdd-HHmm"
$EvidenceRoot = "D:\Dev\_codex\artifacts\logs\$(Get-Date -Format yyyy-MM-dd)\go-live-$RunId"
New-Item -ItemType Directory -Force $EvidenceRoot | Out-Null
```

Store these files under that folder:

| File | Contents | Owner |
|---|---|---|
| `00-owner-decisions.md` | Pilot tenant identity, go-live date criteria, activation week rota, named rollback approvers. | Program owner |
| `01-cluster.txt` | Cluster, GitOps, image digest, Kyverno, RLS runtime-role evidence. | Platform ops |
| `02-tenant.txt` | Tenant onboarding, host routing, default-tenant fallback, RLS isolation evidence. | Platform ops |
| `03-identity.txt` | IdP, SCIM, break-glass, role mapping, session revocation evidence. | Security owner |
| `04-content.txt` | Terminology, drug knowledge base, indigenous knowledge base, content-studio evidence. | Clinical governance |
| `05-media.txt` | LiveKit/TURN/media smoke evidence. | Platform ops |
| `06-devices.txt` | VLAN, gateway, NodePort, soak replay, alert evidence. | Biomedical engineering |
| `07-nhcx.txt` | Sandbox/live mode approval, callback verification, finance SOP evidence. | Revenue cycle owner |
| `08-clinical-flips.txt` | Care-team ABAC, ledger, privilege-gated workflows, CSSD governance evidence. | Clinical safety owner |
| `09-observability-dr.txt` | Prometheus, Grafana, SLO, backup, restore, load, incident-response evidence. | SRE/on-call lead |
| `10-external.txt` | Pen-test, ABDM/NHCX/certification, legal and compliance signoffs. | Compliance owner |

## Phase 0 - Inventory And Freeze

Owner: Release captain.

Evidence gate:

- `github/main` is the intended release commit.
- No active production deploy is in progress.
- Operator owners are present or delegated for every owner in this runbook.
- The owner decisions in the final section are filled in and approved.
- PR #872 (`INF-006`) external containment is complete and the named release
  authority has supplied a retained receipt. As of 2026-09-02 it is not
  complete: the PR remains open/draft/HELD.

Commands:

```powershell
git fetch github --prune
git status -sb
git rev-parse github/main
gh run list --repo Bahuleyandr/VH-Health-Platform --branch main --limit 10
```

Run these read-only checks in a clean isolated checkout of the exact candidate
SHA. Do not reset, clean, switch, or overwrite a checkout owned by another
operator or agent.

Confirm the held surfaces are still held before activation:

```powershell
rg -n "HELD|deploy-state|not listed" infra/kubernetes/base/telemedicine infra/kubernetes/base/device-gateway
rg -n "ALLOW_DEFAULT_TENANT|LIVEKIT_ENABLED|NHCX_ENABLED|CARE_TEAM_ENFORCEMENT_MODE|LEDGER_AUTHORITATIVE_MODE|CHEMO_REQUIRE_ADMIN_PRIVILEGE" infra apps/backend/src docs
```

Rollback:

- Stop the activation ceremony.
- Leave all held kustomizations unreferenced.
- Leave all tenant/env flags at defaults.

## Phase 1 - Cluster, GitOps, Release Pins, And Policy Baseline

Owner: Platform ops.

Dependency: Phase 0.

Evidence gate:

- Node, storage, ingress, Cloudflare Tunnel, cert-manager, Argo CD, and CNPG
  have target-environment evidence. Monitoring delivery is not assumed; it is
  separately proven by the Alertmanager ceremony below.
- Production image placeholders in `infra/kubernetes/apps/kustomization.yaml` have been replaced by signed digest pins.
- RLS runtime role is present and the backend does not run as a PostgreSQL superuser.
- Kyverno is clean in Audit before any Enforce flip.
- The exact migration target, pre-sync restore point, migration-754 acceptance,
  migration-753 readiness, and post-run tracker expectation are reviewed.

Commands:

```powershell
kubectl get nodes -o wide
kubectl -n argocd get applications
kubectl -n cnpg-system get pods
kubectl -n vhhealth-monitoring get pods
kubectl -n vhhealth get deploy,sts,svc,ingress
kubectl -n vhhealth get secret vhhealth-backend-env -o jsonpath='{.metadata.name}'
kubectl -n vhhealth exec deploy/vhhealth-backend -- node -e "console.log(process.env.AUTH_TENANT_RLS_RUNTIME_ROLE || '')"
```

Pin release images:

```powershell
node scripts/update-prod-digests.mjs --verify backend --verify admin --verify staff-web
git diff -- infra/kubernetes/apps/kustomization.yaml
```

### 1A - PreSync migration evidence and rollback limit

Owner: database owner with platform ops and the release captain.

OWNER-INPUT — target SHA: ______; environment: ______; database owner: ______;
payroll data owner: ______; change window: ______; restore decision owner:
______; evidence location/hash: ______.

Before any `vhhealth-apps` manual sync:

1. Capture the rendered `vhhealth-backend-migration-config`,
   `vhhealth-payroll-revision-754-acceptance`, and
   `Job/vhhealth-backend-migrate` hashes without Secret values.
2. Capture a verified pre-sync backup/restore receipt, the current `_migrations`
   tail and checksums, the exact target migration files/checksums, and the
   expected post-run tail.
3. Run the migration-754 report-only preflight from the approved backend image.
   If legacy rows exist, the named payroll data owner must accept the exact
   exported mode-0600 manifest hash. The production acceptance fields are blank
   by default and must stay a stop until that receipt exists.
4. STOP on migration-753 activation: the current release has 82 `NOT VALID`
   constraints, no validation statements, no migration 756, and two unresolved
   design questions in the readiness gap matrix. An additive readiness
   migration plus owner-approved zero-open/exception evidence is required.
5. Only after every preceding receipt is complete may the authorized operator
   start the exact manual sync. Observe the PreSync Job live and export the Job
   conditions plus every attempt selected by
   `batch.kubernetes.io/job-name=vhhealth-backend-migrate` before the 24-hour
   TTL or another sync removes them. Confirm the owner-bypass gate and the final
   `_migrations` state independently; `Deployment` progress is not proof.

Failure stop:

- Stop the sync and preserve the ArgoCD stream, Job conditions, every retained
  attempt log, and database state. `DeadlineExceeded` may delete the running
  pod, so the live stream is part of the evidence.
- Do not re-sync merely to obtain fresh logs: `BeforeHookCreation` deletes the
  prior Job and its pods.
- Do not edit an applied migration, rewrite `_migrations`, force the Deployment,
  or assume a previous image reverses schema/data changes.
- OWNER-INPUT chooses restore-to-new-cluster from the verified pre-sync backup
  or an additive fix-forward migration after diagnosis. Until that decision and
  recovery proof exist, production cutover remains stopped.

### 1B - G1 Alertmanager activation ceremony

Owner: SRE/on-call lead with infrastructure and security approvers. The complete
live drill is
[`runbooks/C1_3_MONITORING_LIVE_DRILL.md`](runbooks/C1_3_MONITORING_LIVE_DRILL.md).

OWNER-INPUT — exact SHA: ______; environment: ______; operator: ______;
infrastructure approver: ______; security approver: ______; on-call coordinator:
______; approved window: ______; prior approved monitoring revision: ______;
off-site evidence location/retention: ______.

Sequence:

1. Outside git, the owners supply the complete `alertmanager.yaml`, operations
   webhook and off-site Watchdog endpoints, PagerDuty routing key, Slack API
   URL, SMTP password, SMTP smarthost/from/username, seven Slack channels, seven
   team/unmatched email targets, and the named on-call/acknowledgement map. Do
   not record values or direct contact details in the packet.
2. Build the private config from `alertmanager.yaml.example`; replace every
   `OWNER_INPUT` and example-invalid recipient value. Run pinned Alertmanager
   0.27.0 `amtool check-config` against the private file, then run the repository
   monitoring and route validators. Retain hashes and route output, including
   `BackendMigrationJobFailed` to `ops-webhook`, `critical-pagerduty`, and
   `team-backend`. Template validation is not live-delivery proof.
3. The authorized secret operator creates the strict-scope six-key
   `alertmanager-secrets` SealedSecret, commits ciphertext only as the
   non-example file, and adds that file to
   `infra/kubernetes/base/monitoring/kustomization.yaml`. Review the exact
   ciphertext/resource diff and the prior-revision rollback receipt.
4. The authorized ArgoCD operator manually syncs the approved exact revision of
   `vhhealth-platform` so the SealedSecret materializes. Verify only the Secret
   name and six key names. Then separately manually reconcile the approved exact
   revision of `vhhealth-kube-prometheus` so Alertmanager consumes that Secret.
   Never enable auto-sync.
5. Prove Prometheus targets/rules, Grafana dashboards, Alertmanager readiness,
   and the off-site Watchdog are healthy. Execute C1.3 scrape-to-resolution,
   owning-rule, and missed-Watchdog drills. Each route must reach a named human,
   be acknowledged and resolved, and retain delivery identifiers off-site.
6. G1 remains open until cleanup and rollback proof are attached. Missing input,
   target, delivery, acknowledgement, resolution, Watchdog, or off-site evidence
   is a failure, not an accepted partial pass.

Rollback/stop:

- Remove the synthetic drill namespace; manually restore the prior approved
  monitoring revision; verify all targets and Watchdog heartbeats recover; and
  preserve both failure and recovery evidence.
- Never weaken a route, alert, duration, threshold, recipient requirement, or
  evidence-retention rule to make the ceremony pass.

Run policy and repository monitoring validation as preparation evidence:

```powershell
node infra/kubernetes/base/monitoring/validate-monitoring.mjs
kubectl get policyreport,clusterpolicyreport -A
```

Files:

- `infra/kubernetes/apps/kustomization.yaml`
- `scripts/update-prod-digests.mjs`
- `infra/kubernetes/base/monitoring/kustomization.yaml`
- `infra/kubernetes/base/monitoring/backend-slo.yaml`
- `infra/kubernetes/base/monitoring/device-gateway-alerts.yaml`
- `docs/KYVERNO_ENFORCE_READINESS.md`
- `docs/DR_RESTORE_DRILL.md`

Rollback:

- Revert the digest PR or repin to the last known-good digest.
- Keep Kyverno in Audit.
- If the runtime DB role is wrong, roll back the backend deployment before any tenant or clinical flip.

## Phase 2 - Tenant Cutover And Default-Tenant Removal

Owner: Platform ops.

Dependency: Phase 1.

Evidence gate:

- Wildcard DNS and TLS are working for `<slug>-api.<base-host>` and tenant admin hosts.
- `onboard-tenant.mjs` has been run for the pilot tenant.
- Host-to-token cross-check and RLS isolation tests pass for the pilot tenant.
- All client builds use tenant-specific API base URL, tenant slug, tenant ID, and API key.
- `ALLOW_DEFAULT_TENANT=false` is only flipped after all production tenants are subdomained.

Commands:

```powershell
$env:DATABASE_URL = "<production-admin-url>"
$env:TENANT_BASE_HOST = "vhhealth.app"
node apps/backend/scripts/onboard-tenant.mjs --slug <pilot-slug> --name "<Pilot Hospital>" --region IN --compliance DPDP --base-host vhhealth.app --dry-run
node apps/backend/scripts/onboard-tenant.mjs --slug <pilot-slug> --name "<Pilot Hospital>" --region IN --compliance DPDP --base-host vhhealth.app
node apps/backend/scripts/check-no-default-tenant-fallback.mjs
```

Verify hosts and RLS:

```powershell
curl.exe -fsS https://<pilot-slug>-api.vhhealth.app/api/v1/health
curl.exe -fsS https://<pilot-slug>-api.vhhealth.app/api/v1/version
npm --prefix apps/backend test -- tenant-rls
```

Files:

- `docs/TENANT_ONBOARDING_RUNBOOK.md`
- `apps/backend/scripts/onboard-tenant.mjs`
- `apps/backend/scripts/check-no-default-tenant-fallback.mjs`
- `apps/backend/src/config/tenantRlsConfig.js`
- `infra/kubernetes/apps/backend/configmap.yaml`

Rollback:

- Set `ALLOW_DEFAULT_TENANT=true` only if the pilot is not live or if the rollback decision explicitly accepts single-tenant fallback risk.
- Remove the pilot host from public DNS or route it to maintenance.
- Disable tenant-specific client distribution until host and token binding are corrected.

## Phase 3 - Enterprise Identity And SCIM

Owner: Security owner.

Dependency: Phase 2.

Evidence gate:

- Tenant-scoped OIDC/SAML provider config exists for the pilot tenant and realm.
- Role mappings are explicit, approved, and fail closed on unmapped groups.
- SCIM bearer credential is rotated and configured only after the provider exists.
- Break-glass local admin accounts exist, MFA is verified, and they are excluded from SCIM deactivation.
- Deprovisioning blocks SSO, password, PIN, quick login, refresh, and active-token use.

Commands:

```powershell
# Inspect current provider config through the admin API or database.
curl.exe -fsS -H "Authorization: Bearer <SUPER_ADMIN_TOKEN>" `
  "https://<pilot-slug>-api.vhhealth.app/api/v1/admin/identity-sso/providers?realm=admin"

curl.exe -fsS -H "Authorization: Bearer <SUPER_ADMIN_TOKEN>" `
  "https://<pilot-slug>-api.vhhealth.app/api/v1/admin/identity-sso/providers?realm=staff"

node apps/backend/scripts/smoke-sso-admin-oidc.mjs --base-url https://<pilot-slug>-api.vhhealth.app/api/v1 --provider <provider-key>
```

SCIM smoke:

```powershell
curl.exe -fsS -H "Authorization: Bearer <SCIM_TOKEN>" `
  "https://<pilot-slug>-api.vhhealth.app/api/v1/scim/v2/<pilot-slug>/<provider-key>/ServiceProviderConfig"

curl.exe -fsS -H "Authorization: Bearer <SCIM_TOKEN>" `
  "https://<pilot-slug>-api.vhhealth.app/api/v1/scim/v2/<pilot-slug>/<provider-key>/Groups"
```

Files:

- `docs/superpowers/specs/2026-07-05-nl1-enterprise-identity-design.md`
- `apps/backend/src/routes/admin/identitySsoRoutes.js`
- `apps/backend/src/routes/auth/adminOidcSsoRoutes.js`
- `apps/backend/src/routes/auth/staffOidcSsoRoutes.js`
- `apps/backend/src/routes/auth/adminSamlSsoRoutes.js`
- `apps/backend/src/routes/auth/staffSamlSsoRoutes.js`
- `apps/backend/src/routes/scimRoutes.js`
- `apps/backend/src/services/auth/scimCredentialService.js`
- `apps/backend/src/migrations/357_tenant_identity_providers.sql`
- `apps/backend/src/migrations/368_nl1_p4_saml_config.sql`

Rollback:

- Disable the tenant IdP provider status or role mappings.
- Disable SCIM credentials for the provider.
- Use break-glass local admin accounts while IdP is corrected.
- Revoke active sessions for affected users after any bad mapping.

## Phase 4 - Terminology, Drug Knowledge Base, Indigenous Knowledge Base, And Content Studio

Owner: Clinical governance.

Dependency: Phase 3 for tenant-owned settings; Phase 1 for release and database baseline.

Evidence gate:

- Licensed terminology files are obtained from approved sources and remain outside the repo.
- Dry-run imports pass before real imports.
- Terminology coverage endpoint and verification SQL show the intended release labels.
- Drug knowledge base imports pass metadata lint, inactive import, acceptance battery, and signed activation.
- Indigenous/local knowledge base sources have provenance, activation approval, rollback label, and reviewer signoff.
- Content studio remains disabled until the tenant acceptance snapshot is attached.

Terminology commands:

```powershell
$env:DATABASE_URL = "<production-admin-url>"
Push-Location apps/backend
node scripts/terminology-import.mjs --system SNOMED_CT --rf2 "<rf2-snapshot-dir>" --version "<version>" --full --dry-run
node scripts/terminology-import.mjs --system LOINC --loinc "<loinc-csv>" --version "<version>" --full --dry-run
node scripts/terminology-import.mjs --system ICD11 --csv "<icd11-csv>" --version "<version>" --full --dry-run
node scripts/terminology-import.mjs --system ATC --csv "<atc-csv>" --version "<version>" --full --dry-run
Pop-Location
```

Real import only after dry-run signoff:

```powershell
Push-Location apps/backend
node scripts/terminology-import.mjs --system SNOMED_CT --rf2 "<rf2-snapshot-dir>" --version "<version>" --full
node scripts/terminology-import.mjs --system LOINC --loinc "<loinc-csv>" --version "<version>" --full
node scripts/terminology-import.mjs --system ICD11 --csv "<icd11-csv>" --version "<version>" --full
node scripts/terminology-import.mjs --system ATC --csv "<atc-csv>" --version "<version>" --full
Pop-Location
```

Per-tenant terminology settings:

```sql
INSERT INTO tenant_terminology_settings (
  tenant_id, preferred_diagnosis_system, enabled_systems, snomed_pickers_enabled, updated_by, updated_at
) VALUES (
  '<pilot-tenant-uuid>', 'ICD11', ARRAY['ICD10','ICD11','SNOMED_CT','LOINC','ATC']::text[], true, '<actor-uuid>', NOW()
)
ON CONFLICT (tenant_id) DO UPDATE SET
  preferred_diagnosis_system = EXCLUDED.preferred_diagnosis_system,
  enabled_systems = EXCLUDED.enabled_systems,
  snomed_pickers_enabled = EXCLUDED.snomed_pickers_enabled,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();
```

Drug knowledge base commands:

```powershell
node apps/backend/scripts/drug-kb-lint.mjs --manifest "<manifest-json>"
node apps/backend/scripts/drug-kb-import.mjs --source "<source-key>" --source-family "<source-family>" --version "<version>" --vendor "<vendor>" --license-note "<license-note>" --source-license-status "<status>" --edition-status candidate --priority 500 --inactive --dataset monographs --csv "<monographs-csv>"
node apps/backend/scripts/drug-kb-acceptance.mjs --source "<source-key>" --record-source "<source-key>"
npm --prefix apps/backend test -- drug-kb
```

Content studio flip:

```sql
INSERT INTO content_studio_settings (
  tenant_id, enabled, enabled_at, enabled_by, acceptance_snapshot, updated_at
) VALUES (
  '<pilot-tenant-uuid>', true, NOW(), '<actor-uuid>', '<redacted-acceptance-json>'::jsonb, NOW()
)
ON CONFLICT (tenant_id) DO UPDATE SET
  enabled = true,
  enabled_at = NOW(),
  enabled_by = EXCLUDED.enabled_by,
  acceptance_snapshot = EXCLUDED.acceptance_snapshot,
  updated_at = NOW();
```

Files:

- `apps/backend/docs/RUNBOOKS/terminology-releases.md`
- `apps/backend/docs/RUNBOOKS/drug-kb-import.md`
- `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md`
- `docs/superpowers/specs/2026-07-07-indigenous-drugkb-program-design.md`
- `apps/backend/src/migrations/370_tenant_terminology_settings.sql`
- `apps/backend/src/services/terminology/terminologySettingsService.js`
- `apps/backend/src/migrations/382_content_studio_settings.sql`
- `apps/backend/src/services/emr/orderSetContentStudioSettingsService.js`

Rollback:

- Disable `snomed_pickers_enabled` or remove the problematic system from `enabled_systems`.
- Deactivate the newly imported drug KB edition and reactivate the previous edition.
- Disable `content_studio_settings.enabled`.
- Do not delete licensed source artifacts until compliance retention has confirmed they are not evidence.

## Phase 5 - LiveKit Media Edge And TURN

Owner: Platform ops.

Dependency: Phase 1; Phase 2 if the media endpoint is tenant-specific.

Evidence gate:

- LiveKit remains held until L4/TURN, firewall, DNS, certificate, and two-device smoke evidence are approved.
- Recording remains disabled unless a separate privacy/legal approval exists.
- No third-party relay or generic HTTPS egress is introduced by the media network policy.

Commands:

```powershell
kubectl kustomize infra/kubernetes/base/telemedicine | Out-File "$EvidenceRoot\05-media-rendered.yaml"
rg -n "LIVEKIT_ENABLED|livekit|TURN|3478|7881" infra/kubernetes/base/telemedicine apps/backend/docs/RUNBOOKS/teleconsult-media-ops.md
```

Activation patch:

```powershell
# Add infra/kubernetes/base/telemedicine to the environment overlay only after owner approval.
kubectl apply -k infra/kubernetes/base/telemedicine --server-side
kubectl -n vhhealth rollout status deploy/livekit
kubectl -n vhhealth get svc livekit -o wide
```

Smoke:

```powershell
curl.exe -fsS https://<pilot-slug>-api.vhhealth.app/api/v1/health
# Then perform the manual two-device teleconsult smoke in apps/backend/docs/RUNBOOKS/teleconsult-media-ops.md.
```

Files:

- `infra/kubernetes/base/telemedicine/README.md`
- `infra/kubernetes/base/telemedicine/kustomization.yaml`
- `infra/kubernetes/base/telemedicine/livekit-deployment.yaml`
- `infra/kubernetes/base/telemedicine/network-policy.yaml`
- `apps/backend/docs/RUNBOOKS/teleconsult-media-ops.md`

Rollback:

- Set the backend LiveKit flag back to disabled.
- Remove the telemedicine kustomization from the environment overlay or delete the LiveKit resources.
- Re-run the manual smoke to prove teleconsult falls back to a held/disabled state without exposing stale sessions.

## Phase 6 - Device VLAN, Gateway NodePort, And Monitor Pilot

Owner: Biomedical engineering with platform ops.

Dependency: Phase 1 and Phase 2.

Evidence gate:

- Bedside monitors are isolated on the approved VLAN.
- Device registry is loaded with pilot devices and locations.
- `DEVICE_GATEWAY_API_KEY` and backend service token are sealed.
- NodePort or load-balancer exposure is approved by network/security.
- Soak replay produces no unassociated messages, old spooled payloads, or forward failures.
- PrometheusRule and Grafana panels are visible before the feed is opened.

Commands:

```powershell
kubectl kustomize infra/kubernetes/base/device-gateway | Out-File "$EvidenceRoot\06-device-gateway-rendered.yaml"
kubectl apply -k infra/kubernetes/base/device-gateway --server-side
kubectl -n vhhealth rollout status deploy/device-gateway
kubectl -n vhhealth get svc device-gateway -o wide
```

Soak replay and acceptance:

```powershell
npm --prefix apps/backend test -- device-vitals-tenant-scope
kubectl -n vhhealth exec deployment/device-gateway -c device-gateway -- node scripts/soak-replay.mjs --cycles=250 --duplicate-every=25
kubectl -n vhhealth-monitoring get prometheus -o name
```

Files:

- `apps/backend/docs/RUNBOOKS/device-gateway-activation.md`
- `apps/backend/docs/RUNBOOKS/device-gateway-triage.md`
- `infra/kubernetes/base/device-gateway/kustomization.yaml`
- `infra/kubernetes/base/device-gateway/deployment.yaml`
- `infra/kubernetes/base/device-gateway/service.yaml`
- `infra/kubernetes/base/monitoring/device-gateway-alerts.yaml`

Rollback:

- Close the monitor feed at the network edge.
- Remove or scale down the device-gateway deployment.
- Rotate `DEVICE_GATEWAY_API_KEY` if exposure or misrouting is suspected.
- Keep the triage queue for post-incident review; do not auto-associate uncertain device messages.

## Phase 7 - NHCX Live Mode

Owner: Revenue cycle owner with compliance.

Dependency: Phase 2, Phase 3 for tenant identity, and Phase 9 external approval if required.

Evidence gate:

- Live package, participant IDs, callback URLs, signing/HMAC material, replay window, and payment notice SOP are owner-approved.
- `NHCX_ENABLED=false` remains the global default until the pilot tenant effective config is approved.
- Sandbox callback and replay protection evidence is attached.
- Finance confirms NHCX payment notices never auto-settle or directly mutate the money ledger.

Commands:

```powershell
rg -n "NHCX_ENABLED|nhcx|PaymentReconciliation|payment notice" apps/backend/src apps/backend/docs/RUNBOOKS docs/superpowers/specs/2026-07-05-nl2-nhcx-claims-design.md
npm --prefix apps/backend test -- nhcx
```

Effective config check:

```powershell
curl.exe -fsS -H "Authorization: Bearer <ADMIN_TOKEN>" `
  "https://<pilot-slug>-api.vhhealth.app/api/v1/admin/nhcx/config"
```

Files:

- `apps/backend/docs/RUNBOOKS/nhcx-p1-core.md`
- `docs/superpowers/specs/2026-07-05-nl2-nhcx-claims-design.md`
- `apps/backend/src/config/nhcxConfig.js`
- `apps/backend/src/services/nhcx/nhcxTenantConfigService.js`
- `apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js`

Rollback:

- Set tenant NHCX config to disabled.
- Set `NHCX_ENABLED=false` globally if a deployment-wide override was used.
- Reject callbacks at the edge while preserving audit records.
- Resume manual claims/payment reconciliation SOP.

## Phase 8 - Clinical And Financial Flips

Owner: Clinical safety owner, finance owner, and department owners.

Dependency: Phases 2 through 7 as applicable.

### 8A - Care-Team ABAC Enforce

Evidence gate:

- Shadow telemetry covers every governed PHI record type; the owner separately
  confirms every in-scope URL sharing those policies was exercised.
- No legitimate-access denials appear in `patient_access_audit_log` for the agreed observation window.
- No `Patient access audit file fallback` entry exists in the observation
  window; unresolved-patient and database-write failures are recorded there
  rather than in `patient_access_audit_log`.
- Break-glass procedure is rehearsed.
- Enumeration-oracle check is clean: enforce responses do not reveal whether a patient/resource exists to unrelated staff.

Commands:

```powershell
$env:DATABASE_URL = "<production-owner-url>" # the script enforces READ ONLY
$env:CARE_TEAM_ENFORCEMENT_MODE = "shadow"
npm --prefix apps/backend run care-team:audit-enforcement-readiness -- `
  --tenant-id <pilot-tenant-uuid> `
  --window-days 7 `
  --output runs/care-team/<pilot-tenant-uuid>-readiness.json
```

The readiness audit runs in one repeatable-read, read-only snapshot. It blocks
on a split observation window with no traffic, missing governed record types,
any shadow denial, missing active
appointment/admission clinician membership, any active episode-scoped team
whose appointment/admission relationship is no longer valid, any active
non-longitudinal team with no episode context, a missing end-to-end break-glass
exercise, or an override that is still active. `READY FOR OWNER REVIEW` is not
automatic activation authority: the clinical safety owner must review the
report and retain the enumeration-oracle evidence before the SQL flip.

```sql
SELECT access_decision, metadata ->> 'shadow_mode' AS shadow_mode, COUNT(*)
FROM patient_access_audit_log
WHERE tenant_id = '<pilot-tenant-uuid>'
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY access_decision, metadata ->> 'shadow_mode'
ORDER BY access_decision, metadata ->> 'shadow_mode';

UPDATE tenants
SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{care_team_enforcement_mode}', '"enforce"', true)
WHERE id = '<pilot-tenant-uuid>';
```

Files:

- `docs/CARETEAM_ABAC_DESIGN.md`
- `apps/backend/src/services/security/careTeamEnforcement.js`
- `apps/backend/src/middleware/phiAccessMiddleware.js`
- `apps/backend/src/app.js`

Rollback:

```sql
UPDATE tenants
SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{care_team_enforcement_mode}', '"shadow"', true)
WHERE id = '<pilot-tenant-uuid>';
```

### 8B - Ledger Authoritative

Evidence gate:

- Reconciliation evidence says `FLIP-READY` for the pilot tenant.
- Finance accepts the ledger-vs-events oracle and drift alert behavior.
- No open billing/payment/cash-drawer incident exists.

Commands:

```powershell
$env:DATABASE_URL = "<production-admin-url>"
node apps/backend/scripts/ledger-reconciliation-evidence.mjs <pilot-tenant-uuid>
```

Flip:

```sql
UPDATE tenants
SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ledger_authoritative_mode}', '"enforce"', true)
WHERE id = '<pilot-tenant-uuid>';
```

Files:

- `apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js`
- `apps/backend/src/migrations/349_reconciliation_checks.sql`
- `apps/backend/scripts/ledger-reconciliation-evidence.mjs`
- `docs/superpowers/specs/2026-06-29-money-ledger-phase4-flip-authoritative-design.md`

Rollback:

```sql
UPDATE tenants
SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ledger_authoritative_mode}', '"shadow"', true)
WHERE id = '<pilot-tenant-uuid>';
```

### 8C - Credential Privilege Gates

Evidence gate:

- Privilege catalog contains the required privilege.
- Staff credentials are active, verified, and in date.
- Flag-off inertness test has already passed for each gate.
- Department owner signs the gate-on list.

Commands:

```powershell
rg -n "CHEMO_REQUIRE_ADMIN_PRIVILEGE|hasActivePrivilege|isGateEnabled|privilege_catalog" apps/backend/src docs/superpowers/build-prompts/nl6-05-credentialing.md
```

Flip one gate at a time:

```powershell
# Example only. Set through sealed environment/config, not ad hoc shell in production.
CHEMO_REQUIRE_ADMIN_PRIVILEGE=true
```

Files:

- `docs/superpowers/build-prompts/nl6-05-credentialing.md`
- `apps/backend/src/migrations/378_privilege_catalog.sql`
- `apps/backend/src/services/staff/credentialingService.js`
- `apps/backend/src/services/oncology/chemoService.js`

Rollback:

- Set the per-gate env flag back to false.
- Leave the credential catalog intact; do not remove evidence records.

### 8D - CSSD Governance

Evidence gate:

- CSSD cycle is running with warn-only theatre linkage.
- Overdue returns and failed-load cascades are visible.
- Hard-gating OT on CSSD data has explicit department signoff.

Files:

- `docs/superpowers/build-prompts/nl6-13-cssd.md`
- `apps/backend/src/migrations/423_set_issue_log.sql`
- `apps/backend/src/services/cssd/cssdService.js`

Rollback:

- Keep `warn_only=true` and `enforcement_enabled=false`.
- If hard enforcement was enabled by a future gate, disable it before schedule start.

## Phase 9 - Observability, Backup, DR, Load, And Security Readiness

Owner: SRE/on-call lead and compliance owner.

Dependency: Phases 1 through 8 evidence attached.

Evidence gate:

- PrometheusRule syntax and dashboards validate.
- Phase 1B and the complete C1.3 live drill prove backend SLO burn alerts and
  every required family route to the named activation-week on-call, including
  acknowledgement, resolution, Watchdog, and rollback evidence.
- DR drill proves RPO/RTO target or has a signed exception.
- Backup posture has R2 object lock/versioning and restore evidence.
- Pen-test readiness pack is current and external tester handoff is complete.
- CERT-In log retention and PHI audit evidence are attached.

Commands:

```powershell
node infra/kubernetes/base/monitoring/validate-monitoring.mjs
kubectl -n vhhealth-monitoring get prometheusrule
kubectl -n vhhealth-monitoring get configmap -l grafana_dashboard=1
```

DR drill:

```powershell
$env:CF_R2_ACCOUNT_ID = "<account-id>"
$env:DRILL_DATE = Get-Date -Format "yyyy-MM-dd"
bash infra/kubernetes/base/cnpg/dr-restore-drill.sh
# Save docs/qa-findings/$env:DRILL_DATE-dr-drill.md into 09-observability-dr.txt.
```

Security/compliance evidence:

```powershell
rg -n "RPO|RTO|CERT-In|pen-test|evidence packet|PHI reads|PHI writes" docs/DR_RESTORE_DRILL.md docs/india-deployment-readiness.md docs/PENTEST_READINESS.md docs/ABDM_READINESS.md
```

Files:

- `docs/DR_RESTORE_DRILL.md`
- `docs/RUNBOOK_ONCALL.md`
- `docs/india-deployment-readiness.md`
- `docs/PENTEST_READINESS.md`
- `docs/ABDM_READINESS.md`
- `infra/kubernetes/base/monitoring/validate-monitoring.mjs`
- `infra/kubernetes/base/monitoring/backend-slo.yaml`

Rollback:

- Stop production cutover if alerts, backups, or restore fail.
- Move the pilot to maintenance if evidence shows a production-impacting observability or recovery gap.

## Phase 10 - Production Cutover And First-Week Watch

Owner: Release captain.

Dependency: all prior phases.

Evidence gate:

- All phase owners sign `00-owner-decisions.md`.
- Release captain confirms no Sev1/Sev2 production issues are open.
- Activation-week on-call rota is live.
- Backout window and owner are announced.

Commands:

```powershell
git rev-parse github/main
gh run list --repo Bahuleyandr/VH-Health-Platform --branch main --limit 10
kubectl -n vhhealth get deploy
kubectl -n vhhealth rollout status deploy/vhhealth-backend
kubectl -n vhhealth rollout status deploy/vhhealth-admin
```

First-week checks:

```powershell
kubectl -n vhhealth logs deploy/vhhealth-backend --since=30m --tail=500
kubectl -n vhhealth-monitoring get alertmanager,prometheus
node apps/backend/scripts/ledger-reconciliation-evidence.mjs <pilot-tenant-uuid>
```

Rollback:

- Use the most recent phase-specific rollback that matches the failure.
- For broad instability: disable tenant-affecting flips first (`care_team_enforcement_mode`, `ledger_authoritative_mode`, LiveKit, NHCX, content studio, device gateway), then roll back image digest if required.
- Preserve evidence and incident notes before cleanup.

## QA Rehearsal Profile

Run the full sequence in QA with deliberate skips for irreversible or externally controlled production actions.

| Phase | QA action | Production-only skip |
|---|---|---|
| 0 | Create a QA evidence packet and freeze a QA commit. | None. |
| 1 | Validate QA cluster, digest render, monitoring syntax, and Kyverno reports. | Do not change production image pins. |
| 2 | Onboard a QA tenant and prove host/token/RLS isolation. | Do not flip production `ALLOW_DEFAULT_TENANT=false`. |
| 3 | Configure a QA IdP app and SCIM token; prove deprovisioning. | Do not rotate production IdP or SCIM credentials. |
| 4 | Import tiny approved non-production terminology/drug-KB fixtures; enable content studio for QA tenant. | Do not import licensed production files into QA unless license allows it. |
| 5 | Deploy LiveKit/TURN in QA and run two-device smoke. | Do not open production media ports. |
| 6 | Replay monitor feed from fixture data into QA gateway. | Do not connect real bedside monitors unless biomedical owner approves. |
| 7 | Use NHCX sandbox only. | Do not enable production NHCX. |
| 8 | Flip QA tenant care-team and ledger modes; run inertness tests for privilege/CSSD gates. | Do not flip production clinical gates. |
| 9 | Run restore drill against QA restore target and validate alert routing to test channel. | Do not page production on-call for drill alerts unless pre-announced. |
| 10 | Execute a QA cutover checklist and rollback one flip. | Do not announce production go-live. |

QA rehearsal is acceptable only if every skipped item is listed in `00-owner-decisions.md` with the production owner who will perform it.

## Flip Registry

| Flip | Default / held state | Activation condition | Evidence | Rollback |
|---|---|---|---|---|
| Release image digests in `infra/kubernetes/apps/kustomization.yaml` | Placeholder or previous digest | Signed image and digest verification complete | `scripts/update-prod-digests.mjs` output and Git diff | Revert to last known-good digest |
| Admin IP allowlist in `infra/kubernetes/apps/kustomization.yaml` | Fail-closed placeholder | Admin source CIDRs approved | Rendered manifest and ingress smoke | Restore previous allowlist |
| Kyverno `validationFailureAction` | Audit | Audit reports clean and owner approves enforce | `docs/KYVERNO_ENFORCE_READINESS.md` evidence | Return to Audit |
| Runtime RLS role | Superuser prohibited, runtime role required | Runtime role secret present and smoke passes | DB role query and tenant RLS tests | Roll back backend deployment/config |
| `ALLOW_DEFAULT_TENANT` | `true` in current single-tenant posture | All tenants subdomained; host/token/RLS evidence clean | `check-no-default-tenant-fallback.mjs` output | Set true only under explicit rollback approval |
| OIDC/SAML provider `status` | Draft/disabled | IdP metadata, role mapping, break-glass, and smoke pass | SSO smoke, identity audit events | Disable provider or mapping |
| SCIM `scim_enabled` | Disabled until token configured | Token stored, provider exists, deprovision smoke passes | SCIM ServiceProviderConfig and deprovision evidence | Disable SCIM and rotate token |
| `tenant_terminology_settings.snomed_pickers_enabled` | `false` | Licensed content imported and coverage approved | Import logs and coverage endpoint | Set false or remove system from enabled list |
| Drug KB edition `is_active` / equivalent active status | New import inactive | Acceptance battery and clinical governance signoff | Import log, acceptance tests, approval | Reactivate prior edition |
| Indigenous/local KB activation | Held/inactive | Provenance, source-family approval, reviewer signoff, rollback label | Source registry and acceptance packet | Deactivate source/edition |
| `content_studio_settings.enabled` | `false` | Tenant acceptance snapshot approved | `acceptance_snapshot` and audit event | Set `enabled=false` |
| LiveKit / `LIVEKIT_ENABLED` / telemedicine kustomization | Held and unreferenced | L4/TURN, network policy, privacy, two-device smoke pass | Rendered manifest and smoke notes | Disable flag and remove/scale LiveKit |
| Device gateway kustomization and MLLP exposure | Held and unreferenced | VLAN, registry, credentials, soak replay, alerts pass | Gateway runbook evidence | Close feed, scale down, rotate API key |
| NHCX tenant/global enablement | `NHCX_ENABLED=false` default | Live package, callbacks, replay protection, finance SOP approved | NHCX smoke and callback audit | Disable tenant/global NHCX |
| `care_team_enforcement_mode` | `shadow` | Clean shadow telemetry and enumeration-oracle review | Audit query and route coverage | Set `shadow` |
| `ledger_authoritative_mode` | `shadow` | `FLIP-READY` reconciliation evidence | `ledger-reconciliation-evidence.mjs` output | Set `shadow` |
| `CHEMO_REQUIRE_ADMIN_PRIVILEGE` and future privilege gates | `false` | Catalog, grants, department signoff, inertness proof | Credential/privilege tests and owner approval | Set env flag false |
| CSSD hard enforcement | `warn_only=true`, `enforcement_enabled=false` | Department signoff after warn-only pilot | CSSD board and issue-log evidence | Restore warn-only |
| Metabase optional module (`infra/kubernetes/optional/metabase`) | Held and unreferenced by the root kustomization | BI owner approves; SSO and network policy reviewed | Rendered manifest diff and dashboard smoke | Remove the overlay reference and scale down |
| PrometheusRule/Grafana activation | Rules present, firing behavior environment-dependent | Rule syntax, dashboard load, alert routing pass | `validate-monitoring.mjs` and alert route test | Remove bad rule or silence with incident note |
| Backup/DR production posture | Not a feature flag; go/no-go gate | RPO/RTO drill passes or exception signed | Restore drill output | Stop go-live |
| Pen-test/certification signoff | Not a feature flag; go/no-go gate | External owner approval complete | Signed report or exception | Stop go-live |

## Owner Decisions Required Before Production

| Decision | Required answer | Owner |
|---|---|---|
| Pilot tenant identity | Tenant slug, legal display name, tenant UUID, primary admin, production API host, production admin host. | Program owner and platform ops |
| Go-live date criteria | Exact date/time window, minimum green evidence list, no-go conditions, and who can call a stop. | Program owner |
| Activation-week on-call rota | Primary and secondary for platform, backend, database, security, biomedical/device, revenue cycle, clinical safety, compliance. | SRE/on-call lead |
| Rollback authority | Named person who can approve disabling each production flip and named person who can approve image rollback. | Program owner |
| IdP policy | OIDC/SAML provider, mapped groups, break-glass account owners, MFA/step-up requirement, SCIM ownership model. | Security owner |
| Clinical safety gates | Care-team enforce observation window, privilege-gate list, CSSD hard-enforcement decision, break-glass path. | Clinical safety owner |
| Content governance | NRCeS/SNOMED, LOINC, ICD-11, ATC, drug-KB, and indigenous/local KB source approvals. | Clinical governance |
| Device pilot scope | VLAN, monitor vendor/model list, wards/beds, NodePort/LB exposure, triage owner. | Biomedical engineering |
| NHCX live package | Environment, participant IDs, callback host, finance SOP, payment notice non-settlement rule. | Revenue cycle owner |
| Compliance acceptance | ABDM/NHCX/certification prerequisites, CERT-In log retention, pen-test signoff, evidence retention location. | Compliance owner |
| Alertmanager recipient and Watchdog authority | Operations webhook owner, off-site Watchdog service/evidence retention, PagerDuty integration owner, Slack channels, SMTP sender/recipients, drill acknowledgement map. | SRE/on-call lead, security, infrastructure, and department owners |
| Migration disposition | Payroll-754 manifest owner; inventory-753 readiness/exception owner; answers to 753-D1 and 753-D2; restore vs additive fix-forward decision owner. | Database, payroll, pharmacy, clinical safety, and release owners |

## Source Map

- Current go-live checklist and critical path: `docs/GO_LIVE_ACTIVATION_CHECKLIST.md`, `docs/GO_LIVE_CRITICAL_PATH.md`.
- Operator plan and dependency board: `docs/superpowers/plans/2026-07-07-one-month-execution-plan.md`, `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md`.
- Deployment and recovery: `docs/DEPLOYMENT_GUIDE.md`, `docs/DR_RESTORE_DRILL.md`, `docs/KYVERNO_ENFORCE_READINESS.md`, `docs/RUNBOOK_ONCALL.md`.
- Tenant and identity: `docs/TENANT_ONBOARDING_RUNBOOK.md`, `docs/superpowers/specs/2026-07-05-nl1-enterprise-identity-design.md`.
- Content and knowledge bases: `apps/backend/docs/RUNBOOKS/terminology-releases.md`, `apps/backend/docs/RUNBOOKS/drug-kb-import.md`, `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md`, `docs/superpowers/specs/2026-07-07-indigenous-drugkb-program-design.md`.
- Media, devices, and NHCX: `apps/backend/docs/RUNBOOKS/teleconsult-media-ops.md`, `infra/kubernetes/base/telemedicine/`, `apps/backend/docs/RUNBOOKS/device-gateway-activation.md`, `infra/kubernetes/base/device-gateway/`, `apps/backend/docs/RUNBOOKS/nhcx-p1-core.md`.
- Clinical and financial flips: `docs/CARETEAM_ABAC_DESIGN.md`, `apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js`, `docs/superpowers/build-prompts/nl6-05-credentialing.md`, `docs/superpowers/build-prompts/nl6-13-cssd.md`.
- External readiness: `docs/india-deployment-readiness.md`, `docs/ABDM_READINESS.md`, `docs/PENTEST_READINESS.md`.
