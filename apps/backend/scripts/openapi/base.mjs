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
  // Curated top-level tag DESCRIPTIONS.
  //
  // The tag NAMES are not listed here — buildOpenApiDocument emits the complete
  // top-level `tags` array as the union of every tag its operations actually
  // use, so Spectral's `operation-tag-defined` can never fire and a new route
  // module can never silently produce an undefined tag. This list only supplies
  // the human description for tags that have one; a name present here is
  // matched by `name` and its `description` is carried through, and any name
  // NOT here is emitted as a bare `{ name }`.
  //
  // `spectral:oas` does not require tag descriptions, so an undescribed tag is
  // clean — nothing is gated on filling this in. It is deliberately empty
  // rather than seeded with auto-generated text: restating a subsystem's name
  // back at the reader ("Appointment endpoints") is not documentation, the same
  // reason operation descriptions are not auto-generated (see .spectral.yml).
  // Subsystem owners add real entries here as they write them, e.g.
  //   { name: 'appointments', description: 'Slot search, booking, reschedule …' }
  tags: [],
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
