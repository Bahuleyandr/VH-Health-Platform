# C3.2b Publication Volume, Edge Mirror, and Monitoring Slice Design

**Status:** build record for the coordinator-cleared C3.2 design

**Implementation baseline:** `github/main` at
`4c8d12ea98133d01b87dab5034632d426e15e1ff`, fetched 2026-07-30

**Branch:** `infra/c3-2b-edge-mirror`

**Authority:** the complete cleared design in
[`c3-2-edge-mirror-design-delta.md`](c3-2-edge-mirror-design-delta.md), the
C3.2 handoff packet, and the C3 tranche in
[`2026-07-28-clinical-service-continuity.md`](../superpowers/plans/2026-07-28-clinical-service-continuity.md).
This document records the C3.2b build shape; it does not reopen or replace the
cleared design.

## 1. Outcome and hard boundary

C3.2b supplies three inert repository assets:

1. a held Kustomize component that mounts a pre-created RWX publication PVC
   into the downtime-pack CronJob read/write and the backend Deployment
   read-only;
2. an independently operable, encrypted continuity-edge package that pulls,
   verifies, authorizes, logs, purges, and uploads evidence without depending
   on the backend, database, Kubernetes, Cloudflare, or internet at read time;
   and
3. Prometheus rules for the five C3.2a continuity metrics plus operator
   documentation and go-live evidence gates.

The slice does not:

- change anything under `apps/backend/src`;
- add or alter a migration;
- create a PVC, StorageClass, PV, key, certificate, credential, policy,
  grant, secret, DNS record, or live edge host;
- select a storage implementation before
  [`C1_2_STORAGE_PLACEMENT_GATE.md`](../C1_2_STORAGE_PLACEMENT_GATE.md) reaches
  `PLACEMENT QUALIFIED / CHANGE APPROVED`;
- add the publication component to an active overlay;
- enable `CLINICAL_CONTINUITY_PACKS_ENABLED`;
- wire Alertmanager delivery;
- sync Argo CD, deploy, activate, or run a live outage drill; or
- remove the deprecated `/downtime/static` route.

All top-level Argo Applications remain manual-sync. Repository rollback is a
Git revert while this slice remains unselected and inactive.

## 2. Held RWX publication component

`infra/kubernetes/components/continuity-publication-rwx/` is a Kustomize
`Component`. It contains patches only; it does not declare or provision a
`PersistentVolumeClaim`.

When an operator deliberately includes the component, it:

- references the pre-created `vhhealth-continuity-publication` PVC;
- mounts it at `/var/lib/vhhealth/continuity`;
- sets `DOWNTIME_MIRROR_DIR` to that path;
- keeps `CLINICAL_CONTINUITY_PACKS_ENABLED=false`;
- mounts the backend volume read-only; and
- mounts the downtime-pack CronJob volume read/write.

The backend and CronJob manifests carry explicit held-hook annotations so the
component targets are reviewable, but the actual volume, environment
variables, and mounts exist only in the component patches. The component is
excluded from `base`, `dev`, `staging`, `prod`, and every other active
overlay. A held-render fixture proves the selected result without making it
deployable by default.

The PVC is RWX because the backend has three replicas with hard hostname
spread. `hostPath` and other node-local storage are rejected: replicas on
different nodes would see different publication state. The component does not
name Longhorn or any other StorageClass. Storage selection waits for the C1.2
placement gate and the complete H1 receipt set.

## 3. Edge host and encryption boundary

`infra/continuity-edge/` is an operator-installed package for an independently
powered Linux host. It assumes two configured mount points:

- a continuity data/state mount; and
- an access-log/batch mount.

`preflight.sh` refuses activation unless both paths are mounted from
LUKS2/dm-crypt devices. It also refuses:

- an unmounted directory or a symlinked mount;
- a source that is not a device-mapper crypt target;
- a non-LUKS2 mapper;
- missing or permissively readable credentials;
- reused pull/upload/user TLS key material;
- a container reference without `@sha256`;
- a missing trusted-key set, bootstrap floor receipt, signed schema-v2 policy
  receipt, or exact facility scope; and
