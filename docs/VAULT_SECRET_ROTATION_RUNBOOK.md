# Vault Secret Rotation Runbook (INF-6 / B2.7)

> **STATUS — NOT YET LIVE.** Vault is code-complete but its prod overlay patch is OPERATOR-GATED (commented out in infra/kubernetes/overlays/prod/kustomization.yaml). These steps apply only AFTER the vault-bootstrap init sequence is run. Until then, secrets use Sealed Secrets.

> Applies to: production 3-replica Vault (vhhealth-security namespace) with
> Transit auto-unseal via vault-bootstrap.

---

## Rotation schedule

| Secret | Cadence | Method | Owner |
|---|---|---|---|
| CNPG runtime DB password (`vhhealth-pg-runtime`) | 90 days | SealedSecret regenerate + CNPG managed-role | ops |
| CNPG read-only DB password (`vhhealth-pg-readonly`) | 90 days | Same | ops |
| Redis password (`redis-credentials`) | 90 days | SealedSecret regenerate + rolling restart | ops |
| MinIO root credentials | 180 days | SealedSecret + mc admin user rotate | ops |
| Harbor admin password | 90 days | SealedSecret + Harbor API | ops |
| Vault transit unseal token | 365 days | Vault token renew / new token | ops |
| step-ca intermediate cert | 365 days (annual) | step ca renew + cert-manager update | ops |
| Cloudflare R2 backup keys | 180 days | R2 console + SealedSecret update | ops |
| Vault bootstrap Shamir keys | Annual | vault rekey | ops + 5 key holders |

---

## Prerequisites

```bash
# On the ops workstation — install kubeseal + vault CLI:
export VAULT_ADDR=https://vault.vhhealth-security.svc.cluster.local:8200
export VAULT_CACERT=<path-to-step-ca-root.crt>
export KUBECONFIG=<path-to-prod-kubeconfig>
```

---

## Procedure: rotate a SealedSecret-backed credential

This procedure applies to CNPG passwords, Redis, MinIO, Harbor admin, and R2 keys.

```bash
# 1. Generate a new secret value (example: 32-byte random base64)
NEW_SECRET=$(openssl rand -base64 32)

# 2. Create a plain Kubernetes Secret (in-memory, not saved to disk):
kubectl create secret generic <secret-name> \
  -n <namespace> \
  --from-literal=<key>="${NEW_SECRET}" \
  --dry-run=client -o yaml > /tmp/plain-secret.yaml

# 3. Seal it with kubeseal (requires the controller public key):
kubeseal \
  --controller-namespace vhhealth-security \
  --controller-name sealed-secrets \
  --format yaml \
  < /tmp/plain-secret.yaml \
  > infra/kubernetes/base/<service>/<secret-name>.sealed-secret.yaml

# 4. Wipe the plaintext:
shred -u /tmp/plain-secret.yaml

# 5. Commit the sealed secret, push, wait for ArgoCD sync:
git add infra/kubernetes/base/<service>/<secret-name>.sealed-secret.yaml
git commit -m "ops: rotate <secret-name> [skip ci]"
git push origin main
# ArgoCD picks up the new SealedSecret and applies it; the controller
# decrypts and writes the underlying Secret.

# 6. Trigger a rolling restart of the workload (if it mounts the secret as
#    env or volume):
kubectl rollout restart <kind>/<name> -n <namespace>
kubectl rollout status <kind>/<name> -n <namespace>

# 7. Verify the workload is healthy:
kubectl get pods -n <namespace> -l app.kubernetes.io/instance=<instance>
```

### CNPG-specific: password rotation

CNPG managed roles (vhhealth_runtime, vhhealth_readonly) rotate automatically
when the referenced Secret is updated — the operator reconciles the DB role
password on next heartbeat (~30s). No manual ALTER ROLE needed.

```bash
# Confirm rotation applied:
kubectl cnpg status vhhealth-pg -n vhhealth-platform
# Look for "Managed Roles status" showing "not ready → reconciled"
```

---

## Procedure: rotate the Vault transit unseal token

The transit token has a long TTL (orphan, no expiry) but should be rotated
annually or on key-holder change.

