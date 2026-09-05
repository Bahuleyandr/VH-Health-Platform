// apps/backend/src/middleware/labResultOriginGuard.js
//
// The public manual-result route may not choose a provenance. Outside-lab
// values enter only through the cath readiness checklist (spec
// 2026-09-04-cath-pre-procedure-lab-readiness §6.3, §8.2), which is the only
// caller of labResultsService.recordExternalLabResultRow — the internal entry
// point no route imports — and the only one that can name the laboratory and
// the report date.
//
// recordResultManual, which this route DOES call, has no way to ask for an
// outside origin at all: it forces result_origin to 'manual_in_house' and nulls
// the three external columns. So this middleware is not the thing that keeps
// the data honest — it is the thing that says so out loud. Silently dropping a
// field a client sent looks like acceptance; a 400 naming the field does not.
import { HTTP_STATUS } from '../config/responseCodes.js';
import { error } from '../utils/responseHelper.js';

export const LAB_RESULT_ORIGIN_FIELDS = Object.freeze([
  'result_origin', 'external_lab_name', 'external_report_ref', 'external_reported_on',
]);

export function rejectLabResultOriginFields(req, res, next) {
  const body = req.body || {};
  const present = LAB_RESULT_ORIGIN_FIELDS.filter((field) => body[field] !== undefined);
  if (present.length) {
    return error(
      res,
      `Fields not allowed on this route: ${present.join(', ')}`,
      HTTP_STATUS.BAD_REQUEST,
      { code: 'LAB_RESULT_ORIGIN_NOT_ALLOWED', fields: present },
    );
  }
  return next();
}
