// apps/backend/scripts/openapi/schemas/terminology.mjs
// Central terminology service (roadmap B8 / NL-5): concept search (explicit
// system or tenant-settings-driven diagnosis fan-out), tenant terminology
// settings, and the catalog-binding coverage report.
import { envelope } from './_helpers.mjs';

const TERMINOLOGY_SYSTEM_KEYS = ['ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC'];

export const schemas = {
  TerminologyConcept: {
    type: 'object',
    required: ['system_key', 'code', 'display'],
    properties: {
      system_key: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
      code: { type: 'string', maxLength: 64 },
      display: { type: 'string', maxLength: 1000 },
      category: { type: 'string', maxLength: 200, nullable: true },
      semantic_tag: { type: 'string', maxLength: 200, nullable: true },
      status: { type: 'string', example: 'active' },
      match_rank: {
        type: 'number',
        nullable: true,
        description: 'Rank within the concept\'s system group: 0 = exact code match, then display-prefix, then substring matches.',
      },
    },
  },

  TerminologySearchResolved: {
    type: 'object',
    required: ['preferred_system', 'systems', 'snomed_included'],
    description:
      'Present only on settings-driven searches (no explicit system param): describes how the tenant terminology settings resolved the diagnosis-system fan-out.',
    properties: {
      preferred_system: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
      systems: {
        type: 'array',
        items: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
        description: 'Ordered systems actually searched (preferred system first). Concepts are grouped in this order.',
      },
      snomed_included: {
        type: 'boolean',
        description: 'True only when the tenant has snomed_pickers_enabled and SNOMED_CT is in enabled_systems.',
      },
    },
  },

  TerminologySearchPayload: {
    type: 'object',
    required: ['concepts', 'count'],
    properties: {
      concepts: { type: 'array', items: { $ref: '#/components/schemas/TerminologyConcept' } },
      count: { type: 'integer', minimum: 0 },
      resolved: { $ref: '#/components/schemas/TerminologySearchResolved' },
    },
  },

  TerminologyTenantSettings: {
    type: 'object',
    required: ['preferred_diagnosis_system', 'enabled_systems', 'snomed_pickers_enabled', 'is_default'],
    properties: {
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      preferred_diagnosis_system: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
      enabled_systems: {
        type: 'array',
        items: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
        minItems: 1,
      },
      snomed_pickers_enabled: {
        type: 'boolean',
        description: 'Dark flag: SNOMED_CT joins the settings-driven diagnosis search fan-out only when true (and SNOMED content is imported).',
      },
      coding_enforcement: {
        type: 'object',
        description: 'Per-surface downstream-document code enforcement (WP2): keys are document surfaces (death_certificate, insurance_preauth, insurance_claim, discharge_summary), values off|warn|block. Effective level is min(env TERMINOLOGY_CODING_ENFORCEMENT, this). Empty object = all off.',
        additionalProperties: { type: 'string', enum: ['off', 'warn', 'block'] },
      },
      is_default: {
        type: 'boolean',
        description: 'True when the tenant has no stored settings row and platform defaults apply.',
      },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  TerminologySettingsPayload: {
    type: 'object',
    required: ['settings'],
    properties: {
      settings: { $ref: '#/components/schemas/TerminologyTenantSettings' },
    },
  },

  TerminologySettingsUpdateRequest: {
    type: 'object',
    description: 'Partial update: omitted fields keep their current values. preferred_diagnosis_system must be a member of enabled_systems.',
    properties: {
      preferred_diagnosis_system: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
      enabled_systems: {
        type: 'array',
        items: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
        minItems: 1,
      },
      snomed_pickers_enabled: { type: 'boolean' },
      coding_enforcement: {
        type: 'object',
        additionalProperties: { type: 'string', enum: ['off', 'warn', 'block'] },
      },
    },
  },

  TerminologyCatalogBindingCoverage: {
    type: 'object',
    required: ['catalog_type', 'table', 'default_system', 'catalog_rows', 'confirmed', 'suggested', 'rejected', 'confirmed_pct'],
    properties: {
      catalog_type: { type: 'string', example: 'investigation_test' },
      table: { type: 'string', example: 'investigation_test_catalog' },
      default_system: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
      catalog_rows: { type: 'integer', minimum: 0 },
      confirmed: { type: 'integer', minimum: 0 },
      suggested: { type: 'integer', minimum: 0 },
      rejected: { type: 'integer', minimum: 0 },
      confirmed_pct: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Confirmed bindings as a percentage of catalog rows, one decimal place.',
      },
    },
  },

  TerminologyConceptMapCoverage: {
    type: 'object',
    required: ['source_system', 'target_system', 'total', 'relationships'],
    properties: {
      source_system: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
      target_system: { type: 'string', enum: TERMINOLOGY_SYSTEM_KEYS },
      total: { type: 'integer', minimum: 0 },
      relationships: {
        type: 'object',
        required: ['equivalent', 'broader', 'narrower', 'related'],
        properties: {
          equivalent: { type: 'integer', minimum: 0 },
          broader: { type: 'integer', minimum: 0 },
          narrower: { type: 'integer', minimum: 0 },
          related: { type: 'integer', minimum: 0 },
        },
      },
    },
  },

  TerminologyCoveragePayload: {
    type: 'object',
    required: ['coverage'],
    properties: {
      coverage: {
        type: 'object',
        required: ['catalog_bindings', 'concept_maps'],
        properties: {
          catalog_bindings: {
            type: 'array',
            items: { $ref: '#/components/schemas/TerminologyCatalogBindingCoverage' },
          },
          concept_maps: {
            type: 'array',
            items: { $ref: '#/components/schemas/TerminologyConceptMapCoverage' },
          },
        },
      },
    },
  },

  TerminologySearchResponse: envelope('TerminologySearchPayload'),
  TerminologySettingsResponse: envelope('TerminologySettingsPayload'),
  TerminologyCoverageResponse: envelope('TerminologyCoveragePayload'),
};

export const operations = {
  'GET /api/v1/terminology/search': {
    description:
      'Ranked concept search. With `system` (canonical key or alias), searches that single system — the original contract, unchanged. Without `system`, the search is settings-driven: the tenant\'s preferred_diagnosis_system and enabled_systems choose the diagnosis systems (SNOMED_CT only behind snomed_pickers_enabled), concepts arrive grouped by system in resolved.systems order, and the payload additionally carries `resolved`. Query params: q (min 2 chars), limit (default 20, max 100; per system in settings-driven mode). Empty results are expected while code systems are unimported — typeahead clients degrade to free text.',
    response: 'TerminologySearchResponse',
  },
  'GET /api/v1/terminology/settings': {
    description:
      'Tenant terminology preferences (preferred diagnosis system, enabled systems, SNOMED picker flag). Falls back to platform defaults (is_default=true) when the tenant has no stored row.',
    response: 'TerminologySettingsResponse',
  },
  'PUT /api/v1/terminology/settings': {
    description:
      'Updates the tenant terminology preference row (catalog curator roles only). Omitted fields keep their current values; every change lands a terminology_audit_events row.',
    request: 'TerminologySettingsUpdateRequest',
    response: 'TerminologySettingsResponse',
  },
  'GET /api/v1/terminology/coverage': {
    description:
      'Terminology binding coverage report (roadmap B8 exit metric): confirmed/suggested/rejected standard-code bindings per local catalog plus concept-map counts per system pair.',
    response: 'TerminologyCoverageResponse',
  },
};
