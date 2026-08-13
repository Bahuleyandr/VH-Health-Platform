# Production image pin verification

The production platform and application roots are separate ArgoCD sync units,
so image validation must render both of them:

```text
infra/kubernetes/overlays/prod
infra/kubernetes/apps
```

Run both repository guards from the repository root:

```bash
node scripts/check-prod-helm-image-inventory.mjs
node scripts/check-prod-digests-pinned.mjs
```

The digest guard renders the Kustomize-controlled content in both roots and
inventories every scalar image-reference field covered by the production
manifest contract: workload `image`, CRD `imageName`, and operator/bootstrap
configuration keys ending in `Image` (including `operatorImage`,
`barmanPluginImage`, and `barmanSidecarImage`). It also inventories the three
JSON image fields synthesized by the rendered
`cnpg-scheduled-restore-proof` script (object-verification Job, restore
Cluster, and SQL-verification Job); a dynamic image must resolve to exactly one
literal value rendered into the parent workload. Contract tests hold that
synthesized inventory at exactly three, so a changed or unresolved runtime
image fails closed. The guard requires every active occurrence to use a real
`tag@sha256` reference.
Repeated references are checked for policy at every occurrence and
deduplicated only for the live registry request.
It then requests the pinned digest through the registry's OCI Distribution API
and fails unless that manifest exists and its `Docker-Content-Digest` exactly
equals the rendered pin.
It supports anonymous Bearer challenges and optional host-specific
`GHCR_USERNAME`/`GHCR_TOKEN` or
`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` credentials. Generic credential
variables are never used. Token exchange requires HTTPS, a registry-bound
token authority, and the exact `repository:<path>:pull` scope; authentication
and rate-limit failures report actionable diagnostics without printing
credentials.

The following references at the exact all-zero digest are the only exceptions,
and each is bound to one specific render root. A tag, a different repository
spelling, or the same reference in the wrong root is not held.

Application images, only in the rendered `infra/kubernetes/apps` root:

- `ghcr.io/bahuleyandr/vh-health-platform-backend`
- `ghcr.io/bahuleyandr/vh-health-platform-adminportal`
- `ghcr.io/bahuleyandr/vhhealth-staff-web`

Database image, only in the rendered `infra/kubernetes/overlays/prod` root
(audit 2026-08-13, P1):

- `ghcr.io/cloudnative-pg/postgresql:17.10-standard-bookworm`

The application entries take the form
`<repository>@sha256:0000000000000000000000000000000000000000000000000000000000000000`;
the database entry keeps its tag, because the tag names the declared
generation while the digest is what the operator must supply. The exception is
also bound to the exact seven rendered workload occurrences: the admin,
backend, and staff-web Deployments; the ward-downtime-packs CronJob; both
containers in the backend migration Job; and `Cluster/vhhealth-pg`'s
`imageName`. A missing, duplicated, or additional all-zero occurrence fails the
guard.

The application pins are deliberately held fail-closed until the signed release
pipeline writes build-emitted digests. The database pin is held because the
exact qualified PostgreSQL 17 minor and digest are operator evidence this
repository does not hold — see
[`CNPG_POSTGRES_18_QUALIFICATION.md`](../../../docs/CNPG_POSTGRES_18_QUALIFICATION.md)
§1 and `infra/kubernetes/held/c1-1-pg18-cutover/README.md`. Holding it
fail-closed is what keeps the PostgreSQL 18.4 cutover target out of the active
graph, where an ordinary platform sync would have run an irreversible
`pg_upgrade`. The default guard reports all four as `HELD`; pass
`--require-pinned` during activation to reject them.

## Helm chart boundary

Longhorn, kube-prometheus-stack, and Loki are child ArgoCD Applications backed
by upstream Helm charts. Kustomize renders those Application objects, not the
chart-generated workloads, so their runtime image references are **not** part
of the digest guard's live registry proof.

`check-prod-helm-image-inventory.mjs` fails closed unless the exact reviewed
Application/chart repository, revision, and values-source inventory remains
unchanged. That makes a new chart or revision visible to review, but it is not
an immutable chart-image proof. Before activation, render those three pinned
charts with the committed values, inventory every resulting image, pin or
otherwise approve those image references under the activation procedure, and
verify them separately against their registries.

## 2026-08-13 registry and Redis security evidence

Baseline commit: `614216b28ffbf8f0270c4d88178cceae604ac091`.

Before the registry correction, `docker buildx imagetools inspect <tag@digest>`
returned `not found` for all eight reviewed platform references below. The
seven behavior-preserving tags were resolved live with:

```bash
docker buildx imagetools inspect <image:tag> --format '{{json .Manifest}}'
```

Redis was revalidated separately from consolidated commit
`6dfb40a23dbe1f5666a793730a90468860d24179`. The critical
[`GHSA-4789-qfc9-5f9q`](https://github.com/redis/redis/security/advisories/GHSA-4789-qfc9-5f9q)
advisory fixes the Lua use-after-free in Redis 7.4.6. The live upstream release
list showed [`7.4.10`](https://github.com/redis/redis/releases/tag/7.4.10) as the
newest non-draft, non-prerelease 7.4.x patch, so the platform pin was upgraded
to that compatible patch rather than stopping at the first fixed version.

The exact production tag was resolved and the resulting pin was requested
again with:

```bash
docker buildx imagetools inspect docker.io/library/redis:7.4.10-alpine --format '{{json .Manifest}}'
docker buildx imagetools inspect docker.io/library/redis:7.4.10-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2 --format '{{.Manifest.Digest}} {{.Manifest.MediaType}}'
```

The pinned object is an OCI image index. It contains Linux images for amd64,
arm/v6, arm/v7, arm64/v8, 386, ppc64le, riscv64, and s390x. The other resolved
objects were also multi-architecture indexes/manifest lists containing
`linux/amd64` plus at least one additional Linux platform. No held resource was
composed or activated.

| Image tag | Correct multi-architecture digest |
|---|---|
| `redis:7.4.10-alpine` | `sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2` |
| `oliver006/redis_exporter:v1.66.0` | `sha256:d98e6db8094f491b95791e9f776b0ba30a20aeacb90e18334935d5e51bf2e6a1` |
| `busybox:1.37.0` | `sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0` |
| `hashicorp/vault:1.18.2` | `sha256:2090eb7ac7a4bdef802f685698bd4dc0740de683affe8ff7df55f4fc77077ba7` |
| `smallstep/step-ca:0.28.1` | `sha256:a8308bddba866f5fccb2740c8bb2e5dea8cdde4b5856058539a7f5170894a9c0` |
| `docker.io/bitnami/sealed-secrets-controller:0.27.3` | `sha256:76f8c93c9e2e5450f90a416674f62ed9b9638b939561298f3218ed2a1cbe69d1` |
| `cloudflare/cloudflared:2024.11.1` | `sha256:665dda65335e35a782ed9319aa63e8404f88b34d2644d30adf3e91253604ffa0` |
| `ghcr.io/kubereboot/kured:1.16.2` | `sha256:c8c19766c778ba7fe87b4321eef05ba81dcc893a366a4cb3da00bf66a6d5d4df` |

This table records the current tag resolution after the committed registry
correction and Redis security upgrade. The CI guard remains the authoritative
current availability proof for the Kustomize-controlled and
scheduled-restore-proof inventory described above: it requests every unique
active digest on each infrastructure gate and detects a missing or invalid
manifest. It deliberately does not require an upstream version tag to remain
bound forever; the digest, not the mutable tag, is Kubernetes' pull authority.
Helm chart-generated images remain outside that proof as documented in the
preceding boundary.
