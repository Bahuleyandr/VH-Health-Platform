# HELD — PostgreSQL 17 → 18.4 production cutover (C1.1 / C1.2)

Status: **held, not composed, not applied. No cutover authority exists.**

Nothing in the active production graph references this directory. It is absent
from `infra/kubernetes/base/cnpg/kustomization.yaml`, from
`infra/kubernetes/base/kustomization.yaml`, and from every overlay, so
`kustomize build infra/kubernetes/overlays/prod` does not contain the
PostgreSQL 18 image and an ArgoCD sync of the platform Application performs no
major version change.

## Why this exists

`docs/DEPLOYMENT_GUIDE.md` §6 and `docs/PRODUCTION_DB_HARDENING.md` both state
that the running production cluster remains PostgreSQL 17 and that the
committed PostgreSQL 18.4 image is *"an inert target, not permission to sync
it."* It was not inert. Until 2026-08-13 the PostgreSQL 18.4 pin was written
directly into `infra/kubernetes/base/cnpg/cluster.yaml` — the live
`Cluster/vhhealth-pg` that the prod overlay composes. A single operator sync of
the active platform Application would have handed CNPG an `imageName` bump
across a major version, which triggers the declarative **offline** major
upgrade (`pg_upgrade`). That is an irreversible data conversion of the
production clinical database, and the only thing standing between a routine
sync and that conversion was a prose warning in a comment.

The audit of 2026-08-13 (P1, item 6) required PG18 to become a separately
governed held path, with the active production graph kept on its declared
database generation until qualification and cutover authority exist.

## What changed

- `infra/kubernetes/base/cnpg/cluster.yaml` now declares the **PostgreSQL 17**
  generation for the live cluster, with an all-zero fail-closed digest — the
  same intentional placeholder convention already used for the three
  platform-owned application images in
  `infra/kubernetes/apps/kustomization.yaml`. The repository does not know the
  live cluster's exact qualified PG17 digest, and inventing one would be
  fabricating operator evidence; an unpullable digest cannot silently deploy
  anything, whereas the PG18 pin could silently convert everything.
- The exact digest-pinned PostgreSQL 18.4 target moved here, expressed as the
  same atomic `kubectl patch` that
  `infra/kubernetes/base/cnpg/pg18-upgrade-rehearsal.sh` already proves against
  synthetic data — so the rehearsal now genuinely rehearses the production
  action.
- No manifest was deleted. The rehearsal (`pg18-upgrade-rehearsal.yaml`) and DR
  drill (`dr-restore-drill.yaml`) were already excluded from the cnpg
  kustomization and remain exactly as they were; that exclusion was verified to
  be honoured by the render, not merely claimed.

## Operator actions before the active graph can be synced

The active `Cluster/vhhealth-pg` carries a fail-closed placeholder digest, so
the platform Application must not be synced until an operator replaces it:

1. Re-derive the current secure PostgreSQL 17 minor at execution time
   (17.10 as of 2026-07-28 — re-derive, do not copy) on the Bookworm image
   family required by `docs/CNPG_POSTGRES_18_QUALIFICATION.md` §4.
2. Capture its exact multi-architecture digest:
   ```bash
   docker buildx imagetools inspect ghcr.io/cloudnative-pg/postgresql:<minor>-standard-bookworm
   ```
3. Confirm it matches the image the live cluster is actually running:
   ```bash
   kubectl get cluster vhhealth-pg -n vhhealth-platform \
     -o jsonpath='{.status.pgDataImageInfo.image}{"\n"}{.status.pgDataImageInfo.majorVersion}'
   ```
4. Write that exact `tag@sha256:` reference into `spec.imageName` in
   `infra/kubernetes/base/cnpg/cluster.yaml` in a reviewed change, and confirm
   `spec.postgresql.parameters` still carry the pgvector prerequisites.

Only then does the active graph describe a syncable PostgreSQL 17 cluster.

## Cutover (separately governed, owner-gated)

Do **not** perform any of this by re-adding the PG18 image to
`base/cnpg/cluster.yaml`. That is precisely the defect this directory exists to
remove. The blocking preconditions and the exact atomic patch are recorded in
`pg18-cutover-target.yaml`; in summary:

1. Kubernetes/RKE2 advanced to 1.34.9+ (production is 1.31.4).
2. The interleaved CNPG/Kubernetes operator ladder rehearsed with the database
   major unchanged.
3. A PG17 backup proven by reader-only restore into a disposable PG17 cluster.
4. The synthetic offline PG17→PG18 rehearsal passed on a run-unique isolated
   archive.
5. A completed production `Backup` CR and an agreed downtime window.
6. The live PG17 archive identity read off the running Cluster.
7. Owner sign-off recorded.

Then apply the single atomic patch from `pg18-cutover-target.yaml`, which
`test`-guards the live plugin and PG17 archive identity before replacing the
archive identity and the image together. Rollback is restore-into-a-new-cluster
only; a physical `pg_upgrade` is not reversible in place.

## Known residual (not fixed here — needs live evidence)

`infra/kubernetes/base/cnpg/cluster.yaml` still declares the **post-cutover**
WAL archive identity `serverName: vhhealth-pg18` (line ~330), and the backup
verifier (`r2-backup-hardening.yaml:88`) and suspended restore proof
(`scheduled-restore-proof.yaml:106`) read the same value. On a PostgreSQL 17
cluster that identity is wrong — `docs/CNPG_POSTGRES_18_QUALIFICATION.md`
records `vhhealth-pg` as the historical PostgreSQL 17 identity, and
`pg18-upgrade-rehearsal.sh` `test`-guards that the identity is still the PG17
one immediately before conversion.

This was deliberately **not** changed. Which identity the running cluster is
actually archiving under is live state, not repository state; flipping it blind
would orphan a real WAL archive, which is a worse failure than the one being
fixed. It requires the operator to read
`{.spec.plugins[0].parameters.serverName}` off the running Cluster and
reconcile the manifest to it in a reviewed change. Until then, the fail-closed
image placeholder keeps the active graph unsyncable, so no WAL is written under
a wrong identity as a result of this repository.

## Validation

Held paths are outside the rendered-manifest validator targets in
`scripts/validate-kubernetes-manifests.mjs`, like `held/operator-lifecycle/` and
`held/c6-2-warm-standby/`. The C1.1 contract
(`scripts/check-c1-1-manifest-contract.mjs`) asserts the inverse: the
PostgreSQL 18.4 pin must be **absent** from every workload image field in the
production render and **present** here.
