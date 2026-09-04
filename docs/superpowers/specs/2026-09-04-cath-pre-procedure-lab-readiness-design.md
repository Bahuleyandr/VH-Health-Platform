# Cath-lab pre-procedure lab readiness — design

- Date: 2026-09-04
- Status: approved in conversation by the platform owner; awaiting written review of this document
- Base: `main` at `f60df4e95`
- Companion: `2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md` (this spec consumes its blood-borne marker record and shares its lab analyte code map)
- Related: migration 482 (`cath_lab_readiness_checks`), 098/102 (investigation catalogue), 151/175 (`lab_results`), 260 (`lab_specimens`), `cathQuickWinsService.js` (evidence attach pattern)

## 1. Problem

Every cath case carries eight readiness checks and procedure start is blocked until all are cleared (cathLabService.js:514-534, 621-632). The `labs` check is a bare human tick: nothing tells the operator whether Hb, platelets, creatinine, potassium and serology exist, were never ordered, or are sitting in the lab awaiting a result. The Staff app does not render the individual checks at all; it shows a progress bar (cath_lab_screen.dart:956-1014) and has no client for the status-setting endpoint. Values obtained at an outside laboratory have no home: manual lab entry requires an in-house order (labResultsService.js:1728-1737), cannot record the external lab's name (:1819-1825), and forces the row to `preliminary`.

Owner decisions, 2026-09-04:

| Question | Owner answer |
|---|---|
| Should the `labs` check tick itself when the values exist? | Yes. Availability is the rule. |
| A value the lab flagged critical? | Tick anyway; show a "critical value" warning next to the tick. |
| Values done at an outside lab? | Store them as external lab results. Enterable only from the cath checklist, only for these items. |
| Missing values? | Alert, naming whether the test was never ordered or is ordered and not yet resulted; provide the order. |

## 2. Non-goals

- Blocking procedure start on a critical or abnormal lab value. The gate follows availability; the warning and the existing critical-alert acknowledgement path (labRoutes.js:593-600) are the safety net. This is an owner decision recorded here.
- A general external-result entry surface in the lab module. The lab route keeps rejecting unlinked results; only the cath readiness path may create an external-origin row, and only for the seven items below.
- Extending the `cath_lab_readiness_type_check` list (482:94). `labs` stays the single check; the items live under it.
- Changing the other seven readiness checks.
- OT or dialysis consumption of the item resolver (future, §12).

## 3. Decisions

- **Seven items under `labs`**: `hb`, `platelets`, `creatinine`, `potassium`, `hiv`, `hbsag`, `hcv`.
- **Automation only manages what it set.** Rows the system passed carry `metadata.auto_managed = true` and may be flipped back to `pending` by the system before procedure start. A human `pass` or `waived` is never altered by automation; item-level alerts still display. This keeps the recorded principle that readiness is a human decision (cathQuickWinsService.js:246-250) while honouring the owner's auto-tick.
- **Critical never blocks, always warns.** Any item whose result carries `is_critical = true` or `abnormal_flag IN ('HH','LL','AA')` sets `critical_warning` on the check; the tick shows the warning; the check still passes.
- **Outside values are real lab results**, stored with a new origin column, never signed off, badged "external, unverified", and counted as available under a policy default of yes.
- **One code map** for order codes and analyte codes, shared with the marker hook.

## 4. Architecture

```
getCase / consumables read ──▶ labReadinessResolver (live) ──▶ persists cath_case_lab_readiness_items
                                                            ──▶ auto pass / auto pending on the labs check
Lab result filed or signed off ──▶ hook: refresh open cath cases for that patient
POST /readiness/labs/order-missing ──▶ orderService creates the covering orders
POST /readiness/labs/:item/external-result ──▶ lab_results (origin external_lab) ──▶ marker hook (serology) ──▶ refresh
Staff readiness tab ──▶ per-check list + labs expansion + actions
```

