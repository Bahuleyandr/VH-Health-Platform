// utils/paginationUtils.js

/**
 * Extract pagination parameters from request query.
 * Provides defaults if not specified.
 *
 * @param {Object} query - The request query object.
 * @returns {Object} - Contains page, limit, offset.
 */
function getPaginationParams(query) {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.max(parseInt(query.limit) || 10, 1);
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Formats paginated response payload.
 *
 * @param {number} page - Current page number.
 * @param {number} limit - Number of items per page.
 * @param {Array} data - The actual data array.
 * @returns {Object} - Formatted paginated response.
 */
function formatPaginatedResponse(page, limit, data) {
  return {
    page,
    limit,
    count: data.length,
    data,
  };
}

module.exports = {
  getPaginationParams,
  formatPaginatedResponse,
};
