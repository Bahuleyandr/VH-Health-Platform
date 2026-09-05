# Cath-lab pre-procedure lab readiness — design

- Date: 2026-09-04
- Status: approved in conversation by the platform owner; **built** on `feat/cath-lab-readiness` (Plan 3), backend/staff/admin final at `84ded1b04`, `main` merged at `13e885d98`
- Base: `main` at `f60df4e95`
- Companion: `2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md` (this spec consumes its blood-borne marker record and shares its lab analyte code map)
- Related: migration 482 (`cath_lab_readiness_checks`), 098/102 (investigation catalogue), 151/175 (`lab_results`), 260 (`lab_specimens`), `cathQuickWinsService.js` (evidence attach pattern)

> **As built.** This document has been amended in place against the shipped
> branch: sections §6.2, §6.3, §6.4, §7, §8.1–§8.3, §9, §10, §11 and §15 carry
> **As built** paragraphs, and §16 records the decisions still open with the
> owner. Where a paragraph and the surrounding design prose disagree, the
> **As built** paragraph is what the code does. Plan: `docs/superpowers/plans/2026-09-04-cath-lab-readiness.md`
> (its "Execution notes (as built)" block lists the commit per task).

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

**As built.** Every reference out of this table is a **tenant-pinned composite**
foreign key and nothing else, so a readiness item can never bind to another
tenant's case, result, specimen or order: `(tenant_id, case_id)` →
`cath_lab_cases (tenant_id, id)` `ON DELETE CASCADE`, and `(tenant_id,
lab_result_id)`, `(tenant_id, specimen_id)`, `(tenant_id, investigation_id)` →
their parents with `ON DELETE SET NULL (<column>)` — the Postgres 15+ column
list, because a bare `SET NULL` on a composite nulls *every* member including
the `NOT NULL` `tenant_id` and would raise 23502 instead of releasing the
pointer. Three `(tenant_id, id)` uniques (`ux_cath_lab_cases_tenant_id`,
`ux_lab_results_tenant_id`, `ux_lab_specimens_tenant_id`) are created first as
the targets. The separate `(tenant_id, case_id)` index was **dropped**: it is a
strict leading prefix of the unique above it.

`refreshed_at` does **not** mean "last time the resolver ran". The refresh
writes an item row only when the resolution actually **changed** (the stored row
is compared column by column, `refreshed_at` excluded), so the column means
"last time this item's resolution changed" and nothing reads it. The ≤60 s
freshness stamp for the whole snapshot lives on the `labs` check row instead, as
`metadata.live_evidence_refreshed_at` (§6.4).

### 6.3 Changes to `lab_results`

- `result_origin VARCHAR(20) NULL` CHECK `lab_results_result_origin_check`: `analyzer`, `manual_in_house`, `external_lab`. Null for legacy rows; new writers set it (`recordResultManual` and `labPanelService` write `manual_in_house`; HL7 ingest writes `analyzer`; the cath external path writes `external_lab`).
- `external_lab_name VARCHAR(160) NULL`, `external_report_ref VARCHAR(120) NULL`, `external_reported_on DATE NULL`.
- CHECK `lab_results_external_origin_check`: `result_origin <> 'external_lab' OR (external_lab_name IS NOT NULL AND external_reported_on IS NOT NULL)`.
- The order-link requirement in `recordResultManual` (labResultsService.js:1728-1737) gains one internal escape: a caller-supplied `allowUnlinkedExternal` option, set only by `cathLabReadinessService`, permits `investigation_id` and `booking_id` both null when `result_origin = 'external_lab'`. The lab route's validator rejects `result_origin` and the option from request bodies, so the public manual-entry surface is unchanged.

**As built — the escape is structural, not a flag.** `allowUnlinkedExternal`
does not exist. One private implementation, `recordManualLabResultRow({…,
external })`, has **two** exported entry points:

- `recordResultManual` — the public path behind `POST /api/v1/lab/results`. It
  calls the private function with `external: false`, which **forces**
  `result_origin = 'manual_in_house'` and nulls `external_lab_name`,
  `external_report_ref`, `external_reported_on` and `performed_at` whatever the
  body said. There is no argument on this entry point that changes that.
