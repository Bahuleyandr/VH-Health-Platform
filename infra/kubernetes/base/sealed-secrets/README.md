# Sealed Secrets

This directory installs the [Bitnami sealed-secrets controller](https://github.com/bitnami-labs/sealed-secrets)
in namespace `vhhealth-security`. It lets us commit encrypted secrets to
Git: the controller decrypts them into regular Kubernetes `Secret` objects
at sync time, and only the controller holds the private key.

## Controller version

Pinned at **v0.27.3** (released 2024-10). Bump in `sealed-secrets.yaml`
and `crd.yaml` together.

## Creating a new sealed secret

1. Install `kubeseal` on your workstation:

   ```bash
   KUBESEAL_VERSION='0.27.3'
   curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION:?}/kubeseal-${KUBESEAL_VERSION:?}-linux-amd64.tar.gz"
   tar -xvzf kubeseal-*.tar.gz kubeseal
   sudo install -m 755 kubeseal /usr/local/bin/kubeseal
   ```

2. Write the plaintext `Secret` (DO NOT COMMIT):

   ```bash
   cat > /tmp/my-secret.yaml <<'EOF'
   apiVersion: v1
   kind: Secret
   metadata:
     name: my-secret
     namespace: vhhealth-platform
   type: Opaque
   stringData:
     my-key: my-value
   EOF
   ```

3. Encrypt with the in-cluster public cert:

   ```bash
   kubeseal \
     --controller-namespace vhhealth-security \
     --controller-name sealed-secrets \
     --format yaml \
     < /tmp/my-secret.yaml \
     > infra/kubernetes/base/<subdir>/my-secret.sealed-secret.yaml
   ```

4. Commit the `*.sealed-secret.yaml` file. Delete the plaintext.

## Key rotation

The controller automatically generates a fresh private key every 30 days
(`--key-renew-period=720h`). Old keys are retained indefinitely so that
pre-existing sealed secrets keep decrypting.

**Back up the keys.** They are stored as Secrets in `vhhealth-security`
with label `sealedsecrets.bitnami.com/sealed-secrets-key`. Losing them
means losing access to every encrypted secret in this repo.

Recommended backup (monthly, automated by Ansible):

```bash
kubectl -n vhhealth-security get secret \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o yaml > /secure-backup/sealed-secrets-keys-$(date +%F).yaml
```

Store these backups in an offline location — never in this repo, never
in the same Cloudflare account that hosts our primary backups.

## Re-encryption after rotation

If for any reason the controller's keys are re-generated (cluster rebuild,
DR restore), existing `SealedSecret` objects won't decrypt. Re-seal them
by running the plaintext Secret generator through `kubeseal` again and
committing the new file.

`kubeseal --re-encrypt` can update existing SealedSecrets in place using
the latest active key.
