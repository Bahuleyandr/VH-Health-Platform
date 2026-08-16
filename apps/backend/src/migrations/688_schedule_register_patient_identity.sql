-- 688_schedule_register_patient_identity.sql
--
-- PR #875 adversarial-review fix (group 3, pharmacy MEDIUM): a scheduled-drug
-- (Schedule H1/X/narcotic) walk-in counter sale wrote a statutory
-- pharmacy_schedule_register row with NO patient identity — patient_uid is
-- nullable (correct: anonymous walk-ins have no chart) and the register had
-- no columns for the captured customer identity, so an anonymous H1/X sale
-- produced a register entry that names the item, batch, prescriber and
-- witness but not WHO the drug was handed to. The Schedule H1 register
-- (Drugs & Cosmetics Rules, 1945 — rule 65(3)/97) and the Schedule X account
-- both require the patient's name and address/contact on the dispense entry.
--
-- Fix, two halves:
--   * schema (here): pharmacy_schedule_register gains patient_name +
--     patient_phone snapshot columns; the pharmacy_schedule_register_full
--     read view appends them. Nullable — historical rows and non-counter
--     flows that link a registered patient carry identity via patient_uid.
--   * service (same commit): counterSaleService rejects anonymous H1/X/
--     narcotic sales that lack customer_name + customer_phone
--     (COUNTER_SALE_SCHEDULED_IDENTITY_REQUIRED) and writes the identity
--     (registered patient's name/phone, or the captured walk-in identity)
--     into every counter-sale register row, dispense and return direction.
--     OTC and plain Schedule H anonymous sales are unchanged.

BEGIN;

ALTER TABLE pharmacy_schedule_register
  ADD COLUMN IF NOT EXISTS patient_name  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS patient_phone VARCHAR(20);

-- CREATE OR REPLACE VIEW: existing columns keep their order; the two new
-- identity columns append at the end (a Postgres replace-view requirement).
CREATE OR REPLACE VIEW public.pharmacy_schedule_register_full AS
 SELECT r.id,
    r.tenant_id,
    r.created_at,
    r.schedule_class,
    r.movement_kind,
    i.sku_code,
    i.display_name,
    i.generic_name,
    i.brand_name,
    i.strength,
    i.form,
    b.batch_number,
    b.expiry_date,
    r.quantity,
    r.unit_label,
    r.running_balance,
    r.patient_uid,
    r.prescription_number,
    r.prescriber_name,
    r.prescriber_registration,
    r.patient_id_proof_type,
    r.patient_id_proof_last4,
    r.performed_by_name,
    r.witness_name,
    r.notes,
    r.patient_name,
    r.patient_phone
   FROM ((public.pharmacy_schedule_register r
     JOIN public.pharmacy_inventory_items i ON ((i.id = r.inventory_item_id)))
     LEFT JOIN public.pharmacy_inventory_batches b ON ((b.id = r.inventory_batch_id)));

COMMENT ON COLUMN pharmacy_schedule_register.patient_name IS
  'Patient identity snapshot for the statutory entry: the registered patient''s name, or the captured walk-in customer name. Service-enforced NOT NULL for counter-sale H1/X/narcotic dispenses (COUNTER_SALE_SCHEDULED_IDENTITY_REQUIRED).';
COMMENT ON COLUMN pharmacy_schedule_register.patient_phone IS
  'Patient contact snapshot paired with patient_name; required with it for anonymous walk-in H1/X/narcotic counter sales.';

COMMIT;
