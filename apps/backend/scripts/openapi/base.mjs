// apps/backend/scripts/openapi/base.mjs
// Curated, hand-authored OpenAPI base. The generator merges live-router-derived
// `paths` over this. Phase 5 enriches `components.schemas` with per-subsystem
// request/response types. (schemas + securitySchemes carried from the legacy
// swagger.yaml; info/servers refreshed off the Render-era values.)
export const OPENAPI_TAG_REGISTRY = [
  { slug: 'abdm' },
  { slug: 'abdm-full' },
  { slug: 'activity' },
  { slug: 'adoption' },
  { slug: 'alerts' },
  { slug: 'analytics' },
  { slug: 'appointment' },
  { slug: 'appointments' },
  { slug: 'attendance' },
  { slug: 'audit' },
  { slug: 'auth' },
  { slug: 'bed' },
  { slug: 'billing' },
  { slug: 'billing-masters' },
  { slug: 'biomed-cmms' },
  { slug: 'bloodbank' },
  { slug: 'care-operations' },
  { slug: 'care-pathway' },
  { slug: 'care-pathway-reconciliation' },
  { slug: 'care-plan' },
  { slug: 'cath-consumables' },
  { slug: 'chatbot' },
  { slug: 'clinical' },
  { slug: 'clinical-governance' },
  { slug: 'clinical-inbox' },
  { slug: 'clinical-use' },
  { slug: 'cold-chain' },
  { slug: 'compliance' },
  { slug: 'config' },
  { slug: 'consent' },
  { slug: 'core-clinical' },
  { slug: 'create' },
  { slug: 'credentialing' },
  { slug: 'cssd' },
  { slug: 'dashboard' },
  { slug: 'dashboards' },
  { slug: 'data-export' },
  { slug: 'database' },
  { slug: 'delivery' },
  { slug: 'department' },
  { slug: 'departments' },
  { slug: 'developer-portal' },
  { slug: 'device' },
  { slug: 'device-registry' },
  { slug: 'diagnostics' },
  { slug: 'diagnostics-medication' },
  { slug: 'dietary' },
  { slug: 'discharge' },
  { slug: 'discharge-compose' },
  { slug: 'doctor' },
  { slug: 'document' },
  { slug: 'documents' },
  { slug: 'downtime' },
  { slug: 'ed' },
  { slug: 'emr' },
  { slug: 'encryption-key' },
  { slug: 'engagement' },
  { slug: 'entitlement' },
  { slug: 'entitlements' },
  { slug: 'event-outbox' },
  { slug: 'executive-kpi' },
  { slug: 'export' },
  { slug: 'facility' },
  { slug: 'facility-risk' },
  { slug: 'feature-flag' },
  { slug: 'feedback' },
  { slug: 'fhir' },
  { slug: 'forecast' },
  { slug: 'gamification' },
  { slug: 'gdpr' },
  { slug: 'governance' },
  { slug: 'health' },
  { slug: 'hl7' },
  { slug: 'housekeeping' },
  { slug: 'hr' },
  { slug: 'identity-sso' },
  { slug: 'infrastructure' },
  { slug: 'insurance' },
  { slug: 'integration' },
  { slug: 'interface-engine' },
  { slug: 'internal' },
  { slug: 'investigation' },
  { slug: 'ipd' },
  { slug: 'knowledge-base' },
  { slug: 'knowledge-governance' },
  { slug: 'lab' },
  { slug: 'ledger-reports' },
  { slug: 'linen' },
  { slug: 'list' },
  { slug: 'logs' },
  { slug: 'maternity' },
  { slug: 'medical' },
  { slug: 'messaging' },
  { slug: 'metrics' },
  { slug: 'mfa-api-clients' },
  { slug: 'migration-toolkit' },
  { slug: 'nhcx' },
  { slug: 'notification' },
  { slug: 'oncology' },
  { slug: 'operational-alert' },
  { slug: 'outcome-scoreboard' },
  { slug: 'overview' },
  { slug: 'paediatric' },
  { slug: 'pathology' },
  { slug: 'patient' },
  { slug: 'patient-explainers' },
  { slug: 'patient-flow' },
  { slug: 'patient-identifier' },
  { slug: 'patient-merge' },
  { slug: 'patient-portal' },
  { slug: 'pharmacy' },
  { slug: 'pharmacy-supply' },
  { slug: 'phone' },
  { slug: 'platform-workbench' },
  { slug: 'prescription' },
  { slug: 'prescriptions' },
  { slug: 'prior-auth-appeal' },
  { slug: 'productivity' },
  { slug: 'quality' },
  { slug: 'quality-case' },
  { slug: 'queue-display' },
  { slug: 'radiology' },
  { slug: 'realtime' },
  { slug: 'record' },
  { slug: 'referral' },
  { slug: 'refresh-cache' },
  { slug: 'reminders' },
  { slug: 'replacements' },
  { slug: 'research' },
  { slug: 'revenue-cycle' },
  { slug: 'roll-call' },
  { slug: 'roster-board' },
  { slug: 'scheduling' },
  { slug: 'scim' },
  { slug: 'search' },
  { slug: 'security' },
  { slug: 'session' },
  { slug: 'shift' },
  { slug: 'smart-fhir' },
  { slug: 'sos' },
  { slug: 'staff-admin' },
  { slug: 'staff-care-plan' },
  { slug: 'staff-messaging' },
  { slug: 'stats' },
  { slug: 'steps' },
  { slug: 'storage' },
  { slug: 'summary' },
  { slug: 'surgical-ai' },
  { slug: 'surgical-documentation' },
  { slug: 'system' },
  { slug: 'tasks-workflow' },
  { slug: 'teleconsult-ai' },
  { slug: 'telemedicine' },
  { slug: 'tenant' },
  { slug: 'tenant-context' },
  { slug: 'terminology' },
  { slug: 'test' },
  { slug: 'theatre' },
  { slug: 'tier-a-assistants' },
  { slug: 'tier-c-assistants' },
  { slug: 'tier-d-emergency' },
  { slug: 'tier-e-patient-engagement' },
  { slug: 'tier-f-interop' },
  { slug: 'tier-g-public-health' },
  { slug: 'tier-h-operational' },
  { slug: 'transplant' },
  { slug: 'trial-safety-operations' },
  { slug: 'unclassified' },
  { slug: 'upload' },
  { slug: 'user' },
  { slug: 'walk-in' },
];

