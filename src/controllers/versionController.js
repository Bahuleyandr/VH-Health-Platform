// src/controllers/versionController.js

import { success } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';

/**
 * ✅ Return current API version information
 */
export function getAppVersion(req, res) {
  const versionInfo = {
    version: '1.0.0',
    updated_at: '2025-05-12',
    message: 'VH Health API Version 1.0.0 - Initial Release'
  };

  logger.info('[Version]', 'App version fetched', versionInfo);
  success(res, versionInfo, 'App version fetched successfully');
}
