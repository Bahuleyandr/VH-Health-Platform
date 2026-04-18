# VH Health Backend — Operational Runbooks

Runbooks for the five scenarios P1.5 / Phase 4.4 called out. Each page
is self-contained and aimed at whoever is on-call when the alert fires
(not the author of the affected code). Written 2026-04-17 against the
`claude/phase-3-landing` codebase.

| Scenario | Runbook | Severity |
|----------|---------|----------|
| Postgres primary is down / DB data loss | [`db-restore.md`](./db-restore.md) | **P0** |
| R2 bucket inaccessible / object missing | [`r2-restore.md`](./r2-restore.md) | **P0** |
| JWT signing key / API key rotation | [`cert-rotation.md`](./cert-rotation.md) | **P1** (routine) / **P0** (compromise) |
| Code Blue alert fired but shouldn't have | [`code-blue-misfire.md`](./code-blue-misfire.md) | **P0** (patient safety) |
| Chatbot LLM provider outage / key rotation | [`chatbot-provider-switch.md`](./chatbot-provider-switch.md) | **P2** (degraded feature) |

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

- `$` prefix = run as the app user (`vhhealth`) on the primary API host.
- `#` prefix = run as root.
- `[backend]` = run from `/srv/vhhealth/backend/` (the deploy checkout).
- Every sensitive command ends with an explicit verify step so "did it
  work" isn't left to operator memory.
