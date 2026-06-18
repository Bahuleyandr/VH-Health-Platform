import { success } from '../../../utils/responseHelper.js';
import {
  listOperationalAlerts, decideOperationalAlert, runSweep,
} from '../../../services/ai/operationalAlertService.js';

export async function list(req, res, next) {
  try {
    const data = await listOperationalAlerts({
      tenantId: req.tenantId, domain: req.query.domain || null,
      severity: req.query.severity || null, systemStatus: req.query.system_status || null,
      reviewerDecision: req.query.reviewer_decision || null, limit: req.query.limit,
    });
    return success(res, data, 'Operational alerts');
  } catch (err) { return next(err); }
}

export async function decide(req, res, next) {
  try {
    const data = await decideOperationalAlert({
      tenantId: req.tenantId, alertId: req.params.id,
      decision: req.body?.decision, reviewerUid: req.user?.uid || null, note: req.body?.note || null,
    });
    return success(res, data, 'Operational alert decision recorded');
  } catch (err) { return next(err); }
}

export async function sweep(req, res, next) {
  try {
    const data = await runSweep({ tenantId: req.tenantId });
    return success(res, data, 'Operational alert sweep complete');
  } catch (err) { return next(err); }
}
