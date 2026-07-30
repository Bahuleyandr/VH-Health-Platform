# C1.3 monitoring activation design delta

## 1. Authority, sequencing, and status

This delta implements plan section 4 C1.3 and design section 5.1 under the
design section 10 C1 rollback contract. Coordinator clearance was granted
before build. The branch starts from merged C3.2b release
`dfac4c7202f49037f3407a705064be3c1945b3f0`.

C3.2b added exactly `continuity-edge-alerts.yaml` to the monitoring
kustomization. C1.3 preserves that line and appends
`continuity-edge-service-monitor.yaml`; it does not reorder or replace any
C3.2b resource.

All repository changes remain inert because the monitoring and workload Argo
Applications require manual sync. This change does not deploy Alertmanager,
create a receiver credential, create an edge target, apply the synthetic live
drill, or activate monitoring.

## 2. Post-C3.2b contract decisions

The merged C3.2b edge is an independently operated systemd workload outside
Kubernetes. It writes five Prometheus metrics atomically for node-exporter
textfile collection. It did not land a Kubernetes Service or ServiceMonitor.
C1.3 therefore adds a selectorless headless Service as the Kubernetes
discovery bridge and a ServiceMonitor whose labels exactly select that Service.
The pinned chart exposes `prometheus.prometheusSpec.serviceDiscoveryRole`, which
C1.3 sets to `EndpointSlice` for ServiceMonitor target discovery. An operator
supplies the external EndpointSlice during activation; no edge address or
nonexistent workload selector is committed.

The backend continuity exporter is already served by
`Service/vhhealth-backend` and selected by
`ServiceMonitor/vhhealth-backend`. Rendering the exact Argo source
`infra/kubernetes/apps/backend` proves that ServiceMonitor's namespace is
`vhhealth`. The credential SecretKeySelector therefore resolves
`vhhealth/vhhealth-monitoring-token`; the stale `-n monitoring` comment is
corrected to `-n vhhealth` without changing manifest behavior.

Backup-verification alert expressions consume kube-state-metrics
`kube_cronjob_*` and `kube_job_*` series. There is no separate backup exporter
or Service to select. The pinned chart's kube-state-metrics ServiceMonitor is
the truthful scrape source.

## 3. File ledger

| File | Change |
| --- | --- |
| `infra/kubernetes/base/monitoring/kube-prometheus-values.yaml` | Select cross-namespace rules/monitors and consume/mount `alertmanager-secrets` through the pinned chart fields |
| `infra/kubernetes/base/monitoring/alertmanager.yaml.example` | Add the valid owner-fillable routing, receiver, grouping, inhibition, repeat, and resolve configuration |
| `infra/kubernetes/base/monitoring/alertmanager-secrets.sealed-secret.yaml.example` | Add `alertmanager.yaml`, `discord-watchdog-url`, Slack, SMTP, webhook, and PagerDuty keys plus sealing instructions |
| `infra/kubernetes/base/monitoring/continuity-edge-service-monitor.yaml` | Add the selectorless bridge Service and its ServiceMonitor for the C3.2b node-exporter textfile endpoint |
| `infra/kubernetes/base/monitoring/continuity-edge-endpoints.yaml.example` | Define the held operator-supplied EndpointSlice without committing its address |
| `infra/kubernetes/base/monitoring/kustomization.yaml` | Preserve C3.2b's edge alert resource and append the edge ServiceMonitor bridge |
| Six production rule files | Add only `team` metadata; no expression, duration, severity, threshold, annotation, or recording rule changes |
| `rule-semantics.sha256`, `verify-rule-metadata.mjs`, `promtool-rule-parity.test.yaml`, `run-promtool-rule-tests.mjs` | Lock non-team rule content and prove representative firing before/after metadata insertion |
| `validate-alertmanager.mjs` | Run `amtool check-config` and deterministic routing-tree cases |
| `validate-monitoring.mjs` | Cover production and synthetic rules, parity, and dashboards |
| `infra/kubernetes/base/monitoring/proof/**` | Add the disposable Prometheus/Alertmanager pipeline, mock receivers, held live-drill manifest, and non-secret fixtures |
| `docs/runbooks/C1_3_MONITORING_LIVE_DRILL.md` | Define the operator-only live gate, off-site evidence, cleanup, and rollback |
| `infra/kubernetes/apps/backend/service-monitor.yaml` | Comment-only correction to the rendered `vhhealth` Secret namespace |

No migration or application-runtime file is changed.

## 4. Pinned chart and Secret wiring

The repository pins kube-prometheus-stack `65.2.0`. `helm show values` for that
exact version exposes all three required
`alertmanager.alertmanagerSpec` fields:

- `useExistingSecret`;
- `configSecret`; and
- `secrets`.

An exact-version Helm render proves:

```yaml
spec:
  configSecret: alertmanager-secrets
  secrets:
    - alertmanager-secrets
```

`useExistingSecret: true` suppresses the chart-generated Alertmanager
configuration. `configSecret: alertmanager-secrets` makes the Secret's
`alertmanager.yaml` key authoritative. Listing the same Secret in `secrets`
mounts its file-backed receiver values under
`/etc/alertmanager/secrets/alertmanager-secrets/`.

The operator seals these keys; this delta provides no real value:

- `alertmanager.yaml`;
- `discord-webhook-url`;
- `discord-watchdog-url`;
- `pagerduty-routing-key`;
- `slack-api-url`; and
- `smtp-password`.

`alertmanager.yaml.example` must be copied to a secure path, have every
`OWNER_INPUT` replaced, pass `amtool check-config`, and only then be sealed as
the `alertmanager.yaml` key.

## 5. Routing tree