New module: `apps/backend/src/services/clinical/cathLabReadinessService.js` (resolver, persistence, auto-status, order-missing, external entry). Shared module: `apps/backend/src/services/lab/labAnalyteCodes.js`.

## 5. Lab analyte code map

Results are one row per analyte with analyte codes; orderable tests use different codes (102:22-200 versus 175:93-128). The map is the single source of truth for both this spec and the marker hook in the companion spec.

| Item | Analyte codes on `lab_results.test_code` (case-insensitive) | Orderable catalogue codes that produce it |
|---|---|---|
| hb | `HGB`, `HB`, `HAEMOGLOBIN`, `HEMOGLOBIN` | `CBC` |
| platelets | `PLT`, `PLATELET`, `PLATELETS` | `CBC`, `PLT` |
| creatinine | `CREA`, `CREATININE`, `CREAT` | `CREATININE`, `KFT` |
| potassium | `K`, `POTASSIUM` | `ELECTROLYTES` |
| hiv | `HIV`, `HIV1_2`, `HIV_AB` | `HIV` |
| hbsag | `HBSAG`, `HBS_AG` | `HBSAG` |
| hcv | `HCV`, `ANTI_HCV`, `HCV_AB` | `HCV` |

Aliases exist because analyzers and the manual panel path write different spellings; the map is a constant with a unit test that pins every row. LOINC codes on `lab_results.loinc_code` are matched as a secondary key where present (718-7, 777-3, 2160-0, 2823-3); the dark analyzer mapping layer (721) is not consulted.

## 6. Data model

New tables follow the tenant GUC default and the `tenant_isolation` RLS block of 482:53-69. All CHECKs are named.

### 6.1 `cath_lab_readiness_settings` (one row per tenant)

| Column | Type | Notes |
|---|---|---|
| tenant_id | UUID PK | |
| required_items | TEXT[] NOT NULL DEFAULT all seven | CHECK `cath_lab_readiness_settings_items_check`: `<@` the seven item codes |
| lab_validity_days | INTEGER NOT NULL DEFAULT 30 | CHECK 1..365; applies to hb, platelets, creatinine, potassium |
| auto_pass | BOOLEAN NOT NULL DEFAULT true | |
| external_results_count | BOOLEAN NOT NULL DEFAULT true | external-origin results satisfy availability |
| updated_by, updated_at | | |

Serology validity comes from `cath_reprocessing_settings.serology_validity_days` (companion §5.2), default 90 when absent, so both features agree on how long a serology result may be relied on. Read path returns the literal defaults when no row exists.

### 6.2 `cath_case_lab_readiness_items`

One row per case per item; a persisted snapshot of the live resolution.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| tenant_id | UUID NOT NULL | |
| case_id | BIGINT NOT NULL | FK `cath_lab_cases(id)` ON DELETE CASCADE |
| item_code | VARCHAR(20) NOT NULL | CHECK `cath_case_lab_readiness_items_code_check`: the seven |
| required | BOOLEAN NOT NULL | from settings at refresh |
| state | VARCHAR(32) NOT NULL | CHECK `cath_case_lab_readiness_items_state_check`: `result_final`, `result_preliminary`, `external_recorded`, `sample_sent_awaiting_result`, `ordered_awaiting_sample`, `not_ordered`, `stale`, `waived` |
| value_text, value_numeric, unit, abnormal_flag, is_critical | | copied from the winning result |
| observed_at | TIMESTAMPTZ | `COALESCE(performed_at, received_at)` of the result |
| lab_result_id | INTEGER | FK `lab_results(id)` |
| investigation_id | INTEGER | the open order, when state is an awaiting state |
| specimen_id | INTEGER | FK `lab_specimens(id)` when known |
| ordered_at | TIMESTAMPTZ | for awaiting states |
| waived_by, waived_at, waive_reason | | human waiver of one item |
| refreshed_at | TIMESTAMPTZ NOT NULL | |

Unique `(tenant_id, case_id, item_code)`. Index `(tenant_id, case_id)`.

