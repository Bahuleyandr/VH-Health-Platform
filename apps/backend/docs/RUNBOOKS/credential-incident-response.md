# Credential Incident Response

Use this runbook when a secret, service-account key, API token, or signing
secret is exposed in GitHub, CI logs, chat, local artifacts, or a third-party
provider alert.

## Severity

Treat exposed production credentials as **P0** until the credential is revoked
or proven unusable. Treat exposed test placeholders as **P2** unless they grant
access to shared infrastructure.

## Immediate Response

1. Stop using the exposed credential.
2. Disable or revoke it at the provider.
3. Rotate dependent runtime configuration only through the deployment secret
store. Do not commit generated key files.
4. Review provider audit logs for use of the exposed principal or token.
5. Run local and CI secret scans.
6. Decide whether public Git history must be rewritten.

## Firebase Admin SDK Keys

List service-account keys:

```powershell
& "D:\Dev\Tools\google-cloud-sdk\bin\gcloud.cmd" iam service-accounts keys list `
  --iam-account="firebase-adminsdk-fbsvc@vhhealth.iam.gserviceaccount.com" `
  --format="table(name.basename():label=KEY_ID,keyType,validAfterTime,validBeforeTime,disabled)"
```

Delete a confirmed exposed key:

```powershell
& "D:\Dev\Tools\google-cloud-sdk\bin\gcloud.cmd" iam service-accounts keys delete KEY_ID `
  --iam-account="firebase-adminsdk-fbsvc@vhhealth.iam.gserviceaccount.com"
```

Check audit logs for disable/delete:

```powershell
& "D:\Dev\Tools\google-cloud-sdk\bin\gcloud.cmd" logging read `
  'protoPayload.resourceName:"KEY_ID"' `
  --freshness=90d `
  --format="table(timestamp,protoPayload.methodName,protoPayload.authenticationInfo.principalEmail,protoPayload.status)"
```

## 2026-04-21 Firebase Key Incident

Google Cloud reported this service-account key as publicly exposed:

- Service account: `firebase-adminsdk-fbsvc@vhhealth.iam.gserviceaccount.com`
- Key ID: `af2ca5d7aa1663634f6c11eae3a1f4ceb7517720`
- Git commit: `33326b23a2449a5ea013caac26b8b1f81b4d9ced`
- Historical filename: `vhhealth-firebase-adminsdk-fbsvc-af2ca5d7aa.json`

Verified response:

- Google auto-disabled the key at `2026-04-21T06:45:32Z`.
- The key was deleted at `2026-04-21T10:55:02Z`.
- Remaining key for the service account is system-managed only.
- Project-level `roles/iam.serviceAccountTokenCreator` was removed from the
  Firebase Admin service account after no 90-day IAMCredentials usage was
  found.
- Android and iOS Firebase API keys were app-restricted.
- Browser Firebase API key was restricted on `2026-04-21` to:
  `https://admin.vhhealth.app/*`, `https://*.vhhealth.app/*`,
  `https://vh-health-portal.vercel.app/*`,
  `https://vhhealth.firebaseapp.com/*`, `https://vhhealth.web.app/*`,
  `http://localhost:3000/*`, and `http://127.0.0.1:3000/*`.
  Existing API targets were preserved.

## Post-Rewrite Credential Follow-Up

Historical secret files and credential literals have been removed from public
Git history, and the local full-history `gitleaks` scan was clean after the
rewrite. Still treat any credential that was ever public as compromised until
the provider confirms revocation or rotation.

Current status and remaining provider work:

- Firebase Admin SDK: exposed key
  `af2ca5d7aa1663634f6c11eae3a1f4ceb7517720` is deleted.
- Cloudflare R2: bucket `vh-health-records` was verified through the Cloudflare
  API on `2026-04-21`, but the current Cloudflare connector cannot manage
  account-owned API tokens (`9109 Unauthorized to access requested resource`).
  Rotate manually in the Cloudflare dashboard: create a new scoped R2 token for
  `vh-health-records`, update deployment secrets `CF_R2_ACCESS_KEY_ID` and
  `CF_R2_SECRET_ACCESS_KEY`, deploy, verify upload/read/delete, then revoke the
  old key.
- Backend JWT: rotation requires deployment secret-store access. Before
  rotating `JWT_SECRET` in production, set independent 32+ character
  `FIELD_ENCRYPTION_KEY` and `TOTP_ENCRYPTION_KEY` values if encrypted fields
  or TOTP secrets may exist, because those utilities currently fall back to
  `JWT_SECRET`. Then set a new 64+ character `JWT_SECRET`, deploy, invalidate
  existing sessions/refresh tokens, and require re-auth.
- SMS provider: no external SMS provider is currently used. Remove any stale
  `MSG91_*` or SMS provider key from deployment secrets instead of rotating it.
- Test bearer tokens: historical-only unless a matching real token was accepted
  outside local tests. Invalidate any matching real token if discovered.

## Secret Scanning

Working tree service-account scan:

```powershell
node scripts/scan-secrets.mjs
```

Working tree gitleaks scan:

```powershell
node scripts/gitleaks-scan.mjs worktree
```

Changed-file GitGuardian scan:

```powershell
& "D:\Dev\Tools\ggshield\ggshield.exe" auth login
node scripts/ggshield-scan.mjs worktree
```

Full current-tree GitGuardian scan:

```powershell
node scripts/ggshield-scan.mjs all-worktree
```

Full history gitleaks scan:

```powershell
& "D:\Dev\Tools\gitleaks\gitleaks.exe" git . --config .gitleaks.toml --redact=100 --no-banner --verbose
```

Full history GitGuardian scan:

```powershell
node scripts/ggshield-scan.mjs repo
```

After a history rewrite, full-history scans should pass. A failure means a new
leak was introduced or the rewrite missed a path.

## Git History Rewrite Decision

Rewrite public history only after coordinating with anyone who has cloned or
forked the repo. Rewriting removes accidental exposure from normal browsing,
but any already-fetched secret must still be treated as compromised.

`2026-04-21` decision: rewrite public history. The rewrite removed historical
secret files, hardcoded credential literals, and the old root deployment
archives `vh-health-backend.zip` and `vh-health-portal.zip`. The current tracked
ZIP is an app-local plugin sample asset, not the root deployment archives that
triggered GitHub large-object warnings.

Use rewrite if:

- A real production secret remains visible in public history.
- Provider cannot fully revoke or rotate it.
- Compliance requires removing the blob from public Git objects.

Skip or defer rewrite if:

- All exposed credentials are fully revoked and the disruption outweighs the
  cleanup value.
- Active forks or deployments cannot be coordinated safely yet.

## Post-Incident Checklist

- [x] Exposed Firebase Admin SDK key revoked or deleted.
- [ ] Runtime secret store updated.
- [ ] Cloudflare R2 access key rotated in provider/deployment secrets.
- [ ] Backend `JWT_SECRET` rotated in provider/deployment secrets.
- [x] No JSON key files or private keys in working tree.
- [x] `node scripts/scan-secrets.mjs` passes.
- [x] `node scripts/gitleaks-scan.mjs worktree` passes.
- [x] `node scripts/ggshield-scan.mjs worktree` passes.
- [ ] Provider audit logs reviewed.
- [x] Browser Firebase key referrer restrictions confirmed and applied.
- [x] History rewrite decision recorded.
