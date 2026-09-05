# Cath-lab device reuse and blood-borne marker alerts — design

- Date: 2026-09-04
- Status: approved in conversation by the platform owner; awaiting written review of this document
- Base: `main` at `f60df4e95` (highest migration 763)
- Scope owner: platform owner (clinical, pharmacy and finance intent); engineering: this spec's author
- Companion: `2026-09-04-cath-pre-procedure-lab-readiness-design.md` (consumes the marker record defined here; defines the shared lab analyte code map `apps/backend/src/services/lab/labAnalyteCodes.js` and the only entry path for outside serology values)
- Related: ledger row OPEN-12 / ballot 753-D1 in `docs/GO_LIVE_READINESS_GAP_MATRIX.md`; migrations 563–566 (cath consumables), 748/753/758 (cath inventory authority), 418 (dialyser reuse register), 421–423 (CSSD), 678 (contrast allergy screening precedent)

## 1. Problem

Indian cath labs reprocess and reuse single-use devices: diagnostic and guiding catheters, guidewires, balloons and sheaths. Stents, pacemakers, leads and closure devices are never reused. The platform has no representation of this. A cath consumable usage row binds to a pharmacy stock batch and, under migration 753, every non-terminal usage must carry a pharmacy shortfall task even when nothing left stock. A reused device therefore cannot be recorded truthfully today, and hospitals keep the reuse count in a paper register.

The owner's requirements, settled on 2026-09-04:

| Question | Owner answer |
|---|---|
| How are reprocessed devices identified today? | Not tracked. The system introduces identity. |
| Where does reprocessing happen? | In-house CSSD. |
| How is a reused device billed? | Reduced tariff. |
| Patient consent for reuse? | Hospital policy only; no patient-level step. |
| Patients with blood-borne infection (HIV, HBsAg, HCV, similar)? | Alert about reusability; devices used on them are not to be reprocessed under the default policy. |
| Blood-borne marker record | Make it reusable across the platform; OT and dialysis are future consumers. |

Goal: no separate manual reuse ledger. The system holds the device identity, the cycle count, the sterilisation outcome, the exposure history and the disposition of every use.

## 2. Decisions already taken

A structured advocate / challenger / supervisor review ran on 2026-09-04. Outcome:

- **Approach chosen: device register plus CSSD linkage, phased.** Phase 1 (this spec) ships the register, the policy tables, the return and reuse flows, the contract carve-out, reduced billing and a manual CSSD device queue. Phase 2 links devices to sterilisation loads so indicator results drive transitions automatically.
- **Rejected: a cycle number typed onto the usage row with no register.** With no register the cycle comes from memory or paper, maximum cycles cannot be enforced, and under the unchanged 753 contract every reused row still spawns a pharmacy shortfall task that must be closed with a recovery receipt. That relocates the manual ledger into the pharmacy worklist; it does not remove it.
- **Rejected: returning devices to pharmacy stock as a "reprocessed" batch.** The device loses identity, batch and expiry semantics become fiction, and the cath contract forbids return movements (748:47-48, 166, 217, 387, 574).
- **Rejected: modelling each device as a one-item instrument set.** `set_issue_log.ot_schedule_id` is `NOT NULL` with a foreign key to OT schedules (423:11, 51-52), CSSD roles exclude cath-lab roles (`routeRolePolicy.js:471-475`), and CSSD is by design non-clinical with no patient timeline (`docs/superpowers/build-prompts/nl6-13-cssd.md:15-17`). A device on a patient is clinical.
- **Refinement 1: identity is minted at return, not at first use.** First use stays exactly today's capture. The register row is created when a device is sent for reprocessing. CSSD affixes the printed tag when it releases the device; CSSD already labels sets.
- **Refinement 2: the reused path is carved out of the shortfall obligation independently of ballot 753-D1.** Reused devices are exempt whichever way the owner votes; D1 governs new units only. See §13.
- **Blood-borne markers are a platform-level patient record**, not a cath field. Cath is the first consumer; the resolver and the record are designed for OT and dialysis to consume later (§14).

## 3. Non-goals for Phase 1

- Automatic cycle increment from sterilisation loads and indicator results (Phase 2).
- Per-catalogue-item policy overrides; Phase 1 policy is per category.
- Any change to CSSD role sets, to `set_issue_log`, or to `instrument_sets`.
- OT or dialysis consumption of the marker record; dialysis enrolment keeps its own `hbsag_status` / `hcv_status` / `hiv_status` columns untouched (168:44-53).
- Patient-facing disclosure of reuse.
- Editing migrations 563, 564, 748, 753 or 758. All schema change is forward-only under a new number.
- Deciding ballot 753-D1. This spec makes the ballot narrower and states the engineering consequence of each option; the vote stays the owner's.

## 4. Architecture

```
Staff cath screen ──capture (new | reused tag)──▶ cathLabService.recordConsumableUsage
      │                                              │ new unit: existing batch path (unchanged)
      │                                              │ reused: device lookup, no stock, no task
      ├──post-use (reprocess | discard)────────────▶ cathDeviceReuseService.recordPostUse
      │                                              │ creates register rows or records disposition
      └──case payload carries reuse_restriction ◀── bloodborneMarkerService.resolveReuseStatus
                                                     ▲            ▲
Lab sign-off (HIV/HBSAG/HCV) ── hook ────────────────┘            │ manual entry (outside reports)
                                                     │
Admin CSSD board ── Devices tab ── receive / reprocessed / quarantine / discard ──▶ cathDeviceReuseService
Admin quality/cath ── Reprocessing policy tab ──▶ settings + category policies
Billing (case completion) ── picks reused code when reuse_cycle ≥ 1
Late reactive marker ── exposure handler ── quarantines in-flight devices, alerts infection control
```

New modules:

