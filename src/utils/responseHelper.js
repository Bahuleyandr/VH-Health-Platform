// utils/responseHelper.js

/**
 * Standard success response handler.
 * @param {Object} res - Express response object.
 * @param {any} data - Payload to return.
 * @param {string} message - Optional success message.
 * @param {number} status - Optional HTTP status code, defaults to 200.
 */
exports.success = (res, data, message = 'Success', status = 200) => {
  res.status(status).json({
    success: true,
    message,
    data,
  });
};

/**
 * Standard error response handler.
 * @param {Object} res - Express response object.
 * @param {string} message - Error message.
 * @param {number} status - Optional HTTP status code, defaults to 500.
 * @param {any} details - Optional detailed error information.
 */
exports.error = (res, message = 'Error', status = 500, details = null) => {
  res.status(status).json({
    success: false,
    message,
    ...(details && { details }),
  });
};
