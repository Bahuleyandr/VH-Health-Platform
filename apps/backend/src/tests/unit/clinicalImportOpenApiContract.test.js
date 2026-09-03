import { buildOpenApiDocument } from '../../../scripts/openapi/buildSpec.mjs';
import * as clinicalImport from '../../../scripts/openapi/schemas/clinicalImport.mjs';

const importRoutes = [
  { method: 'post', path: '/api/v1/documents/import/fhir-bundle', domain: 'document' },
  { method: 'post', path: '/api/v1/documents/import/ccd', domain: 'document' },
];
const reconciliationRoutes = [
  { method: 'get', path: '/api/v1/documents/import/reconciliation', domain: 'document' },
  {
    method: 'post',
    path: '/api/v1/documents/import/reconciliation/{itemId}/retry-request',
    domain: 'document',
  },
  {
    method: 'post',
    path: '/api/v1/documents/import/reconciliation/{itemId}/resolve',
    domain: 'document',
  },
];
const routes = [...importRoutes, ...reconciliationRoutes];

function generatedOperations() {
  const document = buildOpenApiDocument(
    routes,
    {
      openapi: '3.0.3',
      components: { schemas: clinicalImport.schemas },
      tagRegistry: [{ slug: 'document' }],
    },
    clinicalImport.operations,
  );
  return document.paths;
}

function projectPublishedProperties(schema, value) {
  return Object.fromEntries(
    Object.keys(schema.properties).map(property => [property, value[property]]),
  );
}

