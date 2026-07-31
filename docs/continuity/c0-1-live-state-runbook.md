# C0.1 Live-State Evidence Collection Runbook

**Purpose:** operator-run, read-only capture of the hospital platform's actual
infrastructure state against the repository target.

**Authority:** [continuity implementation plan §2 C0.1](../superpowers/plans/2026-07-28-clinical-service-continuity.md#c01-live-state-evidence-pack)

**Proof bar:** a signed inventory whose commands and committed summary contain
no credentials or PHI, produced without a production state change.

This runbook does not ask the maintainer or CI worker to connect to a hospital
cluster. An authorized infrastructure operator runs the collector once from an
approved workstation, reviews both outputs, completes the manual checklist,
signs the integrity manifest, and returns the pack through the hospital's
approved evidence channel.

## 1. Safety boundary

The collector is read-only and enforces a command allowlist/denylist before
every live interrogation command. It does not create a debug pod, change an
object, invoke an Argo CD sync, run Ansible, inject a fault, perform a restore,
or write to R2. Its database SQL is fixed to:

- PostgreSQL version;
- installed and available extension metadata, including `vector`;
- replication state;
- the Prisma migration high-water mark; and
- aggregate RLS enable/force posture from PostgreSQL catalogs.

It never queries a clinical or application table. It never requests a
Kubernetes Secret in YAML/JSON or selects Secret `.data`. API credentials are
accepted only through environment variables, are not put in argv, and are not
written to the command ledger.

Stop if the script emits `SAFETY REFUSAL`. Do not weaken the guard during an
incident. A fact that needs a change or a broader data read remains `unknown`
and is handled later under a separately approved procedure.

## 2. Access and expected duration

Allow **8–15 minutes** for the automated pass on a healthy cluster, plus
**15–30 minutes** to inspect the reports and complete the manual checklist.
Network/API timeouts or unavailable optional systems may make the run longer,
but they do not abort the rest of the pack.

| Evidence section | Minimum access | Expected time |
|---|---|---:|
| Repository targets | Read access to this checkout at the reviewed SHA | <1 minute |
| C1.2 control plane, etcd, CNPG replication, placement, and Longhorn | `kubectl` get/list/version/config plus the existing C1.2 diagnostic exec permissions; SSH to control-plane nodes is optional for VIP ownership | 3–6 minutes |
| Running images and Argo CD revisions | Kubernetes get/list for Pods and Argo CD Applications | <1 minute |
| CNPG operator, PostgreSQL, pgvector, migration, and RLS posture | Kubernetes get/list for CNPG resources and exec into the current CNPG primary as already permitted for operational diagnostics | 1–2 minutes |
| Ingress, Services, tunnel Pods, and certificates | Kubernetes get/list for IngressClasses, Ingresses, workloads, Services, and cert-manager Certificates | 1–2 minutes |
| Cloudflare tunnel control plane | Optional read-only Cloudflare API token with tunnel-read access plus account/tunnel identifiers | <1 minute |
| Outside DNS and public TLS/SPKI | Outbound DNS to `1.1.1.1` and TCP/443 to the named endpoints | <1 minute |
| Clinical-VLAN DNS | Read/query access to the clinical-VLAN resolver named by `C0_1_INSIDE_DNS_SERVER` | <1 minute |
| Prometheus, rules, Watchdog, and Alertmanager | Kubernetes get/list for monitoring CRs and API-server service-proxy GET access to Prometheus/Alertmanager | 1–2 minutes |
| CNPG/app backups and restore evidence | Kubernetes get/list for ScheduledBackup, Backup, CronJob, Job, and Cluster resources | <1 minute |
| R2 lock/versioning | Optional bucket-scoped read-only S3 credentials allowing only bucket versioning/object-lock reads | <1 minute |
| Node time sources | Optional SSH permission to run only `chronyc tracking` and `chronyc sources -v` | <1 minute per node |
| Physical resilience, WAF/bot/rate-limit, and device clock policy | Manual owner evidence; no automated privilege is requested | Operator-dependent |

The existing
[`infra/kubernetes/qa/c1-2-ha-evidence.sh`](../../infra/kubernetes/qa/c1-2-ha-evidence.sh)
is called for every field it already owns. The C0.1 collector does not maintain
a second implementation of those probes.

The production inventory is intentionally cluster-wide. Several probes use
all-namespace queries, including running images, Ingresses, Services,
certificates, monitoring resources, and selected CNPG/backup resources, because
the hospital production cluster is dedicated to this platform. On a shared
rehearsal or test cluster, unrelated namespace, workload, image, route, and
Service metadata will therefore appear in the local pack. That is expected
test-environment divergence, not evidence that those workloads belong to VH
Health. Keep such a pack local and do not use a shared cluster's summary as a
repository evidence record.

## 3. Prepare without exposing credentials

Use a checkout whose `HEAD` is the approved repository authority. Record and
compare the SHA before running:

```bash
git fetch github main
git rev-parse HEAD
git rev-parse github/main
```

Create an evidence root outside the checkout on encrypted operator storage:

```bash
install -d -m 700 /secure/operator-artifacts/vhhealth/c0-1
```

Set only the variables needed for available optional sections. Do not use
`env`, `printenv`, shell tracing, terminal recording, or an interactive history
command after loading credentials.

```bash
export KUBECTL_CONTEXT='hospital-production'
export C0_1_DNS_NAMES='api.vhhealth.app,admin.vhhealth.app,clinical.hospital.local'
export C0_1_INSIDE_DNS_SERVER='<clinical-vlan-resolver-address>'
export C0_1_TLS_ENDPOINTS='api.vhhealth.app:443,admin.vhhealth.app:443'
export C0_1_TIME_SSH_TARGETS='node-a=ops@<node-a-address>,node-b=ops@<node-b-address>,node-c=ops@<node-c-address>'
```

For the Cloudflare control-plane read, load a read-only token without printing
it:

```bash
read -r -s -p 'Cloudflare read-only API token: ' CF_API_TOKEN
printf '\n'
export CF_API_TOKEN
export CF_ACCOUNT_ID='<account-id>'
export CF_TUNNEL_ID='<tunnel-id>'
```

For the R2 retention read, use bucket-scoped read-only S3 credentials in the
normal `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and, if applicable,
`AWS_SESSION_TOKEN` variables. The collector invokes only
`get-object-lock-configuration` and `get-bucket-versioning`:

```bash
export C0_1_R2_ENDPOINT='https://<account>.r2.cloudflarestorage.com'
export C0_1_R2_BUCKET='<production-backup-bucket>'
```

If the operator uses minisign, provide the path to the operator-held secret key.
The key and its contents are never copied into the pack:

```bash
export C0_1_MINISIGN_SECRET_KEY_FILE='/secure/operator-keys/c0-1.minisign.key'
```

Omit any unavailable optional variable. The related row will be `unknown`; the
other sections still run.

## 4. Run, in order

### Step 1 — syntax and fixture preflight

This preflight does not contact a cluster:

```bash
shellcheck infra/kubernetes/qa/c0-1-live-state-evidence.sh \
  infra/kubernetes/qa/c1-2-ha-evidence.sh
node --test infra/kubernetes/qa/c0-1-live-state-collectors.test.mjs
bash infra/kubernetes/qa/c0-1-live-state-evidence.sh \
  /secure/operator-artifacts/vhhealth/c0-1-fixture \
  --fixture infra/kubernetes/qa/fixtures/c0-1-live-state
```

Delete the fixture artifact later under the operator's normal encrypted-storage
retention procedure. Do not confuse it with live evidence.

### Step 2 — one live read-only pass

Run exactly once from the repository root:

```bash
bash infra/kubernetes/qa/c0-1-live-state-evidence.sh \
  /secure/operator-artifacts/vhhealth/c0-1
```

The final terminal lines print the newly created timestamped directory and the
paths to both reports. A missing permission/tool/token appears as an unavailable
capture and an `unknown` or `repository target` row; it is not a reason to
re-run broad commands ad hoc.

### Step 3 — complete the manual section

Open `manual-checklist.md` from the new timestamped directory. Fill every row
with the observed fact, UTC observation/test time, credential-free evidence
reference, named owner, and signature. Specifically cover:

1. UPS and generator presence, protected load, runtime, and latest transfer or
   loaded test;
2. switch redundancy and shared failure points;
3. ISP/provider/path arrangement and latest failover result;
4. each node's rack/room, power feed, UPS/PDU, switch, cooling, and physical
   zone; and
5. the live Cloudflare WAF, bot, rate-limit, exceptions, and change-review
   posture that holds C2.1 activation.

Do not export Cloudflare rule JSON if it contains cookies, tokens, client
addresses, request samples, or payloads. Record a reviewed rule identifier,
configuration version, timestamp, and owner attestation instead.

### Step 4 — inspect and sign

Review `full-report.md` locally. It may contain node addresses and topology, so
it stays in the protected operator artifact directory and is never committed.
Review `redacted-summary.md` separately. Raw IP addresses, discovered
Kubernetes node names, and conventional node-role hostnames must appear only as
stable hash-derived identifiers. Configured public DNS/TLS endpoint names,
Kubernetes namespace and workload names, image references, and certificate
subjects deliberately remain visible because they are inventory facts; the
summary is review-required, not an anonymous export.

Verify the integrity manifest:

```bash
cd /secure/operator-artifacts/vhhealth/c0-1/c0-1-live-state-<timestamp>
sha256sum --check SHA256SUMS
```

If the signing key was provided, verify the detached signature using the
approved public key:

```bash
minisign -Vm SHA256SUMS -x SHA256SUMS.minisig \
  -p /secure/operator-keys/c0-1.minisign.pub
```

Without `SHA256SUMS.minisig` and the completed owner signatures, the pack is
useful partial evidence but does **not** meet the signed C0.1 proof bar.

### Step 5 — hand back both outputs deliberately

Return the entire full directory through the approved restricted evidence
channel. Return `redacted-summary.md` separately as the only candidate for a
repository evidence record. A maintainer may copy that summary into the
reviewed continuity evidence location only after confirming:

- no raw IP/node address remains;
- no credential, Secret value, client identifier, or PHI is present;
- the repository SHA is correct;
- every state is justified by the named artifact; and
- the checksum/signature and manual-owner receipts are attached out of band.

Never commit the full directory, `captures/`, `raw/`, or
`manual-checklist.md`.

## 5. What a partial run proves

A partial pack remains useful. It proves the exact repository target, the exact
commands attempted, their UTC timestamps and exit statuses, and every
successful read-only observation. It does not convert failed probes into
absence:

- a missing binary, RBAC denial, API error, timeout, or absent optional token is
  `unknown`;
- a repository declaration with no live proof is `repository target`;
- `absent` is emitted only when a successful query explicitly returns no
  object; and
- `live verified` applies only to the fact actually returned, not to a broader
  design claim.

The operator should hand back the first safe partial pack rather than improvise
privileged commands during an incident. A targeted follow-up can close named
unknown rows later.

## 6. What this evidence unblocks

Once reviewed and signed, the C0.1 pack supplies the live comparison needed for:

- C1.1's gate that a manifest being present is not the same as live
  verification;
- C1.2's storage-placement gate, truthful physical zones, VIP, and etcd
  activation evidence;
- C2.1's live public-edge and held internal-route comparison;
- C1.3's Prometheus, rule, Alertmanager, and Watchdog reality check; and
- C6.2's backup, retention, last-success, and restore baseline for the
  warm-standby decision.

It does not itself authorize any of those changes, an Argo CD sync, a database
migration, a restore, a failover drill, or continuity activation.
