// apps/backend/scripts/openapi/schemas/continuityFacilityContextGrants.mjs
// Admin management of clinical-continuity facility-context capture grants
// (src/routes/admin/deviceRegistryRoutes.js, mounted at /api/v1/admin/devices),
// requiring INTEGRATION_ADMIN, ADMIN, or SUPER_ADMIN (requireManage/canManage).
// Gated behind clinicalContinuityFacilityEnrollmentEnabled(), which chains
// through the hardcoded-false CLINICAL_CONTINUITY_C_D14_APPROVED constant, so
// every operation here currently always responds 503
// CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE in this codebase.

import { envelope } from './_helpers.mjs';

const base = '/api/v1/admin/devices/continuity-facility-context';
const ALWAYS_503 =
  ' Currently always returns 503 CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE -- gated behind ' +
  'clinicalContinuityFacilityEnrollmentEnabled(), which chains through the hardcoded-false ' +
  'CLINICAL_CONTINUITY_C_D14_APPROVED flag that no deployment configuration can override.';

const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Stable key for this exact device, affected-subject set, incident reference, and reason. ' +
    'A retry with the same key and body resumes the first unfinished evidence-bearing step.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$'
  }
};

export const schemas = {
  ClinicalContinuityDeviceLossRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['stable_device_id', 'affected_staff_uids', 'incident_reference', 'reason'],
    properties: {
      stable_device_id: { type: 'string', format: 'uuid' },
      affected_staff_uids: {
        type: 'array',
        maxItems: 100,
        uniqueItems: true,
        items: { type: 'string', format: 'uuid' }
      },
      incident_reference: {
        type: 'string',
        minLength: 3,
        maxLength: 200,
        pattern: '^[^\\u0000-\\u001F\\u007F]+$'
      },
      reason: {
        type: 'string',
        minLength: 3,
        maxLength: 500,
        pattern: '^[^\\u0000-\\u001F\\u007F]+$'
      }
    }
  },
  ClinicalContinuityDeviceLossSubject: {
    type: 'object',
    additionalProperties: false,
    required: [
      'staff_uid',
      'break_glass',
      'identity_revocation',
      'token_revocation',
      'evidence_ids'
    ],
    properties: {
      staff_uid: { type: 'string', format: 'uuid' },
      break_glass: { type: 'boolean' },
      identity_revocation: {
        type: 'string',
        enum: ['pending', 'completed', 'excluded_break_glass']
      },
      token_revocation: {
        type: 'string',
        enum: ['pending', 'completed', 'excluded_break_glass']
      },
      evidence_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' }
      }
    }
  },
  ClinicalContinuityDeviceLossStepEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'state', 'attempt', 'evidence_ids', 'error_code'],
    properties: {
      name: {
        type: 'string',
        enum: [
          'capture_grants',
          'edge_read_grants',
          'identity_access',
          'tokens',
          'wipe_order',
          'needs_review_routing',
          'offline_pack_risk'
        ]
      },
      state: {
        type: 'string',
        enum: [
          'completed',
          'not_applicable',
          'excluded',
          'retryable_failed',
          'awaiting_contact'
        ]
      },
      attempt: { type: 'integer', minimum: 0 },
      evidence_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' }
      },
      error_code: { type: 'string', nullable: true },
      expires_no_later_than: { type: 'string', format: 'date-time' }
    }
  },
  ClinicalContinuityDeviceWipeOrder: {
    type: 'object',
    additionalProperties: false,
    required: [
      'order_id',
      'content',
      'content_hash',
      'algorithm',
      'key_id',
      'signature',
      'delivery_state'
    ],
    properties: {
      order_id: { type: 'string', format: 'uuid' },
      content: { type: 'object', additionalProperties: true },
      content_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      algorithm: { type: 'string', enum: ['Ed25519'] },
      key_id: { type: 'string', minLength: 1 },
      signature: { type: 'string', minLength: 1 },
      delivery_state: { type: 'string', enum: ['awaiting_contact', 'executed'] }
    }
  },
  ClinicalContinuityDeviceLossOperation: {
    type: 'object',
    additionalProperties: false,
    required: [
      'operation_id',
      'state',
      'stable_device_id',
      'incident_reference',
      'idempotent_replay',
      'subjects',
      'steps',
      'wipe_order',
      'request_id'
    ],
    properties: {
      operation_id: { type: 'string', format: 'uuid' },
      state: {
        type: 'string',
        enum: ['incomplete_retryable', 'awaiting_device_contact', 'executed']
      },
      stable_device_id: { type: 'string', format: 'uuid' },
      incident_reference: { type: 'string' },
      idempotent_replay: { type: 'boolean' },
      subjects: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossSubject' }
      },
      steps: {
        type: 'array',
        minItems: 7,
        maxItems: 7,
        items: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossStepEvidence' }
      },
      wipe_order: {
        allOf: [{ $ref: '#/components/schemas/ClinicalContinuityDeviceWipeOrder' }],
        nullable: true
      },
      request_id: { type: 'string', nullable: true }
    }
  },
  ClinicalContinuityDeviceLossResponse: envelope('ClinicalContinuityDeviceLossOperation'),
  ClinicalContinuityDeviceLossFailureResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string' },
      requestId: { type: 'string' },
      details: {
        type: 'object',
        additionalProperties: true,
        properties: {
          operation: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossOperation' }
        }
      }
    }
  }
};

