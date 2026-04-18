// src/controllers/health/healthStatsController.js
import { MEDICAL_ROLES } from '../../config/healthConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as healthStatsService from '../../services/health/healthStatsService.js';
import { success, error } from '../../utils/responseHelper.js';

export async function getHealthStatistics(req, res) {
  try {
    // Role-based access control
    if (!MEDICAL_ROLES.includes(req.user?.role)) {
      return error(res, 'Medical staff access required for health statistics', HTTP_STATUS.FORBIDDEN);
    }

    const days = parseInt(req.query.days) || 7;
    
    const statistics = await healthStatsService.getHealthStatistics(days);
    
    success(res, {
      statistics,
      period_days: days,
      requestedBy: req.user?.name,
      timestamp: new Date().toISOString()
    }, 'Health statistics retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    
    // Fallback with mock data
    success(res, {
      statistics: {
        totals: {
          total_records: 0,
          unique_patients: 0,
          recent_records: 0
        },
        by_type: [],
        daily_activity: []
      },
      period_days: parseInt(req.query.days) || 7,
      note: 'Statistics unavailable - health_records table may not exist',
      requestedBy: req.user?.name,
      timestamp: new Date().toISOString()
    }, 'Health statistics retrieved (empty - table may not exist)');
  }
}