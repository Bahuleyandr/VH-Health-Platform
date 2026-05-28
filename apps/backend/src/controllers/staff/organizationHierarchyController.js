import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { getOrganizationHierarchy as loadOrganizationHierarchy } from '../../services/staff/organizationHierarchyService.js';
import { success, error } from '../../utils/responseHelper.js';

export const getOrganizationHierarchy = async (req, res) => {
  try {
    const chart = await loadOrganizationHierarchy({ tenantId: req.tenantId });
    return success(res, chart, 'Organization hierarchy retrieved successfully');
  } catch (err) {
    logger.error('Organization hierarchy retrieval failed:', err);
    return error(res, 'Failed to retrieve organization hierarchy', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
