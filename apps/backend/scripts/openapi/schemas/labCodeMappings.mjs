// apps/backend/scripts/openapi/schemas/labCodeMappings.mjs
// Analyzer/interface code → catalog/LOINC mapping curation (migration 721):
// CRUD + coverage under /api/v1/lab/code-mappings. Curated rows only take
// effect on ingest behind LAB_LOINC_MAPPING_ENABLED (env) AND the tenant
// settings.labLoincMapping.enabled flag, both default off.
import { envelope } from './_helpers.mjs';

export const schemas = {
  LabCodeMapping: {
    type: 'object',
    required: ['id', 'source_key', 'incoming_code', 'active'],
    properties: {
      id: { type: 'integer' },
      source_key: {
        type: 'string',
        maxLength: 120,
        description: "Analyzer/interface identity (ORU MSH-3 sending application or ASTM analyzer_code); 'any' is the tenant-wide wildcard consulted when no source-specific row matches.",
      },
      incoming_code: { type: 'string', maxLength: 120 },
      incoming_code_system: { type: 'string', maxLength: 80, nullable: true },
      catalog_id: {
        type: 'integer',
        nullable: true,
        description: 'investigation_test_catalog row this inbound code maps to; its confirmed LOINC binding supplies the code when loinc_code is not set directly.',
      },
      loinc_code: { type: 'string', maxLength: 20, nullable: true },
      display: { type: 'string', nullable: true },
      active: {
        type: 'boolean',
        description: 'Soft-delete flag: only one active mapping may exist per (source_key, incoming_code); inactive rows keep history.',
      },
      verified_by: { type: 'string', format: 'uuid', nullable: true },
      verified_at: { type: 'string', format: 'date-time', nullable: true },
      created_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  LabCodeMappingListPayload: {
    type: 'object',
    required: ['mappings', 'count'],
    properties: {
      mappings: { type: 'array', items: { $ref: '#/components/schemas/LabCodeMapping' } },
      count: { type: 'integer' },
    },
  },

  LabCodeMappingWriteRequest: {
    type: 'object',
    properties: {
      source_key: { type: 'string', maxLength: 120, description: "Defaults to 'any' on create." },
      incoming_code: { type: 'string', maxLength: 120 },
      incoming_code_system: { type: 'string', maxLength: 80, nullable: true },
      catalog_id: { type: 'integer', nullable: true },
      loinc_code: {
        type: 'string',
        maxLength: 20,
        nullable: true,
        description: 'Structurally validated (<digits>-<check digit>). At least one of catalog_id / loinc_code is required.',
      },
      display: { type: 'string', maxLength: 2000, nullable: true },
      active: { type: 'boolean' },
      verified: {
        type: 'boolean',
        description: 'Update only: true stamps verified_by/verified_at from the caller; false clears them.',
      },
    },
  },

  LabCodeMappingCoveragePayload: {
    type: 'object',
    required: ['enabled', 'window_days', 'inbound', 'mappings', 'catalog'],
    properties: {
      enabled: {
        type: 'object',
        required: ['env', 'tenant', 'effective'],
        properties: {
          env: { type: 'boolean' },
          tenant: { type: 'boolean' },
          effective: { type: 'boolean' },
        },
        description: 'Layered gate state: LAB_LOINC_MAPPING_ENABLED env kill switch AND tenant settings.labLoincMapping.enabled.',
      },
      window_days: { type: 'integer', minimum: 1, maximum: 365 },
      inbound: {
        type: 'object',
        required: ['distinct_codes', 'mapped_codes', 'unmapped_codes', 'results_total', 'results_with_loinc', 'top_unmapped'],
        properties: {
          distinct_codes: { type: 'integer' },
          mapped_codes: { type: 'integer' },
          unmapped_codes: { type: 'integer' },
          results_total: { type: 'integer' },
          results_with_loinc: { type: 'integer' },
          top_unmapped: {
            type: 'array',
            items: {
              type: 'object',
              required: ['code', 'result_count'],
              properties: {
                code: { type: 'string' },
                result_count: { type: 'integer' },
              },
            },
          },
        },
      },
      mappings: {
        type: 'object',
        required: ['active', 'inactive'],
        properties: {
          active: { type: 'integer' },
          inactive: { type: 'integer' },
        },
      },
      catalog: {
        type: 'object',
        required: ['active_items', 'loinc_bound', 'loinc_bound_pct'],
        properties: {
          active_items: { type: 'integer' },
          loinc_bound: { type: 'integer' },
          loinc_bound_pct: { type: 'number', minimum: 0, maximum: 100 },
        },
      },
    },
  },

  LabCodeMappingListResponse: envelope('LabCodeMappingListPayload'),
  LabCodeMappingResponse: envelope('LabCodeMapping'),
  LabCodeMappingCoverageResponse: envelope('LabCodeMappingCoveragePayload'),
};

export const operations = {
  'GET /api/v1/lab/code-mappings': {
    description:
      'Lists the tenant\'s curated analyzer/interface code → catalog/LOINC mappings (active by default; include_inactive=true adds history rows). Supports source_key and q (code/display/LOINC substring) filters plus limit/offset. Staff or admin read.',
    response: 'LabCodeMappingListResponse',
  },
  'POST /api/v1/lab/code-mappings': {
    description:
      'Creates an analyzer-code mapping. Terminology catalog curator roles only. Requires incoming_code plus at least one of catalog_id / loinc_code; source_key defaults to the \'any\' wildcard. At most one ACTIVE mapping may exist per (source_key, incoming_code) — duplicates return 409. Curating rows never changes ingest behavior by itself: enrichment stays dark until the env kill switch and the tenant flag are both on.',
    request: 'LabCodeMappingWriteRequest',
    response: 'LabCodeMappingResponse',
  },
  'GET /api/v1/lab/code-mappings/coverage': {
    description:
      'Mapping coverage report: distinct inbound analyzer codes seen on lab_results in the window (days, default 30) split mapped/unmapped with the top unmapped codes, active/inactive mapping counts, the investigation catalog\'s confirmed-LOINC binding rate, and the layered enablement gate state. Staff or admin read.',
    response: 'LabCodeMappingCoverageResponse',
  },
  'GET /api/v1/lab/code-mappings/{id}': {
    description: 'Fetches one analyzer-code mapping.',
    response: 'LabCodeMappingResponse',
  },
  'PUT /api/v1/lab/code-mappings/{id}': {
    description:
      'Updates an analyzer-code mapping; omitted fields keep their current values. Terminology catalog curator roles only. A mapping must always keep at least one of catalog_id / loinc_code; verified=true stamps verification evidence from the caller.',
    request: 'LabCodeMappingWriteRequest',
    response: 'LabCodeMappingResponse',
  },
  'DELETE /api/v1/lab/code-mappings/{id}': {
    description:
      'Deactivates an analyzer-code mapping (audit-preserving soft delete). The live-unique slot for its (source_key, incoming_code) is freed for a corrected replacement row. Terminology catalog curator roles only.',
    response: 'LabCodeMappingResponse',
  },
};
