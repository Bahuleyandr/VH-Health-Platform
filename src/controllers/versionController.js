// controllers/versionController.js
const { success } = require('../responseHelper');
const logger = require('../logger');

exports.getAppVersion = (req, res) => {
  const versionInfo = {
    version: '1.0.0',
    updated_at: '2025-05-12',
    message: 'VH Health API Version 1.0.0 - Initial Release'
  };

  logger.info('App version fetched', versionInfo);
  success(res, versionInfo, 'App version fetched successfully');
};
