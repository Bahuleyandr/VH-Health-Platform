# C1.2 Control-Plane and Data-Plane HA Drill

**Status:** operator runbook and evidence contract only. C1.2 repository work
performs no live drill, fault injection, Argo sync, host change, upgrade,
storage migration, or deployment.

**Companion controls:**

- [`../RKE2_1_34_QUALIFICATION.md`](../RKE2_1_34_QUALIFICATION.md)
- [`../C1_2_STORAGE_PLACEMENT_GATE.md`](../C1_2_STORAGE_PLACEMENT_GATE.md)
- [`../continuity/c1-2-control-plane-slice-design.md`](../continuity/c1-2-control-plane-slice-design.md)
- `infra/kubernetes/qa/c1-2-ha-evidence.sh`

## 1. Activation boundary and pre-sync warning

All four top-level production Argo CD Applications remain manual-sync. The
Longhorn child Application becomes manual-sync. Merging C1.2 does not run this
runbook or change a live cluster.

> **Pre-sync impact and abort gate:** Syncing this revision is an operator
> action, not a merge side effect. Syncing `vhhealth-platform` triggers a CNPG
> rolling re-schedule under required hostname anti-affinity and changes the
> Longhorn child Application to manual-sync. Syncing `vhhealth-apps` redeploys
> the backend under hard hostname spread. Expect controlled pod movement and a
> deliberately `OutOfSync` Longhorn child. Abort before either sync if the
> three live nodes do not carry the reviewed region/zone labels, RKE2 config
> disagrees with those labels, capacity cannot hold the rescheduled pods, CNPG
> quorum or synchronous replication is degraded, backend readiness or its
> disruption budget is unhealthy, or the Longhorn ownership and follow-up sync
> plan is not recorded.

Do not use a drill as the first proof of a new RKE2, CNPG, Longhorn, kernel,
firmware, CNI, or application version. Qualify the exact release set on
synthetic QA first.

## 2. Governance and qualification rule

Every drill has one named incident commander, one change owner, one database
owner, one storage owner, and one application/clinical synthetic-QA owner.
Fault injection is manual and occurs only after the commander reads the
preflight aloud and authorizes the named action.

Engineering must not invent availability, RTO, RPO, data-loss, failover,
re-election, replication, or convergence thresholds. Before the window, the
owners complete this table:

| Required owner input | Approved value or ticket | Approver | Status |
| --- | --- | --- | --- |
| Synthetic-QA availability/error threshold | OWNER INPUT — engineering must not fill | OWNER INPUT | MISSING |
| API VIP failover/convergence threshold | OWNER INPUT — engineering must not fill | OWNER INPUT | MISSING |
| etcd leader re-election/health threshold | OWNER INPUT — engineering must not fill | OWNER INPUT | MISSING |
| Backend read/write disruption threshold | OWNER INPUT — engineering must not fill | OWNER INPUT | MISSING |
| CNPG RPO and switchover/convergence threshold | OWNER INPUT — engineering must not fill | OWNER INPUT | MISSING |
| Storage degradation/rebuild threshold | OWNER INPUT — engineering must not fill | OWNER INPUT | MISSING |
| Abort authority and rollback decision owner | OWNER INPUT — engineering must not fill | OWNER INPUT | MISSING |

If any applicable value or approver is missing, the outcome is
`NOT QUALIFIED`. A repository check, successful evidence collection, or
apparently fast recovery cannot substitute for owner approval.

Only synthetic records created for the drill may be read or written by the
acceptance probes. Do not inject a fault into a production database solely to
exercise this runbook.

## 3. Existing-node label transition before sync

RKE2 `node-label` configuration is applied when a node registers. Editing
inventory does not relabel the three existing live nodes. Complete this
transition before syncing the C1.2 scheduling changes.

1. Point `KUBECONFIG` at the VIP-backed endpoint and prove it:

   ```bash
   : "${KUBECONFIG:?export the VIP-backed kubeconfig path}"
   : "${C1_2_LABEL_EVIDENCE_DIR:?export an absolute evidence directory}"
   mkdir -p -- "${C1_2_LABEL_EVIDENCE_DIR}"
   kubectl config view --minify \
     -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
   # Required: https://10.10.0.10:6443
   kubectl get --raw=/readyz
   ```

