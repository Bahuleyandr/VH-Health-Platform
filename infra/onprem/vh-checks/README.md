# vh-checks

Weekly DB drift + error-pattern scan that runs **on-prem** (Dalekdefender)
via systemd timer. Hits the in-cluster Postgres directly — no public
exposure, no external secrets, no claude.ai connector required.

## Why this exists

The cloud-side scheduled routines on Anthropic's infrastructure cannot
reach the in-cluster Postgres on Dalekdefender (Tailnet-only, behind
Tailscale Funnel which `claude.ai`'s connector validator rejects). This
runs the same three diagnostic queries locally on the same host as the
DB and posts a GitHub issue when drift shows up.

## What it checks

| Check | Drift condition |
|---|---|
| **PHI backfill** | Any of `users.{name,phone,address,phone_search_hash}_encrypted` or `medical_records.{description,diagnosis,treatment}_encrypted` columns has unencrypted rows (Phase E3 follow-up). |
| **Error patterns** | Any (request_summary, status_code) tuple in `audit_log` where status_code ≥ 500 has > 50 occurrences in the last 14 days. |
| **NEW error patterns** | Any (request_summary, status_code) ≥ 500 appearing in the last 14 days that did NOT appear in days 14-28 ago. |

## Output

| Surface | Contains | Where |
|---|---|---|
| Full local report | All counts + non-PHI metadata. **Today the queries don't surface PHI**, but the on-disk report is still treated as the place to look for triage detail. | `./reports/<YYYY-MM-DD>.json` + `./reports/latest.json` (host-only, gitignored) |
| GitHub issue | Counts + method/path/module/status_code only. Never `request_summary`, body payloads, or anything with patient identity. A defence-in-depth regex scrubber redacts and warns if any leak slips through. | github.com/Bahuleyandr/VH-Health-Platform/issues |

## Exit codes

| Code | Meaning | systemd interpretation |
|---:|---|---|
| `0` | Clean — no drift, no spikes, no new patterns | success |
| `1` | Drift detected — issue posted (or attempted) | success (via `SuccessExitStatus=1`) |
| `2` | Infrastructure failure — DB unreachable, missing env, port-forward didn't come up | **failed** (`systemctl status` will show red) |

So `journalctl -u vh-checks.service` is the source of truth for "what happened"; `systemctl status` only signals "did the run itself crash".

## PHI safety design

This is a healthcare system; treat GitHub as a non-PHI surface. The script enforces this in two layers:

1. **Primary defence — query shape.** Error-pattern queries select `method`, `path`, `module`, `status_code`, `count` only. The audit-log column `request_summary` (which can hold raw request bodies, including patient names + phone numbers) is **never read into anything that leaves the host.** PHI-backfill check returns a column name + count; never a row.
2. **Secondary defence — scrubber.** Before `gh issue create`, the formatted body is regex-scanned for 10+ digit sequences (phones, ID numbers), email shapes, and known PHI JSON keys (`patient_name`, `phone`, `aadhaar`, `abha`, etc.). Any hit is replaced with `[REDACTED]` and the issue body is annotated with a "scrubber triggered" warning so the underlying check can be tightened.

If you add a new check, keep it metadata-only at the SQL level. The scrubber is the floor, not the design.

## Install on Dalekdefender

```bash
ssh dalekdefender 'set -e
  cd ~ && git clone https://github.com/Bahuleyandr/VH-Health-Platform vh-platform-checkout 2>/dev/null || (cd vh-platform-checkout && git pull)
  cp -r vh-platform-checkout/infra/onprem/vh-checks ~/vh-checks
  cd ~/vh-checks
  npm install --omit=dev --no-audit --no-fund
  chmod +x run.sh
  mkdir -p reports

  # systemd unit + timer (system-level)
  sudo cp vh-checks.service /etc/systemd/system/
  sudo cp vh-checks.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now vh-checks.timer

  # confirm
  systemctl list-timers vh-checks.timer
'
```

## Test on demand

```bash
ssh dalekdefender 'cd ~/vh-checks && ./run.sh; echo EXIT=$?; cat reports/latest.json | head -40'
```

Or trigger via systemd to verify the timer + service wiring:

```bash
ssh dalekdefender 'sudo systemctl start vh-checks.service; \
  sudo journalctl -u vh-checks.service --since "1 minute ago" -n 50'
```

## View history

```bash
ssh dalekdefender 'ls -lt ~/vh-checks/reports/ | head'
ssh dalekdefender 'cat ~/vh-checks/reports/latest.json'
ssh dalekdefender 'sudo journalctl -u vh-checks.service --since "1 month ago"'
```

## Change the schedule

```bash
sudo systemctl edit vh-checks.timer
# Drop in:
#   [Timer]
#   OnCalendar=
#   OnCalendar=Wed,Sun 06:00:00
sudo systemctl daemon-reload
sudo systemctl restart vh-checks.timer
```

## Tear down

```bash
ssh dalekdefender 'set -e
  sudo systemctl disable --now vh-checks.timer
  sudo rm /etc/systemd/system/vh-checks.service /etc/systemd/system/vh-checks.timer
  sudo systemctl daemon-reload
  rm -rf ~/vh-checks
'
```

## Permissions

- `User=bahuleyan` in the unit file — runs as the home-dir user.
- `sudo -n kubectl ...` — kubeconfig is root-only on this host. The
  `bahuleyan` user has passwordless sudo for `kubectl` (already set up
  per the existing dalekdefender redeploy recipe).
- `gh` uses the auth token at `~/.config/gh/hosts.yml` (already configured
  with `repo` scope).

### Future hardening — restricted Kubernetes ServiceAccount

The current setup uses broad `sudo -n kubectl` (admin kubeconfig). When this
pattern moves to the prod RKE2 cluster, replace it with a dedicated
ServiceAccount bound to a Role that only allows:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: vhhealth
  name: vh-checks-reader
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["vhhealth-postgres"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods", "services"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/portforward"]
    verbs: ["create"]
```

…then write the SA's kubeconfig to `~/.kube/vh-checks-config` and have
`run.sh` set `KUBECONFIG=~/.kube/vh-checks-config` instead of using sudo.
This shrinks the blast radius if `bahuleyan` or the timer is compromised:
the worst it can do is read this one Secret + port-forward to PG.

For Dalekdefender (single-node dev rig where everything already shares
admin kubeconfig), the broad-sudo path is acceptable.

## Source of truth

Everything in this directory is committed to
[`infra/onprem/vh-checks/`](https://github.com/Bahuleyandr/VH-Health-Platform/tree/main/infra/onprem/vh-checks).
After editing, redeploy with the install recipe above.