- `recordExternalLabResultRow` — internal, imported by no route.
  `cathLabReadinessService.js` is the only permitted caller, pinned by
  `src/tests/unit/labExternalResultCallSites.test.js`, so a new caller fails the
  build rather than inheriting the escape by copying a boolean. It requires
  provenance: `result_origin = 'external_lab'`, a non-blank `external_lab_name`
  and an `external_reported_on`, or `LAB_RESULT_EXTERNAL_PROVENANCE_REQUIRED`.

The rule the flag used to express is therefore a property of the call graph that
a test enforces, not a convention.

**As built — the origin writers.** `analyzer` is written by the three machine
paths (the ORU ingest in `labResultsService.js`, `labClosedLoopService.js`, and
`externalLabRecoveryService.js`'s two inserts); `manual_in_house` by
`recordResultManual` and `labPanelService.js`; `external_lab` only by
`recordExternalLabResultRow`. Legacy rows keep `result_origin` NULL and are
untouched.

**As built — the public route.** `middleware/labResultOriginGuard.js`
(`rejectLabResultOriginFields`) sits on `POST /api/v1/lab/results` and answers
**400 `LAB_RESULT_ORIGIN_NOT_ALLOWED`** naming which of the four fields were
sent. It is belt to the service's braces: the service would have overwritten
them silently, and silently dropping a field a client sent looks like
acceptance.

**As built — the CHECK.** `lab_results_external_origin_check` reads
`result_origin IS DISTINCT FROM 'external_lab' OR (NULLIF(btrim(external_lab_name), '') IS NOT NULL AND external_reported_on IS NOT NULL)`:
`IS DISTINCT FROM` so a NULL origin does not make the implication unknown, and
`NULLIF(btrim(...), '')` so a laboratory name of spaces is not provenance
either.

### 6.4 The `labs` check row

No schema change. Automation writes: `status`, `completed_at`, `evidence_owner = 'lab_readiness'`, `source_name = 'lab_results'`, `attachment_ref = 'lab_readiness:<case_id>'`, and `metadata` keys `auto_managed`, `auto_passed_at`, `auto_pending_reason`, `critical_warning`, `critical_items`, `live_evidence` (the seven items, same shape as the persisted table). `completed_by` stays null on automated passes.

**As built.** The metadata keys are `auto_managed`, `auto_passed_at`,
`auto_pending_reason`, `critical_warning`, `critical_items`, `live_evidence` and
`live_evidence_refreshed_at` — the last being the ≤60 s stamp that decides
whether an otherwise-unchanged check row is rewritten at all (see §7 refresh).
`auto_pending_reason` is **recomputed** from the current `missing` on every pass
while automation owns a pending check, never carried forward: a stored line goes
stale the moment a sample is drawn.

The evidence columns follow the same only-what-it-owns rule as `status`:
`evidence_owner` / `source_name` / `attachment_ref` are claimed only on a row
automation is moving or already owns (`auto_managed`), so a consultant's name
and attached report survive every later refresh.

The **human** status endpoint (`POST /cases/:id/readiness`, §8.4) **strips**
every automation key from the request metadata before writing
(`AUTOMATION_METADATA_KEYS` in `cathLabService.js`: the seven above plus
`refreshed_at`) and re-merges `critical_warning`, `critical_items` and
`live_evidence` from the row as it stands. A client therefore cannot mint
`auto_managed`, and `auto_managed` stays the single discriminator between an
automated and a human status.

## 7. Resolution

Per item, for the case's patient, within the tenant's window for that item:

1. **Result present.** Latest `lab_results` row whose `test_code` (or `loinc_code`) matches the item, `status <> 'cancelled'`, `observed_at` within window. State: `result_final` when `status IN ('final','corrected') AND signed_off_at IS NOT NULL`; `external_recorded` when `result_origin = 'external_lab'`; else `result_preliminary`. Values, flags and `is_critical` are copied.
2. **Ordered, awaiting.** Otherwise, an `investigations` row for the patient whose `test_code` is one of the item's orderable codes, `status NOT IN ('COMPLETED','CANCELLED')`, requested within the window. If a linked `lab_specimens` row exists (via the booking) its status decides: `ordered` → `ordered_awaiting_sample`; `collected`, `in_transit`, `received`, `processing` → `sample_sent_awaiting_result`. Without a specimen: `collected_at IS NULL` → `ordered_awaiting_sample`; else `sample_sent_awaiting_result`. Bookings whose `selected_tests` contain the catalogue id (098:57-59) in a resultable status (labResultsService.js:125-131) map the same way from their timestamps.
3. **Stale.** Otherwise, a matching result exists outside the window → `stale`, with the old value and date shown.
4. **Not ordered.** Otherwise → `not_ordered`.
5. **Waived** overrides all of the above for that item, with the human's reason.

**As built — step 1 (result present).**

- `SIGNED_STATUSES` is `final`, `corrected`, `amended`, `verified` — the four
  the platform actually writes, not the two named above — and `result_final`
  additionally requires a usable `signed_off_at`.
- **Freshness has a lower bound.** `withinWindow` requires `age >= 0` as well as
  `age <= windowDays`: a future-dated row is not evidence of anything, so it can
  never be fresh and never outranks a real value. A lone future-dated result
  resolves as `stale`, which is the restrictive direction. Open orders inherit
  the same bound.
- **External rows are dated from `external_reported_on`**, read as IST midnight
  (a DATE carries no zone, and the ward's day is the convention). `performed_at`
  on such a row is only when somebody keyed it in here, which can be months
  later. Everything else uses `COALESCE(performed_at, received_at)`.
- **Criticality is read across ALL items** — required or not, waived or not —
  because a potassium of 6.9 is a potassium of 6.9 whether the team waived the
  item or never required it. `missing` stays required-only: it is the gate,
  criticality is the warning. This is why a waived item keeps the value that
  prompted the waiver.
- **A repeat order in flight stays visible on the result branch.** Open orders
  are resolved *before* the result branch and their `investigation_id` /
  `specimen_id` / `ordered_at` pointers are attached to the resolved item even
  when a fresh result already answered it, so nobody is told to order a draw
  that is already ordered. The *result* still decides the state.
- **The specimen is the highest `id`** for the order's booking, chosen in the
  pure function rather than leaning on the caller's `ORDER BY`.
- Every instant compared against the process clock is read from an
  `<column>_epoch_ms` twin selected beside the column (`src/utils/dbInstant.js`),
  not from the driver-materialised `Date`, which the pg driver shifts by the
  database session timezone. `investigations.requested_at` and
  `investigation_bookings.created_at` are `TIMESTAMP WITHOUT TIME ZONE`, so they
  are read `AT TIME ZONE 'UTC'` — every app writer goes through Prisma, whose
  sessions are pinned to UTC.

**As built — step 2 (ordered, awaiting).** A patient-app **booking** with no
`investigations` row yet is an open order too. Its tests are catalogue ids in
`investigation_bookings.selected_tests`, joined to
`investigation_test_catalog.code`, and it counts in
`RESULTABLE_BOOKING_STATUSES` = `BOOKED`, `CONFIRMED`, `DISPATCHED`,
`COLLECTED`, `PROCESSING` — the same resultable set `labResultsService`,
`labPanelService` and `labClosedLoopService` use. `ordered_at` is the booking's
`created_at` (when the order was **placed**, which is what
`investigations.requested_at` means); `scheduled_date` is a null-prone DATE and
cannot carry that meaning. A booking-derived order has no `investigations` row,
so its `investigation_id` on the item is `null`, never `0`.

> **Hole, accepted in §15.** `RESULT_READY` is deliberately excluded from
> `RESULTABLE_BOOKING_STATUSES` on the reasoning that the `lab_results` row is
> the evidence from then on. But on this platform `RESULT_READY` means a result
> **file** was uploaded, not that structured rows exist — and such a booking can
> no longer accept a structured row. It therefore resolves as `not_ordered`, and
> order-missing may place a duplicate draw.

Check-level:

- `available(item)` is true for `result_final`, `result_preliminary`, `waived`, and `external_recorded` when `external_results_count` is on.
- All required items available and `auto_pass` on → if the check is `pending`, or is `pass` with `auto_managed`, set `pass` with the automation fields. If the check is a human `pass` or `waived`, leave it.
- Not all available → if the check is `pass` with `auto_managed` and the case has no `actual_start_at`, set `pending` with `auto_pending_reason` naming the items. Human-set statuses are left alone.
- `critical_warning` is recomputed every refresh from the items; it is displayed beside the tick regardless of who set the status and is never a reason to change the status.

Refresh triggers:

- **On read**: `getCase` and the readiness listing run the resolver, persist items, and apply the check-level rule, so the screen never shows stale automation. The resolver is a handful of indexed queries per case (`idx_lab_results_patient_test`, 175:43-44).
- **On lab events**: after a `lab_results` row is inserted by any path and after `signOffResults` commits, refresh every case for that patient with status in `scheduled`, `readiness_pending`, `ready` and no `actual_start_at`. Failures here are logged and never fail the lab write.
- **Explicit**: the existing `POST /cases/:id/readiness/evidence/refresh` (cathLabRoutes.js:386-396) adds `labs` to its targets.

**As built — the refresh.**

- **A read-through runs as the SYSTEM actor**, never the reader:
  `context = { actorUid: null, actorRole: 'SYSTEM', requestId }` on both `getCase`
  and `GET .../readiness/labs`. Stamping the reader would put
  `cath_lab_cases.updated_by` and a `cath_lab.readiness.labs.auto_*` audit row —
  a clearance decision — into the trail of someone who only looked. The POST
  refresh *is* an act and keeps its full actor.
- **Write-on-change.** A cath case is read far more often than its labs move.
  An item row is UPSERTed only when its computed values differ from the stored
  row (compared per column type; `refreshed_at` excluded), and the `labs` check
  row is written only when the decision, the criticality, the evidence or the
  pending reason changed — or when `metadata.live_evidence_refreshed_at` is more
  than **60 s** old, so the stamp stays honest without rewriting ~3 KB of
  metadata on every GET.
- The case row is locked **`FOR NO KEY UPDATE`**, not `FOR UPDATE`: it still
  serialises against the `FOR UPDATE` every cath writer takes, but does not
  conflict with the `FOR KEY SHARE` a child-row insert takes on the parent, so a
  read-driven refresh no longer parks writers behind it.
- On the evidence-refresh route the labs refresh is **additive**: a failure
  answers `labs: null` and is logged rather than losing the other seven checks'
  re-evidencing.
- The lab-event hooks reach the readiness service through a **dynamic** import,
  so the lab module keeps no static cycle with the readiness service (which
  imports `recordExternalLabResultRow` statically).

## 8. Actions

### 8.1 Order missing labs

`POST /api/v1/cath-lab/cases/:id/readiness/labs/order-missing`, idempotency scope `cath_lab_readiness_order`. For every required item in `not_ordered` or `stale`, the covering orderable code is chosen: `CBC` when hb or platelets is missing (one order covers both), `ELECTROLYTES` for potassium, `CREATININE` for creatinine, `HIV`, `HBSAG`, `HCV` for serology. Orders are created through the order-creation function in `apps/backend/src/services/investigation/orderService.js` with the actor as requester, one per code, skipping codes that already have an open order. Response lists created and skipped orders; the items refresh to `ordered_awaiting_sample`.

**As built.** `createInvestigationOrder` takes no encounter parameter, so the
orders are placed against the **patient**, with the actor as `doctor_uid` /
`orderedBy` and a note naming the case. **Priority is derived from the case's
urgency** — `emergency` → `STAT`, `urgent` → `URGENT`, everything else →
`NORMAL` — rather than the unconditional `NORMAL` this path started with: a
primary-PCI patient's pre-procedure bloods must not sit on the lab worklist
behind an elective case's.

An open order **older than the item's window** neither counts as evidence nor
blocks re-ordering: `open_order_codes` is filtered by the same `withinWindow`
the resolver uses, because an order the resolver would not honour would
otherwise leave the item `not_ordered` *and* refuse to re-order it — a case the
checklist could never make ready.

### 8.2 Enter an outside result

`POST /api/v1/cath-lab/cases/:id/readiness/labs/:item/external-result`, idempotency scope `cath_lab_readiness_external`. Body: `{ value_text, value_numeric?, unit?, observed_on, external_lab_name, external_report_ref?, notes? }`. Only the seven item codes are accepted. The service:

1. Validates the item, the date (not in the future, within the item's window or the caller is told it will resolve as `stale`), and that qualitative items (serology) carry a recognised token (companion §7.2) while quantitative items carry `value_numeric` and a unit.
2. Calls `recordResultManual` with `allowUnlinkedExternal`, `result_origin = 'external_lab'`, `test_code` = the item's canonical analyte code (`HGB`, `PLT`, `CREA`, `K`, `HIV`, `HBSAG`, `HCV`), `patient_uid` from the case, `performed_at = observed_on`, `performed_by_lab = external_lab_name`, status `preliminary`. The abnormal flag is computed against `lab_reference_ranges` for numeric values the way the panel path does; critical evaluation fans out through the existing critical-alert generation exactly as manual rows do (labResultsService.js:1881, 1972).
3. For serology items, the marker hook creates the `patient_bloodborne_markers` row with `source = 'external_report'` and the `lab_result_id` link (companion §7.1).
4. Writes audit `CATH_LAB_EXTERNAL_RESULT_RECORDED` and refreshes the items.

Role: the cath router's roles (PHI-logged at app.js:2008). The B-3 rule holds: nothing on this path can produce a `final` or signed-off result.

**As built — validation.**

- **A value is required.** `Number()` turns `null`, `''`, `[]` and `false` into
  `0`, so a request naming no value at all used to be stored as a creatinine of
  0 — a number that reads as normal and clears the gate. A quantitative item now
  needs an explicit finite non-negative number (or a plain decimal string) below
  `1e11`, the `NUMERIC(15, 4)` bound, stated here so the answer is a 400 naming
  the field rather than a 22003 halfway through the insert. A qualitative item
  needs a whitelisted token (`reactive`, `non-reactive`, `nonreactive`, `non
  reactive`, `positive`, `negative`, `indeterminate`, `not detected`,
  `detected`). A unit is required for a quantitative item.
- `observed_on` must be a **real calendar day** — round-tripped through
  `Date.UTC`, so `2026-13-45` is a 400 rather than a 22008 surfacing as a 500 —
  and not in the future measured against the **ward's** today (Asia/Kolkata):
  between 18:30 and midnight IST a same-day report is tomorrow in UTC and would
  otherwise be refused.
- **`abnormal_flag` is NOT derived from `lab_reference_ranges`.** On this
  platform the column is owned by the governed threshold rail:
  `labThresholdExceptionService` rewrites `reference_range`,
  `reference_range_low` / `_high` and `abnormal_flag` from the policy assessment
  immediately after the insert, for **every** writer, and nulls them when no
  policy matches (leaving `criticality_status = 'threshold_unavailable'`); the
  panel path inserts `abnormal_flag: null` outright for the same reason. A flag
  computed in the cath path would either be overwritten a statement later or —
  where no policy matches — give an outside value a flag the in-house value for
  the same analyte does not carry, which is the exact inconsistency this section
  exists to prevent. "The same flag an in-house value would carry" therefore
  means **the same rail**, not the same lookup. A tenant-wide reference-range
  fallback belongs in the threshold layer; see §16.
- The idempotency **key** claimed by the route reaches
  `recordExternalLabResultRow`, but the claim's row id and body hash
  deliberately do not — see §11's note on why.

### 8.3 Waive one item

`POST /api/v1/cath-lab/cases/:id/readiness/labs/:item/waive` with `reason`; recorded on the item and in the check's metadata; the check-level rule then applies.

**As built.** A waiver is a clinical decision written to an item row and an audit
row, so it **claims an Idempotency-Key like every other write on this router**
(`required: true`, scope `cath_lab_readiness_waive`); the plan left it off, which
would have let a double-tap record the same override twice under two timestamps.
`reason` is required and **truncated at 500 characters** rather than refused —
the OpenAPI request schema declares `maxLength: 500`, so a longer reason is a
contract violation the client should not send; making the service answer 400
instead of truncating is the tidier rule and is left as a follow-up.

### 8.4 Human status control (existing)

`POST /api/v1/cath-lab/cases/:id/readiness` (cathLabRoutes.js:426-437) is unchanged. A human `pass` over a `critical_warning` writes a `medication_safety_reviews` row with `review_type = 'cath_lab_readiness'`, `finding_code = 'CRITICAL_LAB_ACKNOWLEDGED'`, so it appears on the clinical timeline; the warning stays visible.

**As built.** The override reason is now **server-enforced**, not only a Staff
dialog affordance: the service rejects an empty `notes` on this exact path with
`CATH_LAB_READINESS_REASON_REQUIRED` (§11) before the check row is written, so
the safety review's `override.reason` can no longer fall back to boilerplate.

## 9. Case payload

`getCase` and the consumables listing add:

```json
"lab_readiness": {
  "case_id": 4212,
  "check_status": "pass",
  "auto_managed": true,
  "critical_warning": true,
  "critical_items": ["potassium"],
  "items": [
    { "item_code": "potassium", "required": true, "state": "result_final", "value_text": "6.1", "value_numeric": 6.1, "unit": "mmol/L", "abnormal_flag": "HH", "is_critical": true, "observed_at": "2026-09-04T06:10:00Z", "source": "lab_result", "lab_result_id": 90132, "investigation_id": null, "specimen_id": null, "ordered_at": null, "waived_by": null, "waived_at": null, "waive_reason": null },
    { "item_code": "hbsag", "required": true, "state": "sample_sent_awaiting_result", "ordered_at": "2026-09-04T05:40:00Z", "investigation_id": 55219, "specimen_id": 7781 },
    { "item_code": "hcv", "required": true, "state": "not_ordered" }
  ],
  "missing": [{ "item": "hbsag", "state": "sample_sent_awaiting_result" }, { "item": "hcv", "state": "not_ordered" }],
  "orderable_now": ["HCV"],
  "open_order_codes": ["HBSAG"],
  "settings": { "lab_validity_days": 30, "serology_validity_days": 90, "auto_pass": true, "external_results_count": true, "required_items": ["hb", "platelets", "creatinine", "potassium", "hiv", "hbsag", "hcv"] },
  "case_started": false
}
```

**As built.** The item key is **`item_code`**, not `item` — `missing[]` is the
one place that spells it `item`, because it is a two-key pair
(`{ item, state }`), not an item row. The item rows carry the resolver's full
key set (`value_text` / `value_numeric` rather than a single `value`), and every
key is always present on the wire: the resolver spreads a complete base on every
branch, so `CathLabReadinessItem` is `additionalProperties: false` with **every**
key required and the ones with nothing to say null. (The second and third items
in the example above are abridged for reading; a real response repeats the full
key set of the first.) The `_missing_items` helper key floated in the plan **does
not exist** — the service never emitted one, and the schema says so.

The block has exactly **eleven** keys: `case_id`, `check_status`,
`auto_managed`, `critical_warning`, `critical_items`, `items`, `missing`,
`orderable_now`, `open_order_codes`, `settings`, `case_started`.

**Role projection.** `GET /cases/:id` and `GET .../readiness/labs` are cath
**report-read**, which admits RECEPTIONIST and TECHNICIAN — roles that have no
business reading which blood-borne marker came back reactive. For a role outside
the serology audience (`cathDeviceReuseService.roleSeesSerologyDetail`, the same
predicate the reuse restriction strip is projected through, deliberately not a
second list) `cathLabReadinessProjection.js` blanks `value_text`,
`value_numeric` and `abnormal_flag` on the `hiv` / `hbsag` / `hcv` items —
**keys are blanked, never dropped**, because the schema is strict.

**Criticality is withheld with the values on those three items.** A serology
item is qualitative and nothing but a reactive marker makes it critical, so
`is_critical: true` on the `hbsag` row and the bare code in `critical_items`
disclose precisely what the three blanked keys withhold. The item's
`is_critical` is forced to `false` (the key stays; the schema types it boolean)
and serology codes are dropped from `critical_items` — at the top level, and
from the `labs` check row's `metadata.critical_items` and
`metadata.live_evidence` inside the `readiness[]` array, which is a verbatim
copy of the same items one key over. `critical_warning` is **left alone**: it
says a critical value exists on this case without naming it, which is the
advisory the front desk is admitted for.

## 10. Client scope (Staff, Flutter)

- `cath_lab_screen.dart` readiness tab: replace the progress-bar-only card with the per-check list. Each of the eight checks shows status and a control that calls the existing status endpoint (no client exists today; cath_lab_api_service.dart:686 only calls evidence refresh). This is required work, not polish.
- The `labs` check expands into the seven items with state chips: green result, blue external with "unverified", amber awaiting states naming the stage and time, red "not ordered", grey stale with the old date. A red "Critical value" badge sits beside the tick whenever `critical_warning` is true, and the item shows the value.
- Actions: "Order missing labs" (8.1), "Enter outside result" sheet per item (8.2), "Waive" per item (8.3).
- Case header: an amber strip when any required item is missing; the critical badge repeats there.

**As built — Staff.**

- **Gate-changing statuses are confirmed.** `pending` is the only status that
  does not move the start gate, so it is the only one that goes straight
  through; every other status opens a confirmation naming the check and the
  status.
- **A pass over a critical value names the items and requires a reason.** The
  dialog lists the critical items (`critical_value` alone does not tell the
  person which value they are passing) and refuses an empty reason box, because
  the typed text becomes the override reason on the `CRITICAL_LAB_ACKNOWLEDGED`
  safety review (§8.4) — an empty box would file boilerplate saying a critical
  value was acknowledged and saying nothing about why. Where automation owns the
  check, the dialog also warns that it may set the status back. Naming the
  items depends on having them: the backend blanks `critical_items` for roles
  outside the serology audience (§9) and a degraded read can leave
  `lab_readiness` null altogether, so when the list is empty the dialog falls
  back to an unnamed "critical value present" line rather than rendering the
  naming copy with an empty slot in it — the gate itself does not soften,
  `reasonRequired` still follows the critical flag either way.
- **A status change aborts silently if the card was rebound to another case
  while the confirm dialog stood open.** The list is rebound whenever the date
  changes, the worklist refreshes, or a poll replaces it; the case id is
  captured before the dialog awaits, and the write is dropped with no snackbar
  if that id no longer matches by the time the dialog resolves — the operator
  is already looking at a different case, and a message about the old one
  would only confuse.
- **The outside-result sheet has no defaults**: the serology value starts null
  (a pre-selected "Non-reactive" turns an unread form into a filed marker) and
  so does the report date (defaulting it to today would date a months-old report
  as today's). The date's upper bound is the ward's today.
- **Waive is driven by the server's `missing[]`**, not by a client-side
  re-derivation of availability.
- The header's amber strip and critical badge are read from the **loaded
  checklist**, never from the case-list payload's cleared/total counts — a case
  can be 8/8 on the check rows and still be sitting on a potassium of 6.9. The
  case list carries no readiness summary, so the strip appears once the card's
  checklist has loaded.
- The checklist keeps its state across rebuilds (`AutomaticKeepAliveClientMixin`
  plus a `didUpdateWidget` reload) and every card, action and dialog carries a
  stable `ValueKey`.

Admin (Next.js): settings editor for §6.1 under `dashboard/quality/cath`, beside the reprocessing policy tab from the companion spec.

**As built.** The settings endpoints are **`GET`/`PUT /api/v1/cath-reprocessing/lab-readiness-settings`
on the companion spec's governance mount**, not the admin cath-consumables
barrel. The barrel's mount gate (`ADMIN_ROUTE_ROLES`: SUPER_ADMIN/ADMIN) never
admitted QUALITY_OFFICER or INFECTION_CONTROL_OFFICER, and a route-level
`requireRole` under a prefix mount can only subtract from what the mount already
admits — the prefix-mount lockout class. Lab readiness policy is tenant-wide
clinical governance owned by the same officers as the reprocessing policy, so it
shares their mount and their audience
(`CATH_REPROCESSING_POLICY_ROUTE_ROLES`) and their idempotency scope
(`cath_reprocessing_policy`: one screen, one command rail). See the companion
spec §9.5.

## 11. Error handling

**As built** — the table below is the shipped set. Every code reaches the client
at the **envelope root**, not under `details`: `relayAppError` lifts an
`AppError`'s code through `responseHelper`'s `topLevel` mechanism, and the
router's own `:item` guard answers in the same shape, so a client reads one
envelope whichever layer refused.

| Code | HTTP | When |
|---|---|---|
| `CATH_LAB_READINESS_ITEM_UNKNOWN` | 400 | item outside the seven — from the route's `:item` guard (before an idempotency key is burned) and from the service |
| `CATH_LAB_READINESS_VALUE_INVALID` | 400 | qualitative token unrecognised, numeric missing/negative/≥1e11, unit missing, non-calendar or future date, waive with no reason |
| `CATH_LAB_READINESS_ITEMS_EMPTY` | 400 | settings PUT with an explicitly empty `required_items` (migration 766 requires ≥1) |
| `CATH_LAB_READINESS_ORDER_FAILED` | **500** | order service refused; carries `details.code`, `details.cause` and `details.created` so a retry does not double the orders already placed |
| `CATH_LAB_READINESS_CASE_STARTED` | 409 | order or external entry attempted after `actual_start_at` |
| `CATH_LAB_READINESS_REASON_REQUIRED` | 400 | a human `pass` on the `labs` check while the stored check metadata carries `critical_warning: true`, with `notes` empty — decided from the locked prior row, not the request's own metadata, and thrown before anything is written; the safety review's override reason (§8.4) is then always the clinician's text |
| `CATH_LAB_READINESS_REVIEW_FAILED` | 500 | a human pass over a critical warning did not persist its safety review (§8.4) |
| `CATH_LAB_BAD_UUID` / `CATH_LAB_BAD_ID` | 400 | a UUID or positive-integer parameter that would not survive its SQL cast |
| `LAB_RESULT_ORIGIN_NOT_ALLOWED` | 400 | the public `POST /api/v1/lab/results` was sent any of the four origin fields |
| `LAB_RESULT_EXTERNAL_PROVENANCE_REQUIRED` | 400 | the internal external entry point was called without `result_origin=external_lab` + a non-blank lab name + a report date |
| `LAB_RESULT_ORDER_LINK_REQUIRED` | 400 | unchanged on the public lab route; the escape applies only to the internal entry point |

**`ORDER_FAILED` is 500, not the 502 designed above.** `AppError` offers no
gateway constructor, and the failure is in-process (the order service is a
module call, not a network hop). It is constructed directly so the code *and*
the partial progress survive — `AppError.internal(message, code)` silently drops
a third argument, which is how this used to reach the ward as a bare
`INTERNAL_ERROR`. Whether the surface should answer 502 instead is §16.

All writes run inside `setTenantTx`; refresh-on-event never propagates errors into the lab write.

**Idempotency.** All three write routes claim a key (`required: true`; scopes
`cath_lab_readiness_order`, `cath_lab_readiness_external`,
`cath_lab_readiness_waive`), and the case guard runs **before** the claim so a
request that can never succeed does not burn one. The external-result route
forwards the claimed **key** to the lab rail but deliberately **not** the claim's
row id or body hash: those would make the lab layer finalise *this* route's HTTP
claim from inside the lab transaction, so a replay would answer 200 with the lab
service's payload instead of this route's published 201, and a 5xx raised after
that transaction commits (the marker write, the audit and the refresh are all
still to come) could neither release nor re-finalise the claim. The lab rail
keeps its own content-derived fingerprint, which is also what makes an `hiv`, an
`hbsag` and an `hcv` entry sent under one `Idempotency-Key` three distinct
commands rather than one.

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
- **A booking in `RESULT_READY` is invisible to the resolver, and order-missing
  may duplicate its draw.** `RESULTABLE_BOOKING_STATUSES` (§7 step 2) excludes
  `RESULT_READY` on the reasoning that once a result is in, the `lab_results` row
  is the evidence. On this platform, though, `RESULT_READY` means a result
  **file** was uploaded, not that structured rows exist — and such a booking can
  no longer accept a structured row, so no `lab_results` row will ever arrive for
  it. The item therefore resolves as `not_ordered`, the checklist tells the ward
  to order a test that has already been done, and "Order missing labs" places a
  second draw. Nothing is lost or mis-stated clinically; the cost is a duplicate
  order and a re-stick. Owner call (§16): accept this, or spec a "result file
  only" item state that reads the uploaded report.
- `critical_warning` stays true for a role outside the serology audience even
  when the only critical item is a serology marker (§9). It says a critical
  value exists without naming it, which is the intended advisory, but a
  receptionist can infer *something* came back critical on a case whose other
  six items are unremarkable.

## 16. Owner decisions pending

Three questions were reached during the build and deliberately left open rather
than settled in code:

1. **A tenant-wide reference-range fallback in the governed threshold layer.**
   §8.2 as built does not derive `abnormal_flag` for outside values, because
   `labThresholdExceptionService` owns the column for every writer and nulls it
   where no policy matches (`criticality_status = 'threshold_unavailable'`). If
   a tenant wants outside values flagged where no analyte policy exists, the
   fallback belongs in the **threshold layer**, applying to in-house and outside
   rows alike — not in the cath path, which would make the two disagree. Owner
   decision: add it, or accept unflagged values for unpoliced analytes.
2. **`CATH_LAB_READINESS_ORDER_FAILED`: 502 or 500?** Shipped as 500 with the
   code and `details.created` (§11). The design said 502. Owner decision on the
   status; the code and details stay either way.
3. **The `RESULT_READY` booking state (§15).** Accept the duplicate-draw hole as
   a recorded risk, or spec a "result file only" state so the checklist reads
   the uploaded report and order-missing stands down.
