import { envelope } from './_helpers.mjs';

const sha256 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const positiveInt = { type: 'integer', minimum: 1, maximum: 2147483647 };
const idempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$',
  },
};

export const schemas = {
  NhcxAcceptedProjectionRecovery: {
    type: 'object',
    additionalProperties: false,
    required: [
      'message_id', 'cycle', 'claim_id', 'preauth_id', 'patient_uid', 'admission_id',
      'status', 'transport_accepted_at', 'transport_http_status',
      'transport_response_sha256', 'transport_gateway_reference', 'projection_status',
      'projection_error', 'projection_evidence', 'task_id', 'task_status', 'owner_role',
      'deep_link', 'next_action',
    ],
    properties: {
      message_id: positiveInt,
      // Every outbound cycle can carry a durable gateway receipt, so all six
      // are readable here. Only `claim` and `preauth` own a local workflow row
      // to project onto; the other four close as projection-complete with a
      // not-applicable evidence contract and are never left reconcilable.
      cycle: {
        type: 'string',
        enum: ['eligibility', 'preauth', 'claim', 'communication', 'task', 'payment_notice'],
      },
      claim_id: { ...positiveInt, nullable: true },
      preauth_id: { ...positiveInt, nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      admission_id: { ...positiveInt, nullable: true },
      status: { type: 'string', enum: ['accepted'] },
      transport_accepted_at: { type: 'string', format: 'date-time' },
      transport_http_status: { type: 'integer', minimum: 200, maximum: 299 },
      transport_response_sha256: sha256,
      transport_gateway_reference: { type: 'string', nullable: true },
      projection_status: { type: 'string', enum: ['applied', 'reconciliation_required'] },
      projection_error: { type: 'string', nullable: true },
      projection_evidence: { type: 'object', additionalProperties: true, nullable: true },
      task_id: { ...positiveInt, nullable: true },
      task_status: { type: 'string', nullable: true },
      owner_role: { type: 'string', enum: ['INSURANCE_COORDINATOR', null], nullable: true },
      deep_link: { type: 'string', pattern: '^/billing-desk\\?nhcx_projection_message_id=[1-9][0-9]*$' },
      next_action: {
        type: 'string',
        enum: ['retry_accepted_nhcx_projection', 'nhcx_projection_complete'],
      },
    },
  },
  NhcxAcceptedProjectionRetryRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['expected_transport_response_sha256'],
    properties: {
      expected_transport_response_sha256: sha256,
    },
  },
  NhcxAcceptedProjectionRecoveryResponse: envelope('NhcxAcceptedProjectionRecovery'),
};

export const operations = {
  'POST /api/v1/admin/nhcx/messages/{id}/claim-stranded-inbound': {
    description:
      'Authenticated ADMIN or step-up-authenticated SUPER_ADMIN operators may claim a stale inbound NHCX callback for owner-directed review within the request tenant. The claim records recovery ownership and disposition without replaying the callback or invoking NHCX domain, dispatch, redrive, or payment processing.',
  },
  'GET /api/v1/insurance/nhcx/projections/{messageId}': {
    summary: 'Read an exact accepted NHCX projection recovery task',
    description:
      'Returns the durable gateway 2xx receipt, local projection state, and exact insurance-coordinator task. This operation never contacts or resends to the NHCX gateway.',
    pathParameters: { messageId: positiveInt },
    response: 'NhcxAcceptedProjectionRecoveryResponse',
  },
  'POST /api/v1/insurance/nhcx/projections/{messageId}/retry': {
    summary: 'Retry local projection of an accepted NHCX receipt without resend',
    description:
      'Claims a durable command before mutation, verifies the exact immutable transport-response hash and task, applies only the local claim/pre-auth projection, and completes the insurance task in the same transaction. It never invokes the external gateway.',
    pathParameters: { messageId: positiveInt },
    parameters: [idempotencyKeyParameter],
    request: 'NhcxAcceptedProjectionRetryRequest',
    response: 'NhcxAcceptedProjectionRecoveryResponse',
  },
};
