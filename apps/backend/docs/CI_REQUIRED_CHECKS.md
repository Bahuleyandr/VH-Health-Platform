# CI required checks — branch-protection runbook

> Running CI on every PR doesn't stop anyone from clicking merge while it's
> red. This doc lists the exact status-check names to require on each repo's
> `main` branch and gives the one-shot `gh` command to configure it.

**Heads-up, 2026-04-17:** Both classic branch protection and the newer
Rulesets API are gated to **GitHub Pro** on private repos. Attempting the
block below on a free private repo returns HTTP 403 "Upgrade to GitHub
Pro or make this repository public to enable this feature." Options:
1. **Upgrade** (account-level, $4/mo). Then the block below Just Works.
2. Make the repo public (NOT viable for anything touching PHI).
3. Fall back to a local pre-push hook (see §"Free-tier fallback" below).

All five repos already have CI (`.github/workflows/ci.yml`). The gap has
been that GitHub doesn't know *which* checks are load-bearing, so a red PR
can still be merged. The check name GitHub sees is the **job name** inside
the workflow (not the filename, not the workflow `name:` field).

## Per-repo required checks

| Repo                          | Workflow         | Job (= check name)      | What it covers                                                          |
|-------------------------------|------------------|-------------------------|-------------------------------------------------------------------------|
| `VH-health-backend`           | Backend CI       | `lint-and-test`         | npm audit, ESLint, Swagger/Spectral, Prisma, raw migrations, Jest suite |
| `VH-health-backend`           | Backend CI       | `codeql`                | CodeQL JS static analysis                                               |
| `VH-Health-Adminportal`       | Admin Portal CI  | `lint-typecheck-build`  | npm audit, ESLint, `tsc`, Jest, `next build`                            |
| `VH-health` (patient)         | Patient App CI   | `analyze-and-test`      | `flutter analyze`, `flutter test`, debug APK build                      |
| `VHhealth-staff`              | Staff App CI     | `analyze-and-test`      | `flutter analyze`, `flutter test`, debug APK build                      |
| `vhhealth-core`               | Core Library CI  | `analyze-and-test`      | `flutter analyze`, `flutter test`                                       |

`fhir-conformance` and `deploy-staging` are NOT required — the former is
intentionally `continue-on-error` until warnings are cleaned up; the latter
only runs on `main` after merge.

## Enabling branch protection (GitHub Pro)

Solo-dev recipe — strict CI gate + admin-enforced, no review requirement
(GitHub won't let you approve your own PR, so `review_count=1` would
deadlock a solo maintainer). Pipe each payload through `gh api --input -`
so null fields serialise correctly.

```bash
gh auth login   # one-time, needs `repo` scope

# Backend
gh api -X PUT repos/Bahuleyandr/vh-health-backend/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {"strict": true, "contexts": ["lint-and-test", "codeql"]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF

# Admin portal
gh api -X PUT repos/Bahuleyandr/VH-Health-Adminportal/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {"strict": true, "contexts": ["lint-typecheck-build"]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF

# Patient app
gh api -X PUT repos/Bahuleyandr/VH-health/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {"strict": true, "contexts": ["analyze-and-test"]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF

# Staff app
gh api -X PUT repos/Bahuleyandr/vhhealth-staff/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {"strict": true, "contexts": ["analyze-and-test"]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF

# Core library
gh api -X PUT repos/Bahuleyandr/vhhealth-core/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {"strict": true, "contexts": ["analyze-and-test"]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

Flags explained:
- `required_status_checks.strict=true` — PR must be up-to-date with base
  before merge. This catches the "green on a stale branch, red on trunk"
  case.
- `enforce_admins=true` — the rule applies to repo admins too. Without
  this the protection is theatre.
- `required_pull_request_reviews: null` — no human reviewer required.
  Flip to `{"required_approving_review_count": 1}` once there's a second
  maintainer; keep null while solo, otherwise nothing merges.
- `restrictions: null` — do not restrict who can push; only the PR path
  is gated. Change if you ever want a named allowlist.

## Free-tier fallback: local pre-push hook

If you can't / don't want to upgrade, the next-best enforcement is a
local `.git/hooks/pre-push` script that runs the CI-equivalent locally
and refuses to push to `main` when it fails. Bypassable via
`git push --no-verify` but catches accidents.

Sketch (per-repo, adapt the test command):

```bash
#!/usr/bin/env bash
# .git/hooks/pre-push — refuse to push to main on red
set -e
while read -r local_ref local_sha remote_ref remote_sha; do
  if [[ "$remote_ref" == refs/heads/main ]]; then
    echo "→ running pre-push checks for main…"
    npm run lint
    npm test
  fi
done
```

Hook lives outside the repo (not committed), so every clone needs it
installed. Worth pairing with `husky` if you already use it.

## Verifying protection

```bash
gh api repos/Bahuleyandr/vh-health-backend/branches/main/protection | jq '.required_status_checks.contexts'
```

Expected output includes every required check name above. Repeat per repo.

## What "failed" looks like

When CI fails on a PR:
- The PR merge button is disabled with "Required statuses must pass before
  merging".
- The Discord webhook fires (`DISCORD_WEBHOOK_URL` secret must be set on
  each repo; `fhir-conformance` and `codeql` have their own notifications).
- The failure annotation appears on the PR Files tab if the failing step
  produces SARIF (CodeQL does; Jest/Flutter don't).

## Housekeeping

- If a workflow renames its `jobs.<id>` key, the check name changes and
  the protection rule needs to be updated. Prefer adding new jobs over
  renaming.
- Adding a non-blocking job? Set `continue-on-error: true` (that's how
  `fhir-conformance` stays informational without gating merges).
- Running into "expected check never arrived"? A branch that hasn't been
  pushed since the rule was added may not have a check run — push a
  no-op commit to force it.
