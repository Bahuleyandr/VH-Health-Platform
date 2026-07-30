import logger from '../../logging/logger.js';
import { evaluateClientReadiness } from '../../services/health/clientReadinessService.js';
import { error, success } from '../../utils/responseHelper.js';

export async function getClientReadiness(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await evaluateClientReadiness({
      tenantId: req.tenantId,
      routeKind: req.get('x-vh-route-kind'),
    });
    if (result.statusCode === 200) {
      return success(res, result.payload, 'Client readiness confirmed');
    }
    if (result.internalError) {
      logger.warn('Client readiness check failed closed', {
        state: result.payload.state,
        error: result.internalError.message,
      });
    }
    return error(
      res,
      'Client readiness is unavailable',
      result.statusCode,
      {
        safe: true,
        topLevel: { code: 'CLIENT_NOT_READY' },
        readiness: result.payload,
      },
    );
  } catch (err) {
    logger.error('Client readiness controller failed:', err);
    return error(
      res,
      'Client readiness is unavailable',
      503,
      {
        safe: true,
        topLevel: { code: 'CLIENT_NOT_READY' },
      },
    );
  }
}