2. Capture the three current node names and labels:

   ```bash
   kubectl get nodes -o wide
   kubectl get nodes \
     -L topology.kubernetes.io/region,topology.kubernetes.io/zone \
     -o yaml \
     > "${C1_2_LABEL_EVIDENCE_DIR}/nodes-before-label-transition.yaml"
   ```

3. Obtain a facilities-approved mapping. Until rack, PDU/UPS, and switch
   evidence proves independent failure domains, use the same truthful zone for
   all three servers. Set the exact three live node names; placeholders are not
   executable values:

   ```bash
   : "${C1_2_REGION:?export the truthful region}"
   : "${C1_2_ZONE:?export the truthful zone}"
   C1_2_LIVE_NODES=(
     "${C1_2_LIVE_NODE_A:?export the first live node name}"
     "${C1_2_LIVE_NODE_B:?export the second live node name}"
     "${C1_2_LIVE_NODE_C:?export the third live node name}"
   )
   test "${#C1_2_LIVE_NODES[@]}" -eq 3
   test "$(printf '%s\n' "${C1_2_LIVE_NODES[@]}" | sort -u | wc -l)" -eq 3
   ```

4. The operator performs the explicit relabel:

   ```bash
   for node in "${C1_2_LIVE_NODES[@]}"; do
     kubectl label node "${node}" \
       "topology.kubernetes.io/region=${C1_2_REGION}" \
       "topology.kubernetes.io/zone=${C1_2_ZONE}" \
       --overwrite
   done
   ```

5. In the production Ansible inventory, set the matching non-empty
   `inventory_region` and `inventory_zone` on each of those three hosts. Render
   and check the RKE2 configuration for all three hosts, then review the diff:

   ```bash
   cd infra/ansible
   ansible-inventory -i inventories/prod.yml --list \
     > "${C1_2_LABEL_EVIDENCE_DIR}/inventory-after-label-alignment.json"
   ansible-playbook -i inventories/prod.yml playbooks/site.yml \
     --tags rke2 --check --diff --ask-vault-pass \
     2>&1 | tee "${C1_2_LABEL_EVIDENCE_DIR}/rke2-label-config-check.log"
   ```

   Abort on any unrelated change or label mismatch. In the owner-approved
   window, apply the reviewed config alignment through the same serial
   playbook:

   ```bash
   ansible-playbook -i inventories/prod.yml playbooks/site.yml \
     --tags rke2 --ask-vault-pass \
     2>&1 | tee "${C1_2_LABEL_EVIDENCE_DIR}/rke2-label-config-apply.log"
   ```

   `site.yml` processes servers one at a time. Do not replace it with a
   parallel host run or restart all servers together.

6. Capture and compare live labels with the three rendered
   `/etc/rancher/rke2/config.yaml` `node-label` entries:

   ```bash
   kubectl get nodes \
     -L topology.kubernetes.io/region,topology.kubernetes.io/zone \
     -o yaml \
     > "${C1_2_LABEL_EVIDENCE_DIR}/nodes-after-label-transition.yaml"
   ```

Abort before Argo sync if there are not exactly three expected live nodes, any
label is empty, a distinct zone lacks facilities evidence, or any live label
disagrees with its reviewed inventory/rendered config. Retain the before/after
objects, inventory revision, render receipt, and operator approval.

## 4. Read-only evidence collector

The collector records releases, node labels and readiness, VIP owner and API
endpoint, etcd membership/leader/health, workload placement, CNPG
status/replication, StorageClasses, PVs/PVCs, and Longhorn state when present.
It never drains, cordons, scales, patches, labels, restarts, deletes, switches
over, detaches storage, changes networking, or injects a fault.

Run it before injection, at each material transition, and after recovery:

