# Runbook — Cloudflare R2 bucket restore

**Severity:** P0 (file access blocked) / P1 (degraded upload path)

R2 is the backing store for patient uploads, prescription PDFs,
housekeeping photos, investigation reports, and Sentry release
sourcemaps. When R2 is unreachable, the app gracefully degrades per
`src/utils/r2.js` — uploads fail at call time, not at import time — so
the API stays up but affected endpoints return 503.

## Symptoms

- Patient app: "Upload failed, please try again" on any file upload
- Admin portal `Uploads` page: file list returns empty + 503 logs
- Backend logs: `R2 request timeout after 30s` (retry also failed) or
  `SignatureDoesNotMatch` (key rotation issue)
- Sentry: spike in `R2ServiceError` under `src/utils/r2.js` scope

## Prerequisites

- Cloudflare dashboard access with `R2 Admin` role (check Slack
  `#vhhealth-secrets` for the credential locker).
- `wrangler` CLI installed: `npm install -g wrangler@latest`.
- The four R2 env vars in `.env.local`:
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

## Response

### Option A — Bucket unreachable but objects intact

This is 95% of R2 outages — Cloudflare control plane hiccup.

1. Confirm with Cloudflare status page: <https://www.cloudflarestatus.com/>
2. Verify locally:
   ```bash
   $ wrangler r2 bucket list
   # Expected: vh-health-records in the output
   $ wrangler r2 object get vh-health-records/README.txt -f /tmp/r2test
   # (Drop a README.txt via wrangler r2 object put once per account to enable this.)
   ```
3. If R2 is recovering, enable the graceful-degrade flag in the backend
   so upload endpoints return 503 with a user-friendly body instead of
   a generic 500:
   ```bash
   $ sudo systemctl set-environment VHHEALTH_R2_DEGRADED=1
   $ sudo systemctl restart vhhealth-backend
   ```
4. Watch `curl -s http://localhost:5000/health/metrics | jq .r2` until
   `ok: true` returns.
5. Clear the degrade flag:
   ```bash
   $ sudo systemctl unset-environment VHHEALTH_R2_DEGRADED
   $ sudo systemctl restart vhhealth-backend
   ```

### Option B — Specific object(s) missing (accidental delete)

R2 does NOT version by default — deleted objects are gone.

1. Check if the object exists in the staging bucket backup (if configured):
   ```bash
   $ wrangler r2 object get vh-health-records-staging-mirror/<key> -f /tmp/recovered
   ```
2. If recovered, push it back:
   ```bash
   $ wrangler r2 object put vh-health-records/<key> -f /tmp/recovered
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
   $ wrangler r2 bucket create vh-health-records-new
   ```
2. Copy objects (scripted — native R2 has no bulk-copy UI):
   ```bash
   [backend] $ npm run r2:migrate-archive -- \
       --from vh-health-records --to vh-health-records-new
   ```
   This script is in `src/scripts/r2/r2-migrate-archive.js`.
3. Flip the env var + restart:
   ```bash
   $ sed -i 's/^R2_BUCKET=.*/R2_BUCKET=vh-health-records-new/' /srv/vhhealth/.env.local
   $ sudo systemctl restart vhhealth-backend
   ```
4. List what's in the new bucket to verify:
   ```bash
   [backend] $ npm run r2:list-files -- --bucket vh-health-records-new | wc -l
   ```
5. Keep the old bucket for 30 days as rollback; then delete.

## Verify recovery

```bash
$ curl -s -H "x-api-key: $API_KEY" \
    -F "file=@/tmp/test.pdf" \
    http://localhost:5000/api/v1/uploads/upload
# Expected: { "success": true, "data": { "key": "...", "url": "..." } }

$ curl -s http://localhost:5000/health/metrics | jq .r2
# Expected: { "ok": true, "latencyMs": <150 }
```

## Post-incident

- [ ] If an object was unrecoverable, file a DPDPA/HIPAA breach-notification
      ticket (required within 72hrs in India; 60 days US).
- [ ] Confirm that the `r2:migrate-archive` mirror cron is running
      (crontab check on the ops host; it should sync hourly by default).
- [ ] Move the on-call log line describing the failure into Sentry
      via `?referenced_in=postmortem` tag for dashboard tracking.
- [ ] If bucket was recreated, confirm IAM lifecycle rules still apply:
      archive > 90 days old objects to cold storage; delete > 7 years old
      per retention policy.
