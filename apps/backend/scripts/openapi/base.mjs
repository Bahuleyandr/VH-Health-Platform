// apps/backend/scripts/openapi/base.mjs
// Curated, hand-authored OpenAPI base. The generator merges live-router-derived
// `paths` over this. Phase 5 enriches `components.schemas` with per-subsystem
// request/response types. (schemas + securitySchemes carried from the legacy
// swagger.yaml; info/servers refreshed off the Render-era values.)
export const OPENAPI_BASE = {
  openapi: '3.0.3',
  info: {
    title: 'VH Health API',
    version: '2.0.0',
    description:
      'VH Health platform REST API. Paths are generated from the live Express '
      + 'router by scripts/generate-openapi.mjs and gated by '
      + 'scripts/check-openapi-drift.mjs. Operation request/response payloads are '
      + 'enriched per subsystem in later phases — see '
      + 'docs/superpowers/specs/2026-06-24-openapi-contract-pipeline-design.md.',
    contact: { name: 'VH Health Tech Team', email: 'api@vhhealth.com', url: 'https://vhhealth.com' },
    license: { name: 'Proprietary', url: 'https://vhhealth.com/license' },
  },
  servers: [
    { url: 'https://api.vhhealth.app/api/v1', description: 'Production' },
    { url: 'http://localhost:5000/api/v1', description: 'Development' },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'API key (API_KEY env var)' },
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT user token' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Error message' },
          error: { type: 'string', example: 'Error details' },
          details: { type: 'object' },
        },
      },
      Success: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Operation successful' },
          data: { type: 'object', description: 'Response data (varies by endpoint)' },
        },
      },
      PaginatedResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string' },
          data: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object' } },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'integer', example: 1 },
                  limit: { type: 'integer', example: 10 },
                  total: { type: 'integer', example: 100 },
                  totalPages: { type: 'integer', example: 10 },
                },
              },
            },
          },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
};
