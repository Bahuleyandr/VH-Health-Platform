# Continuity edge mirror operator runbook

**Status: held.** This runbook prepares an independently powered, facility-
scoped continuity edge. It does not authorize a Kubernetes sync, deployment,
feature-flag change, key generation, DNS change, bookmark cutover, or service
enablement. Those are separate operator changes after every receipt below is
approved.

The edge remains useful when the backend, PostgreSQL, Kubernetes, Cloudflare,
and internet are unavailable. It serves only verified immutable
`pack.html`/`pack.json` assets through an mTLS gateway. It is not a charting
surface, patient search, tenant/facility index, or emergency authentication
bypass.

## Ownership and hard prerequisites

Name one clinical owner, privacy owner, security owner, and infrastructure
owner. Stop if any ownership field is vacant.

Activation requires all of the following:

- the C-D4 and C-D10 decisions are countersigned;
- `GO_LIVE_ACTIVATION_CHECKLIST.md` H1 contains the complete RWX evidence
  packet, including the approved C1.2 placement result;
- the `vhhealth-continuity-publication` PVC already exists and the held
  component's rendered diff is approved;
- an active, correctly scoped, signed schema-v2 policy receipt supplies
  explicit edge-access and all three retention durations;
- a source-side read-only SSH principal and a separate central-drop write-only
  SSH principal have been provisioned;
- facility/location access grants and dedicated location-scoped logging grants
  have been issued by the existing C3.2a CLI;
- the edge data and log filesystems are separate LUKS2/dm-crypt mounts, unless
  the owners explicitly approve and record a shared encrypted device;
- trusted pack/policy keys, anti-rollback bootstrap floors, server TLS material,
  client CA, source host key, and log-upload host key are installed;
- the Caddy and edge images are digest-pinned and the actual built edge image
  digest is recorded; and
- the exact activation receipt passes
  `bin/validate-activation-receipt.mjs`.

The activation receipt contains only references and approvals, never private
keys:

```text
edge host asset ID
H1 storage evidence reference
C-D4 countersignature
C-D10 countersignature
location logging-identity approval
outage drill receipt
four named owners and canonical approval time
```

Do not copy a terminal private key to the edge. The edge logging identity is a
dedicated location-scoped grant and certificate whose private key signs only
recovery log batches.

## Package and network boundary

Build the package from the exact reviewed repository commit:

```sh
docker build --file infra/continuity-edge/Dockerfile \
  --tag vhhealth-continuity-edge:c3-2b .
docker image inspect vhhealth-continuity-edge:c3-2b \
  --format '{{.Id}} {{json .RepoDigests}}'
```

Record the source commit, the three source hashes in
`runtime/source-receipt.json`, the built image ID, registry digest, builder,
and time. Tag-only references are forbidden.

Caddy binds only `127.0.0.1:8080`, exposes no directory browsing, and allowlists
only the immutable facility/location `pack.html` and `pack.json` path. The
first-party gateway binds the operator-selected LAN address, terminates TLS,
requires a trusted client certificate, evaluates the exact signed
tenant/facility/location/staff/device/certificate grant, records the read, and
then proxies to Caddy.

Firewall policy permits the gateway port only from managed clinical terminal
networks. It permits source SSH only from the edge to the source host and log
upload only from the edge to the central drop. No inbound SSH, internet
publishing, Cloudflare route, tenant-root route, or all-facility discovery is
required.

The bookmark format is exact:

```text
https://<facility-edge-host>:8443/v1/tenants/<tenant-uuid>/facilities/<facility-id>/locations/<location-type>/<location-id>/pack.html
```

The managed launcher must present the approved client certificate and the
exact `X-VHHealth-Staff-Uid` and `X-VHHealth-Device-Id` context. A normal raw
bookmark cannot supply that context and must receive a denial.

## Storage preparation

Provision the host using the hospital's approved disk/key-management process.
This package never formats, unlocks, or generates keys for a volume.

Mount data and logs at the configured absolute paths. Both mounts must:

- resolve to `/dev/mapper/*`;
- report device type `crypt` and cryptsetup type `LUKS2`;
- be their own mount points, not subdirectories of another filesystem;
- use `rw,nodev,nosuid,noexec`; and
- be owned so only `vhcontinuity-edge` and the required root preflight can
  access them.

Create `state` and `metrics` directly below the data mount. Make both mount
roots and those two directories UID/GID 10001 with no group/world access.
The gateway mounts the data root read-only and receives only `state` and
`metrics` as nested read/write mounts; it cannot modify an immutable pack set.

Record LUKS header backup custody, recovery-key custody, mount UUIDs, filesystem
type, capacity threshold, remount test, and edge-loss disposal procedure.
Never place data, logs, floors, or staging on the unencrypted root filesystem.

## Credentials and configuration

