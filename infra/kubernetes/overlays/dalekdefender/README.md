# Dalekdefender deployment

Single-node k3s deploy for VH Health backend + Postgres on
`dalekdefender.hippocampus-monitor.ts.net` (Tailnet-only).

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
  --from-literal=ALERTS_ENABLED='false' \
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

# 7) Surface the localhost-only backend proxy over Tailscale at port 8444. Khata owns 8443.
ssh dalekdefender "sudo tailscale serve --bg --https=8444 http://localhost:30090"

# 8) Seed test staff accounts (after backend is up).
ssh dalekdefender "sudo kubectl -n vhhealth exec deploy/vhhealth-backend -- node --import dotenv/config scripts/seed-test-staff-accounts.mjs"
```

## Smoke

```bash
# From any tailnet device (the laptop, the phone via Tailscale on Android):
curl -sk https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1/health
curl -sk -H "x-monitoring-token: ${MONITORING_TOKEN}" \
  https://dalekdefender.hippocampus-monitor.ts.net:8444/health/ready
```

## Updating

```bash
# After pulling new backend code:
ssh dalekdefender 'cd ~/VH-Health-Platform && git pull && cd apps/backend && sudo docker build -t vhhealth-backend:dev . && sudo docker save vhhealth-backend:dev | sudo k3s ctr images import - && sudo kubectl -n vhhealth rollout restart deploy/vhhealth-backend'
```

## Tear down

```bash
ssh dalekdefender 'sudo kubectl delete namespace vhhealth && sudo tailscale serve --https=8444 off'
```
