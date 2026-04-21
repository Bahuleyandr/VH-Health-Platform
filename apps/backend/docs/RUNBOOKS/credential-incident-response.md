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
- Android and iOS Firebase API keys were app-restricted. Browser key still
  needs allowed referrer domains before it can be safely restricted.

## Remaining Rotations From Historical Git Scan

`gitleaks` still finds historical exposures in old commits:

- `.env.render`: `CF_R2_SECRET_ACCESS_KEY`
- `.env.render`: `JWT_SECRET`
- `.env.render`: deprecated SMS provider key
- old test bearer JWTs
- old Firebase Admin SDK private key

Rotate these where they are currently active:

- Cloudflare R2: create a replacement R2 token, update deployment secrets, then
  revoke the exposed access key.
- Backend JWT: set a new `JWT_SECRET`, deploy, and force logout/re-auth for
  existing sessions.
- SMS provider: no external SMS provider is currently used. Remove any stale
  provider key from deployment secrets instead of rotating it.
- Test bearer tokens: invalidate any matching real tokens if the old test token
  was ever accepted outside local tests.

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

The full history scans are expected to fail until old public history is
rewritten or accepted as permanently exposed after all affected credentials are
revoked.

## Git History Rewrite Decision

Rewrite public history only after coordinating with anyone who has cloned or
forked the repo. Rewriting removes accidental exposure from normal browsing,
but any already-fetched secret must still be treated as compromised.

Use rewrite if:

- A real production secret remains visible in public history.
- Provider cannot fully revoke or rotate it.
- Compliance requires removing the blob from public Git objects.

Skip or defer rewrite if:

- All exposed credentials are fully revoked and the disruption outweighs the
  cleanup value.
- Active forks or deployments cannot be coordinated safely yet.

## Post-Incident Checklist

- [ ] Exposed credentials revoked or deleted.
- [ ] Runtime secret store updated.
- [ ] No JSON key files or private keys in working tree.
- [ ] `node scripts/scan-secrets.mjs` passes.
- [ ] `node scripts/gitleaks-scan.mjs worktree` passes.
- [ ] `node scripts/ggshield-scan.mjs worktree` passes.
- [ ] Provider audit logs reviewed.
- [ ] Browser Firebase key referrer restrictions confirmed and applied.
- [ ] History rewrite decision recorded.
