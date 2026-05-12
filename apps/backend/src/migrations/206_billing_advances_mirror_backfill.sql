-- Mirror existing IPD advance_deposits into billing_advances so the
-- cashier can see and settle them against the final invoice. Pairs
-- with the runtime bridge added to ipdSupportService.collectAdvanceDeposit
-- (and refundAdvanceDeposit) — this DML backfills the rows collected
-- before the bridge existed.
--
-- The reference column carries `IPD/<receipt_number>` so the refund
-- path can find the corresponding mirror row deterministically.
-- Balance starts at amount minus the sum of any refund siblings.
--
-- Finding: 2026-05-10-inpatient-admission-billing-advance-deposit-not-netted.

INSERT INTO billing_advances
  (patient_uid, admission_id, amount, balance, mode, reference, collected_by, collected_at, notes, status, tenant_id)
SELECT
  parent.patient_uid,
  parent.admission_id,
  parent.amount,
  GREATEST(
    parent.amount + COALESCE((
      SELECT SUM(r.amount)
        FROM advance_deposits r
       WHERE r.parent_deposit_id = parent.id
         AND r.is_refund = true
    ), 0)::numeric,
    0::numeric
  ),
  parent.payment_method,
  'IPD/' || parent.receipt_number,
  parent.collected_by,
  parent.collected_at,
  parent.notes,
  CASE
    WHEN GREATEST(
      parent.amount + COALESCE((
        SELECT SUM(r.amount) FROM advance_deposits r
         WHERE r.parent_deposit_id = parent.id AND r.is_refund = true
      ), 0)::numeric,
      0::numeric
    ) <= 0.005 THEN 'EXHAUSTED'
    ELSE 'ACTIVE'
  END,
  COALESCE(parent.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM advance_deposits parent
 WHERE parent.is_refund = false
   AND NOT EXISTS (
     SELECT 1 FROM billing_advances ba
      WHERE ba.reference = 'IPD/' || parent.receipt_number
   );
