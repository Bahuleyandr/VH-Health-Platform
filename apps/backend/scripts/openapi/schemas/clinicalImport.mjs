import { envelope } from './_helpers.mjs';

const AUTHENTICATED_SECURITY = [{ ApiKeyAuth: [], BearerAuth: [] }];
const SHA256_PATTERN = '^[0-9a-fA-F]{64}$';

const jsonResponse = (description, schemaName) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: `#/components/schemas/${schemaName}` },
    },
  },
});

const errorResponse = description => (
  jsonResponse(description, 'ClinicalImportErrorResponse')
);

const authenticatedErrorResponses = {
  400: errorResponse('The body or required clinical-import authority headers were malformed.'),
  401: errorResponse('The API key or bearer token was missing or invalid.'),
  403: errorResponse(
    'The caller was not an authorised Medical Records user or lacked patient access authority.',
  ),
  404: errorResponse('The authorised patient or asserted local source facility was unavailable.'),
  409: errorResponse(
    'The payload, replay identity, patient identity, or another document-level invariant conflicted. Source documents without a stable author reference or identifier fail closed with IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED and HELD_EXTERNAL_AUTHORITY for CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER.',
  ),
  413: errorResponse('The request exceeded the authenticated clinical-import parser limit of 5 MiB.'),
  415: errorResponse(
    'The Content-Type was unsupported, or request Content-Encoding compression was rejected because exact-byte custody parsers do not inflate request bodies.',
  ),
  429: errorResponse('The caller exceeded an API rate limit.'),
  500: errorResponse('The clinical import could not be completed or durably receipted.'),
};

const authorityParameters = payloadDescription => ([
  {
    name: 'X-VH-Import-Patient-Uid',
    in: 'header',
    required: true,
    description:
      'UUID of the single active same-tenant patient targeted by this governed Medical Records import.',
    schema: { type: 'string', format: 'uuid' },
  },
  {
    name: 'X-VH-Import-Source-System',
    in: 'header',
    required: true,
    description:
      'Caller-asserted source-system label retained as provenance. It does not activate or authenticate an external partner.',
    schema: { type: 'string', minLength: 1, maxLength: 255 },
  },
  {
    name: 'X-VH-Import-Source-Document-Id',
    in: 'header',
    required: true,
    description: 'Caller-asserted source document identity retained in the immutable import receipt.',
    schema: { type: 'string', minLength: 1, maxLength: 255 },
  },
  {
    name: 'X-VH-Import-Source-Facility-Id',
    in: 'header',
    required: true,
    description:
      'Positive database id of an active facility in the caller tenant. This is a local provenance identity, not proof of partner trust or an actor facility grant.',
    schema: { type: 'integer', minimum: 1 },
  },
  {
    name: 'X-VH-Import-Authority-Grant-Id',
    in: 'header',
    required: true,
    description:
      'UUID of the current dedicated clinical-import grant. Database authority must exactly bind the authenticated Medical Records actor, target patient, active source facility, source system, and document format. It does not verify an external partner signature.',
    schema: { type: 'string', format: 'uuid' },
  },
  {
    name: 'X-VH-Import-Source-Signature-Sha256',
    in: 'header',
    required: true,
    description:
      'Caller-asserted 64-hex signature digest retained as provenance with asserted/unverified status. This endpoint does not cryptographically verify an external signature or activate partner authority.',
    schema: { type: 'string', pattern: SHA256_PATTERN },
  },
  {
    name: 'X-VH-Import-Payload-Sha256',
    in: 'header',
    required: true,
    description: payloadDescription,
    schema: { type: 'string', pattern: SHA256_PATTERN },
  },
  {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    description:
      'Stable import command key. An exact retry replays the stored receipt; reuse against different authority or payload evidence fails closed.',
    schema: { type: 'string', minLength: 1, maxLength: 255 },
  },
  {
    name: 'X-VH-Import-Correction-Item-Id',
    in: 'header',
    required: false,
    description:
      'For a governed correction resubmission, the UUID of the open reconciliation item whose current RETRY_REQUESTED event caused this import. It must be supplied together with X-VH-Import-Correction-Manifest-Index; ordinary imports omit both.',
    schema: { type: 'string', format: 'uuid' },
  },
  {
    name: 'X-VH-Import-Correction-Manifest-Index',
    in: 'header',
    required: false,
    description:
      'For a governed correction resubmission, the zero-based manifest position that will become the causally bound replacement receipt. It must be supplied together with X-VH-Import-Correction-Item-Id and must resolve to an imported or deduplicated outcome.',
    schema: { type: 'integer', minimum: 0, maximum: 9999 },
  },
]);