### 6.3 Changes to `lab_results`

- `result_origin VARCHAR(20) NULL` CHECK `lab_results_result_origin_check`: `analyzer`, `manual_in_house`, `external_lab`. Null for legacy rows; new writers set it (`recordResultManual` and `labPanelService` write `manual_in_house`; HL7 ingest writes `analyzer`; the cath external path writes `external_lab`).
- `external_lab_name VARCHAR(160) NULL`, `external_report_ref VARCHAR(120) NULL`, `external_reported_on DATE NULL`.
- CHECK `lab_results_external_origin_check`: `result_origin <> 'external_lab' OR (external_lab_name IS NOT NULL AND external_reported_on IS NOT NULL)`.
- The order-link requirement in `recordResultManual` (labResultsService.js:1728-1737) gains one internal escape: a caller-supplied `allowUnlinkedExternal` option, set only by `cathLabReadinessService`, permits `investigation_id` and `booking_id` both null when `result_origin = 'external_lab'`. The lab route's validator rejects `result_origin` and the option from request bodies, so the public manual-entry surface is unchanged.

### 6.4 The `labs` check row

No schema change. Automation writes: `status`, `completed_at`, `evidence_owner = 'lab_readiness'`, `source_name = 'lab_results'`, `attachment_ref = 'lab_readiness:<case_id>'`, and `metadata` keys `auto_managed`, `auto_passed_at`, `auto_pending_reason`, `critical_warning`, `critical_items`, `live_evidence` (the seven items, same shape as the persisted table). `completed_by` stays null on automated passes.

## 7. Resolution

Per item, for the case's patient, within the tenant's window for that item:

1. **Result present.** Latest `lab_results` row whose `test_code` (or `loinc_code`) matches the item, `status <> 'cancelled'`, `observed_at` within window. State: `result_final` when `status IN ('final','corrected') AND signed_off_at IS NOT NULL`; `external_recorded` when `result_origin = 'external_lab'`; else `result_preliminary`. Values, flags and `is_critical` are copied.
2. **Ordered, awaiting.** Otherwise, an `investigations` row for the patient whose `test_code` is one of the item's orderable codes, `status NOT IN ('COMPLETED','CANCELLED')`, requested within the window. If a linked `lab_specimens` row exists (via the booking) its status decides: `ordered` → `ordered_awaiting_sample`; `collected`, `in_transit`, `received`, `processing` → `sample_sent_awaiting_result`. Without a specimen: `collected_at IS NULL` → `ordered_awaiting_sample`; else `sample_sent_awaiting_result`. Bookings whose `selected_tests` contain the catalogue id (098:57-59) in a resultable status (labResultsService.js:125-131) map the same way from their timestamps.
3. **Stale.** Otherwise, a matching result exists outside the window → `stale`, with the old value and date shown.
4. **Not ordered.** Otherwise → `not_ordered`.
5. **Waived** overrides all of the above for that item, with the human's reason.

Check-level:

- `available(item)` is true for `result_final`, `result_preliminary`, `waived`, and `external_recorded` when `external_results_count` is on.
- All required items available and `auto_pass` on → if the check is `pending`, or is `pass` with `auto_managed`, set `pass` with the automation fields. If the check is a human `pass` or `waived`, leave it.
- Not all available → if the check is `pass` with `auto_managed` and the case has no `actual_start_at`, set `pending` with `auto_pending_reason` naming the items. Human-set statuses are left alone.
- `critical_warning` is recomputed every refresh from the items; it is displayed beside the tick regardless of who set the status and is never a reason to change the status.

Refresh triggers:

- **On read**: `getCase` and the readiness listing run the resolver, persist items, and apply the check-level rule, so the screen never shows stale automation. The resolver is a handful of indexed queries per case (`idx_lab_results_patient_test`, 175:43-44).
- **On lab events**: after a `lab_results` row is inserted by any path and after `signOffResults` commits, refresh every case for that patient with status in `scheduled`, `readiness_pending`, `ready` and no `actual_start_at`. Failures here are logged and never fail the lab write.
- **Explicit**: the existing `POST /cases/:id/readiness/evidence/refresh` (cathLabRoutes.js:386-396) adds `labs` to its targets.

