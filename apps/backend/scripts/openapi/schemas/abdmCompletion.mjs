// apps/backend/scripts/openapi/schemas/abdmCompletion.mjs
// ABDM completion (migrations 701-703): ABHA enrolment (Aadhaar-OTP /
// mobile-OTP against the ABDM sandbox by default), Scan & Share front-desk
// intake, and the thin HIU consent/fetch legs.
// Config-gated DEFAULT OFF: ABDM_ENABLED env AND the per-tenant
// tenants.settings.abdmEnrolment / abdmHiu accessors (403
// ABDM_ENROLMENT_DISABLED / ABDM_HIU_DISABLED).
// PRIVACY: Aadhaar numbers and OTP values are RSA-encrypted in memory and
// forwarded — never persisted, logged, or echoed by any endpoint here.
import { envelope } from './_helpers.mjs';

const AUTHENTICATED_SECURITY = [{ ApiKeyAuth: [], BearerAuth: [] }];
const errorResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/AbdmCompletionErrorResponse' },
    },
  },
});
const authenticatedErrorResponses = {
  400: errorResponse('The request was malformed or failed ABDM protocol validation.'),
  401: errorResponse('The API key or bearer token was missing or invalid.'),
  403: errorResponse('The caller, tenant, or ABDM feature gate did not permit this operation.'),
  404: errorResponse('The tenant-scoped ABDM resource was not found.'),
  409: errorResponse('The request conflicted with the current enrolment, consent, or intake state.'),
  429: errorResponse('The caller exceeded an enrolment, OTP, or API rate limit.'),
  500: errorResponse('The ABDM operation failed without exposing protected health information.'),
};
const callbackErrorResponses = {
  400: errorResponse('The callback body or ABDM protocol fields were invalid.'),
  401: errorResponse('The callback signature or provider identity could not be authenticated.'),
  409: errorResponse('The callback conflicted with retained transaction or page evidence.'),
  429: errorResponse('The callback source exceeded the public webhook rate limit.'),
  500: errorResponse('The authenticated callback could not be recorded; the sender may retry.'),
  503: errorResponse(
    'The ABDM integration, durable replay authority, or safe storage cleanup was unavailable; the sender must retry.',
  ),
};
const hiuAuthenticatedErrorResponses = {
  ...authenticatedErrorResponses,
  503: errorResponse('ABDM HIU is disabled or unavailable.'),
};
const hiuDataPushCallbackErrorResponses = {
  ...callbackErrorResponses,
  413: errorResponse('The callback exceeded an ABDM page, object, or byte limit.'),
};
const ABDM_CALLBACK_PARAMETERS = [
  {
    name: 'x-hip-id',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 1 },
    description: 'Tenant-resolving HIP identity covered by the callback credential selection.',
  },
  {
    name: 'x-abdm-signature-version',
    in: 'header',
    required: true,
    schema: { type: 'string', enum: ['v1'] },
    description:
      'Endpoint-bound signature contract. Production accepts only v1. A separately configured, '
      + 'sandbox-only migration seam may temporarily accept an unversioned legacy signature.',
  },
  {
    name: 'x-abdm-signature',
    in: 'header',
    required: true,
    schema: { type: 'string', pattern: '^(?:sha256=)?[0-9a-fA-F]{64}$' },
    description:
      'HMAC-SHA256 over vhhealth.signed-request.v1, POST, the canonical application path, '
      + 'timestamp, request-id, and the exact raw request bytes, separated by LF bytes.',
  },
  {
    name: 'timestamp',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 1 },
    description: 'Fresh signed timestamp within the callback replay window.',
  },
  {
    name: 'request-id',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 1 },
    description: 'Signed request identity used by the durable, endpoint-bound replay claim.',
  },
];
const ABDM_CALLBACK_SIGNATURE_DESCRIPTION =
  'Authenticity uses endpoint-bound v1 HMAC over the exact raw JSON bytes, HTTP method, and '
  + 'canonical application path (/api/v1/abdm plus the callback route). Query parameters and '
  + 'reverse-proxy prefixes are excluded from that canonical path. A wrong method/path fails '
  + 'signature verification before the replay identity is claimed.';

