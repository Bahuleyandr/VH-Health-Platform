# C1.3 monitoring live drill

## Status and authority

This is an operator-executed activation drill. The C1.3 pull request does not
sync Argo, install credentials, create live receivers, apply the temporary
drill manifest, or activate monitoring. CI and the disposable Docker harness
are preparation evidence only. The C1.3 gate passes only when synthetic alerts
are scraped, evaluated, delivered to named operators, acknowledged, and
resolved in the live target environment.

Never use patient data or protected health information in this drill.

## Owner inputs and hold points

Before scheduling the drill, C0.4 must record:

- receiver endpoints and escalation targets for webhook, email, PagerDuty,
  and Slack;
- the off-site dead-man heartbeat destination and its evidence-retention
  location/window; and
- the on-call rotation mapped to platform, database, backup, backend,
  continuity, and device teams.

Infrastructure operators must also prepare the edge node-exporter EndpointSlice
from `continuity-edge-endpoints.yaml.example`. Do not place its address in git.

Stop before any sync unless all of these are true:

1. the exact release SHA and kube-prometheus-stack `65.2.0` are approved;
2. `alertmanager-secrets` exists in `vhhealth-monitoring` and includes
   `alertmanager.yaml`, `discord-webhook-url`, `discord-watchdog-url`,
   `pagerduty-routing-key`, `slack-api-url`, and `smtp-password`;
3. the approved edge EndpointSlice has been prepared without committing its
   address and its network path is authorized;
4. `vhhealth-monitoring-token` exists in `vhhealth`, the rendered namespace of
   `ServiceMonitor/vhhealth-backend`;
5. every named recipient has accepted the drill window and escalation test;
6. the off-site evidence store is reachable without depending on the monitored
   site; and
7. the prior pinned release/configuration is recorded for rollback.

Check Secret names and keys without printing Secret values.

## Evidence record

Create a timestamped evidence directory outside the monitored site. Record:

- release SHA, chart version, Alertmanager/Prometheus image versions, operator,
  approver, environment, and drill start/end time;
- rendered object names/namespaces and Secret key names;
- Prometheus target and rule states;
- each receiver, named operator acknowledgement, firing timestamp, resolution
  timestamp, and delivery identifier;
- off-site Watchdog heartbeat timestamps and the missed-heartbeat escalation;
- rollback or cleanup results; and
- SHA-256 hashes for exported logs/screenshots.

Do not record credentials, direct contact details, or alert payloads containing
patient data.

## Pre-sync verification

From the approved release:

```sh
amtool check-config /secure/path/alertmanager.yaml
node infra/kubernetes/base/monitoring/verify-rule-metadata.mjs
node infra/kubernetes/base/monitoring/run-promtool-rule-tests.mjs
node infra/kubernetes/base/monitoring/validate-monitoring.mjs
node infra/kubernetes/base/monitoring/validate-alertmanager.mjs
node infra/kubernetes/base/monitoring/proof/run-pipeline.mjs
node scripts/ci/run.mjs --only=infra
```

Render the chart and kustomizations through the release process. Confirm:

- `Alertmanager.spec.configSecret: alertmanager-secrets`;
- `Alertmanager.spec.secrets` includes `alertmanager-secrets`;
- Prometheus selects ServiceMonitors and rules across their rendered
  namespaces;
- `ServiceMonitor/vhhealth-continuity-edge` selects the selectorless
  `Service/vhhealth-continuity-edge` in `vhhealth-monitoring`, while
  `Prometheus.spec.serviceDiscoveryRole` is `EndpointSlice`;
- the monitoring kustomization retains
  `continuity-edge-alerts.yaml` followed by
  `continuity-edge-service-monitor.yaml`; and
- the monitoring Argo Application still requires manual sync.

## Manual sync and scrape proof

Only an authorized operator may perform the manual Argo sync. Immediately
after sync, apply the approved EndpointSlice prepared from
`continuity-edge-endpoints.yaml.example`; do not commit its real address.
Inspect the Prometheus targets/rules UI or API and retain evidence for:

