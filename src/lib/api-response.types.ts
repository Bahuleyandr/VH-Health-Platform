/**
 * API response envelope types for VH Health backend.
 *
 * The backend wraps all responses in a standard envelope:
 *   { success: boolean, message: string, data: T, requestId?: string }
 *
 * Paginated endpoints nest items under data with a pagination object.
 */

// ===================================================================
// Core Envelope
// ===================================================================

/** Standard API success/error envelope. */
export interface ApiEnvelope<T = unknown> {
  success: boolean;
  message?: string;
  data: T;
  requestId?: string;
}

/** Error-specific envelope (no data payload). */
export interface ApiErrorEnvelope {
  success: false;
  message: string;
  error?: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

// ===================================================================
// Pagination
// ===================================================================

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Paginated list wrapper — used inside the envelope's `data` field. */
export interface PaginatedData<T> {
  items: T[];
  pagination: PaginationMeta;
}

/** Full paginated API response (envelope + paginated data). */
export type PaginatedResponse<T> = ApiEnvelope<PaginatedData<T>>;

// ===================================================================
// Helper Utilities
// ===================================================================

/** Extract the data type from an ApiEnvelope. */
export type UnwrapEnvelope<E> = E extends ApiEnvelope<infer D> ? D : never;

/** Extract the item type from a PaginatedResponse. */
export type UnwrapPaginatedItem<E> = E extends PaginatedResponse<infer T>
  ? T
  : never;

/** Convenience: a single-item response. */
export type SingleResponse<T> = ApiEnvelope<T>;

/** Convenience: a list response (non-paginated). */
export type ListResponse<T> = ApiEnvelope<T[]>;

/** Convenience: a message-only response (e.g. DELETE confirmations). */
export type MessageResponse = ApiEnvelope<null> & { message: string };