Copy the package to `/opt/vhhealth-continuity-edge`. Create the unprivileged
`vhcontinuity-edge` account with UID/GID 10001. The system units use the
root-owned Podman store so the preflight and services see the same pinned
images; each workload is forced to numeric UID/GID 10001 inside its container,
with every capability dropped. Copy configuration examples under
`/etc/vhhealth/continuity-edge`, replace every `OWNER_INPUT`, and make
runtime-readable sensitive files owned by UID/GID 10001 with mode 0600.

The following credentials are different keys and principals:

- **source pull:** read-only forced command, facility path only, no shell,
  forwarding, write, delete, rename, or parent listing;
- **central drop upload:** create-only/write-only forced command, no read,
  overwrite, delete, listing, shell, or forwarding;
- **gateway TLS:** server authentication only;
- **terminal access:** client certificate on the managed terminal, never on
  the edge; and
- **location logger:** dedicated Ed25519 certificate/private key on the
  encrypted log volume, limited by its signed facility/location grant.

Pin SSH host keys in separate known-hosts files. Do not enable
`StrictHostKeyChecking=no`. Rotate source/upload credentials independently.

Populate:

- `trusted-keys.json` with reviewed pack and policy public keys/states;
- a completed signed schema-v2 policy receipt;
- audience-bound bootstrap floors from an approved current set;
- location-keyed logging identities;
- rclone source configuration;
- central-drop known hosts and destination;
- TLS server certificate/key and client CA; and
- the completed activation receipt.

The bootstrap floor receipt is a one-time owner assertion. After the first
successful activation, the persisted floor receipt is authoritative and must
never be deleted to make an older set pass.

## Held validation

Keep `VHEDGE_ACTIVATION_APPROVED=false`. Install the systemd unit files without
enabling or starting any service or timer. Validate:

```sh
npm --prefix infra/continuity-edge test
podman run --rm \
  -v "$PWD/infra/continuity-edge/Caddyfile:/etc/caddy/Caddyfile:ro" \
  docker.io/library/caddy:2.10.0-alpine@sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
kustomize build --load-restrictor LoadRestrictionsNone \
  infra/continuity-edge/test/fixtures/held-publication
```

The render must show the generator read/write, backend read-only,
`/var/lib/vhhealth/continuity`, and both flags still false. Confirm no active
overlay references `continuity-publication-rwx`.

Run preflight with approval still false and retain its expected
`edge activation is held` refusal. In an isolated test namespace/device, prove
that a plain, unencrypted filesystem is rejected. Do not weaken or bypass the
mount check for a lab.

## Separately approved activation

Only after every receipt and a separate change approval:

1. set the actual digest-pinned edge image and reviewed facility values;
2. set `VHEDGE_ACTIVATION_APPROVED=true`;
3. run `vhhealth-continuity-edge-preflight.service` and attach its output;
4. run one pull service manually;
5. verify the selected set, source-receipt hashes, signed policy, four floors,
   freshness, exact coverage, and current-pointer hash;
6. start Caddy, then the gateway;
7. make one authorized `HEAD`, one authorized `GET`, and one denied request;
8. verify and seal the local access log, upload it through the write-only
   principal, and ingest it with the existing central C3.2a CLI;
9. enable pull, verify, upload, and purge timers; and
10. observe at least one complete interval before migrating bookmarks.

Never enable a service with a failed preflight. The source publication flag and
held Kubernetes component require their own approved GitOps change; edge
activation does not implicitly select or sync them.

## Verification and failure handling

Each pull reads only the source facility `current.json`, stages the named
immutable set, verifies pointer/manifest/asset/grant-set bytes with the exact
C3.2a source, verifies the signed policy and floors, flushes all files, renames
the set, and atomically renames local `current.json`. A failure before pointer
rename leaves the prior selection. A failure after pointer rename may leave the
new verified selection and is reconciled by the next verify run; never replace
the pointer manually.

Use the stable verifier reason in the edge metric/log:

- `PACK_EXPIRED` or `CLOCK_UNCERTAIN`: stop serving new reads, repair the
  trusted clock source, and obtain a fresh signed set; never change timestamps;
- signature, key-state, hash, coverage, audience, symlink, extra/missing file,
  or rollback reason: quarantine the staged transfer, retain evidence, and
  escalate to security/infrastructure owners;
- source unavailable: keep the last still-valid verified selection; do not
  fabricate freshness or copy files around the verifier;
- no current selection: remain unavailable and use printed fallback; and
- log volume unavailable/full: deny reads because an authorized read cannot be
  durably recorded.

The edge exports these inert textfile metrics for the delivery lane to scrape:

```text
vhhealth_continuity_pack_fresh_until_timestamp_seconds{facility_id}
vhhealth_continuity_verification_failures_total{facility_id,reason}
vhhealth_continuity_coverage_complete{facility_id}
vhhealth_continuity_edge_last_sync_success_timestamp_seconds{facility_id}
vhhealth_continuity_edge_replication_lag_seconds{facility_id}
```

