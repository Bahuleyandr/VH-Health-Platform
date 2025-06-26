import * as pharmacyService from '../../services/staff/pharmacyService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

// Update pharmacy order status
export const updatePharmacyOrder = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const staffUid = req.user?.uid;
    const staffRole = req.user?.role;
    const staffName = req.user?.name;

    // Verify staff has permission
    if (!['PHARMACY_STAFF', 'ADMIN'].includes(staffRole)) {
      return error(res, 'Insufficient permissions to update pharmacy orders', HTTP_STATUS.FORBIDDEN);
    }

    const result = await pharmacyService.updatePharmacyOrderStatus({
      ...req.body,
      phone,
      updatedBy: staffUid,
      updatedByName: staffName
    });

    success(res, result, 'Pharmacy order updated successfully');
  } catch (err) {
    logger.error('Update Pharmacy Order Error:', err);
    
    if (err.message === 'ORDER_NOT_FOUND') {
      error(res, 'Pharmacy order not found', HTTP_STATUS.NOT_FOUND);
    } else {
      error(res, 'Failed to update pharmacy order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};