- any placeholder activation value.

The package never runs `cryptsetup luksFormat`, generates a key/certificate,
or mutates a trust store. Those are operator actions with retained receipts.

## 4. Static serving and local gateway

Caddy is pinned by digest and listens only on `127.0.0.1`. Its root is mounted
read-only. The Caddyfile has no browse directive and accepts only exact
versioned pack asset paths. Tenant roots, facility roots, set roots, location
roots, directory indexes, dotfiles, and undeclared files return 404.

The first-party gateway terminates LAN TLS with:

- TLS 1.2 or newer;
- a configured server key/certificate;
- a configured client CA;
- mandatory, verified client certificates; and
- no HTTP listener or plaintext downgrade.

It exposes only exact URLs of this form:

`/v1/tenants/<tenant>/facilities/<facility>/locations/<type>/<id>/pack.html`

and the corresponding `pack.json`. Only `GET` and `HEAD` are accepted. The
gateway requires a named staff UID and device ID and derives the client
certificate SHA-256 fingerprint from the mTLS socket. It authorizes only an
unrevoked grant whose tenant, facility, location type/identifier, staff UID,
device ID, fingerprint, policy, access revision, and finite validity interval
all match. It also enforces the signed maximum offline authorization window.
It then proxies the exact immutable asset for the currently verified set to
loopback Caddy.

The gateway has no tenant/facility/unit listing endpoint. Health and metrics
state are local-only. Failure to verify the current set, persisted floors,
clock posture, signed policy, grant, revocation, or log chain denies the read.

## 5. Pull, verify, and atomic activation

The pull worker uses rclone SFTP over a dedicated SSH identity. The source
account is chrooted to one approved facility export and forced to
read-only `internal-sftp`; it has no shell, PTY, port forwarding, agent
forwarding, X11 forwarding, or write operation. Its key is distinct from
ward-terminal/user credentials and the central-drop upload key.

Each sync:

1. acquires the facility activation lock;
2. reads only the facility-local source `current.json`;
3. validates the exact `continuity-current-v1` pointer shape, tenant,
   facility, versioned set path, and manifest hash;
4. copies the referenced immutable set into a new staging tree on the
   encrypted data filesystem;
5. verifies the manifest bytes against the pointer hash;
6. runs the exact C3.2a `continuityEdgeMirrorVerifier.js` source through a
   build-time runtime adapter, retaining every C3.1/C3.2 stable reason;
7. verifies the signed schema-v2 policy receipt matches the set's audience,
   policy ID/version/checksum, revocation epoch, and the persisted floors;
8. requires exact coverage, every asset hash, no missing/extra asset, no
   unsafe segment, no symlink, and no path escape;
9. recursively fsyncs the staging files and directories;
10. renames the complete set into `sets/vN` without replacing an existing
    immutable set;
11. writes and fsyncs a new edge `current.json`, then atomically renames it
    over the old pointer;
12. advances manifest, policy, revocation, access-revision, and trusted-time
    floors under the same lock; and
13. atomically updates node-exporter textfile metrics.

A failure before the pointer rename leaves the old pointer byte-for-byte
intact. A failure after the rename leaves a complete verified new pointer and
set. On restart, the gateway re-verifies the selected set and advances any
crash-lagged floor before serving. A partial, unsigned, expired, stale,
rolled-back, wrong-audience, revoked-key, tampered, or clock-uncertain staging
tree is never discoverable.

## 6. Exact verifier reuse

The edge container build copies the C3.2a verifier plus its runtime-neutral
canonicalization and publication dependencies from `apps/backend/src`. A
small build adapter substitutes only:

- the two imported format constants; and
- the backend in-process metric sink.