```bash
# 1. Log into vault-bootstrap:
kubectl exec -n vhhealth-security vault-bootstrap-0 -- \
  vault login -method=token <bootstrap-root-token>

# 2. Create a new auto-unseal token:
kubectl exec -n vhhealth-security vault-bootstrap-0 -- \
  vault token create \
    -policy=autounseal-policy \
    -period=0 \
    -orphan \
    -display-name=vault-autounseal-$(date +%Y%m) \
    -format=json | tee /tmp/new-autounseal-token.json

NEW_TOKEN=$(jq -r .auth.client_token /tmp/new-autounseal-token.json)

# 3. Seal the new token as a SealedSecret:
kubectl create secret generic vault-autounseal-token \
  -n vhhealth-security \
  --from-literal=token="${NEW_TOKEN}" \
  --dry-run=client -o yaml \
  | kubeseal --controller-namespace vhhealth-security \
             --controller-name sealed-secrets \
             --format yaml \
  > infra/kubernetes/base/vault/vault-autounseal-token.sealed-secret.yaml

shred -u /tmp/new-autounseal-token.json

# 4. Commit + push. ArgoCD applies the new SealedSecret.
git add infra/kubernetes/base/vault/vault-autounseal-token.sealed-secret.yaml
git commit -m "ops: rotate vault transit unseal token"
git push origin main

# 5. Rolling restart of production Vault (it picks up the new token via env):
kubectl rollout restart statefulset/vault -n vhhealth-security
kubectl rollout status statefulset/vault -n vhhealth-security

# 6. Verify auto-unseal is working (sealed pods should auto-unseal on start):
kubectl exec -n vhhealth-security vault-0 -- vault status | grep -E 'Sealed|Recovery'
# Expected: Sealed: false, Recovery Seal Type: transit

# 7. Revoke the old token from bootstrap Vault (after confirming new one works):
kubectl exec -n vhhealth-security vault-bootstrap-0 -- \
  vault token revoke <old-token-accessor>
```

---

## Procedure: annual vault rekey (Shamir key rotation for vault-bootstrap)

Run annually or when a key holder leaves.

```bash
# Requires 3 of 5 existing key holders.
# Run from a secure terminal with VAULT_ADDR pointing to vault-bootstrap.

vault operator rekey -init \
  -key-shares=5 \
  -key-threshold=3 \
  -pgp-keys="<key1.asc>,<key2.asc>,<key3.asc>,<key4.asc>,<key5.asc>"
  # PGP-encrypt each unseal key to the respective holder's public key.

# Each key holder provides their current unseal key:
vault operator rekey -key <holder-1-key>
vault operator rekey -key <holder-2-key>
vault operator rekey -key <holder-3-key>
# Output: 5 new encrypted unseal keys. Distribute to holders.
```

---

## ESO path (future — when External Secrets Operator is adopted)

Once ESO is installed, secrets can sync FROM Vault TO Kubernetes secrets
automatically, eliminating manual SealedSecret management for app credentials.
The rotation cadence stays the same but step 2–5 above become:

```yaml
# An ExternalSecret CRD (not yet deployed — flag for batch 30):
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: redis-credentials
  namespace: vhhealth-platform
spec:
  refreshInterval: 1h          # polls Vault hourly
  secretStoreRef:
    name: vault-cluster-store
    kind: ClusterSecretStore
  target:
    name: redis-credentials
  data:
    - secretKey: password
      remoteRef:
        key: vhhealth/redis
        property: password
```

This is not deployed yet. SealedSecrets + manual rotation per this runbook
is the current source of truth.

---

## Alert: VaultSealed

If the `VaultSealed` Prometheus alert fires (vault.status.sealed == 1):

1. Check bootstrap Vault status:
   ```bash
   kubectl exec -n vhhealth-security vault-bootstrap-0 -- vault status
   ```
2. If bootstrap is sealed: page the 3 key holders on the on-call rota.
   ```bash
   kubectl exec -n vhhealth-security vault-bootstrap-0 -- \
     vault operator unseal <key-1>
   kubectl exec -n vhhealth-security vault-bootstrap-0 -- \
     vault operator unseal <key-2>
   kubectl exec -n vhhealth-security vault-bootstrap-0 -- \
     vault operator unseal <key-3>
   ```
3. Once bootstrap is unsealed, production Vault pods should auto-unseal
   within 60s. If not, force a restart:
   ```bash
   kubectl rollout restart statefulset/vault -n vhhealth-security
   ```
4. Confirm: `vault status` on all pods shows Sealed: false.

RTO for a sealed-bootstrap incident: ~10 minutes (key holders on 5-min SLA).
