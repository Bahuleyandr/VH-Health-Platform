# Helm chart update runbook

Dependabot/Renovate cannot parse our `chart-tracker.yaml` ConfigMaps — they
are plain ConfigMaps, not Helm manifests. Review active trackers by hand on a
monthly cadence (or when a CVE fix requires it). This procedure is not an
activation or Argo CD sync approval.

## Active tracked charts

| Chart | Tracker file | Upstream |
|---|---|---|
| Argo CD | `infra/kubernetes/base/argocd/chart-tracker.yaml` | https://argoproj.github.io/argo-helm (`argo-cd`) |
| Falco | `infra/kubernetes/base/falco/chart-tracker.yaml` | https://falcosecurity.github.io/charts (`falco`) |
| kube-prometheus-stack | `infra/kubernetes/base/monitoring/chart-tracker.yaml` | https://prometheus-community.github.io/helm-charts |
| loki-stack | `infra/kubernetes/base/monitoring/chart-tracker.yaml` | https://grafana.github.io/helm-charts |

The historical Harbor tracker is retained at
`infra/kubernetes/held/local-object-storage/harbor/chart-tracker.yaml`.
Harbor and the local object-store backing it are excluded from active
composition pending the [Rook/Ceph qualification design](../../../docs/OBJECT_STORE_ROOK_CEPH_REPLACEMENT_DESIGN.md).
Do not run this update procedure against the held tracker or treat a version
bump as permission to install Harbor. The owner attests that VH Health Harbor
and MinIO have not been deployed; the bounded Dalek metadata inspection found
none, but that is not a substitute for any future qualification evidence.

## Procedure

1. Look up the latest stable chart release on the upstream repo.
2. Edit the matching `chart-tracker.yaml` — update `chartVersion` and the
   `appVersion` / `falcoVersion` / component-version field(s). The monitoring
   tracker also carries per-component versions (`prometheusVersion`,
   `grafanaVersion`, `alertmanagerVersion`, `lokiVersion`, `promtailVersion`)
   — bump those alongside their parent chart.
3. Sanity-check the kustomize build still resolves:
   ```bash
   kustomize build infra/kubernetes/base/<chart-name>
   ```
4. Open a PR labelled `dependencies,infra,k8s`. Production Argo CD Applications
   remain manual-sync; a reviewed PR or merge does not apply the chart. The
   named operator must separately approve the exact revision and sync.

Major-version bumps (e.g. Argo CD 7.x → 8.x) should be done in a standalone
PR with release-note review — they often carry CRD changes.
