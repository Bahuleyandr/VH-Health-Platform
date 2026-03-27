// src/utils/responseHelper.js
/**
 * Standard success response.
 * @param {Response} res - Express response
 * @param {*} data - Response payload
 * @param {string} message - Human-readable message
 * @param {number} status - HTTP status (default 200)
 * @param {Object} meta - Optional metadata (pagination, etc.)
 */
export function success(res, data, message = 'Success', status = 200, meta = {}) {
  const response = {
    success: true,
    message,
    data,
  };

  // Include request ID for correlation if available
  if (res.req?.id) {
    response.requestId = res.req.id;
  }

  // Merge optional metadata (pagination, etc.)
  if (Object.keys(meta).length > 0) {
    response.meta = meta;
  }

  res.status(status).json(response);
}

/**
 * Standard error response.
 * @param {Response} res - Express response
 * @param {string} message - Error message (generic, safe for clients)
 * @param {number} statusCode - HTTP status (default 500)
 * @param {*} details - Optional error details (validation errors, etc.)
 */
export function error(res, message = 'Internal server error', statusCode = 500, details = null) {
  const response = {
    success: false,
    message,
  };

  if (res.req?.id) {
    response.requestId = res.req.id;
  }

  if (details) {
    response.details = details;
  }

  res.status(statusCode).json(response);
}