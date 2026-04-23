# Vault

HashiCorp Vault deployed as a 3-replica StatefulSet with Raft integrated
storage. Scaffolded now so Agent B's batch 17 (secret rotation) can wire
the Vault Agent Injector into the backend + admin workloads without
re-architecting.

## Versions

- Vault: **1.18.2** (November 2024)
- Vault Agent Injector: added in batch 17 (not yet installed)

## First-boot bootstrap (runbook)

1. All three pods come up sealed. Check status:

   ```bash
   kubectl -n vhhealth-security exec -it vault-0 -- vault status
   ```

2. Initialise Shamir secret sharing on `vault-0` (only run once per cluster):

   ```bash
   kubectl -n vhhealth-security exec -it vault-0 -- \
     vault operator init -key-shares=5 -key-threshold=3
   ```

   This prints **5 unseal keys** and **1 initial root token**. Distribute
   to five named holders. Any three together unseal a pod; losing three
   permanently means the cluster is unrecoverable without this data.

3. Unseal `vault-0` (repeat 3 times with different keys):

   ```bash
   kubectl -n vhhealth-security exec -it vault-0 -- vault operator unseal
   ```

4. For `vault-1` and `vault-2`, the same three keys unseal them because
   Raft replicates the sealed state:

   ```bash
   kubectl -n vhhealth-security exec -it vault-1 -- vault operator unseal
   kubectl -n vhhealth-security exec -it vault-2 -- vault operator unseal
   ```

5. Enable the Kubernetes auth method so pods can authenticate with their
   service account token:

   ```bash
   kubectl -n vhhealth-security exec -it vault-0 -- sh -c '
     vault login <ROOT_TOKEN> &&
     vault auth enable kubernetes &&
     vault write auth/kubernetes/config \
       kubernetes_host="https://kubernetes.default.svc.cluster.local"
   '
   ```

6. Enable audit logging to file + stdout:

   ```bash
   vault audit enable file file_path=/vault/audit/vault.log
   vault audit enable -path=stdout file file_path=stdout
   ```

7. Revoke the initial root token (step 2 output) once first policies are
   configured — don't leave a permanent root lying around:

   ```bash
   vault token revoke <INITIAL_ROOT_TOKEN>
   ```

## Pod restart

Every pod restart re-seals. Expected to be handled automatically by
Vault Agent Injector sidecars in batch 17; until then, on-call manually
unseals via:

```bash
for i in 0 1 2; do
  kubectl -n vhhealth-security exec -it vault-$i -- vault operator unseal
done
```

## Using Vault from apps (forward-looking)

Once wired up, app pods will annotate for the Vault Agent Injector:

```yaml
annotations:
  vault.hashicorp.com/agent-inject: "true"
  vault.hashicorp.com/role: "vhhealth-backend"
  vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/vhhealth-backend"
  vault.hashicorp.com/agent-inject-template-db-creds: |
    {{- with secret "database/creds/vhhealth-backend" -}}
    DATABASE_URL=postgres://{{ .Data.username }}:{{ .Data.password }}@vhhealth-pg-rw.vhhealth-platform.svc:5432/vhhealth
    {{- end -}}
```

Vault issues short-lived database credentials per pod, auto-rotated by
the Agent.
