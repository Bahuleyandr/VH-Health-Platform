# Runbook — Cloudflare R2 bucket restore

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P0 (file access blocked) / P1 (degraded upload path)

R2 is the backing store for patient uploads, prescription PDFs,
housekeeping photos, investigation reports, and Sentry release
sourcemaps. When R2 is unreachable, the app gracefully degrades per
`src/utils/r2.js` — uploads fail at call time, not at import time — so
the API stays up but affected endpoints return 503.

## Symptoms

- Patient app: "Upload failed, please try again" on any file upload
- Admin portal `Uploads` page: file list returns empty + 503 logs
- Backend logs (`kubectl -n vhhealth logs deployment/vhhealth-backend`):
  `R2 request timeout after 30s` (retry also failed) or
  `SignatureDoesNotMatch` (key rotation issue)
- Sentry: spike in `R2ServiceError` under `src/utils/r2.js` scope

## Prerequisites

- Cloudflare dashboard access with `R2 Admin` role (check Slack
  `#vhhealth-secrets` for the credential locker).
- `wrangler` CLI installed: `npm install -g wrangler@latest`.
- `kubeseal` + repo write access to update R2 credential sealed secrets.
- The four R2 env vars live in sealed secret `vhhealth-r2`:
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

## Response

### Option A — Bucket unreachable but objects intact

This is 95% of R2 outages — Cloudflare control plane hiccup.

1. Confirm with Cloudflare status page: <https://www.cloudflarestatus.com/>
2. Verify locally:
   ```bash
   wrangler r2 bucket list
   # Expected: vh-health-records in the output
   wrangler r2 object get vh-health-records/README.txt -f /tmp/r2test
   # (Drop a README.txt via wrangler r2 object put once per account to enable this.)
   ```
3. If R2 is recovering, enable the graceful-degrade flag in the backend
   so upload endpoints return 503 with a user-friendly body instead of
   a generic 500:
   ```bash
   kubectl -n vhhealth set env deployment/vhhealth-backend VHHEALTH_R2_DEGRADED=true
   kubectl -n vhhealth rollout status deployment/vhhealth-backend
   ```
4. Watch
   ```bash
   kubectl -n vhhealth exec deployment/vhhealth-backend -- \
     curl -s http://localhost:5000/health/metrics | jq .r2
   ```
   until `ok: true` returns.
5. Clear the degrade flag:
   ```bash
   kubectl -n vhhealth set env deployment/vhhealth-backend VHHEALTH_R2_DEGRADED-
   kubectl -n vhhealth rollout status deployment/vhhealth-backend
   ```

### Option B — Specific object(s) missing (accidental delete)

R2 does NOT version by default — deleted objects are gone.

1. Check if the object exists in the staging bucket backup (if configured):
   ```bash
   wrangler r2 object get vh-health-records-staging-mirror/<key> -f /tmp/recovered
   ```
2. If recovered, push it back:
   ```bash
   wrangler r2 object put vh-health-records/<key> -f /tmp/recovered
   ```
3. If there's no mirror and the object is a patient upload, it IS lost.
   Open a P0 incident and notify the patient per HIPAA/DPDPA breach
   procedure.

### Option C — Access-key compromise (rotation)

See [`cert-rotation.md`](./cert-rotation.md) §R2-keys. This runbook
covers the *bucket* level; the key-rotation one covers the *credentials*.

### Option D — Bucket replaced / region migration

If Cloudflare forces a bucket rename or region migration:

1. Create the new bucket:
   ```bash
   wrangler r2 bucket create vh-health-records-new
   ```
2. Copy objects (scripted — native R2 has no bulk-copy UI). Run it as
   a one-off Job in the cluster so the pod has access to both the
   source + target credentials:
   ```bash
   kubectl -n vhhealth apply -f infra/kubernetes/apps/backend/jobs/r2-migrate-archive.yaml
   kubectl -n vhhealth wait --for=condition=complete job/r2-migrate-archive --timeout=3600s
   kubectl -n vhhealth logs job/r2-migrate-archive
   ```
   This Job wraps `src/scripts/r2/r2-migrate-archive.js`.
3. Flip the `vhhealth-r2` sealed secret to point at the new bucket:
   ```bash
   # Rebuild vhhealth-r2.sealed-secret.yaml with R2_BUCKET=vh-health-records-new
   git commit -am "chore(r2): point backend at vh-health-records-new"
   git push
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   ```
4. List what's in the new bucket to verify:
   ```bash
   kubectl -n vhhealth exec deployment/vhhealth-backend -- \
     node -e "require('./src/scripts/r2/list-files.js')({bucket:'vh-health-records-new'})" | wc -l
   ```
5. Keep the old bucket for 30 days as rollback; then delete.

## Verify recovery

```bash
# End-to-end upload via the public ingress
curl -s -H "x-api-key: $API_KEY" \
    -F "file=@/tmp/test.pdf" \
    https://api.vhhealth.app/api/v1/uploads/upload
# Expected: { "success": true, "data": { "key": "...", "url": "..." } }

kubectl -n vhhealth exec deployment/vhhealth-backend -- \
  curl -s http://localhost:5000/health/metrics | jq .r2
# Expected: { "ok": true, "latencyMs": <150 }
```

## Post-incident

- [ ] If an object was unrecoverable, file a DPDPA/HIPAA breach-notification
      ticket (required within 72hrs in India; 60 days US).
- [ ] Confirm that the `r2-migrate-archive` CronJob (scheduled hourly
      mirror) is Healthy:
      `kubectl -n vhhealth get cronjob r2-migrate-archive`.
- [ ] Move the on-call log line describing the failure into Sentry
      via `?referenced_in=postmortem` tag for dashboard tracking.
- [ ] If bucket was recreated, confirm lifecycle rules still apply:
      archive > 90 days old objects to cold storage; delete > 7 years old
      per retention policy.