## 8. Actions

### 8.1 Order missing labs

`POST /api/v1/cath-lab/cases/:id/readiness/labs/order-missing`, idempotency scope `cath_lab_readiness_order`. For every required item in `not_ordered` or `stale`, the covering orderable code is chosen: `CBC` when hb or platelets is missing (one order covers both), `ELECTROLYTES` for potassium, `CREATININE` for creatinine, `HIV`, `HBSAG`, `HCV` for serology. Orders are created through the order-creation function in `apps/backend/src/services/investigation/orderService.js` against the case's encounter with the actor as requester, one per code, skipping codes that already have an open order. Response lists created and skipped orders; the items refresh to `ordered_awaiting_sample`.

### 8.2 Enter an outside result

`POST /api/v1/cath-lab/cases/:id/readiness/labs/:item/external-result`, idempotency scope `cath_lab_readiness_external`. Body: `{ value_text, value_numeric?, unit?, observed_on, external_lab_name, external_report_ref?, notes? }`. Only the seven item codes are accepted. The service:

1. Validates the item, the date (not in the future, within the item's window or the caller is told it will resolve as `stale`), and that qualitative items (serology) carry a recognised token (companion §7.2) while quantitative items carry `value_numeric` and a unit.
2. Calls `recordResultManual` with `allowUnlinkedExternal`, `result_origin = 'external_lab'`, `test_code` = the item's canonical analyte code (`HGB`, `PLT`, `CREA`, `K`, `HIV`, `HBSAG`, `HCV`), `patient_uid` from the case, `performed_at = observed_on`, `performed_by_lab = external_lab_name`, status `preliminary`. The abnormal flag is computed against `lab_reference_ranges` for numeric values the way the panel path does; critical evaluation fans out through the existing critical-alert generation exactly as manual rows do (labResultsService.js:1881, 1972).
3. For serology items, the marker hook creates the `patient_bloodborne_markers` row with `source = 'external_report'` and the `lab_result_id` link (companion §7.1).
4. Writes audit `CATH_LAB_EXTERNAL_RESULT_RECORDED` and refreshes the items.

Role: the cath router's roles (PHI-logged at app.js:2008). The B-3 rule holds: nothing on this path can produce a `final` or signed-off result.

### 8.3 Waive one item

`POST /api/v1/cath-lab/cases/:id/readiness/labs/:item/waive` with `reason`; recorded on the item and in the check's metadata; the check-level rule then applies.

### 8.4 Human status control (existing)

`POST /api/v1/cath-lab/cases/:id/readiness` (cathLabRoutes.js:426-437) is unchanged. A human `pass` over a `critical_warning` writes a `medication_safety_reviews` row with `review_type = 'cath_lab_readiness'`, `finding_code = 'CRITICAL_LAB_ACKNOWLEDGED'`, so it appears on the clinical timeline; the warning stays visible.

## 9. Case payload

`getCase` and the consumables listing add:

```json
"lab_readiness": {
  "check_status": "pass",
  "auto_managed": true,
  "critical_warning": true,
  "items": [
    { "item": "potassium", "required": true, "state": "result_final", "value": "6.1", "unit": "mmol/L", "abnormal_flag": "HH", "is_critical": true, "observed_at": "2026-09-04T06:10:00Z", "source": "lab_result" },
    { "item": "hbsag", "required": true, "state": "sample_sent_awaiting_result", "ordered_at": "2026-09-04T05:40:00Z" },
    { "item": "hcv", "required": true, "state": "not_ordered" }
  ],
  "missing": [{ "item": "hbsag", "state": "sample_sent_awaiting_result" }, { "item": "hcv", "state": "not_ordered" }],
  "orderable_now": ["HCV"]
}
```

## 10. Client scope (Staff, Flutter)

- `cath_lab_screen.dart` readiness tab: replace the progress-bar-only card with the per-check list. Each of the eight checks shows status and a control that calls the existing status endpoint (no client exists today; cath_lab_api_service.dart:686 only calls evidence refresh). This is required work, not polish.
- The `labs` check expands into the seven items with state chips: green result, blue external with "unverified", amber awaiting states naming the stage and time, red "not ordered", grey stale with the old date. A red "Critical value" badge sits beside the tick whenever `critical_warning` is true, and the item shows the value.
- Actions: "Order missing labs" (8.1), "Enter outside result" sheet per item (8.2), "Waive" per item (8.3).
- Case header: an amber strip when any required item is missing; the critical badge repeats there.

Admin (Next.js): settings editor for §6.1 under `dashboard/quality/cath`, beside the reprocessing policy tab from the companion spec, on the admin cath consumables router with the same route-level role check.

## 11. Error handling

| Code | HTTP | When |
|---|---|---|
| `CATH_LAB_READINESS_ITEM_UNKNOWN` | 400 | item outside the seven |
| `CATH_LAB_READINESS_VALUE_INVALID` | 400 | qualitative token unrecognised, numeric missing, unit missing, future date |
| `CATH_LAB_READINESS_ORDER_FAILED` | 502 | order service refused; response names the code |
| `CATH_LAB_READINESS_CASE_STARTED` | 409 | order or external entry attempted after `actual_start_at` |
| `LAB_RESULT_ORDER_LINK_REQUIRED` | 400 | unchanged on the public lab route; the escape applies only internally |

All writes run inside `setTenantTx`; refresh-on-event never propagates errors into the lab write.

## 12. Future consumers

- **OT**: the surgical safety checklist sign-in phase (116:309-330) reads the same item resolver for its labs line.
- **Dialysis**: monthly serology surveillance can be driven from the marker record and the same resolver instead of `dialysis_serology`.
- Per-item validity windows, if a tenant wants creatinine fresher than Hb.

## 13. Testing and gates

Unit: the code map (every alias, every orderable mapping), state resolution for each of the eight states with boundary dates, check-level rule for every combination of `auto_managed`, human status, availability and `actual_start_at`, `critical_warning` derivation from `is_critical` and flags, order-missing code selection including the CBC-covers-two rule, external entry validation.

Deep (own tenant, 30 s budget): auto-pass when the seventh result lands via sign-off; critical potassium passes with `critical_warning`; stale flips an auto-managed pass back to pending before start and not after; a human pass is untouched by a later missing item; external serology entry creates the lab row with origin, the marker row, and satisfies availability; external results ignored when the policy is off; order-missing creates CBC once for hb and platelets and is idempotent; the public lab route rejects `result_origin`; RLS isolation on both new tables.

Mutation checks: remove the `auto_managed` guard and confirm the human-pass test fails; remove the `actual_start_at` guard and confirm the post-start test fails.

Gates: inline-check census static guard (new tables are not baseline-owned; manifest unchanged), `--verify-db`, migration immutability, `openapi:check` after the new routes, Flutter analyzer and widget tests for the readiness tab, canonical `ci.yml` with `[full-ci]` on the last commit before hand-back.

## 14. Rollout

- `auto_pass` and `external_results_count` default on; `required_items` default all seven; `lab_validity_days` 30. A tenant that wants a stricter or looser posture edits the settings row.
- Existing cases get items on first read; no backfill.
- The `lab_results` origin column is nullable; legacy rows are untouched and resolve as in-house results.

## 15. Risks accepted by the owner

- A critical value does not block procedure start; the warning and the critical-alert acknowledgement are the controls.
- External results are unverified by a pathologist and count as available by default.
- A patient's results filed under codes outside the alias map resolve as `not_ordered` until the map is extended; the map is a one-line change with a pinned test.
