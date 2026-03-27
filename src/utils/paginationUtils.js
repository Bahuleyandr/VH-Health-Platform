// src/utils/paginationUtils.js

/**
 * Extract pagination parameters from request query.
 * Provides defaults if not specified.
 *
 * @param {Object} query - The request query object.
 * @returns {Object} - Contains page, limit, offset.
 */
export function getPaginationParams(query) {
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
 * @param {number} [total] - Optional total count of all matching records (for computing totalPages/hasNext).
 * @returns {Object} - Formatted paginated response.
 */
export function formatPaginatedResponse(page, limit, data, total) {
  const response = {
    page,
    limit,
    count: data.length,
    data
  };

  if (total !== undefined && total !== null) {
    response.total = total;
    response.totalPages = Math.ceil(total / limit);
    response.hasNext = page * limit < total;
    response.hasPrev = page > 1;
  }

  return response;
}
