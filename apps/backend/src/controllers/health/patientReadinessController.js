import logger from '../../logging/logger.js';
import { evaluatePatientReadiness } from '../../services/health/patientReadinessService.js';
import { error, success } from '../../utils/responseHelper.js';

export async function getPatientReadiness(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await evaluatePatientReadiness({
      tenantId: req.tenantId,
      routeKind: req.get('x-vh-route-kind'),
    });
    if (result.statusCode === 200) {
      return success(res, result.payload, 'Patient readiness confirmed');
    }
    if (result.internalError) {
      logger.warn('Patient readiness check failed closed', {
        state: result.payload.state,
        error: result.internalError.message,
      });
    }
    return error(
      res,
      'Patient readiness is unavailable',
      result.statusCode,
      {
        safe: true,
        topLevel: { code: 'PATIENT_NOT_READY' },
        readiness: result.payload,
      },
    );
  } catch (err) {
    logger.error('Patient readiness controller failed:', err);
    return error(
      res,
      'Patient readiness is unavailable',
      503,
      {
        safe: true,
        topLevel: { code: 'PATIENT_NOT_READY' },
      },
    );
  }
}