describe('clinical import OpenAPI source contract', () => {
  it.each(importRoutes)('$method $path requires exact import authority and authenticated security', (route) => {
    const operation = generatedOperations()[route.path][route.method];
    const requiredHeaders = operation.parameters
      .filter(parameter => parameter.in === 'header' && parameter.required)
      .map(parameter => parameter.name);

    expect(requiredHeaders).toHaveLength(8);
    expect(requiredHeaders).toEqual([
      'X-VH-Import-Patient-Uid',
      'X-VH-Import-Source-System',
      'X-VH-Import-Source-Document-Id',
      'X-VH-Import-Source-Facility-Id',
      'X-VH-Import-Authority-Grant-Id',
      'X-VH-Import-Source-Signature-Sha256',
      'X-VH-Import-Payload-Sha256',
      'Idempotency-Key',
    ]);
    expect(operation.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);

    const correctionHeaders = operation.parameters
      .filter(parameter => parameter.name.startsWith('X-VH-Import-Correction-'));
    expect(correctionHeaders.map(parameter => parameter.name)).toEqual([
      'X-VH-Import-Correction-Item-Id',
      'X-VH-Import-Correction-Manifest-Index',
    ]);
    expect(correctionHeaders.every(parameter => parameter.required === false)).toBe(true);
    expect(correctionHeaders[0].description).toMatch(/supplied together/i);
    expect(correctionHeaders[1].schema).toMatchObject({ minimum: 0, maximum: 9999 });

    const grant = operation.parameters.find(parameter => (
      parameter.name === 'X-VH-Import-Authority-Grant-Id'
    ));
    for (const scope of [
      /authenticated Medical Records actor/i,
      /target patient/i,
      /active source facility/i,
      /source system/i,
      /document format/i,
    ]) expect(grant.description).toMatch(scope);

    const signature = operation.parameters.find(parameter => (
      parameter.name === 'X-VH-Import-Source-Signature-Sha256'
    ));
    expect(signature.description).toMatch(/caller-asserted/i);
    expect(signature.description).toMatch(/asserted\/unverified/i);
    expect(signature.description).toMatch(/does not cryptographically verify/i);
  });

  it('publishes the canonical FHIR body and durable 200/207 receipt contract', () => {
    const operation = generatedOperations()['/api/v1/documents/import/fhir-bundle'].post;

    expect(operation.requestBody.content).toEqual({
      'application/json': {
        schema: { $ref: '#/components/schemas/ClinicalImportFhirBundleRequest' },
      },
      'application/fhir+json': {
        schema: { $ref: '#/components/schemas/ClinicalImportFhirBundleRequest' },
      },
    });
    expect(operation.description).toMatch(/application\/fhir\+json/i);
    expect(operation.description).toMatch(/authenticated route-local JSON parser capped at 5 MiB/i);
    expect(operation.description).toMatch(/Content-Encoding compression is rejected/i);
    expect(operation.responses['413'].description).toMatch(/parser limit of 5 MiB/i);
    expect(operation.responses['415'].description).toMatch(/Content-Type was unsupported/i);
    expect(operation.responses['415'].description).toMatch(/do not inflate request bodies/i);
    expect(operation.responses['429'].description).toMatch(/rate limit/i);
    expect(operation.responses['200'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/ClinicalImportFhirResponse' });
    expect(operation.responses['207'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/ClinicalImportFhirResponse' });
    expect(operation.responses['207'].description).toMatch(/per-resource failures/i);
    expect(operation.responses['207'].description).toMatch(/OPENED reconciliation items/i);
    expect(operation.responses['409'].description).not.toMatch(/ASSERTION_PROMOTION/);
    expect(operation.description).toMatch(/no assertion-promotion endpoint/i);
    expect(Object.keys(operation.responses)).toEqual([
      '200', '207', '400', '401', '403', '404', '409', '413', '415', '429', '500',
    ]);

    const result = clinicalImport.schemas.ClinicalImportFhirReceiptResult;
    expect(result.required).toEqual(expect.arrayContaining([
      'failed', 'errors', 'observationPartitions', 'resource_receipts',
      'reconciliation_items', 'receipt_id', 'replayed',
    ]));
  });

  it('publishes wired C-CDA bodies and its durable partial 207 receipt', () => {
    const operation = generatedOperations()['/api/v1/documents/import/ccd'].post;

    expect(operation.requestBody.content).toEqual({
      'application/json': {
        schema: { $ref: '#/components/schemas/ClinicalImportCcdaJsonRequest' },
      },
      'application/xml': {
        schema: { $ref: '#/components/schemas/ClinicalImportCcdaXmlRequest' },
      },
      'text/xml': {
        schema: { $ref: '#/components/schemas/ClinicalImportCcdaXmlRequest' },
      },
      'application/hl7-v3+xml': {
        schema: { $ref: '#/components/schemas/ClinicalImportCcdaXmlRequest' },
      },
    });
    expect(operation.responses['207'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/ClinicalImportCcdaResponse' });
    expect(operation.responses['207'].description).toMatch(/resource failures/i);
    expect(operation.responses['207'].description).toMatch(/OPENED reconciliation items/i);
    expect(operation.responses['409'].description).not.toMatch(/ASSERTION_PROMOTION/);
    expect(operation.description).toMatch(/no assertion-promotion endpoint/i);
    expect(operation.description).toMatch(/authenticated route-local JSON and XML parsers/i);
    expect(operation.description).toMatch(/each capped at 5 MiB/i);
    expect(operation.description).toMatch(/Content-Encoding compression is rejected/i);
    expect(operation.responses['413'].description).toMatch(/parser limit of 5 MiB/i);
    expect(operation.responses['415'].description).toMatch(/Content-Type was unsupported/i);
    expect(operation.responses['415'].description).toMatch(/do not inflate request bodies/i);
    expect(operation.responses['429'].description).toMatch(/rate limit/i);
    expect(Object.keys(operation.responses)).toEqual([
      '200', '207', '400', '401', '403', '404', '409', '413', '415', '429', '500',
    ]);
    expect(operation.description).toMatch(/savepoint-isolated per-medication failures/i);
    expect(clinicalImport.schemas.ClinicalImportResourceError.properties.index)
      .toEqual({ type: 'integer', minimum: 0, nullable: true });
    expect(clinicalImport.schemas.ClinicalImportCcdaReceiptResult.required)
      .toContain('reconciliation_items');
    expect(clinicalImport.schemas.ClinicalImportCcdaReceiptResult.required)
      .toContain('resource_receipts');
  });

  it('always exposes typed resource receipts and OPENED reconciliation work', () => {
    const item = clinicalImport.schemas.ClinicalImportReconciliationItem;
    expect(item).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['id', 'resource_receipt_id', 'opened_event_id', 'status'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        resource_receipt_id: { type: 'string', format: 'uuid' },
        opened_event_id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['OPENED'] },
      },
    });

    for (const result of [
      clinicalImport.schemas.ClinicalImportFhirReceiptResult,
      clinicalImport.schemas.ClinicalImportCcdaReceiptResult,
    ]) {
      expect(result.required).toContain('resource_receipts');
      expect(result.properties.resource_receipts).toEqual({
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalImportResourceReceipt' },
      });
      expect(result.required).toContain('reconciliation_items');
      expect(result.properties.reconciliation_items).toMatchObject({
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalImportReconciliationItem' },
      });
      expect(result.properties.reconciliation_items.description).toMatch(/always present/i);
    }
    expect(clinicalImport.schemas.ClinicalImportResourceReceipt.required).toEqual([
      'id',
      'source_resource_type',
      'source_resource_id',
      'source_resource_index',
      'outcome',
      'target_table',
      'target_id',
    ]);
  });

  it('documents assertion holds as durable partial failures without publishing a command', () => {
    for (const path of importRoutes.map(route => route.path)) {
      const operation = generatedOperations()[path].post;
      expect(operation.description).toMatch(/IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED/);
      expect(operation.description).toMatch(/HELD_EXTERNAL_AUTHORITY/);
      expect(operation.description).toMatch(/CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER/);
      expect(operation.description).toMatch(/durable reconciliation work/i);
      expect(operation.description).toMatch(/no assertion-promotion endpoint/i);
    }
    expect(clinicalImport.schemas.ClinicalImportResourceError.properties.code.description)
      .toMatch(/held for governed reconciliation/i);
    expect(clinicalImport.schemas.ClinicalImportReconciliationSource.properties
      .error_code.description).toMatch(/held diagnosis or allergy assertion/i);
    expect(Object.keys(clinicalImport.operations).join('|')).not.toMatch(/assertion.*promotion/i);
  });

  it('documents missing source-author identity as a named document-level hold', () => {
    expect(clinicalImport.schemas.ClinicalImportSourceAuthorIdentityHoldDetails).toEqual({
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
    });
    expect(clinicalImport.schemas.ClinicalImportErrorResponse.properties.details.description)
      .toMatch(/IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED/);
    for (const path of importRoutes.map(route => route.path)) {
      const operation = generatedOperations()[path].post;
      expect(operation.description).toMatch(/stable author reference or identifier/i);
      expect(operation.description).toMatch(/IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED/);
      expect(operation.description).toMatch(/CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER/);
      expect(operation.responses['409'].description)
        .toMatch(/CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER/);
    }
    expect(Object.keys(clinicalImport.operations).join('|')).not.toMatch(/source.*author.*identity/i);
  });

  it('publishes an access-filtered reconciliation worklist without raw custody material', () => {
    const operation = generatedOperations()['/api/v1/documents/import/reconciliation'].get;
    expect(operation.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(operation).not.toHaveProperty('requestBody');
    expect(operation.parameters).toEqual([{
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
    }]);
    expect(operation.responses['200'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/ClinicalImportReconciliationWorklistResponse' });
    expect(operation.responses['400'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/ClinicalImportErrorResponse' });
    expect(operation.responses['400'].description).toMatch(/cursor was malformed or invalid/i);
    expect(operation.responses['403'].description).toMatch(/Medical Records/i);
    expect(operation.responses['429'].description).toMatch(/Retry-After: 1/i);
    expect(operation.responses['503'].description).toMatch(/deadline.*database budget/i);
    expect(operation.description).toMatch(/keyset-paginated/i);
    expect(operation.description).toMatch(/page of at most 25/i);
    expect(operation.description).toMatch(/one 25-row source-page query/i);
    expect(operation.description).toMatch(/one batch patient-survivor query/i);
    expect(operation.description).toMatch(/one exact tenant\/id\/uid active-patient verification query/i);
    expect(operation.description).toMatch(/one bulk patient-access audit/i);
    expect(operation.description).toMatch(/one awaited bulk HIPAA audit/i);
    expect(operation.description).toMatch(/at most 40 total worklist database statements/i);
    expect(operation.description).toMatch(/including the tenant-scope preamble/i);
    expect(operation.description).toMatch(/hard 10-second transaction deadline/i);
    expect(operation.description).toMatch(/4 database-coordinated global worklist slots/i);
    expect(operation.description).toMatch(/one nonblocking per-tenant worklist lock/i);
    expect(operation.description).toMatch(/429 with Retry-After: 1/i);
    expect(operation.description).toMatch(/even if the visible page is empty/i);
    expect(operation.description).toMatch(/denied work is not rescanned/i);
    expect(operation.description).toMatch(/PHI-audited/i);
    expect(operation.description).toMatch(/ciphertext and source bytes are never returned/i);

    const worklistSchemas = [
      clinicalImport.schemas.ClinicalImportReconciliationWorklistResult,
      clinicalImport.schemas.ClinicalImportReconciliationWorkItem,
      clinicalImport.schemas.ClinicalImportReconciliationSource,
      clinicalImport.schemas.ClinicalImportReconciliationLatestEvent,
    ];
    const publishedPropertyNames = worklistSchemas.flatMap(schema => (
      Object.keys(schema.properties || {})
    ));
    expect(publishedPropertyNames.join('|')).not.toMatch(
      /ciphertext|raw_payload|raw_artifact|source_author_evidence|^evidence$/i,
    );
    const latestEvent = clinicalImport.schemas.ClinicalImportReconciliationLatestEvent;
    expect(latestEvent.required).toContain('evidence_sha256');
    expect(latestEvent.properties.evidence_sha256).toMatchObject({
      type: 'string',
      pattern: '^[a-f0-9]{64}$',
    });
    expect(latestEvent.properties).not.toHaveProperty('evidence');

    const sentinelSecrets = [
      'SENTINEL-AUTHORITY-GRANT-SECRET',
      'SENTINEL-PATIENT-RELATIONSHIP-SECRET',
      'SENTINEL-CUSTODY-PROVENANCE-SECRET',
    ];
    const projectedLatestEvent = projectPublishedProperties(latestEvent, {
      id: '00000000-0000-4000-8000-000000000001',
      event_type: 'RETRY_REQUESTED',
      actor_uid: '00000000-0000-4000-8000-000000000002',
      reason: 'A bounded public reason',
      evidence_sha256: 'a'.repeat(64),
      created_at: '2026-09-02T00:00:00.000Z',
      evidence: {
        authority_grant_id: sentinelSecrets[0],
        patient_relationship_id: sentinelSecrets[1],
        custody_provenance: sentinelSecrets[2],
      },
    });
    expect(projectedLatestEvent).not.toHaveProperty('evidence');
    for (const sentinel of sentinelSecrets) {
      expect(JSON.stringify(projectedLatestEvent)).not.toContain(sentinel);
    }
    const worklistResult = clinicalImport.schemas.ClinicalImportReconciliationWorklistResult;
    expect(worklistResult.required).toEqual(['items', 'count', 'next_cursor']);
    expect(worklistResult.properties.items).toMatchObject({
        type: 'array',
        maxItems: 25,
        items: { $ref: '#/components/schemas/ClinicalImportReconciliationWorkItem' },
      });
    expect(worklistResult.properties.next_cursor).toEqual({
      type: 'string',
      maxLength: 512,
      pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
      nullable: true,
      description:
        'Opaque, versioned, tenant-bound HMAC-SHA256 keyset cursor anchored to the last source row evaluated under the bounded scan budget. It can be present when items is empty, prevents denied rows from being rescanned, rejects modification or cross-tenant reuse, and is null only when the source is exhausted. The cursor is not an authority token.',
    });
  });

  it.each([
    {
      path: '/api/v1/documents/import/reconciliation/{itemId}/retry-request',
      request: 'ClinicalImportReconciliationRetryRequest',
      eventType: 'RETRY_REQUESTED',
    },
    {
      path: '/api/v1/documents/import/reconciliation/{itemId}/resolve',
      request: 'ClinicalImportReconciliationResolveRequest',
      eventType: 'RESOLVED',
    },
  ])('documents governed $eventType commands and exact replay', ({ path, request }) => {
    const operation = generatedOperations()[path].post;
    expect(operation.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'itemId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      }),
      expect.objectContaining({
        name: 'X-VH-Import-Authority-Grant-Id',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      }),
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
      }),
    ]));
    expect(operation.requestBody.content['application/json'].schema)
      .toEqual({ $ref: `#/components/schemas/${request}` });
    for (const status of ['200', '201']) {
      expect(operation.responses[status].content['application/json'].schema)
        .toEqual({ $ref: '#/components/schemas/ClinicalImportReconciliationActionResponse' });
    }
    for (const status of ['403', '404', '409']) {
      expect(operation.responses[status].content['application/json'].schema)
        .toEqual({ $ref: '#/components/schemas/ClinicalImportErrorResponse' });
    }
    expect(operation.responses['403'].description).toMatch(/grant authority/i);
    expect(operation.responses['404'].description).toMatch(/reconciliation item/i);
    expect(operation.responses['409'].description).toMatch(/replacement receipt evidence/i);
  });

  it('requires bounded reasons and a typed replacement receipt for resolution', () => {
    const reason = { type: 'string', minLength: 10, maxLength: 1000 };
    expect(clinicalImport.schemas.ClinicalImportReconciliationRetryRequest).toMatchObject({
      additionalProperties: false,
      required: ['reason'],
      properties: { reason },
    });
    expect(clinicalImport.schemas.ClinicalImportReconciliationResolveRequest).toMatchObject({
      additionalProperties: false,
      required: ['reason', 'replacement_resource_receipt_id'],
      properties: {
        reason,
        replacement_resource_receipt_id: { type: 'string', format: 'uuid' },
      },
    });
    const event = clinicalImport.schemas.ClinicalImportReconciliationEvent;
    expect(event.properties.event_type)
      .toEqual({ type: 'string', enum: ['RETRY_REQUESTED', 'RESOLVED'] });
    expect(event.required).toEqual(expect.arrayContaining([
      'replacement_resource_receipt_id',
      'evidence_sha256',
    ]));
    expect(event.properties.replacement_resource_receipt_id).toEqual({
      type: 'string',
      format: 'uuid',
      nullable: true,
    });
    expect(event.properties.evidence_sha256).toMatchObject({
      type: 'string',
      pattern: '^[a-f0-9]{64}$',
    });
    expect(event.properties).not.toHaveProperty('evidence');
    const actionEvidenceSentinel = 'SENTINEL-ACTION-AUTHORITY-SECRET';
    const projectedActionEvent = projectPublishedProperties(event, {
      id: '00000000-0000-4000-8000-000000000010',
      reconciliation_item_id: '00000000-0000-4000-8000-000000000011',
      resource_receipt_id: '00000000-0000-4000-8000-000000000012',
      document_receipt_id: '00000000-0000-4000-8000-000000000013',
      historical_patient_uid: '00000000-0000-4000-8000-000000000014',
      facility_id: 1,
      event_type: 'RESOLVED',
      actor_uid: '00000000-0000-4000-8000-000000000015',
      actor_role: 'MEDICAL_RECORDS',
      reason: 'A bounded resolution reason',
      predecessor_event_id: '00000000-0000-4000-8000-000000000016',
      replacement_resource_receipt_id: '00000000-0000-4000-8000-000000000017',
      evidence_sha256: 'b'.repeat(64),
      created_at: '2026-09-02T00:00:00.000Z',
      evidence: { authority_grant_id: actionEvidenceSentinel },
    });
    expect(projectedActionEvent).not.toHaveProperty('evidence');
    expect(JSON.stringify(projectedActionEvent)).not.toContain(actionEvidenceSentinel);
    expect(clinicalImport.schemas).not.toHaveProperty(
      'ClinicalImportReconciliationActionEvidence',
    );
    expect(clinicalImport.schemas).not.toHaveProperty(
      'ClinicalImportReconciliationReplacementReceipt',
    );
    expect(clinicalImport.schemas.ClinicalImportReconciliationActionResult.required)
      .toContain('next_action');
    expect(clinicalImport.schemas.ClinicalImportReconciliationNextAction.description)
      .toMatch(/does not auto-decrypt or automatically retry/i);
    const requirements = clinicalImport.schemas.ClinicalImportReconciliationNextAction
      .properties.requirements;
    expect(requirements.required).toEqual(expect.arrayContaining([
      'correction_item_header',
      'correction_manifest_index_header',
    ]));
    expect(requirements.properties.correction_item_header.properties.name.enum)
      .toEqual(['X-VH-Import-Correction-Item-Id']);
    expect(requirements.properties.correction_item_header.properties.value.format).toBe('uuid');
    expect(requirements.properties.correction_manifest_index_header.properties.name.enum)
      .toEqual(['X-VH-Import-Correction-Manifest-Index']);
  });

  it('holds supersession behind named owner authority without publishing an action', () => {
    expect(clinicalImport.schemas.ClinicalImportReconciliationWorkItem.required)
      .toContain('held_terminal_action');
    expect(clinicalImport.schemas.ClinicalImportHeldSupersessionAction.properties).toMatchObject({
      action: { type: 'string', enum: ['SUPERSEDE'] },
      status: { type: 'string', enum: ['HELD_EXTERNAL_AUTHORITY'] },
      required_authority: {
        type: 'string',
        enum: ['CLINICAL_IMPORT_SUPERSESSION_OWNER'],
      },
      endpoint: { type: 'string', nullable: true, enum: [null] },
    });
    expect(clinicalImport.schemas.ClinicalImportReconciliationNextAction.required)
      .toContain('if_no_legitimate_replacement_exists');
    expect(Object.keys(clinicalImport.operations).join('|')).not.toMatch(/supersed/i);
    expect(generatedOperations()['/api/v1/documents/import/reconciliation'].get.description)
      .toMatch(/no supersession endpoint is published/i);
  });

  it('documents the payload digest inputs without claiming raw-byte or partner trust', () => {
    const paths = generatedOperations();
    const fhir = paths['/api/v1/documents/import/fhir-bundle'].post;
    const ccda = paths['/api/v1/documents/import/ccd'].post;
    const payloadDescription = operation => operation.parameters.find(parameter => (
      parameter.name === 'X-VH-Import-Payload-Sha256'
    )).description;

    expect(payloadDescription(fhir)).toMatch(/recursively key-sorted canonical JSON/i);
    expect(payloadDescription(fhir)).toMatch(/not the original wire bytes/i);
    expect(payloadDescription(ccda)).toMatch(/body\.xml for JSON intake/i);
    expect(payloadDescription(ccda)).toMatch(/parsed text body for raw XML/i);
    expect(payloadDescription(ccda)).toMatch(/not the hash of the surrounding JSON envelope/i);
    expect(fhir.description).toMatch(/external partner activation is not configured/i);
    expect(ccda.description).toMatch(/external partner activation is not configured/i);
  });
});
