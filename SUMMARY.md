# Weekly Drift Sweep — 2026-05-11

## Run metadata

| Item | Value |
|---|---|
| Timestamp | 2026-05-11 |
| Branch | `chore/drift-sweep-2026-05-11` |
| Code-drift scanner exit code | **1 (drift found)** |
| Schema-drift check (`check:schema-drift`) | **Skipped — `DATABASE_URL` not set** |

## Scanner output (full stdout)

```
# scan-code-drift: parsed 387 tables from schema.prisma
# scan-code-drift: scanning 909 .js files under src/
✗ 9 code↔schema drift finding(s):


## appointments
  INSERT .parent_appointment_id  —  apps/backend/src/controllers/appointment/appointmentWorkflowController.js:757
    INSERT INTO appointments (patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes, status, confirmed_at, token_number, department, created_by, updated_at, visit_type, parent_appointment_id) VALUES ($1, $2, NOW(), $3,…

## maternity_anc_visits
  INSERT .visit_number  —  apps/backend/src/services/maternity/maternityService.js:156
    INSERT INTO maternity_anc_visits (pregnancy_id, visit_date, visit_number, gestational_age_weeks, weight_kg, bp_systolic, bp_diastolic, pulse_bpm, fundal_height_cm, fetal_heart_rate_bpm, fetal_movements_felt, presentation, edema, pallor, hb_…

## radiology_orders
  UPDATE .acquired_at  —  apps/backend/src/services/radiology/radiologyService.js:260
    UPDATE radiology_orders SET status = 'acquired', acquired_at = NOW(), acquired_by = $1::uuid, acquired_by_name = $2, tech_uid = COALESCE(tech_uid, $1::uuid), tech_name = COALESCE(tech_name, $2), updated_at = NOW() WHERE id = $3 RETURNING __…
  UPDATE .acquired_by  —  apps/backend/src/services/radiology/radiologyService.js:260
    UPDATE radiology_orders SET status = 'acquired', acquired_at = NOW(), acquired_by = $1::uuid, acquired_by_name = $2, tech_uid = COALESCE(tech_uid, $1::uuid), tech_name = COALESCE(tech_name, $2), updated_at = NOW() WHERE id = $3 RETURNING __…
  UPDATE .acquired_by_name  —  apps/backend/src/services/radiology/radiologyService.js:260
    UPDATE radiology_orders SET status = 'acquired', acquired_at = NOW(), acquired_by = $1::uuid, acquired_by_name = $2, tech_uid = COALESCE(tech_uid, $1::uuid), tech_name = COALESCE(tech_name, $2), updated_at = NOW() WHERE id = $3 RETURNING __…
  UPDATE .report_signed_off_at  —  apps/backend/src/services/radiology/radiologyService.js:292
    UPDATE radiology_orders SET report_signed_off_at = NOW(), report_signed_off_by = $1::uuid, updated_at = NOW() WHERE id = $2 RETURNING __INTERP__, report_signed_off_at, report_signed_off_by
  UPDATE .report_signed_off_by  —  apps/backend/src/services/radiology/radiologyService.js:292
    UPDATE radiology_orders SET report_signed_off_at = NOW(), report_signed_off_by = $1::uuid, updated_at = NOW() WHERE id = $2 RETURNING __INTERP__, report_signed_off_at, report_signed_off_by
  UPDATE .tech_name  —  apps/backend/src/services/radiology/radiologyService.js:260
    UPDATE radiology_orders SET status = 'acquired', acquired_at = NOW(), acquired_by = $1::uuid, acquired_by_name = $2, tech_uid = COALESCE(tech_uid, $1::uuid), tech_name = COALESCE(tech_name, $2), updated_at = NOW() WHERE id = $3 RETURNING __…
  UPDATE .tech_uid  —  apps/backend/src/services/radiology/radiologyService.js:260
    UPDATE radiology_orders SET status = 'acquired', acquired_at = NOW(), acquired_by = $1::uuid, acquired_by_name = $2, tech_uid = COALESCE(tech_uid, $1::uuid), tech_name = COALESCE(tech_name, $2), updated_at = NOW() WHERE id = $3 RETURNING __…
```

