// apps/backend/scripts/openapi/schemas/integrationGates.mjs
// SUPER_ADMIN-only "Integrations & Gates" console read: per tenant, the
// effective state of every dark-shipped feature gate (payment gateway, SMS,
// ABDM legs, UHI, ambulance GPS, facility asset register) plus
// deployment-wide env facts. Read-only;
// secrets are never returned (presence booleans only).
import { envelope } from './_helpers.mjs';

const AUTHENTICATED_SECURITY = [{ ApiKeyAuth: [], BearerAuth: [] }];
const errorResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/IntegrationGateErrorResponse' },
    },
  },
});
const authenticatedErrorResponses = {
  400: errorResponse('The integration-gates request was invalid.'),
  401: errorResponse('The API key or bearer token was missing or invalid.'),
  403: errorResponse('The caller was not a SUPER_ADMIN.'),
  429: errorResponse('The caller exceeded the API rate limit.'),
  500: errorResponse('The integration gate states could not be retrieved.'),
};

const GATE_LAYERS = ['env', 'tenant_setting', 'provider_config', 'unknown'];

export const schemas = {
  IntegrationGateErrorResponse: {
    type: 'object',
    additionalProperties: true,
    required: ['success'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      error: { type: 'string' },
      code: { type: 'string' },
    },
  },

  IntegrationGateEnvFacts: {
    type: 'object',
    additionalProperties: true,
    required: ['payment_gateway_enabled', 'abdm_enabled', 'uhi_enabled'],
    properties: {
      payment_gateway_enabled: { type: 'boolean' },
      sms_provider: {
        type: 'string', nullable: true,
        description: 'SMS_PROVIDER env value (provider NAME only, never credentials); null when unset.',
      },
      sms_kill_switch: {
        type: 'boolean',
        description: 'True when SMS_PROVIDER=logger (deployment-wide dry-run).',
      },
      abdm_enabled: { type: 'boolean' },
      abdm_environment: { type: 'string', enum: ['sandbox', 'production'] },
      abdm_has_client_credentials: {
        type: 'boolean',
        description: 'Presence boolean for ABDM_CLIENT_ID + ABDM_CLIENT_SECRET; values are never returned.',
      },
      uhi_enabled: { type: 'boolean' },
      uhi_environment: { type: 'string', enum: ['sandbox', 'production'] },
      uhi_has_subscriber_identity: { type: 'boolean' },
      facility_assets_enabled: { type: 'boolean' },
      livekit_enabled: { type: 'boolean' },
      file_scan_policy: { type: 'string', enum: ['required', 'disabled_accepted_risk'] },
      clinical_continuity_c_d14_approved: {
        type: 'boolean',
        description: 'Compile-time constant; deliberately not changeable by deployment configuration.',
      },
      // ── Terminology & knowledge env facts (slate C1; appended block) ──
      who_icd_configured: {
        type: 'boolean',
        description: 'Presence boolean for WHO ICD-API credentials (or the local-mirror auth bypass); values are never returned.',
      },
      terminology_coding_enforcement: {
        type: 'string', enum: ['off', 'warn', 'block'],
        description: 'TERMINOLOGY_CODING_ENFORCEMENT env kill switch; unknown values read as off.',
      },
      drug_kb_deterministic_matching: {
        type: 'boolean',
        description: 'DRUG_KB_DETERMINISTIC_MATCHING env kill switch.',
      },
      lab_loinc_mapping_enabled: {
        type: 'boolean',
        description: 'LAB_LOINC_MAPPING_ENABLED env kill switch.',
      },
      lis_listeners_configured: {
        type: 'integer',
        description: 'Count of listener profiles in the backend mirror of DEVICE_GATEWAY_LIS_LISTENERS (config shape only, never ports/hosts/token names).',
      },
    },
  },

  IntegrationGateState: {
    type: 'object',
    additionalProperties: true,
    required: ['effective'],
    properties: {
      effective: {
        type: 'boolean',
        description: 'AND of every gate layer, computed by the feature\'s own resolver.',
      },
      blocking_layer: {
        type: 'string', enum: GATE_LAYERS, nullable: true,
        description: 'The first gate layer holding the feature dark; null when effective.',
      },
      reason: { type: 'string', nullable: true },
      layers: {
        type: 'object', additionalProperties: true,
        description: 'Per-layer state. Provider config rows are the services\' write-only admin views (has_* booleans, never secret values).',
      },
    },
  },

  IntegrationGateTenantEntry: {
    type: 'object',
    additionalProperties: false,
    required: ['tenant', 'gates'],
    properties: {
      tenant: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'slug'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          slug: { type: 'string' },
          name: { type: 'string', nullable: true },
          status: { type: 'string' },
        },
      },
      gates: {
        type: 'object',
        additionalProperties: false,
        required: [
          'payment_gateway', 'sms', 'abdm_enrolment', 'abdm_scan_share',
          'abdm_hiu', 'uhi', 'ambulance_gps', 'facility_assets',
          // Terminology & knowledge gates (slate C1; appended block). Their
          // "provider_config" layer means imported content.
          'terminology_coding', 'lab_loinc_mapping', 'drug_kb',
          // Device-gateway LIS ingress (#891 deferral) + embedded BI (C2).
          'lis_listeners', 'analytics_bi',
        ],
        properties: {
          payment_gateway: { $ref: '#/components/schemas/IntegrationGateState' },
          sms: { $ref: '#/components/schemas/IntegrationGateState' },
          abdm_enrolment: { $ref: '#/components/schemas/IntegrationGateState' },
          abdm_scan_share: { $ref: '#/components/schemas/IntegrationGateState' },
          abdm_hiu: { $ref: '#/components/schemas/IntegrationGateState' },
          uhi: { $ref: '#/components/schemas/IntegrationGateState' },
          ambulance_gps: { $ref: '#/components/schemas/IntegrationGateState' },
          facility_assets: { $ref: '#/components/schemas/IntegrationGateState' },
          // Terminology & knowledge gates (slate C1; appended block).
          terminology_coding: { $ref: '#/components/schemas/IntegrationGateState' },
          lab_loinc_mapping: { $ref: '#/components/schemas/IntegrationGateState' },
          drug_kb: { $ref: '#/components/schemas/IntegrationGateState' },
          // Device-gateway LIS analyzer transport (#891 deferral).
          lis_listeners: { $ref: '#/components/schemas/IntegrationGateState' },
          // Embedded Metabase BI (slate C2). Emitted by the service since
          // #894; was missing from this additionalProperties:false object
          // (2026-08 audits' K-1) — a strict validator dropped the row.
          analytics_bi: { $ref: '#/components/schemas/IntegrationGateState' },
        },
      },
    },
  },

  IntegrationGateReport: {
    type: 'object',
    additionalProperties: false,
    required: ['generated_at', 'env', 'tenants'],
    properties: {
      generated_at: { type: 'string', format: 'date-time' },
      env: { $ref: '#/components/schemas/IntegrationGateEnvFacts' },
      tenants: {
        type: 'array',
        items: { $ref: '#/components/schemas/IntegrationGateTenantEntry' },
      },
    },
  },

  IntegrationGateReportResponse: envelope('IntegrationGateReport'),
};

export const operations = {
  'GET /api/v1/admin/integration-gates': {
    description:
      'SUPER_ADMIN-only read of every dark-shipped feature gate per tenant: payment gateway (env kill switch AND tenants.settings.paymentGateway.enabled AND an enabled provider-config row, dry_run vs live credentials), SMS (SMS_PROVIDER env ladder AND settings.sms.enabled AND per-tenant config/DLT template registrations), ABDM enrolment / Scan & Share / thin HIU (ABDM_ENABLED AND the tenant flags), UHI, ambulance GPS, and the facility asset register (FACILITY_ASSETS_ENABLED AND settings.facilityAssets.enabled), plus read-only env facts (LiveKit, FILE_SCAN_POLICY, clinical-continuity approval). Effective state is computed by each feature\'s own resolver; secrets are never returned — presence booleans only. Read-only: flips go through the existing mutation endpoints.',
    parameters: [
      {
        name: 'tenantId',
        in: 'query',
        required: false,
        schema: { type: 'string', format: 'uuid' },
        description: 'Restrict the report to one tenant.',
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 500 },
        description: 'Maximum tenants to include (default 100, clamped to 500).',
      },
    ],
    response: 'IntegrationGateReportResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
};