const reconciliationActionParameters = [
  {
    name: 'X-VH-Import-Authority-Grant-Id',
    in: 'header',
    required: true,
    description:
      'UUID of a current clinical-import grant exactly scoped to the authenticated Medical Records actor, active patient survivor, source facility, source system, and document format recorded by this reconciliation item.',
    schema: { type: 'string', format: 'uuid' },
  },
  {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    description:
      'Stable reconciliation command key. An exact retry replays the stored event; reuse for another action, reason, grant, item, or replacement receipt fails closed.',
    schema: { type: 'string', minLength: 1, maxLength: 255 },
  },
];

const reconciliationActionErrorResponses = {
  400: errorResponse('The item id, authority headers, reason, or replacement receipt id was malformed.'),
  401: errorResponse('The API key or bearer token was missing or invalid.'),
  403: errorResponse(
    'The caller was not an active Medical Records user or lacked current patient-access or clinical-import grant authority.',
  ),
  404: errorResponse('The reconciliation item or requested event was not found in this tenant.'),
  409: errorResponse(
    'The item was terminal, the idempotency key conflicted, patient custody was invalid, or replacement receipt evidence did not match.',
  ),
  429: errorResponse('The caller exceeded an API rate limit.'),
  500: errorResponse('The reconciliation action could not be durably recorded.'),
};

function successEnvelope(payloadSchemaName) {
  const schema = envelope(payloadSchemaName);
  return {
    ...schema,
    additionalProperties: false,
    required: ['success', 'message', 'data'],
    properties: {
      ...schema.properties,
      success: { type: 'boolean', enum: [true] },
    },
  };
}

const receiptCountProperties = {
  imported: { type: 'integer', minimum: 0 },
  skipped: { type: 'integer', minimum: 0 },
  deduplicated: { type: 'integer', minimum: 0 },
  failed: { type: 'integer', minimum: 0 },
};

