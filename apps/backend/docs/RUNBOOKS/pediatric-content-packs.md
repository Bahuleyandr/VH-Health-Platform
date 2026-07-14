# Pediatric Content Packs Runbook

NL-5 P4 ships operator-run content import paths for pediatric growth LMS data and per-tenant UIP/IAP immunisation schedules. Deploy remains held; imports run only after clinical and policy sign-off for the target tenant.

## Growth LMS Import

Use operator-supplied CSV files unless the playbook decision log explicitly clears redistribution for the source tables.

Required CSV columns:

```csv
sex,metric,age_days,l,m,s,source_version
M,weight_kg,730,0,12.2,0.13,WHO-2026
```

Run a dry run first:

```bash
cd apps/backend
node scripts/growth-lms-import.mjs --dataset WHO_0_5 --csv D:/secure-content/who-lms.csv --version WHO-2026 --dry-run
```

Then import:

```bash
node scripts/growth-lms-import.mjs --dataset WHO_0_5 --csv D:/secure-content/who-lms.csv --version WHO-2026
node scripts/growth-lms-import.mjs --dataset IAP_5_18 --csv D:/secure-content/iap-lms.csv --version IAP-2026
```

Evidence to retain:

- Source file location and checksum in the operator evidence store.
- Import batch id from `growth_lms_import_batches`.
- Source/version label used in the command.
- Confirmation that no restricted source CSV was committed to git.

## Immunisation Schedule Import

Each tenant chooses UIP-only, IAP-only, or UIP+IAP after a named clinician signs off the schedule variant. The import updates `vaccine_catalogue` only; existing `patient_immunisations` and `newborn_immunisations` due dates remain unchanged because they were computed at seed time.

**The importer is preflight-by-default.** It prints a full diff and writes nothing unless you pass `--apply`.

Preflight (the default — nothing is written):

```bash
cd apps/backend
node scripts/immunisation-schedule-import.mjs --tenant <tenant-uuid> --schedule both --version UIP-IAP-2026
```

Apply:

```bash
node scripts/immunisation-schedule-import.mjs --tenant <tenant-uuid> --schedule both --version UIP-IAP-2026 --apply
```

### ⚠️ The fork guard — read before your first import into a tenant

A tenant that has never been imported still carries the **migration-160 seed**: 29 rows, all `schedule_source='custom'`, attributed to no authority. Importing a pack on top of that seed used to **fork** the catalogue rather than replace it, because rows are matched on `(tenant_id, code, dose_number)` and the retire pass only ever saw rows whose `schedule_source` matched the incoming pack:

- migration 160 seeds **BCG with `dose_number = NULL`**; the UIP pack ships **BCG dose 1** → the probe cannot match → a **second active BCG row** is inserted.
- the UIP pack ships **PENTA**; migration 160 carries the decomposed **DPT / HEPB / HIB** components. Being `'custom'`, they were never retired and stayed active → **every newly seeded child was booked for pentavalent *and* each of its three component antigens**. Same shape for `IPV` vs `FIPV`.

The importer now enforces one invariant:

> **After a run, every ACTIVE catalogue row must belong to the incoming pack.**

Any active row left outside the pack is a **survivor**. Survivors *are* the fork. The importer **refuses to run** (exit code 3) while any exist, prints them, and requires an explicit operator disposition:

```bash
# retire the rows the incoming pack does not contain, then apply
node scripts/immunisation-schedule-import.mjs --tenant <uuid> --schedule uip --version UIP-2026 --apply --retire-survivors
```

The guard needs no antigen map to do this: `DPT`/`HEPB`/`HIB` are caught because they are active rows **absent from the incoming pack**, not because the importer knows `PENTA` contains them. **Choosing an antigen-equivalence or overlay policy is decision D6 and is not engineering's to make** — if you want two packs coexisting, that decision must be signed first.

### Update semantics

- Rows are upserted by `(tenant_id, code, dose_number)`. **`schedule_source` is not part of that key** — so a pack row can match, and silently relabel, a row that came from a different source.
- The whole run is wrapped in a **single transaction**: it commits entirely or not at all. The `immunisation_schedule_import_batches` audit row is written outside that transaction on purpose, so a failed run still leaves evidence.
- Timing changes apply only to **future** patient/newborn schedule seeds — an already-seeded dose keeps its `due_date`.
- **But**: every read surface joins the **live** catalogue row, with no version pin. So changing a row's `recommended_age_days` / `window_days` **does** retroactively change how already-seeded doses render and whether they read as overdue. The preflight diff prints the number of dose rows referencing each changing row so you can see the blast radius before you apply.
- Rows missing from a new import are marked `active=false` with `retired_at=NOW()` — **but only rows whose `schedule_source` matches the incoming pack.** Anything else is a survivor and trips the guard.
- Retired rows are never deleted, because administered doses may reference them (`ON DELETE RESTRICT`).

Clinical sign-off evidence:

- Tenant id and chosen pack: `uip`, `iap`, or `both`.
- Version label.
- Named clinician, role, sign-off timestamp, and approval note.
- Import batch id from `immunisation_schedule_import_batches`.
- **The preflight diff output**, and the survivor disposition used (`--retire-survivors`) if any — including which rows were retired.
- Any local policy exceptions, such as endemic JE applicability or vaccines not offered by the facility.