It does not fork the verifier body, reorder checks, rename reasons, or weaken
defaults. A source-hash receipt in the built image identifies the exact
backend verifier consumed. Contract tests run the adapter and prove the
required C3.1 reasons remain reachable, including tampered, partial,
unsigned, rolled-back, revoked-key, and wrong-audience sets.

## 7. Signed policy and retention

C3.2a intentionally provides no engineering retention fallback. The edge
therefore requires a separately provisioned signed schema-v2 policy receipt
on the encrypted data mount. The receipt contains the canonical policy
signing payload, immutable policy ID, Ed25519 signature, and trusted policy
key identity. The edge verifies:

- canonical hash and Ed25519 signature;
- exact tenant/facility audience;
- policy schema version 2;
- policy ID/version/checksum and revocation epoch against the served
  manifest;
- effective time and persisted anti-rollback floors;
- `mtls_client_certificate` authentication mode; and
- positive `edgePackRetentionHours`, `accessLogRetentionHours`, and the
  existing source retention value.

The package does not create or countersign that receipt. Missing, invalid, or
mismatched evidence blocks preflight, activation, and purge.

Pack purge acquires the activation lock, validates the pointer before and
immediately before deletion, excludes the referenced set unconditionally,
accepts only complete verified versioned sets, and derives eligibility only
from `edgePackRetentionHours`.

Log purge removes only completed, successfully uploaded batches whose signed
last-event time exceeds `accessLogRetentionHours`. It never deletes the active
journal, an unsealed batch, or an upload without a retained receipt.

## 8. Tamper-evident logs and recovery upload

Each authorization attempt appends a bounded canonical event to the encrypted
log volume using `O_APPEND`, fsync, a monotonic per-device sequence, the prior
event hash, and the new event hash. A separately fsynced head receipt binds
the expected byte length, last sequence, and last hash. Rewrite, truncation,
tail replacement, sequence gaps, and hash-chain gaps block further serving
until operator recovery.

Completed batches use the exact
`vhhealth_continuity_edge_log_batch/v1` envelope accepted by the C3.2a ingest
CLI. The configured logging identity is operator-provisioned and
location-scoped; its public certificate/fingerprint must be represented by an
exact signed grant, while its private Ed25519 key remains only on the
encrypted edge. Ward-terminal private keys are never copied to the edge.
If governance does not approve this logging identity shape, log sealing and
edge activation remain held rather than reusing a user credential.

The upload worker verifies every completed batch and local chain before
copying it with a separate SSH key to a central `rrsync -wo` forced-command
drop. It cannot read, list, overwrite, or delete central files. It writes a
local upload receipt only after remote success. Central ingestion remains the
existing C3.2a CLI's responsibility; this slice does not reimplement it.

## 9. systemd and container boundary

The package supplies hardened units for:

- encryption and configuration preflight;
- digest-pinned loopback Caddy;
- the LAN TLS gateway;
- pull and atomic activation;
- periodic re-verification;
- policy-driven purge; and
- recovery-time log upload.

Pull, verify, purge, and upload each have a service and timer. Services use a
dedicated unprivileged account, restrictive filesystem access, no new
privileges, a private temporary directory, protected kernel/home/system
surfaces, and explicit read/write path allowlists. Caddy receives the data
mount read-only. The gateway and workers receive only the paths and
credentials each requires.

The first-party image uses a digest-pinned Node base. The committed Caddy
reference is also digest-pinned. Operators must record the built gateway
image digest before enabling any unit; a tag-only runtime image is rejected.

## 10. Monitoring

`continuity-edge-alerts.yaml` adds inert Prometheus rules for:

- pack expiry from
  `vhhealth_continuity_pack_fresh_until_timestamp_seconds`;
- any increase in
  `vhhealth_continuity_verification_failures_total{reason}`;
- incomplete coverage from
  `vhhealth_continuity_coverage_complete`;
- stale edge sync from
  `vhhealth_continuity_edge_last_sync_success_timestamp_seconds`; and
