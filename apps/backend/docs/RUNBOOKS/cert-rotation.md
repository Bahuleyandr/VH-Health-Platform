# Runbook — Certificate / credential rotation

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P1 (routine quarterly rotation) / P0 (suspected compromise)

Covers rotation of every long-lived secret the backend trusts:

1. JWT signing secret (`JWT_SECRET`)
2. Per-client API keys (`API_KEY_PATIENT`, `API_KEY_STAFF`, `API_KEY_ADMIN`)
3. R2 access keys (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)
4. Firebase Admin service account (`FIREBASE_PRIVATE_KEY`)
5. mTLS client cert root CA (Phase 3.10 — once enforced)
6. pgBackRest encryption key (`pgbackrest-cipher` sealed secret)
7. Cloudflare Tunnel credentials (`cloudflared-token`)

Each section below is a complete rotation procedure with verification.
For suspected compromise, do **all** applicable sections in parallel.

## Prerequisites

- kubeconfig configured for `vhhealth-prod` cluster context.
- `kubeseal` CLI installed and pointing at the cluster's sealed-secrets
  controller.
- Write access to the repo (to commit updated sealed secrets so ArgoCD
  picks them up).
- Separate terminal to roll patient/staff app releases if a client-side
  API key update is required.

## Mental model — secret flow

All app-facing secrets are managed as **sealed secrets** in-repo under
`infra/kubernetes/apps/<app>/*.sealed-secret.yaml`. To rotate:

1. Build a plain `Secret` YAML locally (never commit it).
2. `kubeseal` it to produce the sealed form.
3. Commit the sealed form.
4. ArgoCD syncs → `SealedSecret` CR → `Secret` resource → pod env var on
   next rollout.

## §JWT — rotate `JWT_SECRET`

Impact: every currently-issued JWT becomes invalid. All patients,
staff, admins must re-authenticate. Plan during low-traffic window
(02:00–04:00 IST typical).

### Response

1. Generate new secret:
   ```bash
   NEW_JWT=$(openssl rand -base64 64 | tr -d '\n')
   echo "$NEW_JWT" | wc -c    # should be ~88
   ```

2. Build + seal the updated Secret:
   ```bash
   cat > /tmp/jwt-secret.yaml <<EOF
   apiVersion: v1
   kind: Secret
   metadata:
     name: vhhealth-jwt
     namespace: vhhealth
   stringData:
     JWT_SECRET: "$NEW_JWT"
   EOF

   kubeseal < /tmp/jwt-secret.yaml \
     > infra/kubernetes/apps/backend/vhhealth-jwt.sealed-secret.yaml
   rm /tmp/jwt-secret.yaml
   ```

3. Broadcast logout (invalidates all tokens in Redis + DB blacklist):
   ```bash
   kubectl -n vhhealth create job --from=cronjob/revoke-all-tokens revoke-$(date +%s)
   kubectl -n vhhealth wait --for=condition=complete job -l job-type=revoke-tokens --timeout=120s
   ```

4. Commit + let ArgoCD roll the backend:
   ```bash
   git commit -am "chore(secrets): rotate JWT_SECRET"
   git push
   argocd app sync vhhealth-backend
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   kubectl -n vhhealth rollout status deployment/vhhealth-backend
   ```

5. Verify new token signing:
   ```bash
   kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
     curl -s -H "x-api-key: $API_KEY_ADMIN" \
       -d '{"username":"testadmin","password":"<known-good>"}' \
       -H "Content-Type: application/json" \
       http://localhost:5000/api/v1/auth/admin/login | jq .data.token
   # Decode the token at jwt.io — signature should verify with NEW_JWT
   ```

6. Confirm old tokens now reject:
   ```bash
   OLD_TOKEN=<a token from BEFORE the rotation>
   kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
     curl -s -H "Authorization: Bearer $OLD_TOKEN" \
       -H "x-api-key: $API_KEY_ADMIN" \
       http://localhost:5000/api/v1/users/me
   # Expected: 401 with code TOKEN_REVOKED
   ```

