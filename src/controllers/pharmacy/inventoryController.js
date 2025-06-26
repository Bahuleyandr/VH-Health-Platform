import * as inventoryService from '../../services/pharmacy/inventoryService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';

// Get low stock medications
export const getLowStock = async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 10;
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await inventoryService.getLowStockMedications(threshold);

    success(res, {
      ...result,
      requestedBy
    }, 'Low stock medications retrieved successfully');
  } catch (err) {
    logger.error('Get Low Stock Error:', err);
    error(res, 'Failed to retrieve low stock medications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get expired medications
export const getExpired = async (req, res) => {
  try {
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await inventoryService.getExpiredMedications();

    success(res, {
      ...result,
      note: 'These medications should be removed from inventory',
      requestedBy
    }, 'Expired medications retrieved successfully');
  } catch (err) {
    logger.error('Get Expired Error:', err);
    error(res, 'Failed to retrieve expired medications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get expiring soon medications
export const getExpiringSoon = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await inventoryService.getExpiringSoonMedications(days);

    success(res, {
      ...result,
      requestedBy
    }, 'Expiring medications retrieved successfully');
  } catch (err) {
    logger.error('Get Expiring Soon Error:', err);
    error(res, 'Failed to retrieve expiring medications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get medication categories
export const getCategories = async (req, res) => {
  try {
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await inventoryService.getMedicationCategories();

    success(res, {
      ...result,
      requestedBy
    }, 'Medication categories retrieved successfully');
  } catch (err) {
    logger.error('Get Categories Error:', err);
    error(res, 'Failed to retrieve medication categories', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get inventory summary
export const getInventorySummary = async (req, res) => {
  try {
    const requestedBy = req.user?.uid || 'anonymous';

    const summary = await inventoryService.getInventorySummary();

    success(res, {
      summary,
      timestamp: new Date().toLocaleDateString('en-GB'),
      requestedBy
    }, 'Pharmacy inventory summary retrieved successfully');
  } catch (err) {
    logger.error('Inventory Summary Error:', err);
    res.status(500).json({
      message: 'Failed to retrieve inventory summary - some tables may not exist',
      error: err.message,
      suggestion: 'Ensure medications table exists with proper schema',
      requestedBy: req.user?.uid
    });
  }
};