// apps/backend/scripts/openapi/schemas/_helpers.mjs
// Shared builders for per-subsystem OpenAPI schema overlay modules.

/** Response envelope { success, message, data: $ref(payload) }. Keeping `data`
 * a direct property makes the admin Data-only alias a trivial ['data'] index. */
export function envelope(payloadSchemaName) {
  return {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { $ref: `#/components/schemas/${payloadSchemaName}` },
      requestId: { type: 'string', nullable: true },
    },
  };
}

/** List response envelope: `data` is an array of $ref(item); pagination (when
 * present) lives in the envelope `meta` (this codebase's success(res,data,…,meta)
 * convention), typed loosely so the exact meta shape can't break the contract. */
export function listEnvelope(itemSchemaName) {
  return {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { type: 'array', items: { $ref: `#/components/schemas/${itemSchemaName}` } },
      meta: { type: 'object', additionalProperties: true },
      requestId: { type: 'string', nullable: true },
    },
  };
}

/** Count-list response envelope: data = { <arrayKey>: $ref(item)[], count }. Used by
 * the billing-masters list endpoints which wrap the array in a named key + count. */
export function countListEnvelope(arrayKey, itemSchemaName) {
  return {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: [arrayKey, 'count'],
        properties: {
          [arrayKey]: { type: 'array', items: { $ref: `#/components/schemas/${itemSchemaName}` } },
          count: { type: 'integer', example: 5 },
        },
      },
      requestId: { type: 'string', nullable: true },
    },
  };
}

/** Paginated response envelope: data.items[] of $ref(item) + data.pagination. */
export function paginatedEnvelope(itemSchemaName) {
  return {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        required: ['items', 'pagination'],
        properties: {
          items: { type: 'array', items: { $ref: `#/components/schemas/${itemSchemaName}` } },
          pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer', example: 1 },
              limit: { type: 'integer', example: 20 },
              total: { type: 'integer', example: 100 },
              totalPages: { type: 'integer', example: 5 },
            },
          },
        },
      },
      requestId: { type: 'string', nullable: true },
    },
  };
}
