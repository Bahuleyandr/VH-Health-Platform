# C6.2 restore-only and warm-promotion evidence

**Classification:** PHI-free continuity evidence

**Run ID:**

**Source commit:**

**Evidence object URI:**

**Evidence SHA-256:**

**Independent readback SHA-256:**

**Evidence retention/lock decision:**

## Objective measurements — two rows required

| Scenario | Target | Measured RTO | Measured RPO | Timer/recovery-point definition | Decision authority | Ratification |
| --- | --- | --- | --- | --- | --- | --- |
| Immutable-backup restore-only | Owner ratifies measured result after first timed drill | | | First restore action through passing application clinical read; source safe point minus approved PITR target | C-D1 | |
| Warm-standby end-to-end promotion | Approximately one hour to service restoration; seconds of data loss | `NOT_RUN_PHASE_2` | `NOT_RUN_PHASE_2` | Fencing through promotion, trust/secret restore, edge source transition, application/clinical validation, and traffic change | C-D9 | `NOT_RUN_PHASE_2` |

Never copy the restore-only numbers into the warm-promotion row. A long
restore-only result does not fail C-D9.

## Lock evidence

| Field | Value |
| --- | --- |
| Account/bucket/prefix | |
| Jurisdiction header/decision | |
| Rule ID and condition | |
| Effective configuration retrieval | |
| Existing-object denial | |
| New-object denial | |
| Overwrite denial | |
| Strictest-overlap result | |
| Lifecycle/removal interaction | |
| Legal approval | |
| Security approval | |
| Lock proof SHA-256 | |

Locked objects are intentionally not rollback-deletable.

## Identity-negative tests

| Principal | Positive proof | Required negative proof | Result |
| --- | --- | --- | --- |
| Backup writer | Qualified backup/WAL archive and rotation | Delete denied; lock configuration denied | |
| DR reader | List/head/get and restore | Put/multipart/delete/configuration denied | |
| Retention remover | Exact approved eligible delete | Put/overwrite/configuration denied | |
| Lock administrator | Exact lock read/update | Object read/write/delete and Kubernetes Secret access denied | |
| Evidence writer | Exact evidence put/head | Database archive and delete denied | |
| Evidence reader | Exact evidence get/head | Put/delete and database archive denied | |

## Restore input and timing

| Field | Value |
| --- | --- |
| Barman server and backup ID | |
| Base-backup time | |
| Required WAL range/LSN | |
| Approved PITR target | |
| Captured source safe point | |
| RTO start | |
| Database ready | |
| Application clinical read ready | |
| Teardown complete | |

## Proof results

| Proof | Baseline | Result/evidence | Pass |
| --- | --- | --- | --- |
| Provider retrieval/decryption | | | |
| Sampled object checksums | | | |
| PostgreSQL data checksums | `on` | | |
| Qualified PG image | | | |
| Roles/ownership checksum | | | |
| Schema checksum | | | |
| Finished migration count/checksum | | | |
| Tenant isolation/read | Approved test tenant | | |
| Active admissions | Approved census baseline | | |
| Canonical clinical timeline | Approved test patient/minimum | | |
| Clinical audit chain/read | Approved test patient/minimum plus audit verifier | | |
| Application clinical read | PHI-free expected marker | Response hash only | |

Do not place patient, encounter, staff, or tenant identifiers in this evidence;
store only approved aggregate results and salted/bounded hashes where required.

## Cleanup and acceptance

- [ ] Only created resources with matching labels and UIDs were deleted.
- [ ] Backup objects and last recoverable generation were retained.
- [ ] Lock records and evidence were retained.
- [ ] Evidence writer upload succeeded.
- [ ] Separate evidence reader produced the same SHA-256.
- [ ] Findings and aborted steps are recorded.
- [ ] C-D1 restore-only ratification is attached.
- [ ] Phase 1 acceptance is countersigned.
- [ ] Site-specific Phase 2 work remains blocked until the preceding item.

## Approvals

| Role | Name/reference | Time | Decision |
| --- | --- | --- | --- |
| Drill operator | | | |
| Backup/recovery owner | | | |
| Database owner | | | |
| Security | | | |
| Legal/privacy | | | |
| Clinical owner | | | |
| C-D1 accountable owner | | | |