- excessive
  `vhhealth_continuity_edge_replication_lag_seconds`.

The only monitoring-kustomization change is one additive resource line so the
pending C1.3 lane can merge cleanly. `validate-monitoring.mjs` explicitly
checks the new file with promtool. This slice does not add Alertmanager
receivers, routes, Secrets, or live delivery.

## 11. Operator route transition and outage drill

The runbook preserves the deprecated backend route during coexistence. Before
retirement, an operator:

1. inventories every legacy bookmark;
2. provisions the dedicated legacy token if coexistence is required;
3. replaces each bookmark with the exact approved facility/unit edge URL;
4. proves the URL never lists a tenant, facility, set, or unit root;
5. drills authorized retrieval/printing with backend, database, Kubernetes,
   Cloudflare, and internet unavailable;
6. proves corrupt, unsigned, partial, rolled-back, expired, wrong-audience,
   revoked-credential, and cross-tenant requests fail closed; and
7. records named owner acceptance before withdrawing the legacy route in a
   later, separately approved change.

No silent deletion or automatic bookmark rewrite occurs in C3.2b.

## 12. File ledger

Add:

- `infra/kubernetes/components/continuity-publication-rwx/*`;
- `infra/continuity-edge/*`;
- `infra/kubernetes/base/monitoring/continuity-edge-alerts.yaml`;
- `docs/runbooks/CONTINUITY_EDGE_MIRROR.md`; and
- this design record.

Modify:

- `infra/kubernetes/base/monitoring/kustomization.yaml`, one additive resource
  line only;
- `infra/kubernetes/base/monitoring/validate-monitoring.mjs`, add the new rule
  filename only;
- `infra/kubernetes/apps/backend/deployment.yaml`, held reader hook only;
- `infra/kubernetes/apps/backend/ward-downtime-packs-cronjob.yaml`, held writer
  hook only;
- `docs/DOWNTIME_PROCEDURE.md`; and
- `docs/GO_LIVE_ACTIVATION_CHECKLIST.md`, including the complete H1 RWX
  evidence rewrite.

No other file may change without coordinator amendment.

## 13. Validation ledger

Repository validation must retain receipts for:

- edge contract tests covering tampered, partial, unsigned, rolled-back,
  revoked-key, wrong-audience, exact coverage, missing/extra asset, and
  symlink-escape failures;
- atomicity fault injection before and after set rename and pointer rename;
- audit-log rewrite/truncate rejection and event/batch hash-chain gaps;
- signed-retention-only purge and referenced-set preservation;
- signed-policy absence/mismatch activation refusal;
- held Kustomize render proving backend read-only and CronJob read/write
  mounts, exact PVC/path/env/disabled flag, and exclusion from active renders;
- Caddy config validation, loopback-only/static-path contract, and image
  digest pin;
- LUKS2 preflight acceptance and unencrypted-mount refusal;
- shellcheck for shell scripts;
- production and held Kustomize render plus strict kubeconform;
- promtool validation through `validate-monitoring.mjs`;
- `git diff --check`;
- `node scripts/ci/run.mjs --only=infra`; and
- the existing C1.1 manifest contract.

Live encryption, storage, SSH, mTLS, power-isolation, outage, and print proof
remain operator evidence. Repository tests must not claim those live results.

## 14. Rollback

Before activation, rollback is a repository revert. Manual-sync and component
exclusion keep the change inert.

After a separately approved activation:

1. retain the currently verified edge pointer, immutable sets, floors, signed
   policies, access logs, completed batches, and upload receipts;
2. stop new pulls and bookmark rollout;
3. prove the last approved local set remains readable under exact
   authorization;
4. withdraw a bad pointer atomically rather than selecting an older set below
   any floor;
5. restore the prior digest-pinned package only after the same verification
   and encryption preflight; and
6. preserve all evidence.

Rollback never serves an unsigned, partial, revoked, wrong-audience, expired,
or unencrypted set and never reconstructs purged PHI.
