// apps/backend/scripts/openapi/schemas/drugKb.mjs
// Drug knowledge base surface (/api/v1/drug-kb, clinical-staff gated):
// source/license status, stateless CDS check, and the WP4 formulary coverage
// report for the dark deterministic-matching gates (migration 722).
import { envelope } from './_helpers.mjs';

export const schemas = {
  DrugKbFinding: {
    type: 'object',
    additionalProperties: true,
    required: ['check', 'severity', 'message'],
    properties: {
      check: {
        type: 'string',
        enum: ['interaction', 'allergy_cross_sensitivity', 'condition_caution', 'dose_range', 'iv_compatibility'],
      },
      severity: { type: 'string' },
      drug_keys: { type: 'array', items: { type: 'string' } },
      medications: { type: 'array', items: { type: 'string' } },
      message: { type: 'string' },
      management: { type: 'string', nullable: true },
      source_key: { type: 'string', nullable: true },
    },
  },

  DrugKbCheckResult: {
    type: 'object',
    additionalProperties: true,
    required: ['kb_available', 'findings', 'count'],
    properties: {
      kb_available: {
        type: 'boolean',
        description: 'False on an environment without the migration-277 KB tables — the engine contributes nothing and legacy checks remain the safety floor.',
      },
      findings: { type: 'array', items: { $ref: '#/components/schemas/DrugKbFinding' } },
      count: { type: 'integer', minimum: 0 },
    },
  },

  DrugKbCoverageReport: {
    type: 'object',
    additionalProperties: true,
    required: ['kb_available', 'total_active_catalog_items', 'resolved', 'unmatched'],
    properties: {
      kb_available: { type: 'boolean' },
      total_active_catalog_items: { type: 'integer', minimum: 0 },
      resolved: {
        type: 'object',
        additionalProperties: false,
        required: ['explicit_link', 'atc_binding', 'composition', 'text_fallback'],
        description: 'Active catalog items counted once at their highest-precedence resolution tier.',
        properties: {
          explicit_link: { type: 'integer', minimum: 0 },
          atc_binding: { type: 'integer', minimum: 0 },
          composition: { type: 'integer', minimum: 0 },
          text_fallback: { type: 'integer', minimum: 0 },
        },
      },
      unmatched: { type: 'integer', minimum: 0 },
      deterministic_pct: { type: 'number', minimum: 0, maximum: 100 },
      any_pct: { type: 'number', minimum: 0, maximum: 100 },
      deterministic_matching: {
        type: 'object',
        additionalProperties: false,
        required: ['env_enabled', 'tenant_enabled', 'effective'],
        description: 'State of the dark deterministic-matching gates (env DRUG_KB_DETERMINISTIC_MATCHING AND settings.drugKb.deterministicMatching; both default off).',
        properties: {
          env_enabled: { type: 'boolean' },
          tenant_enabled: { type: 'boolean' },
          effective: { type: 'boolean' },
        },
      },
    },
  },

  DrugKbCheckResponse: envelope('DrugKbCheckResult'),
  DrugKbCoverageResponse: envelope('DrugKbCoverageReport'),
};

export const operations = {
  'POST /api/v1/drug-kb/check': {
    description:
      'Stateless drug-KB evaluation for CDS previews and the pharmacist verification screen: drug–drug interactions, allergy cross-sensitivity, drug–disease cautions, dose ceilings, and IV Y-site compatibility over an explicitly passed medication/allergy/problem context. The patient-bound path runs inside validatePrescriptionSafety on prescription save and is unchanged by this endpoint.',
    response: 'DrugKbCheckResponse',
  },
  'GET /api/v1/drug-kb/coverage': {
    description:
      'Formulary coverage report: how much of the tenant\'s active pharmacy_catalog resolves to a drug-KB key, per resolution tier (explicit drug_kb_catalog_links row, confirmed ATC binding, composition ingredients, name-substring text fallback). Read-only visibility for the dark deterministic-matching gates; not itself gated.',
    response: 'DrugKbCoverageResponse',
  },
};