---

## Per-table findings

### `appointments` — 1 finding

| Column in code | Prisma schema has | Classification |
|---|---|---|
| `parent_appointment_id` | *(absent)* | **Real schema gap** |

**File:** `apps/backend/src/controllers/appointment/appointmentWorkflowController.js:757`

The `appointments` model in `prisma/schema.prisma` (line 709) has no `parent_appointment_id` column and no similar rename candidate (`parent_id`, `follow_up_id`, etc.). The column is referenced in an INSERT for follow-up/recurring appointment creation. The schema needs a new nullable FK column pointing back to `appointments.id`.

---

### `maternity_anc_visits` — 1 finding

| Column in code | Prisma schema has | Classification |
|---|---|---|
| `visit_number` | *(absent)* | **Real schema gap** |

**File:** `apps/backend/src/services/maternity/maternityService.js:156`

The `maternity_anc_visits` model (line 9524) has no `visit_number` column. The existing fields are a continuous auto-incremented `id` plus temporal fields; there is no sequencing field that could be a rename. The service inserts a visit sequence number that is not persisted in the schema.

---

### `radiology_orders` — 7 findings

| Column in code | Prisma schema has | Classification |
|---|---|---|
| `acquired_at` | *(absent)* | **Real schema gap** |
| `acquired_by` | *(absent)* | **Real schema gap** |
| `acquired_by_name` | *(absent)* | **Real schema gap** |
| `tech_uid` | *(absent)* | **Real schema gap** |
| `tech_name` | *(absent)* | **Real schema gap** |
| `report_signed_off_at` | `report_completed_at` (line 6974) | **Rename candidate** |
| `report_signed_off_by` | *(absent)* | **Real schema gap** |

**File:** `apps/backend/src/services/radiology/radiologyService.js:260,292`

The `radiology_orders` model (line 6962) is sparse — it was seeded with an early schema. The code implements a richer acquisition + sign-off workflow that was never back-ported to the Prisma model.

- **Rename candidate:** `report_completed_at` (schema) ↔ `report_signed_off_at` (code). Both capture the moment a radiology report is finalized. Confirm with the radiology team which name is canonical before migrating; if the live DB column is `report_completed_at` the service code needs updating, not the schema.
- **Real gaps (6 columns):** `acquired_at`, `acquired_by`, `acquired_by_name`, `tech_uid`, `tech_name`, and `report_signed_off_by` are entirely absent from the Prisma model. These represent the full "image acquisition" workflow step added to the service layer without a corresponding migration or schema update.

---

## Summary counts

| Classification | Count |
|---|---|
| Real schema gaps (column missing entirely) | 8 |
| Rename candidates (DB column exists under different name) | 1 |
| **Total findings** | **9** |

## Recommended next steps

1. **`radiology_orders.report_signed_off_at` / `report_completed_at`** — confirm with team which name is in the live DB (run `\d radiology_orders` on the Postgres cluster). If the DB column is `report_completed_at`, update `radiologyService.js:292` to use that name; if the DB column is already `report_signed_off_at`, add it to `schema.prisma` and remove `report_completed_at`.
2. **`radiology_orders` acquisition columns** — write a migration (`acquired_at TIMESTAMPTZ`, `acquired_by UUID`, `acquired_by_name VARCHAR(100)`, `tech_uid UUID`, `tech_name VARCHAR(100)`, `report_signed_off_by UUID`) and add to `prisma/schema.prisma`. This unblocks the acquisition workflow in production.
3. **`appointments.parent_appointment_id`** — add a nullable self-referencing FK column (`parent_appointment_id INT REFERENCES appointments(id)`) and update `schema.prisma`.
4. **`maternity_anc_visits.visit_number`** — add `visit_number INT` (ideally with a unique constraint on `(pregnancy_id, visit_number)`) and update `schema.prisma`.
5. **Re-run schema-drift check** with `DATABASE_URL` set to confirm which gaps are already present in the live DB vs only in code.
