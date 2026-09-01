# Dalekdefender deployment

Single-node k3s deploy for VH Health backend + Postgres on
`dalekdefender.hippocampus-monitor.ts.net`. The original Tailnet-only route is
also the private origin for the test deployment's Cloudflare public edge.

This overlay is for personal/test use — running the full app with a
real backend so the patient + staff Android apps can be exercised on a
physical phone over Tailscale. It is **not** a production deployment;
the prod path is `infra/kubernetes/overlays/prod` (RKE2 + CNPG + Cloudflare
Tunnel + SealedSecrets).

## Prerequisites

- k3s running on `dalekdefender` (already there, hosts Khata).
- Tailscale installed + logged in on the host (already there).
- Docker installed on the host for image build (already there, hosts neo4j).
- Your Tailnet machine that wants to call the API also has to be on
  Tailscale (the phone does too — sideload the Tailscale client).

## Bootstrap (one-time)

```bash
# 1) Push this branch / sync the source on the host.
ssh dalekdefender 'cd ~ && git clone https://github.com/Bahuleyandr/VH-Health-Platform.git || (cd VH-Health-Platform && git fetch && git checkout main && git pull)'

# 2) Build the backend image and import into k3s containerd.
ssh dalekdefender 'cd ~/VH-Health-Platform/apps/backend && sudo docker build -t vhhealth-backend:dev . && sudo docker save vhhealth-backend:dev | sudo k3s ctr images import -'

# 3) Generate secrets (run on your laptop, not the host).
node scripts/seed-dev-env.mjs   # uses local files; just for the value generator
# Or generate fresh ones — see "Secrets" below.

# 4) Create the namespace + Postgres + backend secret on the cluster.
PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
JWT="$(openssl rand -base64 32)"
FE_KEY="$(openssl rand -base64 32)"
TOTP_KEY="$(openssl rand -base64 32)"
BK_KEY="$(openssl rand -base64 32)"
API_KEY="phone-$(openssl rand -hex 16)"
ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
MONITORING_TOKEN="$(openssl rand -hex 32)"

ssh dalekdefender "sudo kubectl create namespace vhhealth --dry-run=client -o yaml | sudo kubectl apply -f -"

ssh dalekdefender "sudo kubectl -n vhhealth create secret generic vhhealth-postgres \
  --from-literal=POSTGRES_PASSWORD='${PASSWORD}' \
  --dry-run=client -o yaml | sudo kubectl apply -f -"

ssh dalekdefender "sudo kubectl -n vhhealth create secret generic vhhealth-backend \
  --from-literal=DATABASE_URL='postgresql://vhhealth:${PASSWORD}@vhhealth-postgres:5432/vhhealth' \
  --from-literal=JWT_SECRET='${JWT}' \
  --from-literal=API_KEY='${API_KEY}' \
  --from-literal=MONITORING_TOKEN='${MONITORING_TOKEN}' \
  --from-literal=FIELD_ENCRYPTION_KEY='${FE_KEY}' \
  --from-literal=TOTP_ENCRYPTION_KEY='${TOTP_KEY}' \
  --from-literal=BACKUP_ENCRYPTION_KEY='${BK_KEY}' \
  --from-literal=ADMIN_BOOTSTRAP_USERNAME='admin' \
  --from-literal=ADMIN_BOOTSTRAP_PASSWORD='${ADMIN_PASSWORD}' \
  --from-literal=ADMIN_BOOTSTRAP_EMAIL='admin@vhhealth.local' \
  --from-literal=ADMIN_BOOTSTRAP_NAME='Super Admin' \
  --from-literal=ALLOWED_ORIGINS='https://admin.vhhealth.app,https://api.vhhealth.app,https://vhhealth.app,https://dalekdefender.hippocampus-monitor.ts.net:8445,https://dalekdefender.hippocampus-monitor.ts.net:8444' \
  --from-literal=REQUIRE_MFA_FOR_SUPER_ADMIN='false' \
  --from-literal=SECURITY_WEBHOOKS_ENABLED='false' \
  --from-literal=CLINICAL_AI_PROVIDER='template' \
  --from-literal=FIREBASE_AUTH_ENABLED='false' \
  --from-literal=ABDM_ENABLED='false' \
  --dry-run=client -o yaml | sudo kubectl apply -f -"

# Print the API_KEY — you'll need it for the APK build dart-define.
echo "API_KEY=${API_KEY}"
echo "ADMIN_BOOTSTRAP_PASSWORD=${ADMIN_PASSWORD}"
echo "MONITORING_TOKEN=${MONITORING_TOKEN}"

# 5) Apply Postgres first, then create the runtime RLS role.
ssh dalekdefender "cd ~/VH-Health-Platform && sudo kubectl apply -f infra/kubernetes/overlays/dalekdefender/postgres.yaml"
ssh dalekdefender "sudo kubectl -n vhhealth rollout status statefulset/vhhealth-postgres --timeout=180s"
ssh dalekdefender "cd ~/VH-Health-Platform && sudo kubectl -n vhhealth exec -i vhhealth-postgres-0 -- sh -lc 'PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1' < infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql"

# 6) Apply the remaining manifests.
ssh dalekdefender "cd ~/VH-Health-Platform && sudo kubectl apply -k infra/kubernetes/overlays/dalekdefender"

# 7) Install the public-controller shim, then surface it over Tailscale at
#    port 8444. The shim overwrites the trusted route marker before forwarding
#    to the localhost-only backend proxy on port 30090. Khata owns 8443.
scp -r infra/onprem/vh-public-edge dalekdefender:~/.cache/
ssh dalekdefender "cd ~/.cache/vh-public-edge && docker compose up -d && tailscale serve --bg --https=8444 http://localhost:30093"

# 8) Provision QA identities through the approved onboarding path.
# Synthetic seed scripts intentionally refuse NODE_ENV=production and must not
# be run inside the production-parity backend pod.
```