## §API keys — rotate per-client `API_KEY_*`

Impact: the app that holds the old key stops working until its release
is updated. Stagger one at a time.

### Response (per client)

1. Generate new key:
   ```bash
   NEW_KEY=$(openssl rand -hex 32)
   ```

2. Build the Secret with old+new keys (both valid during rollout). The
   backend supports comma-separated `API_KEY_PATIENT_PREVIOUS`:
   ```bash
   CURRENT=$(kubectl -n vhhealth get secret vhhealth-api-keys -o jsonpath='{.data.API_KEY_PATIENT}' | base64 -d)
   cat > /tmp/api-keys-secret.yaml <<EOF
   apiVersion: v1
   kind: Secret
   metadata:
     name: vhhealth-api-keys
     namespace: vhhealth
   stringData:
     API_KEY_PATIENT: "$NEW_KEY"
     API_KEY_PATIENT_PREVIOUS: "$CURRENT"
     # preserve other API_KEY_* fields by reading them first
   EOF

   kubeseal < /tmp/api-keys-secret.yaml \
     > infra/kubernetes/apps/backend/vhhealth-api-keys.sealed-secret.yaml
   rm /tmp/api-keys-secret.yaml

   git commit -am "chore(secrets): rotate API_KEY_PATIENT (add new, keep previous)"
   git push
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   ```

3. Ship the new key in the next patient-app release (`apiClient.ts`
   `apiKey` constant or runtime config fetch).

4. After 95% of installs have the new key (monitor via Sentry release
   adoption), drop the previous:
   ```bash
   # Rebuild the Secret WITHOUT API_KEY_PATIENT_PREVIOUS, commit.
   git commit -am "chore(secrets): drop API_KEY_PATIENT_PREVIOUS after rollout"
   git push
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   ```

Repeat for `API_KEY_STAFF` and `API_KEY_ADMIN`.

## §R2 keys — rotate access key pair

1. In Cloudflare dashboard, R2 → vh-health-records → API → **Create
   API Token**. Permissions: Object Read & Write. Scope: single bucket.
2. Copy the new access key ID and secret (only shown once).
3. Build + seal:
   ```bash
   cat > /tmp/r2-secret.yaml <<EOF
   apiVersion: v1
   kind: Secret
   metadata:
     name: vhhealth-r2
     namespace: vhhealth
   stringData:
     R2_ACCESS_KEY_ID: "$NEW_ID"
     R2_SECRET_ACCESS_KEY: "$NEW_SECRET"
   EOF
   kubeseal < /tmp/r2-secret.yaml \
     > infra/kubernetes/apps/backend/vhhealth-r2.sealed-secret.yaml
   rm /tmp/r2-secret.yaml

   git commit -am "chore(secrets): rotate R2 access keys"
   git push
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   ```
4. Verify:
   ```bash
   kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
     curl -s -H "x-api-key: $API_KEY_ADMIN" -H "Authorization: Bearer $JWT" \
       -F "file=@/tmp/rotation-test.txt" \
       http://localhost:5000/api/v1/uploads/upload
   ```
5. Delete the old R2 API token in the Cloudflare dashboard.

## §Firebase Admin credentials

1. In Firebase Console → Project Settings → Service Accounts → **Generate
   new private key**. Downloads a JSON file.
2. Extract the `private_key` field (newlines must be preserved as `\n`).
3. Build + seal the `vhhealth-firebase` Secret with the new
   `FIREBASE_PRIVATE_KEY` (wrap in double quotes in YAML).
4. `git commit + push`, then `kubectl -n vhhealth rollout restart deployment/vhhealth-backend`.
5. Verify with an OTP send to a test phone; watch logs for
   `FirebaseAdminError` — absence = success:
   ```bash
   kubectl -n vhhealth logs deployment/vhhealth-backend --tail=100 | grep -i firebase
   ```

