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

- `./reports/<YYYY-MM-DD>.json` — full report per run
- `./reports/latest.json` — symlink-style copy of the most recent
- GitHub issue posted on drift via `gh issue create` (skipped on clean runs)
- Process exit code: `0` clean, `1` drift, `2` infrastructure failure

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

## Source of truth

Everything in this directory is committed to
[`infra/onprem/vh-checks/`](https://github.com/Bahuleyandr/VH-Health-Platform/tree/main/infra/onprem/vh-checks).
After editing, redeploy with the install recipe above.
