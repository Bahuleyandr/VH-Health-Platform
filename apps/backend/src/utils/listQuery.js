const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 100;

function coercePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeSortOrder(value, fallback = 'DESC') {
  const normalized = String(value || fallback).trim().toUpperCase();
  return normalized === 'ASC' ? 'ASC' : 'DESC';
}

export function normalizeSearch(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseListQuery(query = {}, options = {}) {
  const {
    defaultPage = DEFAULT_PAGE,
    defaultLimit = DEFAULT_LIMIT,
    maxLimit = DEFAULT_MAX_LIMIT,
    defaultSortBy = 'created_at',
    defaultSortOrder = 'DESC',
    allowedSortFields,
    allowOffset = false,
  } = options;

  const page = coercePositiveInt(query.page, defaultPage);
  const requestedLimit = coercePositiveInt(query.limit, defaultLimit);
  const limit = Math.min(requestedLimit, maxLimit);
  const computedOffset = (page - 1) * limit;
  const requestedOffset = allowOffset ? Number.parseInt(query.offset, 10) : Number.NaN;
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : computedOffset;

  const allowed = Array.isArray(allowedSortFields) ? new Set(allowedSortFields) : null;
  const requestedSortBy = typeof query.sortBy === 'string' ? query.sortBy : defaultSortBy;
  const sortBy = allowed && !allowed.has(requestedSortBy) ? defaultSortBy : requestedSortBy;

  return {
    page,
    limit,
    offset,
    search: normalizeSearch(query.search),
    sortBy,
    sortOrder: normalizeSortOrder(query.sortOrder, defaultSortOrder),
  };
}

export function buildPagination(total, page, limit) {
  const safeTotal = Math.max(Number.parseInt(total, 10) || 0, 0);
  const safeLimit = Math.max(Number.parseInt(limit, 10) || DEFAULT_LIMIT, 1);
  const safePage = Math.max(Number.parseInt(page, 10) || DEFAULT_PAGE, 1);
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));

  return {
    page: safePage,
    limit: safeLimit,
    total: safeTotal,
    totalPages,
    hasNext: safePage * safeLimit < safeTotal,
    hasPrev: safePage > 1,
  };
}