| Contract | Expected discovery |
| --- | --- |
| Backend continuity and application metrics | `ServiceMonitor/vhhealth-backend` in `vhhealth`; Service label `app.kubernetes.io/name=vhhealth-backend`; authenticated `/metrics` target is up |
| Backup/CronJob status | chart-managed kube-state-metrics target is up and exposes the `kube_cronjob_*` and `kube_job_*` series used by C1.1/backend RED rules |
| Database/HA | CNPG-generated PodMonitor targets from `vhhealth-platform` are up |
| Continuity edge | operator-supplied EndpointSlice backs `Service/vhhealth-continuity-edge`; `ServiceMonitor/vhhealth-continuity-edge` target is up and exposes all five C3.2b textfile metrics |

The five required edge series are:

```text
vhhealth_continuity_pack_fresh_until_timestamp_seconds{facility_id}
vhhealth_continuity_verification_failures_total{facility_id,reason}
vhhealth_continuity_coverage_complete{facility_id}
vhhealth_continuity_edge_last_sync_success_timestamp_seconds{facility_id}
vhhealth_continuity_edge_replication_lag_seconds{facility_id}
```

Every sample must carry `facility_id`; the continuity-edge rules aggregate
`by (facility_id)`. A scraped series without it is a failed gate — it rejoins
the single aggregate group where one healthy facility masks another's failure.

An absent or unauthorized target is a failed gate. Do not bypass authentication
or change an owning slice's alert threshold to make the drill pass.

## Synthetic scrape-to-resolution drill

Copy
`infra/kubernetes/base/monitoring/proof/synthetic-live-drill.yaml.example` to a
secure temporary path. It is deliberately absent from every kustomization.

1. Verify the manifest contains no real endpoint or credential.
2. Apply it manually and wait until its Deployment is ready.
3. Confirm the temporary ServiceMonitor target is up and the
   `vhhealth_c13_live_drill` series is queryable.
4. For one family at a time, change only that family's ConfigMap metric from
   `0` to `1` and apply the ConfigMap.
5. Confirm the matching `C13Live*Synthetic` rule becomes firing.
6. Confirm delivery to the operations webhook, critical PagerDuty receiver,
   and the family's Slack/email receiver. A named operator acknowledges each
   delivery and its identifier is recorded.
7. Return that metric to `0`, apply the ConfigMap, and confirm the alert
   becomes inactive and all `send_resolved: true` receivers receive a resolved
   notification.
8. Repeat for platform, database, backup, backend, continuity, and device.
9. Delete namespace `vhhealth-c1-3-drill` and prove it is gone.

Do not proceed to the next family when firing or resolution evidence is
missing.

## Owning-rule smoke drill

Synthetic routing does not prove the owning metrics. In a separately approved
window, inject or safely induce one non-clinical test condition for each
family, without changing any committed expression, duration, severity, or
threshold:

- platform/HA from `alert-rules.yaml`;
- backup verification from `alert-rules.yaml` or the backend RED backup group;
- backend RED/SLO/reliability;
- database/CNPG;
- device gateway; and
- continuity/edge from `continuity-edge-alerts.yaml`.

Record the source series, evaluated rule, receiver path, named acknowledgement,
resolution, and cleanup. If a condition cannot be safely induced, the gate for
that family remains open; a direct Alertmanager API injection is not a
substitute for scrape and rule evaluation.

## External Watchdog drill

Verify the chart-provided always-firing `Watchdog` reaches
`deadman-external` every five minutes. The receiver must be an off-site
dead-man service, not merely another channel inside the monitored site.

With infrastructure and on-call approval, use the off-site service's supported
test mechanism to suppress or reject the heartbeat for one configured grace
window. Confirm the off-site service escalates the missing heartbeat to a
named operator, then restore acceptance and confirm heartbeat recovery. This
tests the signal a total monitoring/site outage produces without deliberately
stopping the whole monitoring stack.

Retain the heartbeat history and missed-heartbeat escalation outside the
failed-site boundary.

## Rollback and cleanup

For a proven bad monitoring manifest or configuration:

1. stop the drill and remove `vhhealth-c1-3-drill`;
2. manually sync the prior approved pinned release/configuration;
3. verify Prometheus, Alertmanager, backend, CNPG, kube-state-metrics, and edge
   targets recover;
4. verify Watchdog heartbeats resume at the off-site monitor;
5. preserve failed and recovery evidence off-site; and
6. correct the repository configuration through a new reviewed change.

Do not delete drill evidence or silently replace a failed receipt. Rollback
does not authorize different clinical thresholds, receiver ownership, or
retention values.
