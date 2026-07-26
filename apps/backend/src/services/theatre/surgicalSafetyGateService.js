import { AppError } from '../../utils/AppError.js';

export async function assertWhoSignInComplete({
  db,
  tenantId,
  otScheduleId,
  message = 'WHO sign-in must be completed before anesthesia or the procedure starts',
} = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id
       FROM surgical_safety_checklists
      WHERE tenant_id = $1::uuid
        AND ot_schedule_id = $2::int
        AND phase = 'sign_in'
        AND status = 'complete'
        AND all_items_confirmed = TRUE
        AND jsonb_typeof(items) = 'array'
        AND jsonb_array_length(items) > 0
        AND NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements(items) AS item
           WHERE jsonb_typeof(item) <> 'object'
              OR item->>'confirmed' IS DISTINCT FROM 'true'
        )
        AND outstanding_items = '[]'::jsonb
        AND performed_by IS NOT NULL
        AND performed_at IS NOT NULL
      LIMIT 1
      FOR SHARE`,
    tenantId,
    Number(otScheduleId),
  );
  if (!rows[0]) {
    throw AppError.badRequest(message, 'WHO_SIGNIN_REQUIRED');
  }
  return rows[0];
}
