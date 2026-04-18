import logger from '../../logging/logger.js';
import * as analyticsService from '../../services/pharmacy/analyticsService.js';
import { success } from '../../utils/responseHelper.js';

// Get pharmacy analytics
export const getAnalytics = async (req, res) => {
  try {
    const requestedBy = req.user?.uid || 'anonymous';

    const analytics = await analyticsService.getPharmacyAnalytics();

    success(res, {
      analytics,
      period: 'Last 30 days',
      requestedBy
    }, 'Pharmacy analytics retrieved successfully');
  } catch (err) {
    logger.error('Pharmacy Analytics Error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve pharmacy analytics'
    });
  }
};