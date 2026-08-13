# Operator lifecycle gate

Status: **HELD — manual operator action and production evidence required**

INF-010 separates the CRD/controller lifecycle for cert-manager,
CloudNativePG, the Barman Cloud Plugin, and the MinIO Operator from the custom
resources in the production platform overlay. The four operator Applications
are under `infra/kubernetes/held/operator-lifecycle/`. That target is not
referenced by the active Argo application barrel, the platform base, or an
environment overlay.

Applying the held target creates only manual-sync Argo CD Applications. It does
not install, upgrade, prune, or restart an operator. A merge remains inert.

## Immutable sources

| Application | Chart | Runtime version | Destination |
|---|---|---|---|
| `vhhealth-cert-manager-operator` | Jetstack `cert-manager` `v1.16.1` | cert-manager `v1.16.1` | `cert-manager` |
| `vhhealth-cnpg-operator` | CloudNativePG `cloudnative-pg` `0.29.0` | CloudNativePG `1.30.0` | `cnpg-system` |
| `vhhealth-barman-cloud` | CloudNativePG `plugin-barman-cloud` `0.7.0` | Barman Cloud Plugin `v0.13.0` | `cnpg-system` |
| `vhhealth-minio-operator` | MinIO `operator` `5.0.15` | MinIO Operator `v5.0.15` | `minio-operator` |

Each Application pins the exact chart version, chart archive SHA-256, and every
chart-controlled runtime image by registry digest. The repository contract
downloads and hashes the four chart archives and verifies all nine image
digests against their registries:

```bash
node scripts/operator-lifecycle-preflight.mjs --contract-only
```

Changing a repository, chart version, archive hash, image digest, destination,
or manual-sync policy fails this contract. Do not substitute a mutable tag,
copy a digest from an unaudited source, or add these Applications to an active
Kustomization to make the check pass.

## Activation sequence

The sequence describes operator work; it does not authorize it.

1. Complete the normal RKE2, backup, rollback, and maintenance-window
   prerequisites. For CloudNativePG, complete every sequential compatibility
   rung in `CNPG_POSTGRES_18_QUALIFICATION.md`. The held Application expresses
   only the final qualified `1.30.0` target and is not permission to leapfrog a
   minor version or install it on the current Kubernetes baseline.
2. Run the contract check above. Retain its output with the reviewed change and
   independently render each Helm chart before activation. Confirm the render
   contains only the chart and image inventory declared by the Application.
3. Render and review the held Application target. An authorized operator may
   then apply those Application objects to Argo CD:

   ```bash
   kustomize build infra/kubernetes/held/operator-lifecycle
   kubectl apply --server-side --dry-run=server \
     -k infra/kubernetes/held/operator-lifecycle
   kubectl apply --server-side \
     -k infra/kubernetes/held/operator-lifecycle
   ```

4. Manually sync `vhhealth-cert-manager-operator`. Confirm all six cert-manager
   CRDs are Established and its controller, webhook, and CA injector are fully
   Available at the pinned images.
5. Only after the CloudNativePG qualification ladder reaches its approved final
   pair, manually sync `vhhealth-cnpg-operator`. Confirm the Cluster, Backup,
   Pooler, and ScheduledBackup CRDs and the pinned controller.
6. Manually sync `vhhealth-barman-cloud`. Confirm its `ObjectStore` CRD, pinned
   controller, and pinned injected-sidecar setting. This step requires healthy
   cert-manager first.
7. Manually sync `vhhealth-minio-operator`. Confirm all three MinIO operator
   CRDs and the pinned controller. Do not create or change Tenant credentials as
   part of this lifecycle step.
8. Run the live fail-closed preflight:

   ```bash
   node scripts/operator-lifecycle-preflight.mjs
   ```

   It requires all four live Applications to remain manual-sync, `Synced`, and
   `Healthy`; fourteen CRDs to be Established; and six controller Deployments
   to have observed their current generation, have every desired replica ready,
   and use the exact reviewed images. A missing kubeconfig, Application, CRD,
   controller, status, or image is a blocking non-zero result.
9. Only after that preflight and the separate credential, PostgreSQL upgrade,
   backup, restore, MinIO capacity, certificate issuer, and production
   activation gates pass may an authorized operator review a
   `vhhealth-platform` manual sync.

## Failure and rollback

- Stop on the first failed chart render, Argo sync, CRD establishment,
  Deployment availability, image, or preflight check. Do not sync dependent
  Applications or the platform overlay.
- Do not delete an operator Application as a rollback shortcut. Its finalizer
  can prune controllers and CRDs while custom resources still exist.
- Roll back one operator at a time to a previously qualified immutable source,
  preserving CRDs and operand data. CloudNativePG rollback must follow its
  version-specific compatibility procedure; never downgrade its CRDs or
  controller speculatively.
- If cert-manager is unhealthy, do not advance the Barman plugin or any issuer
  resources. If CNPG or Barman is unhealthy, do not sync the production
  PostgreSQL/ObjectStore resources. If the MinIO Operator is unhealthy, do not
  create or modify the Tenant.
- Preserve logs, Argo operation status, CRD conditions, Deployment status, and
  the preflight output as the failure receipt.

## Remaining authorization and evidence

This repository change supplies lifecycle declarations and checks only. It
does not supply a maintenance window, production kubeconfig, cluster owner
approval, the CloudNativePG/RKE2 ladder evidence, backup/restore proof,
Cloudflare or object-store credentials, MinIO root credentials, certificate
issuer readiness, or permission to sync any Application.