export const schemas = {
  ClinicalImportSourceAuthorIdentityHoldDetails: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'required_authority'],
    properties: {
      status: { type: 'string', enum: ['HELD_EXTERNAL_AUTHORITY'] },
      required_authority: {
        type: 'string',
        enum: ['CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER'],
      },
    },
  },
  ClinicalImportErrorResponse: {
    type: 'object',
    additionalProperties: true,
    required: ['success', 'message'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string' },
      details: {
        anyOf: [
          { $ref: '#/components/schemas/ClinicalImportSourceAuthorIdentityHoldDetails' },
          { type: 'object', additionalProperties: true },
        ],
        description:
          'For IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED, this conforms to ClinicalImportSourceAuthorIdentityHoldDetails.',
      },
      requestId: { type: 'string', nullable: true },
    },
  },
  ClinicalImportFhirResource: {
    type: 'object',
    additionalProperties: true,
    required: ['resourceType'],
    properties: {
      resourceType: { type: 'string', minLength: 1 },
      id: { type: 'string', nullable: true },
    },
  },
  ClinicalImportFhirBundleEntry: {
    type: 'object',
    additionalProperties: true,
    required: ['resource'],
    properties: {
      fullUrl: { type: 'string', nullable: true },
      resource: { $ref: '#/components/schemas/ClinicalImportFhirResource' },
    },
  },
  ClinicalImportFhirBundleRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['resourceType'],
    properties: {
      resourceType: { type: 'string', enum: ['Bundle'] },
      type: { type: 'string', nullable: true },
      entry: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalImportFhirBundleEntry' },
      },
    },
  },
  ClinicalImportCcdaJsonRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['xml'],
    properties: {
      xml: {
        type: 'string',
        minLength: 1,
        pattern: 'ClinicalDocument',
        description: 'C-CDA XML containing one ClinicalDocument and exactly one recordTarget.',
      },
    },
  },
  ClinicalImportCcdaXmlRequest: {
    type: 'string',
    minLength: 1,
    pattern: 'ClinicalDocument',
    description: 'Raw C-CDA XML containing one ClinicalDocument and exactly one recordTarget.',
  },
  ClinicalImportResourceError: {
    type: 'object',
    additionalProperties: false,
    required: ['resource', 'error'],
    properties: {
      resource: { type: 'string' },
      id: { type: 'string', nullable: true },
      index: { type: 'integer', minimum: 0, nullable: true },
      error: { type: 'string' },
      code: {
        type: 'string',
        nullable: true,
        description:
          'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED identifies a Condition or Allergy assertion held for governed reconciliation.',
      },
    },
  },
  ClinicalImportResourceReceipt: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'source_resource_type',
      'source_resource_id',
      'source_resource_index',
      'outcome',
      'target_table',
      'target_id',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      source_resource_type: { type: 'string' },
      source_resource_id: { type: 'string', nullable: true },
      source_resource_index: { type: 'integer', minimum: 0 },
      outcome: {
        type: 'string',
        enum: ['imported', 'deduplicated', 'skipped', 'failed'],
      },
      target_table: { type: 'string', nullable: true },
      target_id: { type: 'string', nullable: true },
    },
  },
  ClinicalImportObservationPartition: {
    type: 'object',
    additionalProperties: true,
    required: ['status', 'resourceCount', 'resourceIds'],
    properties: {
      status: {
        type: 'string',
        enum: ['imported', 'deduplicated', 'skipped', 'error', 'failed'],
      },
      resourceCount: { type: 'integer', minimum: 0 },
      resourceIds: {
        type: 'array',
        items: { type: 'string', nullable: true },
      },
      setFingerprint: { type: 'string', nullable: true },
      matchedSetFingerprint: { type: 'string', nullable: true },
      vitalsChartId: { type: 'integer', nullable: true },
      patientUid: { type: 'string', format: 'uuid', nullable: true },
      recordedAt: { type: 'string', format: 'date-time', nullable: true },
      clinicalEffectsReconciled: { type: 'boolean' },
      error: { type: 'string', nullable: true },
      errorCode: { type: 'string', nullable: true },
      errorStatusCode: { type: 'integer', nullable: true },
    },
  },
  ClinicalImportReconciliationItem: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'resource_receipt_id', 'opened_event_id', 'status'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      resource_receipt_id: { type: 'string', format: 'uuid' },
      opened_event_id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['OPENED'] },
    },
  },
  ClinicalImportReconciliationSource: {
    type: 'object',
    additionalProperties: false,
    required: [
      'document_receipt_id',
      'resource_receipt_id',
      'source_system',
      'source_document_id',
      'document_format',
      'source_resource_type',
      'source_resource_id',
      'source_resource_index',
      'error_code',
      'error',
    ],
    properties: {
      document_receipt_id: { type: 'string', format: 'uuid' },
      resource_receipt_id: { type: 'string', format: 'uuid' },
      source_system: { type: 'string' },
      source_document_id: { type: 'string' },
      document_format: { type: 'string', enum: ['fhir_bundle', 'ccda'] },
      source_resource_type: { type: 'string' },
      source_resource_id: { type: 'string', nullable: true },
      source_resource_index: { type: 'integer', minimum: 0 },
      error_code: {
        type: 'string',
        nullable: true,
        description:
          'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED identifies a held diagnosis or allergy assertion.',
      },
      error: { type: 'string', nullable: true },
    },
  },
  ClinicalImportReconciliationLatestEvent: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'event_type',
      'actor_uid',
      'reason',
      'evidence_sha256',
      'created_at',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      event_type: { type: 'string', enum: ['OPENED', 'RETRY_REQUESTED'] },
      actor_uid: { type: 'string', format: 'uuid' },
      reason: { type: 'string', minLength: 10, maxLength: 1000 },
      evidence_sha256: {
        type: 'string',
        pattern: SHA256_PATTERN,
        description:
          'Hash of the withheld append-only evidence. Authority grants, relationship identifiers, and custody internals are not returned in the shared worklist.',
      },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  ClinicalImportHeldSupersessionAction: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'status', 'required_authority', 'endpoint'],
    properties: {
      action: { type: 'string', enum: ['SUPERSEDE'] },
      status: { type: 'string', enum: ['HELD_EXTERNAL_AUTHORITY'] },
      required_authority: { type: 'string', enum: ['CLINICAL_IMPORT_SUPERSESSION_OWNER'] },
      endpoint: { type: 'string', nullable: true, enum: [null] },
    },
  },
  ClinicalImportHeldSupersessionReview: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'status', 'required_authority', 'endpoint'],
    properties: {
      action: { type: 'string', enum: ['OWNER_SUPERSESSION_REVIEW_REQUIRED'] },
      status: { type: 'string', enum: ['HELD_EXTERNAL_AUTHORITY'] },
      required_authority: { type: 'string', enum: ['CLINICAL_IMPORT_SUPERSESSION_OWNER'] },
      endpoint: { type: 'string', nullable: true, enum: [null] },
    },
  },
  ClinicalImportReconciliationWorkItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'owned_by_caller',
      'owner_actor_uid',
      'historical_patient_uid',
      'active_patient_uid',
      'facility_id',
      'reason',
      'created_at',
      'source',
      'latest_event',
      'held_terminal_action',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      owned_by_caller: { type: 'boolean' },
      owner_actor_uid: { type: 'string', format: 'uuid' },
      historical_patient_uid: { type: 'string', format: 'uuid' },
      active_patient_uid: { type: 'string', format: 'uuid' },
      facility_id: { type: 'integer', minimum: 1 },
      reason: { type: 'string', minLength: 10, maxLength: 1000 },
      created_at: { type: 'string', format: 'date-time' },
      source: { $ref: '#/components/schemas/ClinicalImportReconciliationSource' },
      latest_event: { $ref: '#/components/schemas/ClinicalImportReconciliationLatestEvent' },
      held_terminal_action: { $ref: '#/components/schemas/ClinicalImportHeldSupersessionAction' },
    },
  },
  ClinicalImportReconciliationWorklistResult: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'count', 'next_cursor'],
    properties: {
      items: {
        type: 'array',
        maxItems: 25,
        items: { $ref: '#/components/schemas/ClinicalImportReconciliationWorkItem' },
      },
      count: { type: 'integer', minimum: 0, maximum: 25 },
      next_cursor: {
        type: 'string',
        maxLength: 512,
        pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
        nullable: true,
        description:
          'Opaque, versioned, tenant-bound HMAC-SHA256 keyset cursor anchored to the last source row evaluated under the bounded scan budget. It can be present when items is empty, prevents denied rows from being rescanned, rejects modification or cross-tenant reuse, and is null only when the source is exhausted. The cursor is not an authority token.',
      },
    },
  },
  ClinicalImportReconciliationRetryRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', minLength: 10, maxLength: 1000 },
    },
  },
  ClinicalImportReconciliationResolveRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'replacement_resource_receipt_id'],
    properties: {
      reason: { type: 'string', minLength: 10, maxLength: 1000 },
      replacement_resource_receipt_id: { type: 'string', format: 'uuid' },
    },
  },
  ClinicalImportReconciliationEvent: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'reconciliation_item_id',
      'resource_receipt_id',
      'document_receipt_id',
      'historical_patient_uid',
      'facility_id',
      'event_type',
      'actor_uid',
      'actor_role',
      'reason',
      'predecessor_event_id',
      'replacement_resource_receipt_id',
      'evidence_sha256',
      'created_at',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      reconciliation_item_id: { type: 'string', format: 'uuid' },
      resource_receipt_id: { type: 'string', format: 'uuid' },
      document_receipt_id: { type: 'string', format: 'uuid' },
      historical_patient_uid: { type: 'string', format: 'uuid' },
      facility_id: { type: 'integer', minimum: 1 },
      event_type: { type: 'string', enum: ['RETRY_REQUESTED', 'RESOLVED'] },
      actor_uid: { type: 'string', format: 'uuid' },
      actor_role: { type: 'string', enum: ['MEDICAL_RECORDS'] },
      reason: { type: 'string', minLength: 10, maxLength: 1000 },
      predecessor_event_id: { type: 'string', format: 'uuid', nullable: true },
      replacement_resource_receipt_id: { type: 'string', format: 'uuid', nullable: true },
      evidence_sha256: {
        type: 'string',
        pattern: SHA256_PATTERN,
        description:
          'Hash of the withheld append-only action evidence; authority and patient-access internals are never returned.',
      },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  ClinicalImportReconciliationNextAction: {
    type: 'object',
    additionalProperties: false,
    description:
      'Governed manual resubmission instructions. The platform intentionally does not auto-decrypt or automatically retry the source document.',
    required: [
      'action',
      'import_endpoint',
      'requirements',
      'after_success',
      'if_no_legitimate_replacement_exists',
    ],
    properties: {
      action: { type: 'string', enum: ['MANUAL_RESUBMISSION_REQUIRED'] },
      import_endpoint: {
        type: 'string',
        enum: [
          '/api/v1/documents/import/fhir-bundle',
          '/api/v1/documents/import/ccd',
        ],
      },
      requirements: {
        type: 'object',
        additionalProperties: false,
        required: [
          'original_source_document',
          'new_source_document_id',
          'new_idempotency_key',
          'current_authority_grant',
          'current_patient_access_decision',
          'correction_item_header',
          'correction_manifest_index_header',
        ],
        properties: {
          original_source_document: { type: 'boolean', enum: [true] },
          new_source_document_id: { type: 'boolean', enum: [true] },
          new_idempotency_key: { type: 'boolean', enum: [true] },
          current_authority_grant: { type: 'boolean', enum: [true] },
          current_patient_access_decision: { type: 'boolean', enum: [true] },
          correction_item_header: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'value'],
            properties: {
              name: { type: 'string', enum: ['X-VH-Import-Correction-Item-Id'] },
              value: { type: 'string', format: 'uuid' },
            },
          },
          correction_manifest_index_header: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'value'],
            properties: {
              name: {
                type: 'string',
                enum: ['X-VH-Import-Correction-Manifest-Index'],
              },
              value: {
                type: 'string',
                enum: ['zero-based replacement resource manifest index'],
              },
            },
          },
        },
      },
      after_success: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'endpoint', 'body_field'],
        properties: {
          action: { type: 'string', enum: ['RESOLVE_WITH_REPLACEMENT_RECEIPT'] },
          endpoint: { type: 'string' },
          body_field: { type: 'string', enum: ['replacement_resource_receipt_id'] },
        },
      },
      if_no_legitimate_replacement_exists: {
        $ref: '#/components/schemas/ClinicalImportHeldSupersessionReview',
      },
    },
  },
  ClinicalImportReconciliationActionResult: {
    type: 'object',
    additionalProperties: false,
    required: ['event', 'replayed', 'next_action'],
    properties: {
      event: { $ref: '#/components/schemas/ClinicalImportReconciliationEvent' },
      replayed: { type: 'boolean' },
      next_action: {
        allOf: [{ $ref: '#/components/schemas/ClinicalImportReconciliationNextAction' }],
        nullable: true,
      },
    },
  },
  ClinicalImportFhirReceiptResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'imported',
      'skipped',
      'deduplicated',
      'failed',
      'errors',
      'observationPartitions',
      'resource_receipts',
      'reconciliation_items',
      'receipt_id',
      'replayed',
    ],
    properties: {
      ...receiptCountProperties,
      errors: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalImportResourceError' },
      },
      observationPartitions: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalImportObservationPartition' },
      },
      resource_receipts: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalImportResourceReceipt' },
      },
      reconciliation_items: {
        type: 'array',
        description:
          'Durable reconciliation work opened for failed resources; always present and empty when no resource failed.',
        items: { $ref: '#/components/schemas/ClinicalImportReconciliationItem' },
      },
      receipt_id: { type: 'string', format: 'uuid' },
      replayed: { type: 'boolean' },
    },
  },
  ClinicalImportCcdaReceiptResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'imported',
      'skipped',
      'deduplicated',
      'failed',
      'errors',
      'resource_receipts',
      'reconciliation_items',
      'receipt_id',
      'replayed',
    ],
    properties: {
      ...receiptCountProperties,
      errors: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalImportResourceError' },
      },
      resource_receipts: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalImportResourceReceipt' },
      },
      reconciliation_items: {
        type: 'array',
        description:
          'Durable reconciliation work opened for failed resources; always present and empty when no resource failed.',
        items: { $ref: '#/components/schemas/ClinicalImportReconciliationItem' },
      },
      receipt_id: { type: 'string', format: 'uuid' },
      replayed: { type: 'boolean' },
    },
  },
  ClinicalImportFhirResponse: successEnvelope('ClinicalImportFhirReceiptResult'),
  ClinicalImportCcdaResponse: successEnvelope('ClinicalImportCcdaReceiptResult'),
  ClinicalImportReconciliationWorklistResponse:
    successEnvelope('ClinicalImportReconciliationWorklistResult'),
  ClinicalImportReconciliationActionResponse:
    successEnvelope('ClinicalImportReconciliationActionResult'),
};