```bash
: "${KUBECONFIG:?export the VIP-backed kubeconfig path}"
: "${C1_2_EVIDENCE_ROOT:?export an evidence output directory}"
export C1_2_VIP_ADDRESS=10.10.0.10
bash infra/kubernetes/qa/c1-2-ha-evidence.sh \
  "${C1_2_EVIDENCE_ROOT}"
```

The script creates a timestamped
`c1-2-ha-evidence-YYYYMMDDTHHMMSSZ` child under the supplied directory. It
requires `kubectl`, `jq`, and `ssh`: `jq` derives control-plane node/InternalIP
pairs, and SSH runs only the hard-coded read-only
`ip -o -4 address show` probe needed to identify host-network VIP ownership.
Set `C1_2_SSH_USER=<operator-user>` for derived node addresses or provide the
reviewed mapping explicitly:

```bash
export C1_2_VIP_SSH_TARGETS='cp-a=ops@10.10.0.11,cp-b=ops@10.10.0.12,cp-c=ops@10.10.0.13'
```

Optional `C1_2_VIP_PREFIX_LENGTH` defaults to `24`; `KUBECTL_CONTEXT`,
`CNPG_NAMESPACE`, and `CNPG_CLUSTER` select the reviewed target without
changing it. Use a new output parent for every phase. Preserve stdout, stderr,
exit status, UTC timestamps, exact Git revision, kubeconfig endpoint with
credentials redacted, and the collector output checksum. A collector failure
does not authorize injection; it blocks the drill until the commander
understands the missing evidence.

The collector is evidence support, not an acceptance engine. It does not
calculate or approve an RTO/RPO and it cannot claim a drill passed.

## 5. Common preflight

Do not begin fault injection until every row is complete:

| Preflight evidence | Required state | Receipt |
| --- | --- | --- |
| Commander, owners, window, rollback authority | Named and approved | |
| Owner threshold table in section 2 | Every applicable value approved | |
| Repository and rendered revision | Exact reviewed C1.2 revision | |
| RKE2/CNPG release pair | A passing qualified pair from the approved ladder | |
| VIP API and registration endpoints | `10.10.0.10:6443` ready; `:9345` reachable | |
| VIP ownership | Exactly one healthy holder; no duplicate address | |
| Nodes and topology labels | Three expected servers Ready; live/config labels agree | |
| etcd | Three expected members, one leader, no alarms, fresh pre-window snapshot | |
| CNPG | Three healthy instances, one primary, synchronous standby healthy | |
| Backup and restore | Fresh backup plus disposable restore proof retained | |
| Backend | Synthetic read/write probes healthy; readiness and PDB healthy | |
| Storage | SC/PV/PVC inventory captured; no degraded volume or disk | |
| CNI, DNS, metrics, alerts | Healthy and observable before injection | |
| Capacity | Two survivors can carry the authoritative minimum service | |
| Evidence collector | Successful `before` capture retained | |

Any failed or unknown row is an abort. Do not waive quorum, backup/restore,
synthetic-data, or owner-threshold gates inside the drill window.

## 6. Drill 1 — one server loss

**Purpose:** prove that loss of one physical server preserves etcd quorum, the
VIP-backed API path, authoritative backend service, and the two-member CNPG
quorum/synchronous-standby contract.

**Manual injection:** the commander names exactly one server and authorizes the
reviewed power, network, or service-isolation action. Automation and the
evidence collector must not perform it. Never select two members or the last
healthy member.

Expected behavior:

- etcd retains two healthy members and elects or retains one leader;
- the VIP remains on, or transfers to, exactly one locally ready server;
- backend replacements satisfy hard hostname spread where capacity allows;
- CNPG keeps two instances on distinct hostnames. A third instance remaining
  `Pending` is correct; it must not co-locate to simulate a third failure
  domain; and
- synthetic reads/writes, CNI, DNS, metrics, alerts, and storage remain within
  the approved thresholds.