The root groups on `team`, `alertname`, `cluster`, `namespace`, and `severity`.
The technical defaults are:

| Route | Group wait | Group interval | Repeat |
| --- | ---: | ---: | ---: |
| Root/team | 30 seconds | 5 minutes | 12 hours |
| Operations webhook | inherited | inherited | 4 hours |
| Critical PagerDuty | inherited | inherited | 4 hours |
| Watchdog external heartbeat | 0 seconds | 1 minute | 5 minutes |

Alertmanager `resolve_timeout` is five minutes. Every operational, PagerDuty,
Slack, and email receiver has `send_resolved: true`. The Watchdog receiver has
`send_resolved: false` because its health signal is continued heartbeat
presence, not a resolved event. These are delivery mechanics, not clinical
thresholds.

Routing order is:

1. `alertname=Watchdog` stops at `deadman-external`;
2. every critical/warning alert also reaches `ops-webhook`;
3. every critical alert also reaches `critical-pagerduty`; and
4. the `team` label selects the team's Slack/email receiver.

Alerts without a recognized team reach the `unmatched-alerts` Slack/email
receiver. A critical alert inhibits the matching warning only when
`alertname`, `team`, `cluster`, and `namespace` are equal.

## 6. Rule-family activation map

| Rule file/family | Team label | Team receiver |
| --- | --- | --- |
| `alert-rules.yaml` nodes, workloads, certificates, tunnel, Harbor, canary | `platform` | `team-platform` |
| `alert-rules.yaml` PostgreSQL HA | `database` | `team-database` |
| `alert-rules.yaml` backup verification/plugin/restore proof | `backup` | `team-backup` |
| `backend-red-alerts.yaml` backend RED | `backend` | `team-backend` |
| `backend-red-alerts.yaml` downtime packs/outage-critical jobs | `continuity` | `team-continuity` |
| `backend-red-alerts.yaml` CNPG replication | `database` | `team-database` |
| `backend-red-alerts.yaml` CNPG/upload backup | `backup` | `team-backup` |
| `backend-reliability-alerts.yaml` | `backend` | `team-backend` |
| `backend-slo.yaml` | `backend` | `team-backend` |
| `device-gateway-alerts.yaml` | `device` | `team-device` |
| `continuity-edge-alerts.yaml` | `continuity` | `team-continuity` |

The operations webhook and critical PagerDuty fan-out applies in addition to
the team receiver. The semantic hash guard removes only `team:` lines before
comparison and proves all other bytes match the merged C3.2b baseline.
`promtool test rules` is run before and after label insertion against the same
six representative firing cases.

No owning alert expression, `for`, severity, threshold, or SLO value changes.

## 7. Scrape and namespace coverage

| Source | Namespace/target | Discovery |
| --- | --- | --- |
| Backend and backend continuity exporter | ServiceMonitor and token Secret in `vhhealth`; Service target in `vhhealth` | Existing ServiceMonitor selector copied from `Service/vhhealth-backend` |
| CNPG HA/database | CNPG Cluster in `vhhealth-platform` | CNPG `enablePodMonitor: true` plus cross-namespace PodMonitor discovery |
| Backup and outage CronJobs | Workloads in `vhhealth` | Chart-owned kube-state-metrics ServiceMonitor |
| Continuity edge | Selectorless Service and operator-supplied EndpointSlice in `vhhealth-monitoring` | `ServiceMonitor/vhhealth-continuity-edge` |
| Prometheus rules | `vhhealth-monitoring` and temporary drill namespace | Cross-namespace rule discovery |

The real edge EndpointSlice is an operator activation input and is not
committed. Receiver credentials are mounted only into Alertmanager.

## 8. Proof layers

### Static and local proof

- `amtool check-config` validates the rendered production template.
- `amtool config routes test` verifies Watchdog, every team/severity fan-out,
  and the unmatched fallback.
- `promtool check rules` parses all production and synthetic rules.
- `promtool test rules` proves representative rule firing before and after team
  metadata.
- `verify-rule-metadata.mjs` proves all 64 production alerts have one approved
  team and every non-team byte matches the baseline.
- the disposable pipeline uses pinned Prometheus `2.55.0` and Alertmanager
  `0.27.0` to prove scrape, evaluation, Watchdog routing, webhook/PagerDuty/team
  fan-out, and resolution for all six families;
- exact-version Helm and kustomize renders prove Secret mounts,
  Service/ServiceMonitor selectors, namespaces, and resources; and
- `node scripts/ci/run.mjs --only=infra` remains the repository infrastructure
  gate.

### Live proof

`docs/runbooks/C1_3_MONITORING_LIVE_DRILL.md` is the authoritative live gate.
An operator supplies real inputs, performs the manual sync, confirms real
targets, applies the temporary synthetic exporter outside Argo, records named
operator acknowledgements and resolutions, exercises owning metrics safely,
tests missed external Watchdog heartbeat escalation, removes the drill
namespace, and retains evidence off-site.

Passing CI or the disposable pipeline does not satisfy the C1.3 gate.

## 9. Owner inputs and non-goals

C0.4 must name, approve, and retain:

- receiver endpoints and escalation targets;
- the off-site dead-man heartbeat destination and retention; and
- on-call rotation mapping.

C1.3 does not choose these values. It also does not deploy/sync Alertmanager,
create real credentials, activate an edge target, alter a clinical threshold,
or claim the live gate passed.

## 10. Rollback

For a proven bad monitoring manifest/configuration, manually sync the prior
approved pinned release, verify Prometheus/Alertmanager and every scrape target
recover, and confirm the off-site Watchdog heartbeat resumes. Preserve both
failure and recovery evidence outside the site. Fix forward through a reviewed
repository change; do not silently edit live configuration or delete receipts.
