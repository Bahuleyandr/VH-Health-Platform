import * as analyticsService from '../../services/investigation/analyticsService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { logAudit } from '../../utils/logAudit.js';

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
    
    // Graceful fallback
    success(res, {
      statistics: {
        totals: { total_investigations: 0, pending: 0, completed: 0, cancelled: 0 },
        by_type: [],
        by_status: [],
        daily_activity: []
      },
      message: 'Investigation statistics temporarily unavailable',
      generatedBy: req.user?.uid
    }, 'Investigation statistics service status');
  }
};