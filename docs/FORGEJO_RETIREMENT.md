# Forgejo retirement

The owner permanently retired Forgejo delivery and mirroring on 2026-09-30.
GitHub is the sole repository and hosted CI/CD authority. Do not push to the
retired mirror, restore its workflows, provision its credentials, or require
mirror parity as release evidence.

## Repository disposition

The retirement change removes all 21 `.forgejo/workflows` definitions, the
Forgejo runner image and BuildKit configuration, provider-specific release and
deployment helpers, and the GitHub mirror-liveness workflow and fixtures.
Historical commits and audit evidence remain available. The public key at
`infra/forgejo/signing/cosign.pub` is retained byte-for-byte for historical
artifact verification, not as an authorized signer for new delivery.

Useful checks move to GitHub rather than being discarded with the provider:

| Retired coverage | GitHub destination and boundary |
| --- | --- |
| Canonical and full-stack CI | `ci.yml` and `all.yml`; full backend, Admin, Flutter, FHIR, client-contract, gateway and infrastructure gates remain. |
| Secret and dependency checks | Unconditional canonical security stage; `security-sweep.yml` retains both blocking backend/Admin npm audits, blocking Trivy vulnerability/secret scanning, and advisory OSV and broader Semgrep reports. |
| Non-publishing image checks | `container-supply-chain.yml` builds backend, Admin and Staff Web locally in hosted jobs, records image metadata, reports SBOMs and blocks on configured Trivy findings. It cannot publish or sign images. |
| Schema and code drift | Backend reusable gates include SQL-column reference scanning and full migration/schema/OpenAPI checks; client-contract and Flutter code generation retain cross-stack parity. |
| Warehouse checks | `ci-warehouse.yml` remains separate from application CI. |
| Application smoke | `smoke-e2e.yml` retains isolated synthetic backend/Admin journeys. |
| Hosted post-deploy and staff-role smoke | `post-deploy-smoke.yml` and `trial-readiness-smoke.yml` are manual only, require an authority receipt, explicit origins and the exact deployed commit. Write probes and Sentry submissions require explicit selection; they are not activated by this change. |
| Package and image updates | `.github/dependabot.yml`; see `qa/dependency-updates.md` for exact coverage and the Kubernetes-manifest updater gap. |
| Releases and staging delivery | Existing GitHub release, digest-pinning, Dalek and mobile staging workflows remain subject to their separate publication/deployment authority. |
| Staff Windows readiness placeholder | Removed. It never built Windows artifacts. The documented Windows pilot verification remains manual; there is no new hosted Windows-build claim. |

The repository security sweep runs in every canonical tier. Container checks
are required for the full tier and for backend, Admin, Flutter or infrastructure
changes; a security-only documentation run does not build application images.
The aggregate gate requires success when selected and an explicit skipped
result when not selected. Scheduled full-stack runs include both reusable
workflows. Immutable workflow inputs are guarded by
[`WORKFLOW_SUPPLY_CHAIN_PINS.md`](WORKFLOW_SUPPLY_CHAIN_PINS.md).

This mapping is source coverage, not proof that the new hosted jobs have run.
The retirement branch still requires its applicable local checks, exact-head
hosted CI and independent review before publication or merge approval.

## Trust and external stop lines

The checked-in Kyverno policy remains `Audit` with `failurePolicy: Fail`,
required signature verification and verified image digests. Its active signer
is GitHub OIDC for the named image release and Dalek workflows. Changing this
source does not update the live cluster or retire a deployed trust key. Review
current and rollback-image provenance before any separately authorized sync;
see [`KYVERNO_ENFORCE_READINESS.md`](KYVERNO_ENFORCE_READINESS.md).

INF-006 / PR #872 remains held. Removing source does not prove that remote
schedules, webhooks or in-flight jobs stopped, that tokens were revoked, or
that shared runners and infrastructure were retired. A named operator must
record those external containment receipts. Do not delete shared services,
keys, images, databases, backups or audit evidence under this source change.
The remaining fields and release stop lines live in
[`RELEASE_READINESS.md`](RELEASE_READINESS.md).