export const schemas = {
  AbdmCompletionErrorResponse: {
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
  AbhaEnrolmentStartRequest: {
    type: 'object',
    properties: {
      flow: {
        type: 'string',
        enum: ['aadhaar_otp', 'mobile_otp'],
        default: 'aadhaar_otp',
        description: 'aadhaar_otp creates a new ABHA; mobile_otp is the verify/update-mobile leg for an already-enrolled ABHA.',
      },
      aadhaar_number: {
        type: 'string',
        nullable: true,
        description: '12-digit Aadhaar (Verhoeff-validated). Encrypted in memory with the gateway certificate and discarded — never persisted or logged.',
      },
      mobile: { type: 'string', nullable: true, description: '10-digit mobile (mobile_otp flow, or communication mobile).' },
      patient_uid: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'Front-desk assisted mount only; the portal mount always targets the caller.',
      },
    },
  },
  AbhaEnrolmentOtpRequest: {
    type: 'object',
    required: ['session_id', 'otp'],
    properties: {
      session_id: { type: 'integer' },
      otp: { type: 'string', description: '6-digit OTP. Encrypted in memory and forwarded — never persisted or logged.' },
    },
  },
  AbhaEnrolmentResendRequest: {
    type: 'object',
    required: ['session_id'],
    properties: {
      session_id: { type: 'integer' },
      aadhaar_number: {
        type: 'string',
        nullable: true,
        description: 'Required again for the aadhaar_otp flow — the number is never stored, so a resend must re-supply it.',
      },
      mobile: { type: 'string', nullable: true },
    },
  },
  AbhaEnrolmentCancelRequest: {
    type: 'object',
    required: ['session_id'],
    properties: { session_id: { type: 'integer' } },
  },
  AbhaEnrolmentSession: {
    type: 'object',
    required: ['id', 'flow', 'environment', 'status'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      flow: { type: 'string', enum: ['aadhaar_otp', 'mobile_otp'] },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      status: {
        type: 'string',
        enum: ['initiated', 'otp_sent', 'otp_verifying', 'otp_verified', 'enrolled', 'linked', 'failed', 'expired', 'cancelled'],
      },
      otp_attempts: { type: 'integer' },
      mobile_last4: { type: 'string', nullable: true, description: 'The only demographic echo kept — never the full mobile, never any Aadhaar material.' },
      abha_number: { type: 'string', nullable: true },
      abha_address: { type: 'string', nullable: true },
      error_code: { type: 'string', nullable: true },
      otp_sent_at: { type: 'string', format: 'date-time', nullable: true },
      enrolled_at: { type: 'string', format: 'date-time', nullable: true },
      linked_at: { type: 'string', format: 'date-time', nullable: true },
      expires_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  AbhaEnrolmentSessionData: {
    type: 'object',
    required: ['session'],
    properties: { session: { $ref: '#/components/schemas/AbhaEnrolmentSession' } },
  },
  AbhaEnrolmentStatusData: {
    type: 'object',
    properties: {
      session: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/AbhaEnrolmentSession' }],
        description: 'Latest enrolment session for the patient, or null when none exists.',
      },
    },
  },

  AbdmShareIntake: {
    type: 'object',
    required: ['id', 'request_id', 'environment', 'status'],
    properties: {
      id: { type: 'integer' },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      request_id: { type: 'string', description: 'CM request id — UNIQUE per (tenant, environment); redeliveries collapse.' },
      token_number: { type: 'string', nullable: true, description: 'Queue-display token (CM-assigned, or minted from the row id).' },
      counter_context: { type: 'string', nullable: true },
      abha_number: { type: 'string', nullable: true },
      abha_address: { type: 'string', nullable: true },
      profile: { type: 'object', description: 'Allowlisted shared demographics only — never Aadhaar material.' },
      status: {
        type: 'string',
        enum: ['received', 'matched', 'registered', 'linked_visit', 'dismissed', 'expired', 'failed'],
      },
      matched_patient_uid: { type: 'string', format: 'uuid', nullable: true },
      linked_appointment_id: { type: 'integer', nullable: true },
      processed_at: { type: 'string', format: 'date-time', nullable: true },
      received_at: { type: 'string', format: 'date-time' },
      expires_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  AbdmShareIntakeData: {
    type: 'object',
    required: ['intake'],
    properties: { intake: { $ref: '#/components/schemas/AbdmShareIntake' } },
  },
  AbdmShareIntakeList: {
    type: 'object',
    required: ['intakes', 'count'],
    properties: {
      intakes: { type: 'array', items: { $ref: '#/components/schemas/AbdmShareIntake' } },
      count: { type: 'integer' },
    },
  },
  AbdmShareIntakeMatchRequest: {
    type: 'object',
    required: ['patient_uid'],
    properties: { patient_uid: { type: 'string', format: 'uuid' } },
  },
  AbdmShareIntakeRegisterRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', nullable: true, description: 'Overrides the shared profile value.' },
      phone: { type: 'string', nullable: true },
      gender: { type: 'string', nullable: true },
      birthday: { type: 'string', nullable: true, description: 'YYYY-MM-DD.' },
      address: { type: 'string', nullable: true },
      duplicate_override_reason: {
        type: 'string',
        nullable: true,
        description: 'Audited create-anyway reason (min 10 chars) once duplicates were reviewed.',
      },
    },
  },
  AbdmShareIntakeRegisterResult: {
    type: 'object',
    required: ['intake', 'patient'],
    properties: {
      intake: { $ref: '#/components/schemas/AbdmShareIntake' },
      patient: {
        type: 'object',
        required: ['uid'],
        properties: {
          id: { type: 'integer' },
          uid: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          phone: { type: 'string' },
        },
      },
      abha_link: { type: 'object', nullable: true, description: 'registerABHA linkage result (verified only if it passed the 653 gate).' },
      abha_link_error: { type: 'string', nullable: true },
      duplicate_override: { type: 'boolean' },
    },
  },
  AbdmShareIntakeLinkVisitRequest: {
    type: 'object',
    required: ['appointment_id'],
    properties: { appointment_id: { type: 'integer' } },
  },
  AbdmShareIntakeDismissRequest: {
    type: 'object',
    properties: { reason: { type: 'string', nullable: true, maxLength: 500 } },
  },
  AbdmShareCallbackAck: {
    type: 'object',
    required: ['acknowledgement'],
    properties: {
      acknowledgement: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', enum: ['SUCCESS'] } },
      },
      requestId: { type: 'string', nullable: true },
      tokenNumber: { type: 'string', nullable: true },
    },
  },
  AbdmHiuCallbackAck: {
    type: 'object',
    properties: {
      requestId: { type: 'string', nullable: true },
      duplicate: { type: 'boolean' },
    },
  },
  AbdmHiuDataPushAck: {
    type: 'object',
    required: ['transactionId'],
    properties: {
      transactionId: { type: 'string' },
      duplicate: { type: 'boolean' },
      stored: { type: 'integer' },
      failed: { type: 'integer' },
    },
  },

  AbdmHiuConsentRequestCreate: {
    type: 'object',
    required: ['abha_address', 'hi_types', 'date_from', 'date_to', 'expiry'],
    properties: {
      abha_address: { type: 'string', description: 'Patient ABHA address (name@abdm / name@sbx).' },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      purpose: { type: 'string', default: 'CAREMGT' },
      hi_types: { type: 'array', items: { type: 'string' }, minItems: 1 },
      date_from: { type: 'string', format: 'date-time' },
      date_to: { type: 'string', format: 'date-time' },
      expiry: { type: 'string', format: 'date-time' },
    },
  },
  AbdmHiuConsentRequest: {
    type: 'object',
    required: ['id', 'request_id', 'status'],
    properties: {
      id: { type: 'integer' },
      request_id: { type: 'string' },
      flow_kind: { type: 'string', enum: ['hiu'] },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      requester_uid: { type: 'string', format: 'uuid', nullable: true },
      hi_types: { type: 'array', items: { type: 'string' } },
      permission_kind: { type: 'string' },
      data_from: { type: 'string', format: 'date-time', nullable: true },
      data_to: { type: 'string', format: 'date-time', nullable: true },
      expiry_at: { type: 'string', format: 'date-time', nullable: true },
      purpose_code: { type: 'string' },
      status: { type: 'string', enum: ['requested', 'granted', 'denied', 'revoked', 'expired', 'failed'] },
      requested_at: { type: 'string', format: 'date-time' },
      decided_at: { type: 'string', format: 'date-time', nullable: true },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      metadata: { type: 'object' },
    },
  },
  AbdmHiuConsentRequestData: {
    type: 'object',
    required: ['consent_request'],
    properties: { consent_request: { $ref: '#/components/schemas/AbdmHiuConsentRequest' } },
  },
  AbdmHiuConsentRequestList: {
    type: 'object',
    required: ['consent_requests', 'count'],
    properties: {
      consent_requests: { type: 'array', items: { $ref: '#/components/schemas/AbdmHiuConsentRequest' } },
      count: { type: 'integer' },
    },
  },
  AbdmHiuConsentArtifactList: {
    type: 'object',
    required: ['artifacts', 'count'],
    properties: {
      artifacts: { type: 'array', items: { type: 'object' } },
      count: { type: 'integer' },
    },
  },
  AbdmHiuFetchSession: {
    type: 'object',
    required: ['id', 'transaction_id', 'status'],
    properties: {
      id: { type: 'integer' },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      consent_artifact_id: { type: 'integer', nullable: true },
      data_transfer_id: { type: 'integer', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      transaction_id: { type: 'string' },
      request_id: { type: 'string', nullable: true },
      hi_types: { type: 'array', items: { type: 'string' } },
      date_range_from: { type: 'string', format: 'date-time', nullable: true },
      date_range_to: { type: 'string', format: 'date-time', nullable: true },
      data_push_url: { type: 'string', nullable: true },
      status: {
        type: 'string',
        enum: ['requested', 'acknowledged', 'receiving', 'completed', 'partial', 'failed', 'expired'],
      },
      parts_expected: { type: 'integer', nullable: true },
      parts_received: { type: 'integer' },
      requested_at: { type: 'string', format: 'date-time' },
      acknowledged_at: { type: 'string', format: 'date-time', nullable: true },
      completed_at: { type: 'string', format: 'date-time', nullable: true },
      failure_reason: { type: 'string', nullable: true },
    },
  },
  AbdmHiuFetchSessionData: {
    type: 'object',
    required: ['session'],
    properties: { session: { $ref: '#/components/schemas/AbdmHiuFetchSession' } },
  },
  AbdmHiuFetchSessionList: {
    type: 'object',
    required: ['sessions', 'count'],
    properties: {
      sessions: { type: 'array', items: { $ref: '#/components/schemas/AbdmHiuFetchSession' } },
      count: { type: 'integer' },
    },
  },
  AbdmHiuReceivedBundle: {
    type: 'object',
    required: ['id', 'fetch_session_id', 'bundle_sha256', 'byte_length'],
    properties: {
      id: { type: 'integer' },
      fetch_session_id: { type: 'integer' },
      fetch_page_id: { type: 'integer' },
      page_number: { type: 'integer', minimum: 1 },
      care_context_reference: { type: 'string', nullable: true },
      hi_type: { type: 'string', nullable: true },
      part_number: { type: 'integer', nullable: true },
      bundle_sha256: { type: 'string' },
      byte_length: {
        type: 'integer',
        minimum: 0,
        maximum: 524288,
        description: 'Verified decrypted byte length. The private R2 object key is never exposed.',
      },
      checksum_verified: { type: 'boolean' },
      media_type: { type: 'string' },
      received_at: { type: 'string', format: 'date-time' },
    },
  },
  AbdmHiuBundleList: {
    type: 'object',
    required: ['bundles', 'count', 'total', 'limit', 'offset'],
    properties: {
      bundles: { type: 'array', items: { $ref: '#/components/schemas/AbdmHiuReceivedBundle' } },
      count: { type: 'integer' },
      total: { type: 'integer', maximum: 1000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0, maximum: 2147483647 },
    },
  },
  AbdmHiuBundleContent: {
    type: 'object',
    required: ['bundle', 'content'],
    properties: {
      bundle: { $ref: '#/components/schemas/AbdmHiuReceivedBundle' },
      content: { description: 'The decrypted FHIR bundle, streamed from R2 for transient rendering (PHI access is logged).' },
    },
  },

  AbhaEnrolmentSessionResponse: envelope('AbhaEnrolmentSessionData'),
  AbhaEnrolmentStatusResponse: envelope('AbhaEnrolmentStatusData'),
  AbdmShareIntakeResponse: envelope('AbdmShareIntakeData'),
  AbdmShareIntakeListResponse: envelope('AbdmShareIntakeList'),
  AbdmShareIntakeRegisterResponse: envelope('AbdmShareIntakeRegisterResult'),
  AbdmShareCallbackAckResponse: envelope('AbdmShareCallbackAck'),
  AbdmHiuCallbackAckResponse: envelope('AbdmHiuCallbackAck'),
  AbdmHiuDataPushAckResponse: envelope('AbdmHiuDataPushAck'),
  AbdmHiuConsentRequestResponse: envelope('AbdmHiuConsentRequestData'),
  AbdmHiuConsentRequestListResponse: envelope('AbdmHiuConsentRequestList'),
  AbdmHiuConsentArtifactListResponse: envelope('AbdmHiuConsentArtifactList'),
  AbdmHiuFetchSessionResponse: envelope('AbdmHiuFetchSessionData'),
  AbdmHiuFetchSessionListResponse: envelope('AbdmHiuFetchSessionList'),
  AbdmHiuBundleListResponse: envelope('AbdmHiuBundleList'),
  AbdmHiuBundleContentResponse: envelope('AbdmHiuBundleContent'),
};

const enrolmentOps = (base, audience) => ({
  [`POST ${base}/start`]: {
    description: `Starts an ABHA enrolment session (${audience}). Validates the 12-digit Aadhaar (Verhoeff), encrypts it in memory with the gateway certificate, requests the enrolment OTP, and returns the session (status otp_sent). One live session per patient; OTP rate-limited (3 per 10 min). 403 ABDM_ENROLMENT_DISABLED until tenants.settings.abdmEnrolment.enabled AND ABDM_ENABLED hold. No Aadhaar material is ever persisted, logged, or echoed.`,
    request: 'AbhaEnrolmentStartRequest',
    response: 'AbhaEnrolmentSessionResponse',
    responseStatus: 201,
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  [`POST ${base}/otp`]: {
    description: `Verifies the enrolment OTP (${audience}). Aadhaar flow completes enrolment at the gateway and links the resulting ABHA through the migration-653 verified gate (users.abha_verification_status='verified' + clinical_audit_events row, one transaction; no clinical timeline row — identity, not clinical care). Attempts cap at 3, then the session fails. 409 ABHA_ALREADY_LINKED when another patient holds the verified slot.`,
    request: 'AbhaEnrolmentOtpRequest',
    response: 'AbhaEnrolmentSessionResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  [`POST ${base}/resend`]: {
    description: `Re-sends the enrolment OTP (${audience}). The Aadhaar number is never stored, so the aadhaar_otp flow must re-supply it (validated, encrypted in memory, discarded). Capped at 3 resends; OTP rate-limited.`,
    request: 'AbhaEnrolmentResendRequest',
    response: 'AbhaEnrolmentSessionResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  [`POST ${base}/cancel`]: {
    description: `Cancels a live enrolment session (${audience}).`,
    request: 'AbhaEnrolmentCancelRequest',
    response: 'AbhaEnrolmentSessionResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
});

const patientUidQuery = {
  name: 'patient_uid',
  in: 'query',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description: 'Verified patient context required by the clinical PHI access guard.',
};
const listLimitQuery = (maximum = 200, defaultValue = 50) => ({
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum, default: defaultValue },
});

export const operations = {
  ...enrolmentOps('/api/v1/portal/abdm/enrolment', 'patient self-service; target is always the caller'),
  'GET /api/v1/portal/abdm/enrolment/status': {
    description: 'The calling patient\'s latest ABHA enrolment session (safe projection — no txn id, no profile snapshot).',
    response: 'AbhaEnrolmentStatusResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  ...enrolmentOps('/api/v1/abdm/enrolment', 'front-desk assisted; patient_uid in the body, patient-registry write roles'),
  'GET /api/v1/abdm/enrolment/status/{patientUid}': {
    description: 'Front-desk view of a patient\'s latest ABHA enrolment session.',
    response: 'AbhaEnrolmentStatusResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },

  'GET /api/v1/front-desk/abdm/share-intakes': {
    description: 'Front-desk queue of Scan & Share intakes (patient-scanned counter QR → CM profile share). Filter with ?status=received for the live counter screen.',
    parameters: [
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: {
          type: 'string',
          enum: ['received', 'matched', 'registered', 'linked_visit', 'dismissed', 'expired', 'failed'],
        },
      },
      listLimitQuery(),
      {
        name: 'offset',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0, default: 0 },
      },
    ],
    response: 'AbdmShareIntakeListResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'GET /api/v1/front-desk/abdm/share-intakes/{id}': {
    description: 'One Scan & Share intake with the shared (allowlisted) demographics.',
    response: 'AbdmShareIntakeResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'POST /api/v1/front-desk/abdm/share-intakes/{id}/match': {
    description: 'Attaches the intake to an EXISTING patient (status received → matched). Audited front-office identity action.',
    request: 'AbdmShareIntakeMatchRequest',
    response: 'AbdmShareIntakeResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'POST /api/v1/front-desk/abdm/share-intakes/{id}/register': {
    description: 'Registers a NEW patient from the intake through the guarded front-desk flow: exact-phone probe + duplicate candidate scan 409 PATIENT_DUPLICATE_REVIEW_REQUIRED until reviewed or overridden with an audited reason (min 10 chars). On create the shared ABHA links via the registerABHA verified-gate pathway; a linkage refusal is recorded on the intake, never a rollback. Status → registered.',
    request: 'AbdmShareIntakeRegisterRequest',
    response: 'AbdmShareIntakeRegisterResponse',
    responseStatus: 201,
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'POST /api/v1/front-desk/abdm/share-intakes/{id}/link-visit': {
    description: 'Attaches an existing OP appointment belonging to the resolved patient (status matched/registered → linked_visit).',
    request: 'AbdmShareIntakeLinkVisitRequest',
    response: 'AbdmShareIntakeResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'POST /api/v1/front-desk/abdm/share-intakes/{id}/dismiss': {
    description: 'Dismisses an intake without action (audited).',
    request: 'AbdmShareIntakeDismissRequest',
    response: 'AbdmShareIntakeResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },

  'POST /api/v1/abdm/patients/profile/share': {
    description: `Public ABDM callback (pre-auth mount): the CM posts a patient-shared profile after a counter-QR scan. ${ABDM_CALLBACK_SIGNATURE_DESCRIPTION} Transport evidence lands as a plain abdm_webhook_events row (receipt_source NULL by design); redeliveries collapse on the (tenant, request_id, environment) unique and 202-ack replay-safe with the queue token.`,
    response: 'AbdmShareCallbackAckResponse',
    responseStatus: 202,
    security: [],
    parameters: ABDM_CALLBACK_PARAMETERS,
    additionalResponses: callbackErrorResponses,
  },
  'POST /api/v1/abdm/hiu/consent-requests/on-init': {
    description: `Public ABDM callback: gateway acknowledgement of a HIU consent-request init. Stamps the CM consent-request id (or fails the request row on error). ${ABDM_CALLBACK_SIGNATURE_DESCRIPTION}`,
    response: 'AbdmHiuCallbackAckResponse',
    responseStatus: 202,
    security: [],
    parameters: ABDM_CALLBACK_PARAMETERS,
    additionalResponses: callbackErrorResponses,
  },
  'POST /api/v1/abdm/hiu/consents/notify': {
    description: `Public ABDM callback: CM consent notification for the HIU (GRANTED/DENIED/REVOKED/EXPIRED). Every GRANTED notification must carry a signed consent artefact; signature verification is mandatory on this HIU path regardless of the optional HIP-side verification toggle. Revocation and expiry immediately deny bundle access and schedule durable R2 cleanup. ${ABDM_CALLBACK_SIGNATURE_DESCRIPTION}`,
    response: 'AbdmHiuCallbackAckResponse',
    responseStatus: 202,
    security: [],
    parameters: ABDM_CALLBACK_PARAMETERS,
    additionalResponses: callbackErrorResponses,
  },
  'POST /api/v1/abdm/hiu/health-info/on-request': {
    description: `Public ABDM callback: CM acknowledgement of our health-information request — stamps the CM transactionId on the fetch session (status requested → acknowledged). ${ABDM_CALLBACK_SIGNATURE_DESCRIPTION}`,
    response: 'AbdmHiuCallbackAckResponse',
    responseStatus: 202,
    security: [],
    parameters: ABDM_CALLBACK_PARAMETERS,
    additionalResponses: callbackErrorResponses,
  },
  'POST /api/v1/abdm/hiu/health-info/push': {
    description: `Public ABDM callback (the dataPushUrl leg): the HIP pushes encrypted FHIR entries. Each part decrypts against the session's persisted X25519 receive key (encryptField ciphertext, NULLed after the final page), checksum-failed parts are rejected, and consent is revalidated before durable storage references commit. Page redeliveries collapse per (transactionId, page). Limits are 100 pages, 1000 bundles per session, 1000 entries per page, 1 MiB per request/decrypted page, 512 KiB per decrypted bundle, and 20 MiB of decrypted bundles per session. ${ABDM_CALLBACK_SIGNATURE_DESCRIPTION}`,
    response: 'AbdmHiuDataPushAckResponse',
    responseStatus: 202,
    security: [],
    parameters: ABDM_CALLBACK_PARAMETERS,
    additionalResponses: hiuDataPushCallbackErrorResponses,
  },

  'POST /api/v1/abdm/hiu/consent-requests': {
    description: 'Clinician-initiated HIU consent request: persists the abdm_consent_requests row (flow_kind hiu, durable evidence first), then inits at the gateway — a gateway refusal fails the row. 403 ABDM_HIU_DISABLED until tenants.settings.abdmHiu.enabled AND ABDM_ENABLED hold.',
    request: 'AbdmHiuConsentRequestCreate',
    response: 'AbdmHiuConsentRequestResponse',
    responseStatus: 201,
    security: AUTHENTICATED_SECURITY,
    additionalResponses: hiuAuthenticatedErrorResponses,
  },
  'GET /api/v1/abdm/hiu/consent-requests': {
    description: 'HIU consent requests for this tenant (flow_kind hiu), newest first.',
    parameters: [
      patientUidQuery,
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['requested', 'granted', 'denied', 'revoked', 'expired', 'failed'] },
      },
      listLimitQuery(),
    ],
    response: 'AbdmHiuConsentRequestListResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'GET /api/v1/abdm/hiu/consents': {
    description: 'Consent artefacts granted against HIU consent requests.',
    parameters: [patientUidQuery, listLimitQuery()],
    response: 'AbdmHiuConsentArtifactListResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'POST /api/v1/abdm/hiu/consents/{artifactId}/fetch': {
    description: 'Starts a health-information fetch against an ACTIVE consent artefact: generates the X25519 receive keypair, persists the private key encryptField-encrypted for the async hi-request → data-push gap (NULLed after decrypt; 30-min liability window), creates the direction-in transfer row, and hands the public key material + dataPushUrl to the CM.',
    response: 'AbdmHiuFetchSessionResponse',
    responseStatus: 201,
    security: AUTHENTICATED_SECURITY,
    additionalResponses: hiuAuthenticatedErrorResponses,
  },
  'GET /api/v1/abdm/hiu/sessions': {
    description: 'HIU fetch sessions (requested → acknowledged → receiving → completed | partial | failed | expired). Key material columns are never exposed.',
    parameters: [
      patientUidQuery,
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: {
          type: 'string',
          enum: ['requested', 'acknowledged', 'receiving', 'completed', 'partial', 'failed', 'expired'],
        },
      },
      listLimitQuery(),
    ],
    response: 'AbdmHiuFetchSessionListResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'GET /api/v1/abdm/hiu/sessions/{id}': {
    description: 'One HIU fetch session (safe projection — no key material).',
    response: 'AbdmHiuFetchSessionResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'GET /api/v1/abdm/hiu/sessions/{id}/bundles': {
    description: 'Bounded reference-page for decrypted bundles received by a fetch session. Access fails closed after revocation, expiry, dataEraseAt, or inconsistent byte/object accounting. PHI bytes live in R2, not in these rows.',
    parameters: [
      listLimitQuery(100),
      {
        name: 'offset',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0, maximum: 2147483647, default: 0 },
      },
    ],
    response: 'AbdmHiuBundleListResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'GET /api/v1/abdm/hiu/sessions/{id}/bundles/{bundleId}': {
    description: 'Streams one decrypted FHIR bundle from R2 for transient rendering only while the exact tenant, patient, request, artefact, session, byte-count, and SHA-256 chain remains valid. Revocation, expiry, dataEraseAt, or accounting drift fails closed before content is returned. This is PHI access (logPhiAccess), not a clinical write — importing a fetched record into the local chart is a separate, timeline-bearing operation this endpoint does not perform.',
    response: 'AbdmHiuBundleContentResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'POST /api/v1/abdm/consent/on-notify': {
    description:
      `Public ABDM consent notification callback. ${ABDM_CALLBACK_SIGNATURE_DESCRIPTION}`,
    responseStatus: 202,
    security: [],
    parameters: ABDM_CALLBACK_PARAMETERS,
    additionalResponses: callbackErrorResponses,
  },
  'POST /api/v1/abdm/health-info/on-request': {
    description:
      `Public ABDM health-information request callback. ${ABDM_CALLBACK_SIGNATURE_DESCRIPTION}`,
    responseStatus: 202,
    security: [],
    parameters: ABDM_CALLBACK_PARAMETERS,
    additionalResponses: callbackErrorResponses,
  },
};
