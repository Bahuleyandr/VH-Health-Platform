# Redis Sentinel HA activation and recovery gate

Status: **HELD — manual operator approval and live failure evidence required**

This runbook describes the Redis 7.4 / Sentinel topology committed under
`infra/kubernetes/base/redis`. It does not authorize a production sync. The
base manifest keeps `REDIS_ALLOW_FIRST_CLUSTER_BOOTSTRAP=false`, so an empty or
quorum-less cluster refuses to invent a primary by ordinal.

## Runtime contract

- Three Redis pods and three co-located Sentinels use stable StatefulSet DNS.
- Every Redis and Sentinel container start asks all three endpoints for
  `vhhealth-primary` and requires two identical votes.
- A Redis node selected by quorum starts as primary; every other node starts
  with `replicaof` pointing at the selected primary. This runs again on a
  container-only restart, not just pod initialization.
- `min-replicas-to-write 1` stops an isolated former primary from accepting
  writes after the replica-lag window while Sentinel converges.
- Redis data-plane and Sentinel control-plane authentication use separate
  Secret keys. Backend ioredis uses the same three Sentinel endpoints with
  separate `password` and `sentinelPassword` options.
- Kustomize content-hashes the generated Redis ConfigMap and rewrites the
  StatefulSet volume reference. There is no placeholder checksum annotation.
- WebSocket Redis pub/sub remains at-most-once. Sentinel failover restores the
  connections, but messages published during reconnect are not replayed.

## First-cluster bootstrap gate

The only automatic no-quorum role is empty ordinal 0, and even that path needs
the explicit one-time `REDIS_ALLOW_FIRST_CLUSTER_BOOTSTRAP=true` override.

Before an authorized operator applies that transient override, all of these
must be recorded:

1. All three target PVCs are new and contain no RDB/AOF data.
2. Three schedulable nodes exist and the pod anti-affinity result is reviewed.
3. `redis-credentials` contains independently generated
   `redis-password` and `sentinel-password` keys.
4. The backend namespace Secret contains matching `REDIS_PASSWORD` and
   `REDIS_SENTINEL_PASSWORD` values; its non-secret ConfigMap retains all three
   Sentinel hosts and `REDIS_REQUIRE_SENTINEL=true`.
5. Production application digests, allowlists, R2, and the repository's other
   activation prerequisites have independently cleared. Redis readiness alone
   never clears the platform-wide HELD state.

The operator may then apply a reviewed transient patch setting the override to
`true` in both Redis and Sentinel containers. As soon as readiness proves one
primary, two connected replicas, and three usable Sentinels, remove the
override and confirm the rendered value is again `false`. Do not commit an
enabled base manifest.

Required bootstrap evidence:

- the rendered ConfigMap hash and StatefulSet reference;
- Sentinel `CKQUORUM` from each pod;
- the same `get-master-addr-by-name` result from at least two Sentinels;
- Redis `ROLE` / `INFO replication` showing exactly one primary and two linked
  replicas;
- one acknowledged write read back through a fresh Sentinel-discovered client;
- backend readiness plus a cross-process WebSocket fan-out probe;
- the final rendered bootstrap gate set back to `false`.

## Normal restart and failure drills

Production activation remains blocked until a disposable or staging cluster
captures all of the following. `infra/kubernetes/base/redis/test/redis-ha-harness.sh`
is deterministic contract coverage, not a substitute for these live drills.

| Drill | Pass condition |
| --- | --- |
| Current primary pod loss | Sentinels elect one replica; a fresh ioredis client writes and reads through discovery; the surviving old endpoint is not writable. |
| Former primary restart | Its generated config follows the quorum-selected primary and readiness remains false until its replica link is up. |
| Primary network partition | The isolated primary stops writes after `min-replicas-max-lag`; the majority side exposes exactly one writable primary. |
| One Sentinel loss | Two Sentinels retain quorum and all application clients continue discovery. |
| Redis credential rotation | A reviewed staged procedure preserves one writable primary, replication authentication, exporter metrics, backend discovery, and Harbor consumers. |
| Sentinel credential rotation | All three Sentinels and backend discovery move together without an unauthenticated control plane or split view. |
| Full-cluster outage | Automatic startup fails closed. An incident owner selects the authoritative AOF/RDB state and approves a one-time recovery plan before any primary is forced. |

### Credential rotation sequence

Rotate the Redis data plane and Sentinel control plane separately. The optional
`*-password-previous` keys are overlap slots; during phase 1 they temporarily
hold the candidate next credential even though the key name says `previous`.

1. **Add acceptance:** keep the active credential unchanged, place the new
   hexadecimal credential in the matching `*-password-previous` key, reseal,
   and roll the Redis StatefulSet one pod at a time. Outbound authentication
   remains old while every generated ACL accepts old and new. Prove quorum,
   replication, and one writable primary after each pod.
2. **Flip active:** move the new value to the active key and the old value to
   `*-password-previous`, then roll one pod at a time. The first restarted pod
   can authenticate to old peers because phase 1 made them accept the new value.
   After all platform pods are healthy, reseal and roll backend/Harbor consumers
   to the new data credential (or backend Sentinel credential for the control
   plane) while the old value is still accepted.
3. **Remove overlap:** delete the `*-password-previous` key, roll one pod at a
   time, and prove the old credential is rejected without logging either value.

Any failed phase stops the rotation. Do not advance both credential planes in a
single unobserved rollout, and do not use a full simultaneous restart.

## Full-cluster recovery boundary

When no two live Sentinels agree, initialized Redis and Sentinel containers
intentionally refuse to start. Do not delete marker files, clear PVCs, patch an
ordinal into primary mode, or set the first-bootstrap override against existing
data. Those shortcuts can resurrect a stale former primary.

An incident recovery plan must compare the available AOF/RDB evidence and
replication offsets, identify the authoritative dataset, state the accepted
recovery-point loss, and receive independent approval. Only then may an
operator prepare a bounded recovery patch around that selected dataset. The
recovery patch and its evidence are separate from routine GitOps activation.

## Upgrade path

The current design deliberately adds no unowned operator or chart. The next HA
upgrade should evaluate a supported Redis operator or reviewed chart with
version/digest pins, PodDisruptionBudget behavior, ACL rotation, backup/restore,
and Sentinel failover tests. Adoption is justified only when it removes the
manual full-cluster recovery boundary without weakening the quorum and
split-brain gates above.
