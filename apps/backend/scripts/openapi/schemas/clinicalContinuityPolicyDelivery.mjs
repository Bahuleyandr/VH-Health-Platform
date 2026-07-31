const vendorMediaType = 'application/vnd.vhhealth.clinical-continuity-policy+json';
const errorResponse = code => ({
  description: code,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ClinicalContinuityPolicyDeliveryError' },
    },
  },
});

export const schemas = {
  ClinicalContinuityPolicyDelivery: {
    type: 'object',
    additionalProperties: false,
    required: ['format', 'policyId', 'payload', 'signature'],
    properties: {
      format: {
        type: 'string',
        enum: ['vhhealth_clinical_continuity_policy_delivery/v1'],
      },
      policyId: { type: 'string', format: 'uuid' },
      payload: {
        type: 'object',
        description: 'Exact closed C4.2 policy signing payload covered by signature.',
      },
      signature: {
        type: 'string',
        pattern: '^[A-Za-z0-9+/]{86}==$|^[A-Za-z0-9+/]{87}=$',
      },
    },
  },
  ClinicalContinuityPolicyDeliveryError: {
    type: 'object',
    additionalProperties: true,
    required: ['success', 'message', 'code'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: {
        type: 'string',
        enum: [
          'CONTINUITY_POLICY_FACILITY_FORBIDDEN',
          'CONTINUITY_POLICY_NOT_PUBLISHED',
          'CONTINUITY_POLICY_NOT_ACTIVATED',
          'CONTINUITY_POLICY_SUPERSEDED',
          'CONTINUITY_POLICY_REVOKED',
          'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED',
        ],
      },
    },
  },
};

export const operations = {
  'GET /api/v1/clinical-continuity/facilities/{facilityId}/policy': {
    summary: 'Fetch exact signed clinical continuity action-policy bytes',
    description:
      'Authenticated Staff delivery of the canonical signed policy envelope for one AF-authorized facility.',
    pathParameters: {
      facilityId: { type: 'integer', minimum: 1, maximum: 2147483647 },
    },
    parameters: [
      {
        name: 'X-VH-Continuity-Facility-Context',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 16384 },
      },
      {
        name: 'If-None-Match',
        in: 'header',
        required: false,
        schema: { type: 'string' },
      },
    ],
    response: 'ClinicalContinuityPolicyDelivery',
    responseContentType: vendorMediaType,
    responseDescription: 'Canonical delivery envelope bytes',
    additionalResponses: {
      304: { description: 'Current representation is unchanged' },
      403: errorResponse('CONTINUITY_POLICY_FACILITY_FORBIDDEN'),
      404: errorResponse('CONTINUITY_POLICY_NOT_PUBLISHED'),
      409: errorResponse('CONTINUITY_POLICY_NOT_ACTIVATED'),
      410: errorResponse('CONTINUITY_POLICY_SUPERSEDED or CONTINUITY_POLICY_REVOKED'),
      503: errorResponse('CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED'),
    },
  },
};
