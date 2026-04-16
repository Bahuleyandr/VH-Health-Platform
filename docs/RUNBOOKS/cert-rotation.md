# Runbook — Certificate / credential rotation

**Severity:** P1 (routine quarterly rotation) / P0 (suspected compromise)

Covers rotation of every long-lived secret the backend trusts:

1. JWT signing secret (`JWT_SECRET`)
2. Per-client API keys (`API_KEY_PATIENT`, `API_KEY_STAFF`, `API_KEY_ADMIN`)
3. R2 access keys (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)
4. Firebase Admin service account (`FIREBASE_PRIVATE_KEY`)
5. mTLS client cert root CA (Phase 3.10 — once enforced)
6. Encrypted-backup AES key (`/srv/vhhealth/secrets/backup-key.txt`)

Each section below is a complete rotation procedure with verification.
For suspected compromise, do **all** applicable sections in parallel.

## Prerequisites

- Root SSH on the primary API host.
- Write access to `/srv/vhhealth/.env.local` (mode 0600, owner vhhealth).
- Systemd control over `vhhealth-backend.service`.
- Separate terminal to roll admin/patient/staff app releases if key
  rotation requires a client-side update.

## §JWT — rotate `JWT_SECRET`

Impact: every currently-issued JWT becomes invalid. All patients,
staff, admins must re-authenticate. Plan during low-traffic window
(02:00–04:00 IST typical).

### Response

1. Generate new secret:
   ```bash
   $ NEW_JWT=$(openssl rand -base64 64 | tr -d '\n')
   $ echo "$NEW_JWT" | wc -c    # should be ~88
   ```
2. Update `.env.local`:
   ```bash
   $ sudo sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$NEW_JWT|" /srv/vhhealth/.env.local
   ```
3. Broadcast logout (invalidates all tokens in Redis + DB blacklist):
   ```bash
   [backend] $ node scripts/revoke-all-tokens.js
   # Writes every currently-active jti to invalidated_tokens with current iat.
   # After restart, jwtMiddleware's isUserTokensRevoked check will reject them.
   ```
4. Restart API:
   ```bash
   $ sudo systemctl restart vhhealth-backend.service
   ```
5. Verify new token signing:
   ```bash
   $ curl -s -H "x-api-key: $API_KEY_ADMIN" \
       -d '{"username":"testadmin","password":"<known-good>"}' \
       -H "Content-Type: application/json" \
       http://localhost:5000/api/v1/auth/admin/login | jq .data.token
   # Decode the token at jwt.io — signature should verify with NEW_JWT
   ```
6. Confirm old tokens now reject:
   ```bash
   $ OLD_TOKEN=<a token from BEFORE the rotation>
   $ curl -s -H "Authorization: Bearer $OLD_TOKEN" \
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
   $ NEW_KEY=$(openssl rand -hex 32)
   ```
2. Add the new key ALONGSIDE the old one (both valid for the rollout
   window). The backend supports comma-separated values via
   `API_KEY_PATIENT_PREVIOUS`:
   ```bash
   $ sudo sh -c 'echo "API_KEY_PATIENT_PREVIOUS=$CURRENT" >> /srv/vhhealth/.env.local'
   $ sudo sed -i "s|^API_KEY_PATIENT=.*|API_KEY_PATIENT=$NEW_KEY|" /srv/vhhealth/.env.local
   $ sudo systemctl restart vhhealth-backend.service
   ```
3. Ship the new key in the next patient-app release (`apiClient.ts`
   `apiKey` constant or runtime config fetch).
4. After 95% of installs have the new key (monitor via Sentry release
   adoption):
   ```bash
   $ sudo sed -i '/^API_KEY_PATIENT_PREVIOUS=/d' /srv/vhhealth/.env.local
   $ sudo systemctl restart vhhealth-backend.service
   ```

Repeat for `API_KEY_STAFF` and `API_KEY_ADMIN`.

## §R2 keys — rotate access key pair

