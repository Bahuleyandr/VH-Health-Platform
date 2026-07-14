-- 577 — D7 A-1: DB-enforced newborn identity uniqueness (Shape 3, signed 2026-07-15).
--
-- Decision record: _codex artifacts obgyn-d7-decision-record.md
-- (SHA-256 E82EEC9A054CA3708A31F48568818BB27F9986D8F5A02C37AF9407F4D5DB9562).
--
-- 1. One patient identity can back at most ONE maternity newborn row per
--    tenant. This is the structural backstop for the E-c1 in-transaction
--    re-check: post-577 the "multiple newborns for one uid" ambiguity the
--    O1 reconciliation report classifies (multiple_newborns/multiple_doses)
--    can no longer be created; those report reasons remain for residual
--    pre-577 data only (prod is H-1-attested empty).
CREATE UNIQUE INDEX uq_maternity_newborns_tenant_patient_uid
    ON public.maternity_newborns USING btree (tenant_id, newborn_patient_uid)
    WHERE (newborn_patient_uid IS NOT NULL);

-- 2. Per-delivery birth_order uniqueness (Twin-1/Twin-2 slots cannot repeat).
--    Replaces the non-unique idx_maternity_newborns_delivery on the same
--    column pair; the unique index serves the same lookups.
CREATE UNIQUE INDEX uq_maternity_newborns_delivery_birth_order
    ON public.maternity_newborns USING btree (delivery_id, birth_order);

DROP INDEX IF EXISTS public.idx_maternity_newborns_delivery;
