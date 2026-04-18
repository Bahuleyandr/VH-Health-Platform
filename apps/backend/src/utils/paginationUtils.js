// src/utils/paginationUtils.js

/**
 * Extract pagination parameters from request query.
 * Provides defaults if not specified.
 * Enforces a maximum limit to prevent DoS via unbounded queries.
 *
 * @param {Object} query - The request query object.
 * @param {Object} [options] - Optional overrides.
 * @param {number} [options.defaultLimit=20] - Default limit if not specified.
 * @param {number} [options.maxLimit=100] - Maximum allowed limit.
 * @returns {Object} - Contains page, limit, offset.
 */
export function getPaginationParams(query, options = {}) {
  const defaultLimit = options.defaultLimit || 20;
  const maxLimit = options.maxLimit || 100;
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || defaultLimit, 1), maxLimit);
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Safe extraction of limit/offset from query params.
 * Use this for endpoints that take limit+offset directly (not page-based).
 * Enforces bounds: limit capped at maxLimit, offset >= 0.
 *
 * @param {Object} query - The request query object.
 * @param {Object} [options] - Optional overrides.
 * @param {number} [options.defaultLimit=20] - Default limit.
 * @param {number} [options.maxLimit=100] - Maximum allowed limit.
 * @returns {{ limit: number, offset: number }}
 */
export function safePagination(query, options = {}) {
  const defaultLimit = options.defaultLimit || 20;
  const maxLimit = options.maxLimit || 100;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
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
