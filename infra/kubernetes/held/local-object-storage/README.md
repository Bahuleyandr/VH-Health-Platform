# Local object storage: HELD pending qualification

MinIO, Harbor using its bucket, Longhorn's local-store backup target, and new local-record archive production are
unavailable. The owner approved this capability hold on 2026-09-26 after
attesting that VH MinIO and Harbor had never been deployed outside Dalekdefender;
the coordinator's read-only Dalek inventory found neither VH service there.
Unrelated tenants and storage are outside this decision.

The eight files below retain the pre-hold declarations from main `95baac6b5`
without content changes. Their comments, paths, placeholder credentials and
bootstrap commands are historical design material, not activation instructions.
Do not compose either subdirectory, execute those commands, seal credentials,
or apply these sources. The old MinIO image is both unavailable from its
registry and affected by GHSA-hv4r-mvr4-25vw.

- `minio/kustomization.yaml`
- `minio/operator.yaml`
- `minio/tenant.yaml`
- `minio/minio-root-credentials.sealed-secret.yaml.example`
- `harbor/kustomization.yaml`
- `harbor/chart-tracker.yaml`
- `harbor/harbor-values.yaml`
- `harbor/harbor-credentials.sealed-secret.yaml.example`

The C1.1 contract checks their normalized hashes, rejects MinIO and Harbor
resources and image markers in every active root, and requires the local-record
archive producer to remain suspended. Existing encrypted R2 archive verification
and independent CloudNativePG direct-R2 backup and verification remain composed.
Longhorn remains manual-sync and unqualified, with empty backup target and
credential settings; this means backups are unavailable, not healthy.
All remaining deployable image pins must pass the unchanged registry verifier.

This repository hold authorizes no live prune, deletion, migration or sync.
If a previously unknown installation or retained data is found, stop and obtain
an operator inventory and preservation plan before any manifest application.
The Rook/Ceph replacement requires separate security, storage, backup, retention,
clinical/legal and release qualification, including independent restore proof.
Reactivation needs a reviewed implementation and explicit operator authorization;
merely reversing this hold is not a qualification procedure.
