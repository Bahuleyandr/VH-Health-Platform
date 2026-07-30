# C1.3 disposable pipeline proof

`run-pipeline.mjs` starts pinned Prometheus 2.55.0 and Alertmanager 0.27.0
containers plus a disposable metric exporter/receiver. It verifies:

- the always-firing `Watchdog` reaches the external dead-man route;
- every team family is scraped, evaluated, and delivered to the operations
  webhook, critical PagerDuty, and named team route; and
- clearing each synthetic metric produces resolved notifications at all
  receivers where `send_resolved` is enabled.

Run from the repository root:

```sh
node infra/kubernetes/base/monitoring/proof/run-pipeline.mjs
```

The script tears down its containers and volumes even on failure. Its mock
receivers prove local pipeline mechanics only. It does not prove Kubernetes
discovery, real credentials, named operators, or the off-site heartbeat
expiry; those remain the operator-executed live gate in
`docs/runbooks/C1_3_MONITORING_LIVE_DRILL.md`.
