# VH Health Backend — Operational Runbooks

Runbooks for operational scenarios P1.5 / Phase 4.4 called out. Each page
is self-contained and aimed at whoever is on-call when the alert fires
(not the author of the affected code).

**Executed via `kubectl` on the on-prem RKE2 cluster.** See
[`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
for kubeconfig setup. Commands assume your current context is
`vhhealth-prod` with default namespace permissions in `vhhealth` and
`vhhealth-platform`.

| Scenario | Runbook | Severity |
|----------|---------|----------|
| Postgres primary is down / DB data loss | [`db-restore.md`](./db-restore.md) | **P0** |
| R2 bucket inaccessible / object missing | [`r2-restore.md`](./r2-restore.md) | **P0** |
| Service-account key / provider token exposed | [`credential-incident-response.md`](./credential-incident-response.md) | **P0** |
| JWT signing key / API key rotation | [`cert-rotation.md`](./cert-rotation.md) | **P1** (routine) / **P0** (compromise) |
| Code Blue alert fired but shouldn't have | [`code-blue-misfire.md`](./code-blue-misfire.md) | **P0** (patient safety) |
| Chatbot LLM provider outage / key rotation | [`chatbot-provider-switch.md`](./chatbot-provider-switch.md) | **P2** (degraded feature) |
| Clinical AI provider switch / disable | [`clinical-ai-provider-switch.md`](./clinical-ai-provider-switch.md) | **P2** (degraded draft generation) |
| Cashier shift-close drawer reconciliation stuck | [`cashier-shift-close.md`](./cashier-shift-close.md) | **P2** (degraded billing) |
| TPA enhancement chain stuck or cap-alert missing | [`tpa-enhancement-stuck.md`](./tpa-enhancement-stuck.md) | **P2** (degraded TPA workflow) |
| Patient portal PDF / clinical-notes endpoints failing | [`patient-portal-pdf-fail.md`](./patient-portal-pdf-fail.md) | **P2** (degraded patient experience) |
| Teleconsult TURN/firewall/media smoke or held LiveKit activation | [`teleconsult-media-ops.md`](./teleconsult-media-ops.md) | **P2** (degraded teleconsult) |
| Terminology release import / rollback / binding coverage | [`terminology-releases.md`](./terminology-releases.md) | **P2** (degraded terminology) |

## How to use a runbook

1. Read the **Symptoms** section first — make sure you have the right
   runbook for the alert you're seeing.
2. Skim the **Prerequisites** to confirm you have the credentials /
   access / tools you need before the clock runs.
3. Follow **Response** top-to-bottom. Each numbered step is a single
   shell command or a specific UI action with the expected output.
4. Do the **Verify recovery** step before closing the incident.
5. Fill in the **Post-incident** checklist (or file a follow-up).

## Escalation

- **P0 on-call primary**: VH Health tech lead (PagerDuty: `vhhealth-p0`).
- **P0 on-call secondary**: Head of engineering.
- **P1**: File a Sentry-linked issue + notify `#vhhealth-ops` Slack.
- **P2**: Normal ticket queue.

## Conventions

- `$` prefix = run as the on-call engineer from any workstation with
  kubeconfig configured for `vhhealth-prod`.
- `#` prefix = run as root on a cluster node (SSH into `vhh-k8s-01` etc.)
  — only needed for etcd / OS-level operations; almost all day-2 work
  stays in `kubectl`.
- Namespace is always passed explicitly (`-n vhhealth` or
  `-n vhhealth-platform`) — never relies on default context namespace.
- Every sensitive command ends with an explicit verify step so "did it
  work" isn't left to operator memory.