## Smoke

```bash
# From any tailnet device (the laptop, the phone via Tailscale on Android):
curl -sk https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1/health
curl -sk -H "x-monitoring-token: ${MONITORING_TOKEN}" \
  https://dalekdefender.hippocampus-monitor.ts.net:8444/health/ready
```

## Database migrations (automatic, before every rollout)

The backend fails closed at startup unless the `_migrations` tracker is an
exact match for its image's migration directory — `runMigrations.js` raises
`MIGRATION_TIP_MISMATCH` / `MIGRATION_CHECKSUM_DRIFT` and refuses to bind a
socket. That guard is correct and must not be weakened: it is the only reason a
schema/image mismatch is visible instead of silent.

Production gets the matching *apply* step from an ArgoCD PreSync hook
(`infra/kubernetes/apps/backend/migration-job.yaml`). This rig runs no ArgoCD,
so the same ordering is enforced by the root-owned deploy helper. On every
deploy it:

1. refreshes the `ghcr-read` pull Secret,
2. renders `migration-job.yaml` with **the same verified digest** it is about
   to pin, deletes any previous Job, applies it, and waits for `Complete`,
3. only then sets the Deployment images and waits for the rollout.

A failed or timed-out Job **aborts the deploy**: no image is changed, the
previous pods keep serving, and the helper prints the Job's logs plus pod
events. Nothing is left half-applied — `ci-setup-db.mjs` runs each migration in
a transaction and writes its `_migrations` row only on commit.

`migration-job.yaml` is intentionally **not** listed in `kustomization.yaml`:
its `image:` is a placeholder the helper substitutes, so `kubectl apply -k`
would create an unpullable Job. The helper embeds the manifest verbatim (it
runs as root from `/usr/local/sbin` and must not read the host's git checkout);
`scripts/dalek-migration-job-manifest.test.mjs` pins the embedded copy
byte-for-byte against the file so the two cannot drift.

The Job is idempotent and safe to re-run — it is tracker-driven and a no-op
when the database is already caught up. It never runs seeds.

### One thing the helper will not do: roll an image back over a migration

If a deploy applied migrations and the rollout then fails, the helper **refuses**
the automatic image rollback and exits non-zero with the new digest still
pinned. Restoring the older image would not undo the migration, and that image
would then see the new tracker rows as `unexpected` and fail startup with
`MIGRATION_TIP_MISMATCH` — replacing a broken pod with one that cannot boot at
all. Fix forward and redeploy. When nothing was applied, the rollback behaves
as before.

### Running it by hand

The Job is an ordinary manifest; substitute the digest and apply it:

```bash
ssh root@dalekdefender
kubectl -n vhhealth get deploy/vhhealth-backend \
  -o jsonpath='{.spec.template.spec.containers[0].image}'   # current digest
# then: sed the placeholder in migration-job.yaml to that digest, kubectl apply -f -,
# and kubectl -n vhhealth wait --for=condition=complete job/vhhealth-backend-migrate
```

## Digest-pinned CI deploy helper

GitHub Actions and Forgejo both deploy by sending verified GHCR image digests
to a root-owned host helper. Install the repo version on the host whenever this
file changes:

```bash
ssh dalekdefender 'cd ~/VH-Health-Platform && git pull --ff-only'
ssh dalekdefender 'cd ~/VH-Health-Platform && sudo install -o root -g root -m 0755 infra/kubernetes/overlays/dalekdefender/vhhealth-gha-deploy.sh /usr/local/sbin/vhhealth-gha-deploy'
```

Verify the host helper hash matches the repo helper before re-running deploy:

```bash
sha256sum infra/kubernetes/overlays/dalekdefender/vhhealth-gha-deploy.sh
ssh dalekdefender 'sha256sum /usr/local/sbin/vhhealth-gha-deploy'
```

The deploy user should have passwordless sudo for only
`/usr/local/sbin/vhhealth-gha-deploy`. The helper rejects non-GHCR digests and
non-40-char commits, refreshes the `ghcr-read` pull secret when credentials are
provided, waits for backend/admin rollout, and on failure prints bounded
Kubernetes diagnostics before restoring the previous digest-pinned images. Do
not use this test rig for real PHI; failed-startup diagnostics include pod
events and backend log tails. CI compares the host helper SHA256 with this repo
file and skips the cluster mutation step while the host copy is stale.

## Updating

```bash
# After pulling new backend code:
ssh dalekdefender 'cd ~/VH-Health-Platform && git pull && cd apps/backend && sudo docker build -t vhhealth-backend:dev . && sudo docker save vhhealth-backend:dev | sudo k3s ctr images import - && sudo kubectl -n vhhealth rollout restart deploy/vhhealth-backend'
```

## Tear down

```bash
ssh dalekdefender 'sudo kubectl delete namespace vhhealth && sudo tailscale serve --https=8444 off'
```
