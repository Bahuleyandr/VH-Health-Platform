# Argo CD

HA Argo CD install for VH Health. Handles:
- Sync of all `infra/kubernetes/overlays/<env>` into the cluster.
- Sync of app-specific manifests under `infra/kubernetes/apps/`.
- Sync of Helm-based platform charts (Harbor, kube-prometheus-stack,
  Loki, Argo CD itself, and Falco) via child Applications. The cert-manager,
  CNPG, Barman, and MinIO operator Applications remain held outside active
  composition; see `docs/OPERATOR_LIFECYCLE.md`.

## Chart version

Pinned at **v7.7.5** (Argo CD app v2.13.1). See `chart-tracker.yaml`.

## Bootstrap sequence

1. Apply `base/argocd/namespace.yaml` manually (before Argo CD exists,
   there is no one to sync it).

2. Validate and apply the Sealed Secrets controller with the repository helper
   (so that the next step's sealed secrets decrypt):

   ```bash
   scripts/bootstrap-sealed-secrets.sh --check
   scripts/bootstrap-sealed-secrets.sh --apply
   ```

   The helper renders the bootstrap-only Kustomization, validates its exact
   Namespace, CRD, RBAC, and controller identity
   (`vhhealth-security/sealed-secrets`), applies those validated bytes, and
   waits for the Deployment to become available. The ServiceMonitor remains
   in `base/monitoring` until its CRD exists.

3. Apply the `repo-vhhealth-platform` sealed secret so Argo CD can
   pull the repo.

4. Install Argo CD via helm:

   ```bash
   helm repo add argo https://argoproj.github.io/argo-helm
   helm install argocd argo/argo-cd \
     --namespace argocd --create-namespace \
     --version 7.7.5 \
     --values infra/kubernetes/base/argocd/argocd-values.yaml
   ```

5. Apply the `AppProject`:

   ```bash
   kubectl apply -f infra/kubernetes/base/argocd/project.yaml
   ```

6. Apply the bootstrap "app of apps" Application (next section).

This bootstrap does not apply or sync the held operator lifecycle Applications
under `infra/kubernetes/held/operator-lifecycle/`.

## App-of-apps pattern (forward-looking)

Agent C owns `infra/kubernetes/apps/` where per-service `Application`
CRs live. An ApplicationSet in that directory (to be created later,
not in this batch) will enumerate every service via a Git generator:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: vhhealth-apps
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/Bahuleyandr/VH-Health-Platform
        revision: main
        directories:
          - path: infra/kubernetes/apps/*
  template:
    metadata:
      name: "vhhealth-{{path.basename}}"
    spec:
      project: vhhealth
      source:
        repoURL: https://github.com/Bahuleyandr/VH-Health-Platform
        targetRevision: main
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "vhhealth"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=false
          - ServerSideApply=true
```

## Initial admin password

Retrieved on first boot:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d
```

Log in at `https://argocd.vhhealth.hospital.local/` and immediately
change the password under User Info → Update Password. The initial
secret is auto-deleted by Argo CD once changed.

## OIDC SSO (TODO — batch 17)

Wire Keycloak (once stood up in the hospital) into Argo CD via the
`dex.config` stanza in `argocd-values.yaml`. Replace the local admin
user with OIDC-issued groups mapped to `vhhealth-admin` / `vhhealth-viewer`
RBAC roles.
