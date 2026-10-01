# Dependency updates on GitHub

GitHub Dependabot is the repository's dependency-update path. The owner
permanently retired Forgejo delivery and mirroring on 2026-09-30; do not create
a Forgejo bot, restore `RENOVATE_TOKEN`, or dispatch the retired updater.

## Configured coverage

The authoritative configuration is [`.github/dependabot.yml`](../../.github/dependabot.yml).
It declares weekly updates for the Dart workspace and member packages, npm
packages including the device gateway and infrastructure tools, GitHub Actions,
and the actual application Dockerfiles. Package updates are grouped where the
configuration declares groups; major versions remain subject to manual review.
The configuration is not evidence that the hosted bot has run successfully.

Review proposed updates through the same exact-head GitHub CI and release
boundaries as other changes. A dependency PR, a green gate or a container base
image update does not authorize release publication or deployment.

## Remaining updater boundary

The retired Renovate configuration included Kubernetes manifest discovery.
Dependabot's Dockerfile entries do not establish equivalent Kubernetes YAML
image-update coverage. That updater choice remains held for the owner; do not
reintroduce Forgejo or describe the coverage as complete. Production image pins
must continue to come from approved build-emitted digests and verified GitHub
release provenance. Helm chart review remains governed by
[`CHART_UPDATES.md`](../../infra/kubernetes/base/CHART_UPDATES.md).

## External containment

Old bot tokens and any remaining scheduled jobs require named external
containment receipts under [release readiness](../RELEASE_READINESS.md).
Removing the workflow and its setup instructions does not revoke credentials
or establish that remote jobs stopped. INF-006 / PR #872 remains held.