| Phase | Evidence to record | Expected contract | Observed result | Status |
| --- | --- | --- | --- | --- |
| Before | Target, VIP owner, etcd leader, pod/CNPG placement, storage, synthetic baseline | Common preflight passes | | |
| During loss | VIP endpoint/owner, two etcd members, backend reads/writes, CNPG primary/standby, Pending instance, PVC state | Quorum and authoritative service remain within owner thresholds | | |
| Recovery | Rejoined member, etcd convergence, CNPG third instance, pod rebalance, storage rebuild | Full convergence before uncordon/close | | |

Abort and begin recovery on loss of etcd quorum, duplicate/no VIP owner beyond
the approved threshold, CNPG loss of its surviving standby, unexpected data
loss, unavailable synthetic service beyond threshold, or storage corruption.

## 7. Drill 2 — etcd leader and VIP-owner loss

**Purpose:** prove that a failed leader/VIP holder does not make one named
server the control-plane dependency.

Record whether the etcd leader and VIP owner are the same server. If they
differ, the commander must name which failure is being tested and may not fail
both simultaneously unless a separately approved multi-failure scenario
exists.

**Manual injection:** fail the one named current etcd leader or VIP holder
through the approved host/service action.

| Phase | Evidence to record | Expected contract | Observed result | Status |
| --- | --- | --- | --- | --- |
| Before | Exact etcd leader, VIP holder, `/readyz`, 9345, member health | One leader and one VIP holder | | |
| During loss | VIP transition timestamps, `/readyz`, 9345, new etcd leader, member alarms, kubeconfig endpoint | Same VIP resumes on one ready holder; etcd has one healthy leader | | |
| Workload proof | Backend synthetic reads/writes, CNPG replication, DNS/CNI, metrics/alerts | Within owner thresholds | | |
| Recovery | Original member rejoin, no duplicate VIP, etcd convergence | Three-member healthy state restored | | |

A bare TCP 6443 listener is not readiness evidence. Acceptance requires the VIP
path to serve Kubernetes `/readyz`; keepalived itself checks local HTTPS
`/readyz` plus TCP 9345.

## 8. Drill 3 — CNPG primary switchover

**Purpose:** prove that the database can change primary while preserving the
required-hostname placement, synchronous standby, and synthetic application
contract.

**Manual injection:** the database owner invokes the reviewed CNPG switchover
procedure for the named synthetic-QA primary. The evidence collector does not
promote or delete a pod. Do not use an unplanned pod deletion as a substitute
for the approved switchover method.

| Phase | Evidence to record | Expected contract | Observed result | Status |
| --- | --- | --- | --- | --- |
| Before | Primary, synchronous standby, LSN/lag, pod hostnames, backup/restore proof | Healthy three-instance baseline | | |
| Switchover | Request/approval, old/new primary, timeline/LSN, event timestamps | One new primary; no split brain | | |
| Application proof | Bounded synthetic writes with IDs/checksums and subsequent reads | RPO/RTO and error rate within owner thresholds | | |
| Recovery | Three instances healthy, synchronous standby restored, archive/backup health | Replication and backup chain converge | | |

Abort on ambiguous primary ownership, lost or duplicated synthetic writes,
replication outside the approved threshold, loss of the backup/archive path, or
placement that violates one-instance-per-host.

## 9. Drill 4 — one storage member loss

**Purpose:** measure the actual storage stack's response to loss of one real
member without pretending three node copies are three facility failure
domains.

Current CNPG data and WAL use `local-path`, with durability supplied by
PostgreSQL streaming replication. The repository's `longhorn` StorageClass and
Longhorn 1.7.2 target are not proof that Longhorn is active or qualified. If
there is no qualified storage member and synthetic/disposable target, record
`NOT QUALIFIED`; do not improvise a production PVC migration or disk failure.

**Manual injection:** the storage owner names one synthetic/disposable member
and performs the reviewed node, disk, Longhorn replica/engine, or network-loss
action appropriate to the proven stack. Never detach, delete, corrupt, or
reformat a production PV for this drill.