## §mTLS client root CA (when Phase 3.10 lands)

1. Generate new CA cert + key; keep the old one valid for 30 days to
   allow device cert rotation.
2. Update the ingress-nginx CA trust bundle (ConfigMap
   `ingress-nginx/ca-trust`) to the union of old + new CA.
3. Push the new CA fingerprint to the client-cert enrollment endpoint.
4. After 95% of devices have rotated, remove the old CA from the
   trust list and roll ingress-nginx.

## §pgBackRest encryption key (`pgbackrest-cipher`)

The CNPG `Cluster` CR references this sealed secret by name; rotation
requires:

1. Generate new key:
   ```bash
   openssl rand -base64 48 > /tmp/new-cipher.txt
   ```
2. Take a **final backup under the old key** and archive it to R2 cold
   storage under `vhhealth-pg-backups-cold/legacy-cipher-YYYYMMDD/`:
   ```bash
   kubectl cnpg backup vhhealth-pg --method barmanObjectStore
   kubectl -n vhhealth-platform get backups | tail -5
   ```
3. Build + seal the updated cipher secret:
   ```bash
   NEW_CIPHER=$(cat /tmp/new-cipher.txt)
   cat > /tmp/pgbackrest-cipher.yaml <<EOF
   apiVersion: v1
   kind: Secret
   metadata:
     name: pgbackrest-cipher
     namespace: vhhealth-platform
   stringData:
     cipherPass: "$NEW_CIPHER"
   EOF
   kubeseal < /tmp/pgbackrest-cipher.yaml \
     > infra/kubernetes/base/cnpg/pgbackrest-cipher.sealed-secret.yaml
   rm /tmp/pgbackrest-cipher.yaml /tmp/new-cipher.txt
   ```
4. Commit + sync. CNPG rolls a new base backup under the new key
   automatically; old backups remain decryptable with the archived old
   key (which you should keep in the secrets locker for the retention
   window).
5. Force a fresh backup and test-decrypt it to confirm:
   ```bash
   kubectl cnpg backup vhhealth-pg
   kubectl -n vhhealth-platform get backups | head -5
   # Expected: status=completed
   ```

## §Cloudflare Tunnel credentials

Rotation flow:

1. In Cloudflare dashboard → Zero Trust → Networks → Tunnels → create
   a NEW tunnel (`vhhealth-prod-v2`), download its credentials JSON.
2. Build + seal:
   ```bash
   cat > /tmp/tunnel-secret.yaml <<EOF
   apiVersion: v1
   kind: Secret
   metadata:
     name: cloudflared-token
     namespace: ingress-nginx
   stringData:
     credentials.json: |
       $(cat ~/Downloads/vhhealth-prod-v2.json | jq -c .)
   EOF
   kubeseal < /tmp/tunnel-secret.yaml \
     > infra/kubernetes/base/cloudflared/cloudflared-token.sealed-secret.yaml
   rm /tmp/tunnel-secret.yaml
   ```
3. In Cloudflare dashboard, bind the new tunnel to `api.vhhealth.app`,
   `admin.vhhealth.app` hostnames with the same ingress-nginx
   Service target.
4. Commit + sync; `cloudflared` pods restart on each node. Traffic
   flips within ~30 seconds.
5. Delete the old tunnel in Cloudflare dashboard.

## Post-incident / post-rotation

- [ ] `kubectl -n vhhealth get secrets | grep -i $(date +%Y%m)` — new
      secret should appear if you tagged metadata with rotation date.
- [ ] `kubectl -n vhhealth logs deployment/vhhealth-backend --since=1h | grep -i "invalid\|unauth" | wc -l` — should trend down over the next hour.
- [ ] Document the rotation in `docs/incidents/rotation-YYYYMMDD.md`
      (date, who, which key, reason).
- [ ] If rotation was triggered by suspected compromise, file a Sentry
      issue titled `security-compromise-YYYYMMDD` linking the affected
      key + user IDs that may have been exposed.
