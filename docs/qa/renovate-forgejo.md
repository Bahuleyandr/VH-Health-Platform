# Renovate on Forgejo

Renovate is the dependency-update bot for the Forgejo-hosted repository. It runs from `.forgejo/workflows/renovate.yml` every Monday at 03:30 IST and can also be started manually from Forgejo Actions.

## Required secret

Create a Forgejo bot account, for example `renovate-bot`, and give it a full name and email address. Create a Personal Access Token for that bot and save it as the repository Actions secret `RENOVATE_TOKEN`.

The token needs these Forgejo permissions:

- `repo`: read and write
- `user`: read
- `issue`: read and write
- `organization`: read
- `read:packages` if Renovate must read Forgejo packages later

## First run

1. Add `RENOVATE_TOKEN` under repository settings, Actions, Secrets.
2. Open the `Renovate Dependency Updates` workflow in Forgejo Actions.
3. Run it manually once with `workflow_dispatch`.
4. Confirm Renovate creates or updates the `Dependency Dashboard` issue.

The repository rules live in `renovate.json`. Major version updates are disabled by default, while minor and patch updates are grouped by app or infrastructure area.