| Phase | Evidence to record | Expected contract | Observed result | Status |
| --- | --- | --- | --- | --- |
| Before | SC/PV/PVC mapping, volume/replica/engine placement, disk/SMART/capacity, checksums | Qualified healthy storage baseline | | |
| During loss | Affected member, volume robustness, attachment, replica health, I/O latency/errors, network impact | Surviving copies and service stay within owner thresholds | | |
| Data proof | Synthetic fsync/write/read/checksum and CNPG lag | No unapproved data loss or corruption | | |
| Recovery | Member rejoin/rebuild, capacity, replica convergence, final checksums | Rebuild completes inside approved threshold | | |

Longhorn three-replica state means three node copies only. Do not record
facility, rack, power, UPS, PDU, or switch isolation unless the placement gate
contains the corresponding facilities evidence.

## 10. Result record

Create one result file per drill. Do not replace missing values with estimates:

```markdown
# C1.2 HA Drill Result — <scenario> — <UTC date>

## Authority

| Field | Value |
| --- | --- |
| Incident commander | |
| Change owner | |
| Database owner | |
| Storage owner | |
| Application/synthetic-QA owner | |
| Approved window/ticket | |
| Git revision | |
| RKE2/CNPG/Longhorn release set | |
| VIP-backed API endpoint | |

## Owner thresholds

| Metric | Approved threshold | Approver/ticket | Measured | Status |
| --- | --- | --- | --- | --- |
| Availability/error rate | | | | PASS/FAIL/NOT QUALIFIED |
| VIP convergence | | | | PASS/FAIL/NOT QUALIFIED |
| etcd re-election | | | | PASS/FAIL/NOT QUALIFIED |
| Backend read/write disruption | | | | PASS/FAIL/NOT QUALIFIED |
| CNPG RPO/convergence | | | | PASS/FAIL/NOT QUALIFIED |
| Storage degradation/rebuild | | | | PASS/FAIL/NOT QUALIFIED |

## Timeline and evidence

| UTC time | Phase/action | Manual actor | Evidence directory/checksum | Observation |
| --- | --- | --- | --- | --- |
| | Before | | | |
| | Injection | | | |
| | During | | | |
| | Recovery | | | |
| | Converged | | | |

## Synthetic data proof

| Record/check | Before ID/checksum | After ID/checksum | Assessment |
| --- | --- | --- | --- |
| Synthetic write/read | | | |
| CNPG/LSN or storage checksum | | | |

## Outcome

PASS / FAIL / NOT QUALIFIED

## Findings, actions, and retained rollback point

- Finding/ticket:
- Required follow-up:
- Last qualified revision/version:
- Evidence retention location:
```

The result is `PASS` only when every applicable owner threshold and technical
contract passes. Any missing threshold/approver, incomplete evidence phase, or
unqualified storage target makes the result `NOT QUALIFIED`, even if service
appeared healthy.

## 11. Recovery, rollback, and evidence invariants

After every deliberate fault:

1. stop further injection and preserve the during-failure receipts;
2. restart or rejoin only the named failed member through the reviewed
   procedure;
3. prove VIP uniqueness and `/readyz`, etcd quorum/leader health, backend
   synthetic reads/writes, CNPG primary/synchronous-standby health, storage
   convergence, CNI, DNS, metrics, and alerts;
4. uncordon only after the authoritative health checks pass; and
5. retain before/during/after evidence, owner decisions, failed checks, and
   rollback decisions.

Repository rollback is a Git revert while the Applications remain manual-sync.
If scheduling manifests were synced, manually sync the prior pinned revision.
For RKE2, stop at the last qualified rung; a previous-minor rollback is allowed
only with the matching pre-rung etcd snapshot, binary rollback on every server,
and datastore restore. Never perform a per-node binary downgrade alone.

For a VIP rollout, restore the previous keepalived configuration serially.
Repoint operator kubeconfigs to a verified healthy per-node SAN before
withdrawing the VIP. For CNPG, use the C1.1 operator/backup rollback for the
last supported pair. C1.2 selects no storage migration, so there is no storage
cutback; Longhorn downgrade is not accepted.

Never delete the only recoverable etcd snapshot, CNPG backup, restore proof,
collector output, synthetic-data checksum, failed-drill evidence, or owner
decision record during rollback.
