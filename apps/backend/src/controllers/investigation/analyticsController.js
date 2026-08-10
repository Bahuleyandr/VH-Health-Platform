import logger from '../../logging/logger.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import * as analyticsService from '../../services/investigation/analyticsService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';

// Get investigation statistics
export const getInvestigationStatistics = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const requestedBy = req.user?.uid;

    const statistics = await analyticsService.getInvestigationStats(days);

    await logAudit(req, 'investigation-stats-viewed', { period_days: days });

    success(res, {
      statistics,
      period_days: days,
      generatedBy: requestedBy,
      timestamp: new Date().toISOString()
    }, 'Investigation statistics retrieved successfully');

  } catch (err) {
    logger.error('Get Statistics Error:', err);
    error(res, 'Failed to retrieve investigation statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