export const UNCLASSIFIED_TAG_BUDGET = 4;

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
  // CURATED TOP-LEVEL TAG REGISTRY — the authority for the published taxonomy.
  //
  // Every tag an operation carries MUST be declared here by `slug`, or
  // generation FAILS (buildOpenApiDocument throws and lists the offenders).
  // That gate is what makes the generator's filename bootstrap safe: renaming
  // or moving a route module yields an unregistered slug and stops the build,
  // rather than silently republishing the API under a different taxonomy. It is
  // equally what stops `clinical-ai` / `clinicalAi` / `clinical_ai` /
  // "Clinical AI" from drifting into four separate groups.
  //
  // Entry shape: { slug, description?, owner? }
  //   slug        lowercase kebab-case; emitted verbatim as the OpenAPI tag name.
  //   description optional; emitted when present. Absent is CLEAN —
  //               `spectral:oas` does not require tag descriptions, so nothing
  //               is gated on writing these. They are deliberately NOT
  //               auto-generated: restating a subsystem's name back at the
  //               reader ("Appointment endpoints") is not documentation, the
  //               same reason operation descriptions are not (see .spectral.yml).
  //   owner       optional; repo metadata only, never emitted into the spec.
  //
  // Seeded from the taxonomy the generator derived at introduction. Subsystem
  // owners add descriptions/owners here as they write them, and a router can
  // pin its slug explicitly via markRouterDomain (src/config/openapiDomain.js).
  tagRegistry: OPENAPI_TAG_REGISTRY,

  // Ratchet for the `unclassified` debt tag: operations with no reliable domain
  // signal. Generation fails if the count EXCEEDS this. Lower it as domains get
  // declared; never raise it.
  unclassifiedTagBudget: UNCLASSIFIED_TAG_BUDGET,
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