- `apps/backend/src/services/clinical/bloodborneMarkerService.js` — platform-level marker record, resolver, lab hook, exposure-handler registry.
- `apps/backend/src/services/clinical/cathDeviceReuseService.js` — register, policy reads, post-use flow, CSSD device transitions, device history. `cathLabService.js` (already 4,956 lines) calls into it rather than growing.
- One forward migration for the device register, policy tables, usage columns and the contract carve-out. Its number is computed at the moment the file is written, against `github/main` and every open branch (`git ls-remote --heads github` then `git ls-tree` on each head's `apps/backend/src/migrations`), not against `main` alone: two lanes converged on the same next number twice on 2026-09-04, which is why the check runs against every open branch, not `main` alone. Main tops at 763 at `f60df4e95`; migration **764** shipped separately as `patient_bloodborne_markers` (Plan 1, merged in PR #1000); this migration uses **765**, confirmed free at write time. The number is re-checked immediately before push.

## 5. Data model

All new tables: `tenant_id UUID NOT NULL` with the GUC default used by `cath_lab_cases` (482:5-8), `ENABLE` and `FORCE ROW LEVEL SECURITY`, and the `tenant_isolation` policy verbatim from 482:53-69. Every CHECK constraint is named explicitly so the inline-check census gate (`scripts/ci/check-inline-check-census.mjs`) reads it as declared; none of these tables is baseline-owned, so the census manifest does not change.

### 5.1 `patient_bloodborne_markers` (platform-level)

One row per recorded result. Append-only by convention (writers insert rows and perform the void transition only); the resolver reads the latest non-voided row per marker. Database-level enforcement of append-only is a deferred follow-up: it needs the merge-aware trigger pattern of migration 758 so the patient-merge sweep can still re-point `patient_uid`.

Foreign keys are tenant-pinned composites in the repository's convention for children of `users` and `lab_results`, and the two patient-bearing ones are `DEFERRABLE INITIALLY DEFERRED` because the patient-merge sweep re-points `patient_uid` under `SET CONSTRAINTS ALL DEFERRED`. Migration 764, merged in PR #1000 (Plan 1).

The table carries a role-guarded GRANT block for `vhhealth_app` and `vhhealth_runtime` (SELECT, INSERT, UPDATE; DELETE and TRUNCATE revoked; sequence USAGE and SELECT only), matching the append-only-by-convention contract above. Because the boot-time bootstrap in `src/lib/prisma.js` (`ensureTenantRlsRuntimeRoleGrants`) re-narrows the runtime role's privileges on every boot, `patient_bloodborne_markers` is registered in that bootstrap's `runtime_mutable_no_delete_relations` list and `patient_bloodborne_markers_id_seq` in its `runtime_nextval_sequences` list, so a later-provisioned runtime role still gets exactly this posture rather than the bootstrap's broad fallback grants.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| tenant_id | UUID NOT NULL | GUC default; FK `tenants(id)` ON DELETE NO ACTION |
| patient_uid | UUID NOT NULL | composite FK `(tenant_id, patient_uid)` → `users (tenant_id, uid)` ON DELETE NO ACTION, deferrable |
| marker | VARCHAR(32) NOT NULL | CHECK `patient_bloodborne_markers_marker_check`: `hiv`, `hbsag`, `hcv`, `cjd_suspected`, `other` |
| marker_label | VARCHAR(120) | required when marker = `other` (CHECK `patient_bloodborne_markers_label_check`) |
| result | VARCHAR(20) NOT NULL | CHECK `patient_bloodborne_markers_result_check`: `reactive`, `non_reactive`, `indeterminate`, `pending`. For `cjd_suspected` the CHECK `patient_bloodborne_markers_cjd_result_check` allows only `reactive` (suspected) and `non_reactive` (recorded as not suspected); because reactive rows latch (§7.3), a suspicion is withdrawn by voiding the reactive row, not by adding a `non_reactive` one. |
| tested_on | DATE NOT NULL | |
| source | VARCHAR(24) NOT NULL | CHECK `patient_bloodborne_markers_source_check`: `lab_result`, `external_report`, `clinical_declaration` |
| lab_result_id | INTEGER | composite FK `(tenant_id, lab_result_id, patient_uid)` → `lab_results (tenant_id, id, patient_uid)` ON DELETE NO ACTION, deferrable; present for `lab_result` and `external_report` rows, null for `clinical_declaration` (CHECK `patient_bloodborne_markers_lab_link_check`: `(source = 'clinical_declaration') = (lab_result_id IS NULL)`) |
| evidence | JSONB NOT NULL DEFAULT '{}' | external lab name, report number, raw `value_text` for lab rows |
| recorded_by | UUID NOT NULL | composite FK `(tenant_id, recorded_by)` → `users (tenant_id, uid)` ON DELETE NO ACTION |
| recorded_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| voided_at, voided_by, void_reason | | entered-in-error path; all three set together or none (a blank reason is rejected); `voided_by` has the same composite FK to `users`; voided rows are ignored by the resolver |
| notes | TEXT | |

Indexes: `(tenant_id, patient_uid, marker, tested_on DESC, id DESC)`; unique partial `(tenant_id, lab_result_id) WHERE lab_result_id IS NOT NULL` so the lab hook is idempotent.

### 5.2 `cath_reprocessing_settings` (one row per tenant)

Pattern: `tenant_ed_policies` (518:7-50) — tenant primary key, reviewed metadata, fail-closed read when absent.

| Column | Type | Notes |
|---|---|---|
| tenant_id | UUID PK | GUC default |
| reactive_patient_rule | VARCHAR(24) NOT NULL DEFAULT 'discard' | CHECK `cath_reprocessing_settings_reactive_rule_check`: `discard`, `override_allowed` |
| unknown_serology_rule | VARCHAR(24) NOT NULL DEFAULT 'warn' | CHECK `cath_reprocessing_settings_unknown_rule_check`: `warn`, `block_return` |
| serology_validity_days | INTEGER NOT NULL DEFAULT 90 | CHECK `cath_reprocessing_settings_validity_check`: 1..365 |
| reviewed_by, reviewed_at, updated_by, created_at, updated_at | | |

Read path returns the literal defaults (`discard`, `warn`, 90) when no row exists, mirroring `getCathConsumablesBillingSettings` (cathLabService.js:4468-4488).

### 5.3 `cath_reprocessing_category_policies`

| Column | Type | Notes |
|---|---|---|
| tenant_id | UUID NOT NULL | GUC default |
| category | VARCHAR(40) NOT NULL | CHECK `cath_reprocessing_category_policies_category_check`: the nine values of `cath_consumable_catalog_category_check` (563:34-38) |
| reprocessable | BOOLEAN NOT NULL DEFAULT false | |
| max_cycles | INTEGER | CHECK `cath_reprocessing_category_policies_max_cycles_check`: 1..50. Meaning: the maximum number of reprocessing cycles a device may undergo, so a device may be used on at most `max_cycles + 1` patients. |
| allowed_cycle_types | TEXT[] NOT NULL DEFAULT '{}' | CHECK `cath_reprocessing_category_policies_cycle_types_check`: `<@ ARRAY['steam','eto','plasma','dry_heat','chemical','other']` (the `sterilization_loads_cycle_type_check` vocabulary, 422:38-40) |
| function_check_required | BOOLEAN NOT NULL DEFAULT false | |
| updated_by, created_at, updated_at | | |

Constraints: PK `(tenant_id, category)`; CHECK `cath_reprocessing_category_policies_implant_check`: `category NOT IN ('stent','pacemaker','lead','closure_device') OR reprocessable = false`; CHECK `cath_reprocessing_category_policies_complete_check`: `reprocessable = false OR (max_cycles IS NOT NULL AND cardinality(allowed_cycle_types) >= 1)`.

Dark by default: with no rows, no category is reprocessable, the post-use action offers only "not reprocessable", and reused capture is refused.

### 5.4 `cath_reprocessable_devices` (the register)

One row per physical device. No patient identity: patient linkage lives only on usage rows, so the CSSD-facing view stays patient-blind.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| tenant_id | UUID NOT NULL | GUC default; FK `tenants(id)` |
| facility_id | INTEGER NOT NULL | from the origin case; composite FK `(tenant_id, facility_id) → facilities (tenant_id, id)` |
| catalog_item_id | BIGINT NOT NULL | composite FK `(tenant_id, catalog_item_id) → cath_consumable_catalog (tenant_id, id)` |
| device_tag | VARCHAR(24) GENERATED ALWAYS AS ('RP' \|\| lpad(id::text, GREATEST(8, length(id::text)), '0')) STORED | printed on the label and encoded in its barcode; unique index `(tenant_id, device_tag)`. **As built:** the width floor is `GREATEST(8, length(id::text))`, not a fixed 8, so `lpad` never truncates once the bigint id passes 10⁸ — `DEVICE_TAG_PATTERN = /^RP[0-9]{8,19}$/` in `cathDeviceReuseService.js`, not a fixed 8 digits, and `CATH_DEVICE_TAG_INVALID`'s message reads "device tag must look like RP00000042" as an example, not a spec. |
| origin_usage_id | BIGINT NOT NULL | composite FK `(tenant_id, origin_usage_id) → cath_case_consumable_usage (tenant_id, id)`; the first-use row |
| origin_unit_index | SMALLINT NOT NULL DEFAULT 1 | CHECK ≥ 1; UNIQUE `(origin_usage_id, origin_unit_index)` — a usage of quantity N can yield up to N devices |
| cycle_count | INTEGER NOT NULL DEFAULT 0 | CHECK `cath_reprocessable_devices_cycle_check`: ≥ 0 |
| max_cycles_snapshot | INTEGER NOT NULL | policy value at creation; CHECK `cath_reprocessable_devices_cycle_bound_check`: `cycle_count <= max_cycles_snapshot` |
| status | VARCHAR(32) NOT NULL | CHECK `cath_reprocessable_devices_status_check`: `awaiting_reprocessing`, `in_cssd`, `available`, `in_case`, `quarantined`, `discarded` |
| current_usage_id | BIGINT | composite FK `(tenant_id, current_usage_id) → cath_case_consumable_usage (tenant_id, id) ON DELETE SET NULL (current_usage_id)`; CHECK `cath_reprocessable_devices_in_case_check` is a biconditional: `(status = 'in_case') = (current_usage_id IS NOT NULL)` |
| exposure_flag | BOOLEAN NOT NULL DEFAULT false | set when the device was used on a restricted patient under `override_allowed`, or by the late-result handler |
| exposure_markers | TEXT[] NOT NULL DEFAULT '{}' | marker codes only; CHECK `cath_reprocessable_devices_exposure_check`: `exposure_flag OR cardinality(exposure_markers) = 0` |
| last_reprocessed_at, last_reprocessed_by | | |
| last_cycle_type | VARCHAR(20) | CHECK: the six cycle types |
| last_function_check | VARCHAR(16) | CHECK `cath_reprocessable_devices_function_check_check`: `not_required`, `pass`, `fail` |
| quarantine_reason, quarantined_at | | |
| discard_reason | VARCHAR(40) | CHECK `cath_reprocessable_devices_discard_reason_check`: `max_cycles_reached`, `bloodborne_exposure`, `late_reactive_marker`, `function_check_failed`, `sterilization_failed`, `damaged`, `wasted`, `policy_change`, `other`; CHECK `cath_reprocessable_devices_discarded_check`: `status <> 'discarded' OR (discard_reason IS NOT NULL AND discarded_at IS NOT NULL)` |
| discard_note, discarded_at, discarded_by | | |
| created_by, created_at, updated_at, metadata JSONB | | |

Indexes: `(tenant_id, status)`, `(tenant_id, facility_id, status)`, `(tenant_id, catalog_item_id, status)`. All foreign keys above are tenant-pinned composites; the migration adds `(tenant_id, id)` unique indexes on `cath_consumable_catalog` and `cath_case_consumable_usage` to back them.

Transitions (Phase 1). Any other transition is refused with `CATH_DEVICE_INVALID_TRANSITION`.

| From | Action | To | Side effects |
|---|---|---|---|
| — | post-use `reprocess` on a first-use row | awaiting_reprocessing | row created, cycle 0 |
| in_case | post-use `reprocess` on a reused row, cycle < max | awaiting_reprocessing | current_usage_id cleared |
| in_case | post-use `reprocess`, cycle = max | refused | only `discard` offered, reason `max_cycles_reached` |
| in_case / awaiting_reprocessing / in_cssd / available / quarantined | post-use or CSSD `discard` | discarded | reason required |
| awaiting_reprocessing | CSSD `receive` | in_cssd | |
| awaiting_reprocessing / in_cssd | CSSD `reprocessed` (cycle_type ∈ policy, function check recorded) | available | cycle_count + 1, tag printed; refused if `function_check_required` and result ≠ pass (`fail` → discarded, reason `function_check_failed`) |
| available | reused capture | in_case | current_usage_id set |
| awaiting_reprocessing / in_cssd / available | CSSD `quarantine` | quarantined | reason required |
| quarantined | CSSD `release` | awaiting_reprocessing | never straight to available; a fresh cycle is required |

**As built:** `releaseDevice` clears `quarantine_reason`/`quarantined_at` back to `NULL` on this transition (and on `reprocessed`) rather than leaving the last quarantine's reason hanging off an otherwise-clean device. A usage row pinned to a device that is currently `in_case` is undeletable in practice — usage rows are append-only and the `cath_reprocessable_devices_in_case_check` biconditional (`(status = 'in_case') = (current_usage_id IS NOT NULL)`) would refuse the FK's `ON DELETE SET NULL` — but nothing in the schema stops two usage rows from naming the same `(device_id, reuse_cycle)` pair; that uniqueness is enforced only by the service's `FOR UPDATE` lock plus the device status machine (a device can only be captured while `available`, and capture immediately flips it to `in_case`), not by a database constraint.

### 5.5 Changes to `cath_case_consumable_usage`

- `device_id BIGINT NULL` composite FK `(tenant_id, device_id) → cath_reprocessable_devices (tenant_id, id)` — set on reused rows.
- `reuse_cycle INTEGER NULL` CHECK `cath_consumable_usage_reuse_cycle_check`: ≥ 1 — the device's cycle count at capture.
- `post_use_disposition VARCHAR(32) NULL` CHECK `cath_consumable_usage_post_use_check`: `sent_for_reprocessing`, `discarded_bloodborne_exposure`, `discarded_max_cycles`, `discarded_wasted`, `discarded_other`, `not_reprocessable`.
- `reuse_screen JSONB NULL` — the serology screen result at capture (§7.4).
- `post_use_screen JSONB NULL` — the serology screen result at post-use.
- `cath_consumable_usage_inventory_status_check` dropped and re-added with `reused_device` as a seventh value (the same forward pattern 753:3683-3689 used on 564's constraint).
- New CHECK `cath_consumable_usage_reused_device_shape_check`, two biconditionals plus the no-batch/no-movement clause: `(inventory_decrement_status = 'reused_device') = (device_id IS NOT NULL)` AND `(inventory_decrement_status = 'reused_device') = (reuse_cycle IS NOT NULL)`, and reused rows have `inventory_batch_id IS NULL AND inventory_movement_id IS NULL`.
- `chk_cath_usage_exact_inventory_authority_753` dropped and re-added `NOT VALID` with a third arm: `inventory_decrement_status = 'reused_device' AND device_id IS NOT NULL AND facility_id IS NOT NULL AND inventory_item_id IS NOT NULL AND inventory_batch_id IS NULL AND inventory_movement_id IS NULL`. The added `inventory_item_id IS NOT NULL` clause is what lets the existing facility/catalogue/item FK bite on reused rows too. It stays `NOT VALID` for the same reason the original did (legacy rows); the migration header carries the violation-count query and the `VALIDATE CONSTRAINT` follow-up so it does not join the OPEN-15 backlog by default.
- `cath_authority_identity_guard_753` (the append-only/immutability trigger function) is re-declared alongside the assert-contract function so that, on `cath_case_consumable_usage`, `device_id` and `reuse_cycle` join the immutable column list once written — a change to either after insert raises the same 23514 as changing `catalog_item_id` or `quantity` today. `post_use_disposition`, `post_use_screen` and `reuse_screen` are deliberately left out of that list and stay mutable, since post-use recording writes them after the capture insert.
- **As built, one more constraint touched:** migration 765 also drops and re-adds `cath_consumable_usage_batch_expiry_check` (originally added by migration 564) with an extra disjunct, `OR inventory_decrement_status = 'reused_device'` — otherwise batch-tracked catalogue items (most catheters, balloons, sheaths) could never take the `reused_device` path, since 564's check demands batch/expiry fields whenever the catalogue item is batch-tracked and a reused row deliberately carries neither (the lineage lives on the origin usage row, not the reused one).

### 5.6 Change to `cath_consumable_catalog`

- `reused_billing_item_code VARCHAR(50) NULL` — service-master code for the reprocessed tariff.

## 6. Flows

### 6.1 First use (unchanged)

`recordConsumableUsage` behaves exactly as today for a new unit: catalogue and facility authority checks, batch lineage, `pending` status, shortfall workflow materialised (cathLabService.js:4439-4448), pharmacist reconciliation later. Two additions only: the case payload and the capture response carry `reuse_restriction` (§7.3), and the row stores `reuse_screen`.

### 6.2 Reused capture

Request adds `reused_device_tag`. It is mutually exclusive with `inventory_batch_id`, `batch_number`, `lot_number`, `expiry_date` and `serial_number`; sending both is `CATH_CONSUMABLE_REUSE_FIELDS_CONFLICT`.

Inside the existing tenant transaction, after the case lock (cathLabService.js:4079-4081):

1. Resolve the device by `(tenant_id, device_tag)` `FOR UPDATE`. Missing → `CATH_DEVICE_NOT_FOUND`.
2. Device `catalog_item_id` must equal the request's catalogue item → else `CATH_DEVICE_CATALOG_MISMATCH`. Device `facility_id` must equal the case facility → else `CATH_DEVICE_FACILITY_MISMATCH`.
3. Category policy must be reprocessable → else `CATH_REPROCESSING_NOT_ALLOWED` (policy withdrawn after the device was made).
4. Device status must be `available` → else `CATH_DEVICE_NOT_AVAILABLE` with the current status.
5. Exposure: if `exposure_flag` and the tenant rule is `discard` → `CATH_DEVICE_EXPOSURE_BLOCKED`; if `override_allowed` → the request must carry `exposure_acknowledgement.reason`, recorded in `metadata` and as a safety review (§7.5).
6. Quantity must be exactly 1.
7. Write the usage row with `inventory_decrement_status = 'reused_device'`, `device_id`, `reuse_cycle = device.cycle_count`, `inventory_warning = NULL`, `reuse_screen`. `facility_id`, `inventory_item_id` and `catalog_item_id` are set from the case and the catalogue row exactly as for a new-unit capture — required by the third arm of `chk_cath_usage_exact_inventory_authority_753` (§5.5) — and `quantity = 1` per step 6. No stock movement. `materializeCathInventoryShortfallTx` is not called. Timeline and audit events are emitted as for any usage, with `timeline_event_id`/`audit_event_id` carried on the row and the device tag and cycle in their payload.
8. Device → `in_case`, `current_usage_id = usage.id`.

The pharmacy reconciliation listings and the recovery worklist exclude `reused_device` rows; they never appear in a pharmacist's queue.

**As built:**
- Idempotency replay is answered **before** the device is locked — the same shape as a new-unit capture's replay — so a retried request with the same key never re-enters the transition machinery at all, whether the device is available or not.
- `wasted: true` on a reused capture (§6.5) discards the device via `markDeviceWastedTx` (reason `wasted`, usage `post_use_disposition = 'discarded_wasted'`); if the capture also ran under `override_allowed` with an acknowledgement, the `EXPOSED_DEVICE_REUSED` safety review (§7.5) is still written even though the device never returns to service.
- The `serology_validity_days` used by the first-use `reuse_screen` and by `getCase.reuse_restriction` is the tenant's own `cath_reprocessing_settings` value (default 90), not a hardcoded window.
- `positiveInt` — the guard on every bigint row id, the facility filter and bounded policy fields — accepts decimal digits only (`^[0-9]+$` after trimming); it rejects `'7e2'`, `'0x10'`, `'+7'` and `'7.0'`, each of which `Number(value)` alone would silently accept as a different value than the caller typed.

### 6.3 Post-use (the return tap)

`POST /api/v1/cath-lab/cases/:caseId/consumables/:usageId/post-use`, idempotency scope `cath_consumable_post_use`. Body: `{ disposition: 'reprocess' | 'discard', units?, discard_reason?, discard_note?, acknowledgement?: { reason } }`.

The server computes the allowed dispositions and returns them with the case's consumables listing so the Staff panel renders only what is permitted:

1. Usage must belong to the case and not be `wasted`; the catalogue item must not be an implant; the category policy must be reprocessable. Otherwise the only disposition is `not_reprocessable`, which the panel does not offer as a button; the row simply carries no reuse action.
2. Serology screen (§7.3) at this moment, stored as `post_use_screen`:
   - `restricted` and rule `discard` → only `discard` with reason `bloodborne_exposure`.
   - `restricted` and rule `override_allowed` → `reprocess` permitted with `acknowledgement.reason`; the created or returned device gets `exposure_flag = true` and the marker codes.
   - `unknown` and rule `warn` → `reprocess` permitted with `acknowledgement.reason`.
   - `unknown` and rule `block_return` → `reprocess` refused (`CATH_REPROCESSING_SEROLOGY_REQUIRED`) until a marker row exists; `discard` permitted.
   - `clear` → `reprocess` permitted.
3. First-use rows: `units` defaults to the row quantity and must be an integer ≤ quantity. One register row per unit, cycle 0, `max_cycles_snapshot` from policy, status `awaiting_reprocessing`. Units not sent are recorded in `metadata.units_not_reprocessed`.
4. Reused rows: the device moves per the transition table. At `cycle_count = max_cycles_snapshot` the only disposition is `discard`, reason `max_cycles_reached`.
5. The usage row's `post_use_disposition` is set. Idempotent replays return the original result.

**As built:**
- `computePostUseOptions` checks the **device's own** exposure flag before the current patient's serology: a device the late-reactive sweep (§6.6) flagged from a *previous* patient returns discard-only (reason `bloodborne_exposure`, reason code `device_exposure_flagged`) under the `discard` rule even when the current patient's own screen is clear — the device's history, not the case in front of it, decides.
- If the device was already `discarded` — CSSD can discard a device while it sits `in_case`, even though this Admin console does not offer that action (§6.4) — the post-use call still returns HTTP 200 and settles the usage as `discarded_other` or `discarded_bloodborne_exposure` with `device_already_discarded: true` in the response and in the recorded metadata; the Staff panel renders an amber notice rather than an error.
- First-use rows: units not sent are recorded in `metadata.units_not_reprocessed` only when `units < quantity`; `units` is capped at `CATH_DEVICE_UNITS_CAP` = 50 regardless of the row's quantity.
- `upsertCategoryPolicies` (the settings/policies PUT, §9.5) rejects a payload with more than nine entries or a repeated category with `CATH_REPROCESSING_POLICY_DUPLICATE` (nine is the count of `cath_consumable_catalog_category_check` values, §5.3).
- `markDeviceReprocessed` checks the reprocessed-transition's `from` list **before** any of its own branching — including before the fail-discard shortcut — so a function-check failure submitted against a device that is `in_case`, `available`, `quarantined` or `discarded` 409s as `CATH_DEVICE_INVALID_TRANSITION` naming the actual state, instead of being silently discarded by the wider `from` list a plain `discard` call would accept.
- Cycle-type validation is two failures, not one: `CSSD_DEVICE_CYCLE_TYPE_INVALID` (400) for a value outside the six-type vocabulary, `CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED` (409, carries the allowed list) for a known type the category policy does not permit.
- `releaseDevice` clears `quarantine_reason` and `quarantined_at` back to `NULL` on the `quarantined → awaiting_reprocessing` transition (§5.4).
- The `discarded_check`, the `in_case_check` biconditional and the `exposure_check` are exactly as declared in §5.4 — no additional shape constraints were added at this layer.
- Every device transition's audit-row `metadata` carries `idempotency_key` (the request's idempotency key, or `null` for the system actor in §6.6) alongside `device_tag`, `from`, `to` and the reason fields.

### 6.4 CSSD device queue

Admin CSSD board gains a **Devices** tab backed by the CSSD endpoints (§9.3). Each row shows tag, catalogue item, facility, cycle `k of max`, status, exposure flag, time in queue. Actions: receive, reprocessed (choose cycle type from the category's allowed list; record function check when required), quarantine, release, discard. Reprocessed prints the label (tag as text and barcode) through the browser print path the board already uses for load reports. No patient data is present in any payload on this router.

**As built, several narrowings from the paragraph above:**
- The `/devices` sub-tree of `/api/v1/cssd` is gated by `CSSD_DEVICE_ROUTE_ROLES`, an intersection of `CSSD_ROUTE_ROLES` with `SUPER_ADMIN, ADMIN, NURSING_STAFF, OT_NURSE, OT_INCHARGE, OT_STAFF, QUALITY_OFFICER, INFECTION_CONTROL_OFFICER` — narrower than the CSSD mount at large. There is no `CSSD_*` role in the policy graph; `OT_STAFF`/`OT_NURSE`/`OT_INCHARGE` **are** the CSSD hands here. HR, DPO, compliance, pharmacy and stores roles that can reach the rest of `/api/v1/cssd` are excluded from the device sub-tree; cath-lab roles were never on it (§6.2/§6.3 are how a cath role hands a device to CSSD and takes it back).
- The Devices tab does not offer a Discard action for a device in `in_case`, even though the service's transition table (§5.4) allows CSSD to discard from that state: a device in a case is settled by the cath lab's own post-use tap, and a console-side discard behind the lab's back would strand that usage row and lose the reason the device left the case. `in_case` and `discarded` both render with no action buttons.
- **Follow-up 1, now built:** the cycle-type picker offers only the category policy's `allowed_cycle_types`, read from the same query cache the quality console's policy editor writes (`CATH_REPROCESSING_POLICIES_QUERY_KEY`), and the Reprocess action is disabled with an inline reason naming the category ("No reprocessing policy allows <category>") plus a link to the policy tab when the policy allows nothing — which is also what an unread or failed policy read produces, since undecidable is not the same as permitted. The backend refusals stay the authority: the policy can be rewritten under an open dialog, and `CATH_REPROCESSING_NOT_ALLOWED` / `CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED` (409, carrying the allowed list) still surface there.
- **Follow-up 2, now built:** `GET /api/v1/cssd/devices/{id}/label` on the same `/devices` sub-tree and the same `CSSD_DEVICE_ROUTE_ROLES` gate. It answers a 100 × 50 mm PDF by default (pdfkit, with the tag in large monospace and as a Code 39 barcode drawn from `utils/barcode/code39.js` — the same symbology the instrument-set label already prints, and no new dependency), and the same seven fields as JSON on `?format=json`. It is a READ: no idempotency claim, since a reprint is not a second event. It writes one `cssd.device.label_printed` audit row and NO PHI access row, because the label carries no patient subject: `DEVICE_LABEL_FIELDS` is device identity only, and `exposure_flag` / `exposure_markers` are deliberately not on it — a printed label leaves the department stuck to the device with no role gate in front of it, so a marker on it would be a serology disclosure to everyone who handles the tray. The Devices tab opens it through the portal proxy (`window.open`), which is what gives CSSD the browser's own print dialog.
- The row set as built has no facility column and no time-in-queue column; the table shows tag, device (catalogue item), cycle, status, exposure and an "Updated" timestamp only (§18).

### 6.5 Wasted reused device

Capturing a reused device with `wasted = true` records the usage as today (waste reason required) and moves the device straight to `discarded`, reason `wasted`. Billing treats it as wastage (`wastage_review_required`), unchanged.

### 6.6 Late reactive result

When a marker row with `result = 'reactive'` (or `cjd_suspected`) is recorded for a patient by any writer, the marker service invokes the registered exposure handlers. The cath handler:

1. Selects devices whose origin or reused usage rows belong to that patient with `used_at ≥ tested_on − serology_validity_days` (all uses for `cjd_suspected`), status not `discarded`.
2. Moves each to `quarantined` (or leaves `in_case` devices flagged and quarantines them at post-use), sets `exposure_flag` and appends the marker code.
3. Writes a `cds_alerts` row for the patient (`alert_type = 'bloodborne_reuse_exposure'`, `severity = 'high'`, description naming the device tags) and a notification through the existing outbox to `INFECTION_CONTROL_OFFICER` recipients, following the `cath_inventory_shortfall` notification shape.

This is what makes "unknown serology means warn" safe for emergency cases that proceed with serology pending.

**As built, the sweep's resilience contract:** candidates are read once (ordered by device id, for a reproducible partial-failure list), then each device is quarantined in its **own** transaction rather than one transaction for the whole set — a lock timeout or a status race on one device must not roll back the nine that already succeeded. A device already `discarded` under the lock is skipped (re-checked at lock time, not only in the candidate read, since CSSD may have discarded it in the interim); a device already `in_case` or `quarantined` gets the exposure flag stamped without attempting the transition. Failures are collected as `{ device_id, error }` and returned/logged rather than raised, and the window boundary is computed at Asia/Kolkata midnight (`AT TIME ZONE 'Asia/Kolkata'`) so the boundary does not drift 5h30m against the server's UTC session zone. The `cds_alerts` row and outbox notification are still raised for whatever subset of devices did settle, even when others in the same sweep failed — a partial sweep infection control never hears about is the failure mode this guards against. Separately, `facilityService.js`'s facility-shutdown blocker query now counts `reused_device` as a reconciled terminal state alongside `decremented` and `not_applicable` (§8), matching the migration note that a reused row can never reach `decremented`.

## 7. Blood-borne marker record

### 7.1 Writers

- **Lab sign-off hook.** `recordMarkersFromSignedResults({ tenantId, resultIds, decision, actorUid })`, called from `signOffResults` (labResultsService.js:2076) after the sign-off commit, is a **content-aware upsert, not decision-driven**. For each result whose `test_code` or `loinc_code` matches the `hiv`, `hbsag` or `hcv` row of the shared analyte code map (companion spec §5) and whose decision is one of `SIGN_OFF_DECISIONS = ['verified', 'corrected', 'amended']`, it runs — inside one tenant transaction and under `pg_advisory_xact_lock(hashtextextended('<tenant>:bloodborne-marker:<id>', 0))` — a read-compare-write over that lab result's active marker row (locked `FOR UPDATE`): inserts if none exists; skips if the existing row already has the same `result` and `tested_on`; otherwise voids it (`void_reason = 'lab_result_corrected'`) and inserts the new one. So a sign-off announced as `verified` over a changed value still corrects the record, and one announced as `corrected` over an unchanged value writes nothing; `decision` is validated but stored only in `evidence.decision`, never used to decide whether to void. Return shape `{ recorded, voided, skipped, failed }`: `skipped` lists lab_result_ids whose active row already said exactly this; `failed` lists `{ lab_result_id, reason }` for candidates rejected before any SQL was issued for them (a future-dated or unreadable `performed_at`/`received_at`), logged at warn — but only for `non_reactive`, `pending` and `indeterminate` values. A **reactive** value with a bad date is never dropped this way: the writer instead clamps `tested_on` to today's Asia/Kolkata date, records `evidence.tested_on_clamped = true` plus `evidence.tested_on_raw` (the raw timestamp, or `null` if unreadable) and `evidence.tested_on_problem` (the rejection reason), logs at warn, and proceeds with the normal upsert — so a skewed analyzer clock can never leave a reactive patient reading `clear`. The reconciliation sweep (§18) must apply the same clamp-don't-drop rule when it re-drives a miss. A database error is all-or-nothing for the whole batch. Exposure handlers fire after commit for reactive **inserted** rows only; a void or correction emits no retraction event by design — the intended consumers resolve pull-style through `resolveReuseStatus`, so a lifted restriction is seen on their next read rather than pushed at them. Voiding frees the lab-linked unique slot, so a later replay of a batch whose row was voided and superseded re-inserts (intended: the live row is whatever the lab result currently says). The hook call in `signOffResults` runs post-commit guarded by `SIGN_OFF_DECISIONS`, wrapped in try/catch with a structured warn log (tenant, sign-off id, result ids, decision, error code); a miss is **not** repaired by retrying the same HTTP request (idempotency replays the stored response) — a corrective sign-off or a reconciliation sweep (§18) re-drives the recorder. Codes are the platform catalogue codes seeded in 102:183-201; LOINC mapping is inert (721:14-19) and is not consulted.
- **Outside reports, via the cath checklist only.** By owner decision, outside serology values are entered from the cath pre-procedure lab checklist (companion spec §8.2) and nowhere else. That path stores the value as an external-origin `lab_results` row and the marker hook then creates the marker row with `source = 'external_report'` and the `lab_result_id` link, with the external lab's name and report date in `evidence`. The cath case screen's restriction strip ("Record outside serology") opens that same checklist sheet.
- **Clinical declaration.** A documented status with no report to hand (for example a patient on antiretroviral therapy with no recent report) is recorded from the same checklist sheet as `clinical_declaration`, marker and result only, no `lab_results` row.

### 7.2 Value normaliser (lab rows)

Applied to `value_text` after trimming and lower-casing; `value_numeric` is never consulted for these tests.

| Tokens | Result |
|---|---|
| `reactive`, `positive`, `detected`, `weakly reactive` | `reactive` |
| `non-reactive`, `nonreactive`, `non reactive`, `negative`, `not detected` | `non_reactive` |
| `indeterminate`, `equivocal`, `borderline`, `grey zone`, `gray zone` | `indeterminate` |
| `pending`, `awaited`, empty | `pending` |
| anything else | `indeterminate` (never silently `non_reactive`) |

Precedence (as reviewed on 2026-09-04): empty → `pending`; any indeterminate token → `indeterminate`; a negative token present → `indeterminate` if a positive token survives once the negative phrases are removed ("reactive, not detected on repeat"), else `pending` if a pending token is present ("not detected, repeat pending"), else `non_reactive`; a positive token present → `reactive`, even alongside a pending token ("reactive, confirmation pending" is a reactive screen); a pending token alone → `pending`; anything else → `indeterminate`. Every mixed case resolves toward the restrictive side, because a false `non_reactive` is the one input that manufactures an unearned `clear`.

### 7.3 Resolver

`resolveReuseStatus({ tenantId, patientUid, validityDays, asOf = now })` returns:

```json
{
  "status": "restricted | unknown | clear",
  "markers": [{ "marker": "hbsag", "label": null, "result": "reactive", "tested_on": "2026-08-12", "source": "lab_result", "age_days": 23, "within_window": true }],
  "reasons": ["HBsAg reactive 2026-08-12"],
  "validity_days": 90,
  "evaluated_at": "2026-09-04T10:15:00Z"
}
```

Rules (as reviewed on 2026-09-04):

1. **A reactive row latches.** Any non-voided row with result `reactive`, for any marker, of any age, → `restricted`, even when a later non-voided row for the same marker is `non_reactive`. Antibody markers (HIV, anti-HCV) do not revert, and for device reprocessing "ever reactive" is the safe reading of HBsAg too. Only voiding the row (entered in error) clears it. `cjd_suspected` follows the same rule: a suspicion is withdrawn by voiding, not by a later `non_reactive` row.
2. Otherwise, the latest non-voided row per core marker decides: if `hiv`, `hbsag` and `hcv` each have a `non_reactive` latest row within `validity_days` → `clear`.
3. Otherwise → `unknown`, with one reason per core marker that is missing, `pending`, `indeterminate`, undated, uninterpretable, or older than the window (the reason names the window and the result date). `unknown` always carries at least one reason.
4. Ages are Asia/Kolkata calendar days. A result dated in the future is unusable evidence: it counts as `unknown` with a reason naming the date (a future-dated reactive still latches). A `validity_days` outside 1–365 falls back to 90. The value normaliser's precedence is given in §7.2.

`reasons` lists what produced the status, in the order checked, and is what the Staff strip prints.

The general writer `recordMarkers({ tenantId, patientUid, entries, actorUid })` (used by the companion checklist's external-report and clinical-declaration paths, §7.1) validates `patientUid` and `actorUid` before opening its transaction and returns `{ recorded, skipped }`, where `skipped` lists the lab_result_ids of `external_report` entries whose lab-linked slot was already occupied by an active row — the only entries that can lose the unique-index race, since a clinical declaration always inserts. `marker_label` is honoured only when `marker = 'other'` (required, ≤120 characters, else `BLOODBORNE_MARKER_INVALID`); for a named marker any label sent is ignored rather than stored. `lab_result_id`, when present, must be a positive `int4`. `listMarkersForPatient({ tenantId, patientUid, validityDays, includeVoided, asOf, db })` shares its `asOf`/`db` parameters with `resolveReuseStatus`, so both can be evaluated as of a caller-supplied instant or against a caller's transaction. `voidMarker` scopes both its `FOR UPDATE` lock and its `UPDATE` by tenant **and** patient, so a marker id that resolves to another patient's row 404s rather than voiding across patients.

### 7.4 Evidence freezing

The capture path stores the resolver output as `reuse_screen`; the post-use path stores it as `post_use_screen`. These are immutable evidence of what was known when the decision was made, on the pattern of `contrast_allergy_screen` (678:23-38). A later result changes the device's status through §6.6, never the historical rows.

### 7.5 Overrides

Every `acknowledgement.reason` (exposure at capture, restricted or unknown at post-use) is written to `medication_safety_reviews` (269:188-210) with `review_type = 'cath_device_reuse'`, `finding_code` one of `BLOODBORNE_RESTRICTED_OVERRIDE`, `SEROLOGY_UNKNOWN_ACKNOWLEDGED`, `EXPOSED_DEVICE_REUSED`, `override_required = true` and the actor, so it lands on the clinical timeline like other safety overrides.

## 8. The contract migration

One forward migration re-declares `cath_inventory_authority_assert_contract_753` exactly as migration 758 re-declared it (758:4042-4363), adding one branch immediately after the `not_applicable` early return (753:4371-4422) and before the shortfall-triple assertion (753:4523-4569). The branch below is normative — every arm is a hard requirement the constraint enforces, not a sketch of intent:

```sql
IF usage_record.inventory_decrement_status = 'reused_device' THEN
  IF usage_record.device_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.cath_reprocessable_devices d
        WHERE d.id = usage_record.device_id
          AND d.tenant_id = usage_record.tenant_id
          AND d.catalog_item_id = usage_record.catalog_item_id
          AND d.facility_id = usage_record.facility_id
     )
  THEN
    RAISE EXCEPTION 'Reused device usage does not reference a device of this tenant, catalogue item and facility'
      USING ERRCODE = '23514';
  END IF;
  IF usage_record.reuse_cycle IS NULL
     OR usage_record.quantity <> 1
     OR usage_record.timeline_event_id IS NULL
     OR usage_record.audit_event_id IS NULL
     OR usage_record.inventory_batch_id IS NOT NULL
     OR usage_record.inventory_movement_id IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.pharmacy_stock_movements movement
        WHERE movement.tenant_id = usage_record.tenant_id
          AND (
            (movement.reference_type = 'cath_consumable_usage'
             AND movement.reference_id = usage_record.id::text)
            OR (movement.reference_type = 'cath_consumable_reconciliation'
             AND movement.metadata->>'cath_consumable_usage_id' = usage_record.id::text)
          )
     )
     OR EXISTS (
       SELECT 1 FROM public.tasks task
        WHERE task.tenant_id = usage_record.tenant_id
          AND task.related_resource_type = 'cath_case_consumable_usage'
          AND task.related_resource_id = usage_record.id::text
          AND task.metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
     )
     OR EXISTS (
       SELECT 1 FROM public.workflow_sla_instances sla
        WHERE sla.tenant_id = usage_record.tenant_id
          AND sla.rule_code = 'cath_consumable_inventory_reconciliation'
          AND sla.source_table = 'cath_case_consumable_usage'
          AND sla.source_id = usage_record.id::text
     )
     OR EXISTS (
       SELECT 1 FROM public.notification_outbox outbox
        WHERE outbox.tenant_id = usage_record.tenant_id
          AND outbox.type = 'cath_inventory_shortfall'
          AND outbox.source_event_key = 'cath-inventory-shortfall:' || usage_record.id::text
     )
  THEN
    RAISE EXCEPTION 'Reused device usage carries inventory, shortfall or provenance artefacts it must not'
      USING ERRCODE = '23514';
  END IF;
  RETURN;
END IF;
```

The arms are, normatively: (a) **device identity** — the referenced device must belong to the same tenant, the same catalogue item and the same facility as the usage row; (b) **no artefacts** — no stock movement or batch linkage, no `pharmacy_stock_movements` row under either reference shape 758 uses (`cath_consumable_usage` referenced by `reference_id`, or `cath_consumable_reconciliation` referenced by `metadata->>'cath_consumable_usage_id'`), no `tasks` shortfall row (`related_resource_type = 'cath_case_consumable_usage'`, `metadata->>'task_contract' = 'cath_inventory_shortfall_v1'`), no `workflow_sla_instances` row (`rule_code = 'cath_consumable_inventory_reconciliation'`), no `notification_outbox` row (`type = 'cath_inventory_shortfall'`, `source_event_key = 'cath-inventory-shortfall:<id>'`); (c) **provenance** — `quantity = 1` and both `timeline_event_id` and `audit_event_id` non-null, the same clinical-event evidence a new-unit row must carry. Two distinct `23514` messages separate the failure modes, so a violation on a reused row names which half of the guarantee broke: device identity (arm a) versus artefacts and provenance (arms b and c).

The exact movement, task, SLA and outbox reference predicates are copied from the existing triple assertion in 753 at plan time rather than retyped; column names are pinned to the 758 text, not to this sketch. Every other branch is byte-identical to 758. The dispatcher `cath_inventory_authority_constraint_753` is not touched. `cath_authority_identity_guard_753` is re-declared alongside the assert-contract function, on the same forward pattern, so that `device_id` and `reuse_cycle` join the immutable-column list for `cath_case_consumable_usage` once written (§5.5). The body avoids `CASE` inside `IF` (the 42601 trap recorded in the plpgsql gate note) and passes the repository's plpgsql body gate.

Migration 753's original triple assertion let the pharmacy shortfall worklist (task, SLA, outbox) stand as the durable proof that a use was accounted for. A reused row has no such worklist — the device register row is the accounting instead, and the database now asserts exact provenance for reused rows directly, through arms (a)–(c) above, rather than leaving that guarantee to `cathDeviceReuseService.js` alone: it is no longer service-only.

Because a `reused_device` row never carries the shortfall task/SLA/outbox triple, `facilityService.js`'s facility-shutdown blocker query (`unreconciled_cath_usage`, ~line 244: `usage.inventory_decrement_status NOT IN ('decremented', 'not_applicable')`) must add `'reused_device'` to that list — otherwise every reused capture reads as an open reconciliation blocker forever, since it can never reach `decremented`. Plan 2 Task 3 owns that edit.

The migration header states: reused devices are exempt from the shortfall obligation independently of ballot 753-D1; and carries the violation count and `VALIDATE CONSTRAINT` plan for the re-added `chk_cath_usage_exact_inventory_authority_753`.

## 9. APIs

All mutations require an idempotency key. Money and stock are untouched by every endpoint below except billing emission, which is unchanged in mechanism.

### 9.1 Cath (`/api/v1/cath-lab`, `CATH_LAB_ROUTE_ROLES`, PHI-logged by the mount at app.js:2008)

| Method and path | Purpose |
|---|---|
| `POST /cases/:id/consumables` | existing; accepts `reused_device_tag`, `exposure_acknowledgement` |
| `GET /cases/:id/consumables` | existing; each row gains `device_tag`, `reuse_cycle`, `post_use_disposition`, `allowed_post_use` |
| `GET /cases/:id` | existing; payload gains `reuse_restriction` (resolver output) and `reprocessing_policy_summary` |
| `POST /cases/:id/consumables/:usageId/post-use` | §6.3 |
| `GET /devices/lookup?case_id=&tag=` | device state for the capture sheet, case-pinned; `exposure_markers` blanked for RECEPTIONIST/TECHNICIAN (§6.2 as-built) |
| `GET /devices/:deviceId/history` | uses (case, patient_uid, used_at, cycle) and transitions; PHI |

**As built:** `GET /devices/:deviceId/history` is gated by `requireCathWorkflow`, not `requireReportRead` — reading who a device has touched is treated as a workflow action, not a report read. The same handler function is also registered at `GET /api/v1/cath-reprocessing/devices/:deviceId/history` (§9.5) so infection control can open a device's history without holding a cath-lab workflow role. Because the response lists every patient a device has touched, it is PHI with no single patient subject: neither mount's `phiAccessLogger` can resolve a patient from the request (the cath mount's logger would record `patient_id = NULL`; the governance mount carries no PHI logger at all). The handler instead writes its own `hipaa_access_log` trail explicitly, before responding — one row per **distinct** patient in the answer, `record_type = 'CATH_LAB'`, `action = 'VIEW'`, in batches of 25, with `request_id` set to `"<incoming request id, truncated to fit> cath_device:<device id>"` (the table has no resource column, so the device token rides in the one free-text correlation field, and it is always kept in full — an oversized incoming `X-Request-Id` header is truncated instead). `GET /cases/:id` and `GET /cases/:id/consumables` both project `reuse_restriction` by role through `projectReuseRestrictionForRole`/`roleSeesSerologyDetail` (§9.2 as-built) before returning it.

### 9.2 Blood-borne markers (`/api/v1/bloodborne-markers`)

Mounted in `app.js` mirroring allergies (app.js:1639): `requireRole(...CLINICAL_STAFF_ROLES)`, `sanitizeAllBodyStrings`, `patientAccessGuard('BLOODBORNE_MARKERS', { careTeamModeGoverned: true })`, `phiAccessLogger('BLOODBORNE_MARKERS')`.

| Method and path | Purpose |
|---|---|
| `GET /patient/:patientUid` | rows plus resolver output for a supplied or default window |
| `POST /:id/void` | entered in error (`void_reason` required) |

There is no general create endpoint on this router. Marker rows are created by the lab sign-off hook and by the cath checklist's external-result and clinical-declaration paths (companion spec §8.2), which call the marker service directly. Future consumers (OT, dialysis) add their own entry paths through the service, not through a public write route.

Voiding a lab-linked row through `POST /:id/void` does not retract the lab result. As §7.1 notes, the lab-linked slot it frees is re-filled: the next sign-off event or reconciliation run (§18) for that result re-inserts a row from the result's current content, because the writer treats the lab result as the source of truth. The durable way to retract a lab-linked marker finding is to correct the lab result itself, not to void the marker row.

Implementation detail beyond the table: `validity_days` is parsed digits-only and must be an integer 1–365, else 400; a repeated query key (which Express arrays into `"30,90"`) is rejected by the same digits-only test. The record type `BLOODBORNE_MARKERS` is registered in `config/careTeamGovernedRecordTypes.js` and mapped to `PATIENT_CLINICAL_WORKFLOW_ACCESS` in `services/security/accessPolicyRegistry.js`. The mount is listed in the mount-level patient-guard census exemptions (`mountLevelPatientGuardCensus.test.js`) as a param-only router that already carries its own in-router `guardMarkerAccess` guard — the mount guard runs before Express has matched a route and cannot see `:patientUid` — the same treatment as `/api/v1/allergies`. The OpenAPI contract (`scripts/openapi/schemas/bloodborneMarkers.mjs`, synced to `packages/vhhealth_core/swagger/openapi.json`) makes `BloodborneReuseMarkerSummary.age_days` nullable and `label` always present (not only for `other`), and lists all sixteen `BloodborneMarker` columns as required (only their values are nullable). **As built, `reasons` no longer carries `minItems: 1`.** `computeReuseStatus` always produces at least one reason, but the cath surfaces (§9.1) project this same `BloodborneReuseStatus` object by role through `projectReuseRestrictionForRole`: a caller outside `CLINICAL_STAFF_ROUTE_ROLES` gets `status`, `validity_days` and `evaluated_at` with `reasons` and `markers` **emptied**, not dropped, so the published shape holds for every caller — `SEROLOGY_DETAIL_ROLES` is `CLINICAL_STAFF_ROUTE_ROLES` itself, reused rather than a parallel list that could drift from it. A `minItems: 1` constraint would make that projection a contract violation, so it was removed from the schema.

### 9.3 CSSD (`/api/v1/cssd`, `CSSD_ROUTE_ROLES`, unchanged role set; no PHI in any payload)

| Method and path | Purpose |
|---|---|
| `GET /devices?status=&facility_id=` | queue |
| `POST /devices/:id/receive` | awaiting → in_cssd |
| `POST /devices/:id/reprocessed` | `{ cycle_type, function_check_result }` |
| `POST /devices/:id/quarantine` | `{ reason }` |
| `POST /devices/:id/release` | quarantined → awaiting_reprocessing, `{ note }` |
| `POST /devices/:id/discard` | `{ reason, note }` |

Idempotency scope `cssd_device_transition`. Each transition writes the CSSD audit row the service already writes for set and load changes.

**As built:** the `/devices` sub-tree is narrower than the mount's stated "unchanged role set" — see §6.4 as-built for `CSSD_DEVICE_ROUTE_ROLES`, the intersection with `CSSD_ROUTE_ROLES` that excludes HR, DPO, compliance, pharmacy and stores roles from device transitions specifically.

### 9.4 Admin (`/api/v1/admin/cath-consumables`, existing router mounted at admin/index.js:260 under `ADMIN_ROUTE_ROLES` with super-admin step-up, app.js:1888)

| Method and path | Purpose |
|---|---|
| `PUT /catalog/:id` | existing; accepts `reused_billing_item_code` |

**As built, the reprocessing settings/policies endpoints do not live here.** The design above put `GET`/`PUT /reprocessing-settings` and `GET`/`PUT /reprocessing-policies` on this router behind a route-level `requireRole('QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'SUPER_ADMIN')`. That shape cannot work: this mount is gated at the mount level by `ADMIN_ROUTE_ROLES` (`SUPER_ADMIN`/`ADMIN` only, plus super-admin step-up), and a route-level `requireRole` can only *subtract* from what the mount already admits — it can never let through a role the mount refused. QUALITY_OFFICER and INFECTION_CONTROL_OFFICER were named in the route gate and admitted by neither it nor the mount: the prefix-mount lockout class recorded elsewhere in this program. As built, the four operations move to their own mount — see §9.5. `PUT /catalog/:id` (the catalogue's reused-billing-code field) is the only endpoint that stays here, unchanged.

`npm run openapi:check` runs after the route changes; `apps/backend/scripts/openapi/schemas/cathConsumables.mjs` is updated for the new fields and its `INVENTORY_DECREMENT_STATUSES` list, which still omits `not_applicable`, is corrected to the seven live values in the same change.

### 9.5 Cath reprocessing governance (`/api/v1/cath-reprocessing`, `CATH_REPROCESSING_POLICY_ROUTE_ROLES`, `app.js:1220`) — as built, replaces the §9.4 rows above

| Method and path | Purpose |
|---|---|
| `GET` / `PUT /settings` | §5.2 |
| `GET` / `PUT /policies` | §5.3, whole set per tenant |
| `GET /devices/:deviceId/history` | same handler as §9.1's cath-lab route; infection control's entry point |

A new mount, not a route-level gate on an existing one. `CATH_REPROCESSING_POLICY_ROUTE_ROLES` = `QUALITY_OFFICER`, `INFECTION_CONTROL_OFFICER`, `SUPER_ADMIN`, `ADMIN` (`config/routeRolePolicy.js`), applied as the mount-level `requireRole` in `app.js`. ADMIN is included deliberately, not by inheritance from the old admin mount: the same console administers the consumable catalogue's billing codes (`reused_billing_item_code` only means anything once a category is reprocessable, §5.6) and hosts the policy editor — revisiting that inclusion is a one-line change, not a redesign. The mount deliberately carries **none** of `requireSuperAdminStepUp`, `adminIpAllowlist` or `adminRateLimiter` — this is clinical-mount posture, the same as `/api/v1/cssd` and `/api/v1/cath-lab`, not the SUPER_ADMIN control-plane posture of the `/api/v1/admin/*` mounts: the audience is ward/infection-control roles on ordinary hospital workstations, not a fixed admin IP set, and none of `CATH_REPROCESSING_POLICY_ROUTE_ROLES` requires step-up elsewhere either. A rate limiter is noted as a one-line follow-up if the owner wants a ceiling on this surface (§18).

Both `PUT /settings` and `PUT /policies` require `Idempotency-Key` with scope `cath_reprocessing_policy` — one scope for the pair, since both writes are commands against the same tenant-wide row set edited from the same screen. Writes are still audited as `CATH_REPROCESSING_SETTINGS_UPDATED` / `CATH_REPROCESSING_POLICY_UPDATED`, unchanged from the original design.

The router carries no PHI except `GET /devices/:deviceId/history`, which is the one read that writes its own per-patient `hipaa_access_log` rows rather than relying on a mount-level PHI logger the mount does not have (§9.1 as-built has the batching and `request_id` shape). The Admin app's `/api/proxy` allowlist (`ALLOWED_PATH_PREFIXES`) gained the `api/v1/cath-reprocessing` prefix; the Admin console's route policy admits `QUALITY_OFFICER`/`INFECTION_CONTROL_OFFICER` at `STAFF` rank for both `/dashboard/cssd` and `/dashboard/quality/cath`, so the officers can reach the pages that call these endpoints.

## 10. Billing

In `maybeEmitCathBillingLines` (cathLabService.js:4653-4790) and `listUnbilledConsumableUsage` (:4827, second code match at :4876):

- `usage.reuse_cycle ≥ 1` → match `billing_service_master.code = catalog.reused_billing_item_code`; category `procedure`.
- Missing reused code → unmapped with reason `reused_billing_code_not_mapped` (added to the gap-reason enumeration in `cathConsumables.mjs:21-28`). A reused row is never billed at the new-unit code.
- `wasted` continues to take precedence (`wastage_review_required`).
- Price remains the master's; `unit_price` stays null on the line (:4783-4785).

## 11. Client scope

Staff (Flutter):

- `cath_consumable_capture_sheet.dart`: New / Reused segmented control; tag field accepting typed or scanned input (the platform's existing scanner input where present; typing always works); the restriction strip (red for `restricted`, amber for `unknown`) reading the resolver `reasons`; exposure acknowledgement dialog when the server demands it.
- `cath_case_consumables_panel.dart`: per-row post-use action rendered from `allowed_post_use` (Send to CSSD, Discard with reason, or nothing); device tag and cycle badge on reused rows; the serology-driven variants.
- `cath_lab_screen.dart`: the restriction strip in the case header next to the readiness strip (:572-580); "Record outside serology" opens the checklist's external-result sheet for the serology items (companion spec §10).
- `cath_lab_api_service.dart` and `cath_consumable_models.dart`: the new fields and endpoints.

**As built, additions beyond the bullets above:**
- The device-tag lookup guards against a stale card: `cath_consumable_capture_sheet.dart` keeps an internal generation counter (`_lookupGeneration`) that a catalogue-item change or a fresh scan bumps, so a slow in-flight lookup response for a superseded tag is dropped instead of populating the sheet with a device the pending save would not actually send. The card always shows the tag that will be submitted.
- `_scan()` fills the catalogue **search** field, not the device-tag field — a scanned device tag still has to be typed or otherwise entered into the reused-device field; wiring the scanner to the tag field is a follow-up (§18).
- Post-use recording goes through the module-level `IdempotencyAttemptRegistry` (the same mechanism `ward_indent_workbench.dart`, `orders_screen.dart` and others already use) so a retry of the same post-use action replays the same idempotency key rather than minting a new one.
- On a failed post-use call, the panel reloads the case's consumables rather than leaving stale `allowed_post_use` state on screen.
- The post-use discard path never demands the exposure acknowledgement: only `reprocess` can return a device to service, so only `reprocess` needs the attestation — a discard already takes the device out of service.
- `cath_reuse_restriction_strip.dart` renders nothing when the restriction status is `clear`, and caps visible `reasons` at 4 with a "+N more" line (`s4.dynamic.cath_lab.consumables.more_reasons`) rather than growing unbounded.
- New Staff strings, all five locale maps: `s4.lib.cath_lab.consumables.post_use_device_already_discarded`, `.post_use_note`, `.post_use_confirm`, `s4.dynamic.cath_lab.consumables.more_reasons`.
- Staff refusal messages surface in English only in the current build — the platform's `ApiResponse.code` is discarded on the client rather than mapped through the five-locale string tables; a localized-refusal pass is a follow-up (§18).

Admin (Next.js):

- `dashboard/cssd`: Devices tab with the actions in §6.4 (as narrowed there) and label printing (as built, a text reminder rather than a print endpoint — §6.4, §18).
- `dashboard/billing/cath-consumables`: catalogue form field for the reused code; unbilled tab shows the new gap reason.
- `dashboard/quality/cath`: Reprocessing policy tab (settings and per-category rows).

**As built:** the shared `Modal` component used by both new dashboards does not trap keyboard focus inside itself — a follow-up (§18), not specific to this feature but exercised by it.

## 12. Error handling

| Code | HTTP | When |
|---|---|---|
| `CATH_CONSUMABLE_REUSE_FIELDS_CONFLICT` | 400 | reused tag sent with batch or serial fields |
| `CATH_DEVICE_NOT_FOUND` | 404 | tag unknown in tenant |
| `CATH_DEVICE_CATALOG_MISMATCH`, `CATH_DEVICE_FACILITY_MISMATCH` | 409 | device does not match the request |
| `CATH_DEVICE_NOT_AVAILABLE` | 409 | status ≠ available; payload carries the status |
| `CATH_DEVICE_EXPOSURE_BLOCKED` | 409 | exposure flag under rule `discard` |
| `CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED` | 400 | rule permits but reason missing |
| `CATH_REPROCESSING_NOT_ALLOWED` | 409 | category not reprocessable or implant |
| `CATH_REPROCESSING_SEROLOGY_REQUIRED` | 409 | `unknown` under `block_return` |
| `CATH_DEVICE_MAX_CYCLES_REACHED` | 409 | reprocess requested at the limit |
| `CATH_DEVICE_UNITS_EXCEED_QUANTITY` | 400 | post-use units > row quantity |
| `CATH_DEVICE_INVALID_TRANSITION` | 409 | any transition outside §5.4 |
| `CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED` | 409 | cycle type outside the category policy |
| `BLOODBORNE_MARKER_INVALID` | 400 | label missing for `other`, invalid result for `cjd_suspected`, future `tested_on` |

Concurrency: device rows are read `FOR UPDATE` in every transition; the deferred 753 constraint trigger remains the last line of defence for reused rows. All transitions and the register writes run inside `setTenantTx`; nothing uses the bare Prisma client (the RLS-bypass trap recorded for staff push scope applies).

## 13. Relationship to ballot 753-D1

The ballot in `docs/GO_LIVE_READINESS_GAP_MATRIX.md:44-66` asks whether every cath consumable use must enter a pharmacy shortfall task. After this design:

- Reused devices are exempt regardless of the vote; they consume no stock and the contract says so.
- The ballot now concerns new units only. Option 1 (retain the mandatory task) needs no further code. Option 2 (exact-stock use is not a shortfall: decrement when the batch has stock, task only when it does not) changes the same assert function and the capture path; if chosen, it rides the same forward migration as the carve-out so the function is re-declared once.
- The vote is recorded on the ballot by the owner; this spec does not pre-empt it.

## 14. Phase 2 and future consumers

- **Loads.** `device_ids BIGINT[]` on `sterilization_loads` beside `set_ids`; a `passed` load increments every device's cycle and releases it; a `failed` biological indicator quarantines every device in the load; maximum-cycle discard happens on release without a click. Phase 1's manual actions remain as the fallback.
- **Per-item overrides** of the category policy.
- **OT.** The surgical safety checklist sign-in phase reads the resolver and shows the same strip; instrument sets used on a restricted patient gain an exposure flag on `set_issue_log` return. `surgical_implants.sterilization_lot` links to loads.
- **Dialysis.** `dialysis_patients` statuses are derived from the marker record instead of being maintained separately; the dialyser reuse register refuses or segregates reuse for restricted patients, which it does not do today (dialysisService.js:33-59, 928-960).
- **Patient summary sheet** section for markers, beside allergies.

## 15. Testing and gates

Unit (`apps/backend/src/tests/unit`):

- Resolver: window arithmetic, stale negatives → unknown, reactive outside window → restricted, `cjd_suspected` without window, voided rows ignored, latest-per-marker selection, `other` with label.
- Normaliser: every token row in §7.2, `weakly reactive` → reactive, `non-reactive` never reactive, unknown text → indeterminate.
- Policy validation: implant categories refused, complete-check, cycle-type subset.
- Transition table: every allowed and refused pair in §5.4.
- Post-use disposition computation for every serology status × rule combination.
- Billing code selection and the new gap reason at both call sites.

Deep (`apps/backend/src/tests/*.deep.test.js`, own-tenant fixtures, 30 s budget):

- Contract: a reused row without a task commits; a new-unit row without a task still fails as today; a reused row with a stock movement fails; a reused row whose device belongs to another catalogue item fails.
- Capture: available device → in_case with correct cycle; not available, mismatch, exposure under each rule.
- Post-use: first-use row of quantity 3 yields 3 devices; restricted patient under `discard` offers only discard and records the disposition; `unknown` under `block_return` refuses; at max cycles only discard.
- CSSD: reprocessed increments and releases; function check fail discards; release from quarantine requires a fresh cycle.
- Lab hook: signing off an `HBSAG` result with `Reactive` creates a marker row once across replays; a correction voids and re-inserts; a reactive sign-off quarantines an available device used on that patient within the window and raises the alert.
- Reconciliation listings exclude reused rows.
- RLS: another tenant cannot read or transition a device or a marker row.

Mutation checks on the tests that pin safety behaviour (the lesson recorded from PR #973): delete the exposure block and confirm the test goes red; flip the normaliser's negative-first order and confirm the `non-reactive` test goes red.

Repository gates: `scripts/ci/security.mjs` (inline-check census static guard: unchanged manifest expected), backend `--verify-db` calibration, migration immutability gate, plpgsql body validation, `openapi:check`, Flutter and admin lint and tests, canonical `ci.yml` with the `[full-ci]` marker on the last commit before hand-back.

## 16. Rollout

- Dark by default: no category policy rows, settings defaults `discard` / `warn` / 90. The marker record and lab hook are live from deployment and harmless on their own.
- A tenant activates reuse by creating category policies; the quality or infection-control officer owns that step.
- No data migration: existing usage rows keep their statuses; `post_use_disposition` stays null for history.

## 17. Risks accepted by the owner

- CSSD takes on tag printing and affixing; the label is the only physical artefact.
- Phase 1 reprocessing is a manual mark on the CSSD tab, not a load-driven event; a device can be marked reprocessed without a recorded load until Phase 2.
- A failed function check discards; a failed load in Phase 1 is recorded by CSSD quarantining devices by hand.
- Outside serology reports depend on someone entering them; until then the case shows `unknown`, and the tenant rule decides whether that warns or blocks.
- The marker record is a new patient-level clinical artefact; dialysis and OT will want to write to it, which is future work, not this change.

## 18. Deferred / follow-ups

- The value normaliser (§7.2) misses an abbreviated or numeric positive embedded inside a multi-analyte comment — for example `"Negative. HBsAg: POS"` resolves to `non_reactive` rather than `reactive`, because the negative token it finds first is checked against the whole remaining text rather than per-analyte. A follow-up is needed before free-text panel comments are trusted without review.
- Database-level enforcement of append-only (a `BEFORE UPDATE OR DELETE` trigger in the merge-aware pattern of migration 758, so the patient-merge sweep can still re-point `patient_uid`) is deferred, as already noted in §5.1; convention (insert-only, void transition) is the only enforcement today.
- There is no outbox for exposure notifications: a crash between the lab-sign-off commit and the post-commit `notifyExposureHandlers` call loses that event. The resolver is pull-based (§7.3), so a status read afterwards is still correct — only the push-style `cds_alerts` row and infection-control notification (§6.6) are missed, not the underlying restriction.
- A reconciliation sweep — signed HIV/HBsAg/HCV `lab_results` rows with no active marker row — is recommended before any device-reuse reader goes live, to repair a hook miss that the try/catch around the post-commit call in §7.1 otherwise leaves unrepaired until the next sign-off event touches that same result.
- **As built, additional follow-ups recorded during implementation:**
  - ~~CSSD's Devices tab offers all six cycle types rather than filtering to the category policy's `allowed_cycle_types`.~~ **Closed** — the picker is filtered and the action is disabled with a reason when the policy allows nothing (§6.4).
  - ~~There is no device-label print endpoint.~~ **Closed** — `GET /api/v1/cssd/devices/{id}/label` (PDF, or JSON on `?format=json`) plus a Print label action on the Devices tab (§6.4).
  - The Devices tab has no facility column and no time-in-queue column (§6.4).
  - `retainOnServerError` is deliberately not set on the device/post-use claim routes: the transition `from`-lists plus the service's idempotency replay make a retry after a post-commit 5xx safe on their own (a retry either replays the stored response or 409s naming the state actually reached), so this is a recorded design choice, not an oversight to revisit.
  - A rate limiter on the `/api/v1/cath-reprocessing` mount (§9.5) is optional and not yet added.
  - `reactive_markers`-style derivation straight from `computeReuseStatus` is not implemented on the device register: a device's `exposure_markers` list is whatever the late-reactive sweep or an override appended at the time, so a latched marker whose most recent row later reads `indeterminate` does not currently drop out of that list even though the resolver's own `restricted` status would still hold on the flag.
  - Staff refusal messages are English-only; `ApiResponse.code` is not currently mapped through the five-locale string tables.
  - The Admin `Modal` component (used by the CSSD and reprocessing-policy dialogs) does not trap keyboard focus.
  - `cath_consumable_capture_sheet.dart`'s `_scan()` does not populate the device-tag field — a scanned reused-device tag must still be typed in.
