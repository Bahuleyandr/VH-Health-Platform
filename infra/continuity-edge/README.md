# VH Health continuity edge

This is a held package for an independently powered Linux edge host. It does
not provision disks, keys, certificates, SSH accounts, DNS, storage, or a
live service.

The package has four fail-closed boundaries:

- Caddy serves exact immutable `pack.html`/`pack.json` paths on loopback only;
- the LAN gateway requires mTLS and an exact signed
  tenant/facility/location/staff/device/certificate grant;
- pull activation uses the C3.2a verifier source, signed policy receipt,
  persisted floors, fsync, immutable set rename, and atomic pointer rename;
  and
- pack/log purge derives duration only from signed schema-v2 retention.

## Build

Build from the repository root so the Dockerfile can copy the exact C3.2a
verifier sources:

```sh
docker build \
  --file infra/continuity-edge/Dockerfile \
  --tag vhhealth-continuity-edge:c3-2b \
  .
docker image inspect vhhealth-continuity-edge:c3-2b \
  --format '{{index .RepoDigests 0}}'
```

The Node and rclone bases are digest-pinned. Record the built image digest in
the activation evidence and set `VHEDGE_GATEWAY_IMAGE` to that `@sha256`
reference. The committed all-zero example is deliberately rejected.

Validate the committed Caddy image without starting a listener:

```sh
podman run --rm \
  -v "$PWD/infra/continuity-edge/Caddyfile:/etc/caddy/Caddyfile:ro" \
  docker.io/library/caddy:2.10.0-alpine@sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

## Install boundary

1. Copy this directory to `/opt/vhhealth-continuity-edge`.
2. Install the built verifier runtime from the image or run
   `tools/build-runtime-verifier.mjs` against the exact checked-out source.
3. Create the unprivileged `vhcontinuity-edge` account with UID/GID 10001.
   The system units use the root-owned Podman store, but every container
   workload is forced to numeric UID/GID 10001 with all capabilities dropped.
4. Copy examples into `/etc/vhhealth/continuity-edge` and replace every
   `OWNER_INPUT` value; make runtime-readable credentials, receipts, keys, and
   configuration owned by UID/GID 10001 and mode 0600.
5. Mount the independently encrypted data and log LUKS2 volumes at the paths
   in `edge.env`. Create the data `state` and `metrics` directories, and make
   both mount roots plus those directories UID/GID 10001 with no group/world
   access. The gateway receives the data root read-only and only those two
   state directories read/write.
6. Install the source and drop SSH principals according to `ssh/README.md`.
7. Install the systemd units, but leave timers and services disabled.
8. Complete `docs/runbooks/CONTINUITY_EDGE_MIRROR.md`, set
   `VHEDGE_ACTIVATION_APPROVED=true`, and run the preflight.

The preflight never formats or unlocks a disk. It only proves that the already
mounted paths are dm-crypt/LUKS2, credentials are distinct, image references
are non-placeholder digests, the clock is synchronized, and every required
receipt exists.

## Test

```sh
npm --prefix infra/continuity-edge test
```

The suite creates only synthetic temporary data and keys. It covers the exact
verifier reason contract, atomic activation fault points, audit-chain
tampering, signed-retention purge, held Kubernetes render, Caddy/digest
contracts, and unencrypted preflight refusal.