1. In Cloudflare dashboard, R2 → vh-health-records → API → **Create
   API Token**. Permissions: Object Read & Write. Scope: single bucket.
2. Copy the new access key ID and secret (only shown once).
3. Update `.env.local`:
   ```bash
   $ sudo sed -i "s|^R2_ACCESS_KEY_ID=.*|R2_ACCESS_KEY_ID=$NEW_ID|" /srv/vhhealth/.env.local
   $ sudo sed -i "s|^R2_SECRET_ACCESS_KEY=.*|R2_SECRET_ACCESS_KEY=$NEW_SECRET|" /srv/vhhealth/.env.local
   $ sudo systemctl restart vhhealth-backend.service
   ```
4. Verify:
   ```bash
   $ curl -s -H "x-api-key: $API_KEY_ADMIN" -H "Authorization: Bearer $JWT" \
       -F "file=@/tmp/rotation-test.txt" \
       http://localhost:5000/api/v1/uploads/upload
   ```
5. Delete the old R2 API token in the Cloudflare dashboard.

## §Firebase Admin credentials

1. In Firebase Console → Project Settings → Service Accounts → **Generate
   new private key**. Downloads a JSON file.
2. Extract the `private_key` field (newlines must be preserved as `\n`).
3. Update `FIREBASE_PRIVATE_KEY` in `.env.local` (wrap in double quotes).
4. `sudo systemctl restart vhhealth-backend.service`.
5. Verify with an OTP send to a test phone; watch logs for
   `FirebaseAdminError` — absence = success.

## §mTLS client root CA (when Phase 3.10 lands)

1. Generate new CA cert + key; keep the old one valid for 30 days to
   allow device cert rotation.
2. Update the nginx/Cloudflare-tunnel front-door to trust the union of
   old + new CA.
3. Push the new CA fingerprint to the client-cert enrollment endpoint.
4. After 95% of devices have rotated, remove the old CA from the
   trust list.

## §Backup encryption key

1. Generate new key:
   ```bash
   $ openssl rand -base64 48 > /tmp/new-backup-key.txt
   ```
2. Re-encrypt the 3 most recent encrypted backups with the new key
   (using the old key to decrypt first) so rollback within the last
   retention window still works:
   ```bash
   $ for f in /srv/vhhealth/backups/*.enc; do
       openssl enc -d -aes-256-cbc -pbkdf2 -in "$f" \
         -pass file:/srv/vhhealth/secrets/backup-key.txt | \
       openssl enc -e -aes-256-cbc -pbkdf2 \
         -out "${f%.enc}.new.enc" \
         -pass file:/tmp/new-backup-key.txt
     done
   # Then swap the .new.enc files into place after verification.
   ```
3. Replace the key file:
   ```bash
   $ sudo mv /tmp/new-backup-key.txt /srv/vhhealth/secrets/backup-key.txt
   $ sudo chmod 0600 /srv/vhhealth/secrets/backup-key.txt
   $ sudo chown root:root /srv/vhhealth/secrets/backup-key.txt
   ```
4. Force a new backup and test-decrypt it to confirm:
   ```bash
   [backend] $ npm run db:backup
   $ openssl enc -d -aes-256-cbc -pbkdf2 \
       -in "$(ls -t /srv/vhhealth/backups/*.enc | head -1)" \
       -pass file:/srv/vhhealth/secrets/backup-key.txt \
       | head -1
   # Expected: -- PostgreSQL database dump
   ```

## Post-incident / post-rotation

- [ ] `grep -r "OLD_KEY_VALUE" /srv/vhhealth/` — nothing should match.
- [ ] `journalctl -u vhhealth-backend --since="1h ago" | grep -i "invalid\|unauth" | wc -l` — should trend down over the next hour.
- [ ] Document the rotation in `/srv/vhhealth/secrets/rotation-log.md`
      (append-only, git-ignored) — date, who, which key, reason.
- [ ] If rotation was triggered by suspected compromise, file a Sentry
      issue titled `security-compromise-YYYYMMDD` linking the affected
      key + user IDs that may have been exposed.