export const operations = {
  [`GET ${base}/grants`]: {
    summary: 'List clinical-continuity facility-context capture grants',
    description:
      'Read-only listing, restricted to INTEGRATION_ADMIN/ADMIN/SUPER_ADMIN callers, of a ' +
      "tenant's clinical-continuity facility-context capture grants -- device- or staff-plus-" +
      'device-bound authorizations to mint continuity facility contexts -- optionally filtered ' +
      'to one facility via `facility_id`, including each grant\'s revocation record when ' +
      'revoked.' + ALWAYS_503,
  },
  [`POST ${base}/enroll`]: {
    summary: 'Enroll a new facility-context capture grant',
    description:
      'Mutates (INTEGRATION_ADMIN/ADMIN/SUPER_ADMIN only): enrolls a new clinical-continuity ' +
      "facility-context capture grant for a tenant/facility. A device id and its Ed25519 public " +
      "key are required unconditionally; a named staff member is additionally required when " +
      "grant_purpose is 'capture_staff_facility' and forbidden for 'capture_fixed_device' -- it " +
      "is not an either/or between a staff grant and a device grant, every grant is device-" +
      'bound. Rejected unless the facility has an active continuity policy whose effective ' +
      'window covers the requested validity range. Returns 201 on success.' + ALWAYS_503,
    responseStatus: 201,
  },
  [`POST ${base}/revoke`]: {
    summary: 'Revoke a facility-context capture grant',
    description:
      'Mutates (INTEGRATION_ADMIN/ADMIN/SUPER_ADMIN only): revokes an existing clinical-' +
      'continuity facility-context capture grant, recording the revoking actor and a mandatory ' +
      'audited reason (non-empty, at most 500 characters, no control characters).' + ALWAYS_503,
  },
  'POST /api/v1/admin/devices/continuity-device-loss': {
    summary: 'Contain one reported continuity device loss',
    description:
      'SUPER_ADMIN-only, MFA step-up protected and idempotent device-loss orchestration. Phase 0 ' +
      'performs a read-only activation and authority preflight. Phase 1 atomically revokes the ' +
      'device capture grants and C3 edge-read grants, then invokes the existing C-D15 SCIM ' +
      'identity shutdown for sessions, staff sessions, devices, PINs and biometrics while ' +
      'preserving its exact named break-glass exclusion; the same transaction persists the ' +
      'operation projections and required append-only clinical audit evidence. Phase 1.5 ' +
      'revokes tokens through the existing Redis-plus-database revoker and issues exactly one ' +
      'canonical signed wipe order. Phase 2 arms the durable C-D6 fallback-principal route for ' +
      'later unsynced work and records the residual offline-pack risk window. Effects outside ' +
      'the Phase 1 transaction are best-effort with durable failure evidence: a non-final ' +
      'failure returns 503 with the incomplete operation, and re-invocation skips proved steps ' +
      'and retries the first unfinished step. Tenants without the exact typed active setting ' +
      'receive 503 CONTINUITY_DEVICE_LOSS_ORCHESTRATION_NOT_ACTIVATED without mutation. A new ' +
      'operation returns 202; an idempotent replay returns 200 and never mints a second order.',
    parameters: [idempotencyHeader],
    request: 'ClinicalContinuityDeviceLossRequest',
    response: 'ClinicalContinuityDeviceLossResponse',
    responseStatus: 202,
    additionalResponses: {
      200: {
        description: 'Idempotent replay of the same completed operation',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossResponse' }
          }
        }
      },
      503: {
        description:
          'Typed non-activation or an incomplete retryable post-commit step with evidence',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossFailureResponse' }
          }
        }
      },
      400: {
        description: 'Malformed request or missing/invalid Idempotency-Key',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossFailureResponse' }
          }
        }
      },
      403: {
        description: 'SUPER_ADMIN authority or MFA step-up is absent',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossFailureResponse' }
          }
        }
      },
      409: {
        description: 'Scope, authority, signer, fallback ownership, or in-flight operation conflict',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossFailureResponse' }
          }
        }
      },
      422: {
        description: 'Idempotency-Key was reused with a different request body',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ClinicalContinuityDeviceLossFailureResponse' }
          }
        }
      }
    }
  },
};