`facility_id` is this edge's `VHEDGE_FACILITY_ID` and is present on every
sample. The alert rules aggregate `by (facility_id)` so each facility alerts
independently — a sample missing that label would rejoin the single aggregate
group where one healthy facility hides another facility's failure. A sample
labelled `facility_id="unknown"` means the emitter could not resolve the
configured facility: treat it as a misconfigured edge, not as noise.

The alert rules in `continuity-edge-alerts.yaml` are repo-ready only. This
slice does not wire Alertmanager or deploy them.

## Certificate rotation and revocation

Issue the replacement terminal certificate and an append-only replacement
grant with finite validity. Publish and activate a greater access revision,
test the replacement, then append a revocation for the old grant and publish
another greater revision. Confirm the old certificate is denied at the edge.
Do not edit or renew a grant in place.

Rotate the location logger by issuing a separate location-scoped logging grant
and identity. Seal/upload the old identity's final batch before switching.
Keep certificate/grant provenance with the recovery evidence. Never authorize
one global logger across tenants or facilities.

Compromise response revokes the grant, publishes the revocation, removes the
certificate from the managed terminal, rotates the applicable CA/key only
under its incident procedure, and preserves local/central log evidence.

## Access-log recovery

Every authorized read is appended and flushed before proxying the asset.
Events form a hash chain; sealed batches are Ed25519 signed, bind facility,
location logger/grant, device, policy/access revision, contiguous sequences,
and the previous batch hash.

Upload copies completed batches with the separate write-only credential and
writes a local upload receipt only after success. Recovery uses the existing
`apps/backend/scripts/ingest-continuity-edge-logs.mjs`; do not reimplement
central receipt validation. A rewrite, truncation, dropped middle batch,
signature mismatch, replay conflict, future revision, or scope mismatch is an
incident, not a reason to reset the chain.

## Retention and purge

Purge runs only after the current schema-v2 policy receipt verifies. It derives
source pack, edge pack, and access-log durations exclusively from the signed
policy. There is no code or operator fallback.

The selected set is never deleted. An old set is eligible only after current
has been atomically withdrawn from it, the candidate independently verifies,
the signed retention elapsed, and current remains unchanged. Completed logs
are eligible only after a matching upload receipt and signed retention. Missing
or invalid policy, receipt, pointer, signature, chain, or clock blocks purge.

## Edge loss, rebuild, and rollback

Treat a lost or stolen edge as a security incident. Revoke terminal and logger
grants as applicable, revoke/rotate machine credentials, preserve central
receipts, and follow encrypted-media disposal and breach assessment. A
replacement starts from reviewed bootstrap floors at least as high as the last
central evidence; never restore an older filesystem snapshot and lower floors.

Repository rollback is safe while this slice remains unselected and all units
remain disabled. After activation, rollback is a forward safety operation:

1. stop bookmark rollout and timers;
2. preserve data, logs, floors, policy, keys, activation and upload receipts;
3. keep the last verified current set if still approved and valid, otherwise
   stop the gateway and use printed fallback;
4. revert only through reviewed GitOps/package changes; and
5. rerun the complete preflight and outage drill before reactivation.

Never serve an unsigned/partial/revoked set, serve from an unencrypted mount,
delete floors, reconstruct purged PHI, or silently fall back to the legacy
route.

## Outage and legacy-sunset acceptance drill

Record every command, start/end time, actor, source/current hashes, expected
result, actual result, screenshot or log receipt, and corrective action.

1. Prove a normal healthy pull, verify, authorized `HEAD`/`GET`, print, log
   seal, upload, and central ingest.
2. Stop backend and database access; block Kubernetes, Cloudflare, and internet
   from the edge while keeping the facility LAN and edge power.
3. Retrieve and print the exact facility/unit bookmark.
4. Attempt corrupt asset, partial set, invalid signature, older manifest/access
   revision, wrong tenant/facility/location, expired set, expired grant,
   revoked grant, and untrusted certificate. Each must fail closed without
   replacing current.
5. Inject failures before/after set rename and before/after pointer rename.
   Confirm `current.json` is always complete and selects either the prior or
   fully verified new set.
6. Rewrite and truncate a local event journal and remove a middle completed
   batch in isolated test data. Confirm verification rejects each.
7. Restore connectivity, upload/ingest the intact signed chain, and reconcile
   the simulated paper record.
8. Inventory legacy `/downtime/static` bookmarks and run the owner-approved
   coexistence window with its dedicated token.
9. Migrate managed launchers to the exact edge URL. Retire the legacy token and
   bookmarks only with a signed change receipt; retain rollback instructions.
10. Obtain clinical, privacy, security, and infrastructure sign-off and attach
    the receipt to H3.
