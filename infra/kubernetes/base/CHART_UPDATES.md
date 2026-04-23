# Helm chart update runbook

Dependabot/Renovate cannot parse our `chart-tracker.yaml` ConfigMaps — they
are plain ConfigMaps, not Helm manifests. Bump them by hand on a monthly
cadence (or when a CVE fix requires it).

## Tracked charts

| Chart | Tracker file | Upstream |
|---|---|---|
| Argo CD | `infra/kubernetes/base/argocd/chart-tracker.yaml` | https://argoproj.github.io/argo-helm (`argo-cd`) |
| Falco | `infra/kubernetes/base/falco/chart-tracker.yaml` | https://falcosecurity.github.io/charts (`falco`) |
| Harbor | `infra/kubernetes/base/harbor/chart-tracker.yaml` | https://helm.goharbor.io (`harbor`) |
| kube-prometheus-stack | `infra/kubernetes/base/monitoring/chart-tracker.yaml` | https://prometheus-community.github.io/helm-charts |
| loki-stack | `infra/kubernetes/base/monitoring/chart-tracker.yaml` | https://grafana.github.io/helm-charts |

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
4. Open a PR labelled `dependencies,infra,k8s`. Argo CD picks up the new
   version on the next sync.

Major-version bumps (e.g. Argo CD 7.x → 8.x) should be done in a standalone
PR with release-note review — they often carry CRD changes.