export const operations = {
  'POST /api/v1/documents/import/fhir-bundle': {
    summary: 'Import a governed FHIR Bundle for one patient',
    description:
      'Accepts only application/json or application/fhir+json through an authenticated route-local JSON parser capped at 5 MiB. Request Content-Encoding compression is rejected because exact source bytes must be retained without inflation. A source document without a stable author reference or identifier fails closed with 409 IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED and HELD_EXTERNAL_AUTHORITY for CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER. Manual Medical Records intake is the only configured ingestion mode; external partner activation is not configured. '
      + 'Patient, MedicationRequest, and supported vital-sign Observation resources may be imported, '
      + 'unsupported resource types are explicitly skipped, and external Condition or '
      + 'AllergyIntolerance assertions are recorded as failed resources with '
      + 'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED, held as HELD_EXTERNAL_AUTHORITY for '
      + 'CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER, and opened as durable reconciliation work. '
      + 'There is no assertion-promotion endpoint. A 207 response is a durable receipt with '
      + 'explicit per-resource failures, not an '
      + 'unqualified successful import.',
    requestContent: {
      'application/json': 'ClinicalImportFhirBundleRequest',
      'application/fhir+json': 'ClinicalImportFhirBundleRequest',
    },
    response: 'ClinicalImportFhirResponse',
    responseDescription: 'The complete or exactly replayed FHIR import receipt.',
    parameters: authorityParameters(
      'SHA-256 of the recursively key-sorted canonical JSON value, not the original wire bytes.',
    ),
    security: AUTHENTICATED_SECURITY,
    additionalResponses: {
      207: jsonResponse(
        'The durable FHIR receipt contains one or more explicit per-resource failures and OPENED reconciliation items, including held Condition or AllergyIntolerance assertions.',
        'ClinicalImportFhirResponse',
      ),
      ...authenticatedErrorResponses,
    },
  },
  'POST /api/v1/documents/import/ccd': {
    summary: 'Import a governed C-CDA document for one patient',
    description:
      'Accepts a JSON object containing one C-CDA XML string or a raw application/xml, text/xml, '
      + 'or application/hl7-v3+xml document through authenticated route-local JSON and XML parsers '
      + 'each capped at 5 MiB. Request Content-Encoding compression is rejected because exact '
      + 'source bytes must be retained without inflation. A source document without a stable author '
      + 'reference or identifier fails closed with 409 IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED and '
      + 'HELD_EXTERNAL_AUTHORITY for CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER. Manual Medical Records intake is the only '
      + 'configured ingestion mode; external partner activation is not configured. Diagnoses and '
      + 'allergies are recorded as failed resources with IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED, '
      + 'held as HELD_EXTERNAL_AUTHORITY for CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER, and opened '
      + 'as durable reconciliation work. There is no assertion-promotion endpoint. A 207 response '
      + 'is a durable receipt with explicit '
      + 'savepoint-isolated per-medication failures, not an unqualified successful import.',
    requestContent: {
      'application/json': 'ClinicalImportCcdaJsonRequest',
      'application/xml': 'ClinicalImportCcdaXmlRequest',
      'text/xml': 'ClinicalImportCcdaXmlRequest',
      'application/hl7-v3+xml': 'ClinicalImportCcdaXmlRequest',
    },
    response: 'ClinicalImportCcdaResponse',
    responseDescription: 'The complete or exactly replayed C-CDA import receipt.',
    parameters: authorityParameters(
      'SHA-256 of the XML string: body.xml for JSON intake or the parsed text body for raw XML. It is not the hash of the surrounding JSON envelope.',
    ),
    security: AUTHENTICATED_SECURITY,
    additionalResponses: {
      207: jsonResponse(
        'The durable C-CDA receipt contains one or more explicit resource failures and OPENED reconciliation items, including held diagnosis or allergy assertions and savepoint-isolated medication failures.',
        'ClinicalImportCcdaResponse',
      ),
      ...authenticatedErrorResponses,
    },
  },
  'GET /api/v1/documents/import/reconciliation': {
    summary: 'List open clinical-import reconciliation work',
    description:
      'Returns one keyset-paginated page of at most 25 OPENED or RETRY_REQUESTED items visible to the active Medical Records caller under current patient-record access policy. Each request is bounded to one 25-row source-page query, one batch patient-survivor query, one exact tenant/id/uid active-patient verification query, one bulk patient-access audit, one awaited bulk HIPAA audit, and at most 40 total worklist database statements including the tenant-scope preamble. It has a hard 10-second transaction deadline with statement timeouts derived from its remaining time, one nonblocking per-tenant worklist lock acquired before one of 4 database-coordinated global worklist slots. When the bounded source-page or row budget is reached, next_cursor is anchored to the last completely evaluated source row even if the visible page is empty, so denied work is not rescanned and authorised work remains reachable on later pages. Deadline or database-budget exhaustion fails the transaction without returning unaudited data. Capacity exhaustion returns 429 with Retry-After: 1. Each returned item is PHI-audited using a record type bound to its reconciliation item identity and exposes receipt identities and bounded failure evidence only; encrypted raw-document ciphertext and source bytes are never returned. Supersession remains held for CLINICAL_IMPORT_SUPERSESSION_OWNER authority, and no supersession endpoint is published.',
    response: 'ClinicalImportReconciliationWorklistResponse',
    responseDescription: 'The caller-authorised, PHI-safe open reconciliation worklist.',
    parameters: [{
      name: 'cursor',
      in: 'query',
      required: false,
      description:
        'Opaque, versioned, tenant-bound HMAC-SHA256 next_cursor returned by the previous page and anchored to its last evaluated source row; it may follow an empty visible page, rejects modification or cross-tenant reuse, and is not an authority token.',
      schema: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
      },
    }],
    security: AUTHENTICATED_SECURITY,
    additionalResponses: {
      400: errorResponse('The keyset pagination cursor was malformed or invalid.'),
      401: errorResponse('The API key or bearer token was missing or invalid.'),
      403: errorResponse('The caller was not an active Medical Records user.'),
      429: errorResponse('The caller exceeded an API rate limit or bounded worklist capacity; capacity responses include Retry-After: 1.'),
      503: errorResponse('The hard deadline, counted database budget, or bounded access/audit dependency was unavailable; no page data was returned.'),
      500: errorResponse('The reconciliation worklist could not be read safely.'),
    },
  },
  'POST /api/v1/documents/import/reconciliation/{itemId}/retry-request': {
    summary: 'Request a governed retry for failed clinical-import work',
    description:
      'Appends one RETRY_REQUESTED event after verifying the open item, active patient survivor, current patient-record access decision, and an exact actor/patient/facility/source/format clinical-import grant. The response directs governed manual resubmission with the original source document, new source/idempotency identities, X-VH-Import-Correction-Item-Id, and X-VH-Import-Correction-Manifest-Index. The replacement receipt is immutably bound to this exact item, original failed receipt, and retry event; there is intentionally no auto-decrypt or automatic retry worker. If no legitimate replacement exists, supersession remains held for CLINICAL_IMPORT_SUPERSESSION_OWNER review with no endpoint. The raw Idempotency-Key is never persisted.',
    request: 'ClinicalImportReconciliationRetryRequest',
    response: 'ClinicalImportReconciliationActionResponse',
    responseStatus: 201,
    responseDescription: 'A new RETRY_REQUESTED reconciliation event was durably appended.',
    pathParameters: { itemId: { type: 'string', format: 'uuid' } },
    parameters: reconciliationActionParameters,
    security: AUTHENTICATED_SECURITY,
    additionalResponses: {
      200: jsonResponse(
        'The exact retry command replayed its previously stored reconciliation event.',
        'ClinicalImportReconciliationActionResponse',
      ),
      ...reconciliationActionErrorResponses,
    },
  },
  'POST /api/v1/documents/import/reconciliation/{itemId}/resolve': {
    summary: 'Resolve failed clinical-import work with replacement receipt evidence',
    description:
      'Appends one terminal RESOLVED event only after RETRY_REQUESTED and only when the supplied imported or deduplicated replacement receipt carries an immutable correction binding to this exact item, original failed receipt, and retry event. Patient custody, source resource, source facility, source system, and document format are rechecked as supplemental consistency evidence. Current patient access and exact clinical-import grant authority remain mandatory.',
    request: 'ClinicalImportReconciliationResolveRequest',
    response: 'ClinicalImportReconciliationActionResponse',
    responseStatus: 201,
    responseDescription: 'A new RESOLVED reconciliation event was durably appended.',
    pathParameters: { itemId: { type: 'string', format: 'uuid' } },
    parameters: reconciliationActionParameters,
    security: AUTHENTICATED_SECURITY,
    additionalResponses: {
      200: jsonResponse(
        'The exact resolution command replayed its previously stored reconciliation event.',
        'ClinicalImportReconciliationActionResponse',
      ),
      ...reconciliationActionErrorResponses,
    },
  },
};
