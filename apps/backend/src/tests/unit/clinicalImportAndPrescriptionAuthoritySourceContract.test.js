import { readFileSync } from 'node:fs';

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('clinical import and signed prescription authority source contract', () => {
  const prescription = source('controllers/prescription/ePrescriptionController.js');
  const importService = source('services/import/patientDataImport.js');
  const receiptService = source('services/import/clinicalImportReceiptService.js');
  const reconciliationService = source('services/import/clinicalImportReconciliationService.js');
  const migration755 = source('migrations/755_clinical_import_receipt_and_history_immutability.sql');
  const migration760 = source('migrations/760_clinical_import_authority_custody_and_reconciliation.sql');
  const prismaRuntime = source('lib/prisma.js');
  const patientMerge = source('services/patient/patientMergeService.js');
  const routes = source('routes/documents/documentRoutes.js');
  const app = source('app.js');
  const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

  test('signed prescriptions pin catalog identity and pediatric dose evidence', () => {
    expect(prescription).toMatch(/SIGNED_CLINICAL_AUTHORITY_CONTRACT_VERSION/);
    expect(prescription).toMatch(/signed_catalog_authority/);
    expect(prescription).toMatch(/signed_pediatric_dose_authority/);
    expect(prescription).toMatch(/PRESCRIPTION_SIGNED_CATALOG_AUTHORITY_CHANGED/);
    expect(prescription).toMatch(/PRESCRIPTION_SIGNED_PEDIATRIC_AUTHORITY_CHANGED/);
    expect(prescription).toMatch(/FROM vitals_chart[\s\S]*id=\$3::int[\s\S]*FOR UPDATE/);
    expect(prescription).toMatch(/lockTenantPatientMergeStability[\s\S]*lockPharmacyCatalogAuthorityTx/);
  });

  test('imported history is immutable and delivery type is an explicit enum', () => {
    expect(prescription).toMatch(/VALID_PHARMACY_DELIVERY_TYPES = new Set\(\['delivery', 'counter'\]\)/);
    expect(prescription).toMatch(/PRESCRIPTION_PHARMACY_DELIVERY_TYPE_INVALID/);
    expect(prescription).toMatch(/Imported medication history is immutable/);
    expect(prescription).toMatch(/Imported medication history cannot be signed/);
    expect(prescription).toMatch(/lifecycle_status, 'draft'\)\) <> 'imported_history'/);
    expect(prescription).toMatch(/PRESCRIPTION_IMPORTED_HISTORY_NOT_ORDERABLE/);
  });

  test('manual import requires exact patient, source manifest, payload hash, and PHI policy', () => {
    const requiredHeaders = [
      'X-VH-Import-Patient-Uid',
      'X-VH-Import-Source-System',
      'X-VH-Import-Source-Document-Id',
      'X-VH-Import-Source-Facility-Id',
      'X-VH-Import-Authority-Grant-Id',
      'X-VH-Import-Source-Signature-Sha256',
      'X-VH-Import-Payload-Sha256',
      'Idempotency-Key',
    ];
    expect(requiredHeaders).toHaveLength(8);
    for (const header of requiredHeaders) expect(routes).toContain(header);
    expect(routes).toMatch(/actorRole !== 'MEDICAL_RECORDS'/);
    expect(routes).toMatch(/IMPORT_PARTNER_AUTHORITY_NOT_CONFIGURED/);
    expect(routes).toMatch(/ACCESS_POLICY_CODES\.PATIENT_RECORD_UPLOAD/);
    expect(routes).toMatch(/patientId: authority\.patientUid/);
    expect(routes).toMatch(/userRole: authority\.actorRole/);
    expect(routes).toMatch(/tenantId,/);
    expect(routes).toMatch(/importFhirBundle\(bundle, importedBy, \{ tenantId, authority \}\)/);
    expect(routes).toMatch(/importCCDA\(xmlString, importedBy, \{ tenantId, authority \}\)/);
  });

  test('authenticated import routes own exact-media 5 MiB parsers after the global skip', () => {
    expect(routes).toMatch(
      /const parseClinicalImportJson = express\.json\(\{[\s\S]*type: \['application\/json', 'application\/fhir\+json'\],[\s\S]*limit: '5mb',[\s\S]*inflate: false,[\s\S]*verify: captureClinicalImportRawBody/,
    );
    expect(routes).not.toMatch(
      /const parseClinicalImportJson = express\.json\(\{[\s\S]*application\/\*\+json/,
    );
    expect(routes).toMatch(
      /const parseClinicalImportXml = express\.text\(\{[\s\S]*type: \['application\/xml', 'text\/xml', 'application\/hl7-v3\+xml'\],[\s\S]*limit: '5mb',[\s\S]*inflate: false,[\s\S]*verify: captureClinicalImportRawBody/,
    );
    expect(routes).toMatch(
      /requireClinicalImportMediaType[\s\S]*new AppError\([\s\S]*415,[\s\S]*IMPORT_CONTENT_TYPE_UNSUPPORTED/,
    );
    expect(routes).toMatch(
      /requireFhirImportMediaType = requireClinicalImportMediaType\([\s\S]*'application\/json',[\s\S]*'application\/fhir\+json'/,
    );
    expect(routes).toMatch(
      /requireCcdaImportMediaType = requireClinicalImportMediaType\([\s\S]*'application\/json',[\s\S]*'application\/xml',[\s\S]*'text\/xml',[\s\S]*'application\/hl7-v3\+xml'/,
    );
    expect(routes).toMatch(
      /router\.post\([\s\S]*'\/import\/fhir-bundle',[\s\S]*clinicalImportRateLimiter,[\s\S]*requireFhirImportMediaType,[\s\S]*parseClinicalImportJson/,
    );
    expect(routes).toMatch(
      /router\.post\([\s\S]*'\/import\/ccd',[\s\S]*clinicalImportRateLimiter,[\s\S]*requireCcdaImportMediaType,[\s\S]*parseClinicalImportJson,[\s\S]*parseClinicalImportXml/,
    );

    expect(app).toMatch(/const HTTP_BODY_LIMIT = process\.env\.HTTP_BODY_LIMIT \|\| '1mb'/);
    expect(app).toMatch(
      /const legacyJsonParser = express\.json\(\{[\s\S]*type: \['application\/json', 'application\/\*\+json'\],[\s\S]*limit: HTTP_BODY_LIMIT/,
    );
    expect(app).toMatch(
      /const path = String\(req\.originalUrl \|\| req\.url \|\| ''\)\.split\('\?', 1\)\[0\]\.replace\(\/\\\/\+\$\/, ''\);[\s\S]*path === '\/api\/v1\/documents\/import\/fhir-bundle'[\s\S]*path === '\/api\/v1\/documents\/import\/ccd'[\s\S]*return next\(\)/,
    );
    const apiKeyIndex = app.indexOf('rawHl7RecoveryResponses(validateApiKey)');
    const jwtIndex = app.indexOf('app.use(jwtAuth)');
    const documentRoutesIndex = app.indexOf("app.use('/api/v1/documents'");
    expect(apiKeyIndex).toBeGreaterThanOrEqual(0);
    expect(apiKeyIndex).toBeLessThan(jwtIndex);
    expect(jwtIndex).toBeLessThan(documentRoutesIndex);
  });

  test('FHIR references are single-patient and medication replay includes dosage', () => {
    expect(importService).toMatch(/normalizeFhirBundlePatientReferences/);
    expect(importService).toMatch(/IMPORT_RESOURCE_PATIENT_MISMATCH/);
    expect(importService).toMatch(/lockTenantPatientMergeStability\(lockTx, tid\)/);
    expect(importService).toMatch(/dosageInstruction: fhirMedication\.dosageInstruction \|\| \[\]/);
    expect(importService).toMatch(/IMPORT_SOURCE_IDENTITY_DRIFT/);
    expect(importService).toMatch(/lifecycle_status, prescription_number[\s\S]*'imported_history'/);
    expect(importService).toMatch(/IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED/);
  });

  test('diagnosis and allergy assertions become durable held partial failures', () => {
    expect(importService).toMatch(
      /CLINICAL_IMPORT_ASSERTION_PROMOTION_GATE\s*=\s*'CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER'/,
    );
    expect(importService).toMatch(
      /function clinicalAssertionPromotionRequired[\s\S]*return \{[\s\S]*status: 'failed',[\s\S]*errorCode: 'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',[\s\S]*errorStatusCode: 409,[\s\S]*status: 'HELD_EXTERNAL_AUTHORITY',[\s\S]*required_authority: CLINICAL_IMPORT_ASSERTION_PROMOTION_GATE,[\s\S]*resource_type: resourceType,[\s\S]*resource_id: resourceId/,
    );
    expect(importService).toMatch(
      /async function importCondition[\s\S]*return clinicalAssertionPromotionRequired\('Condition'/,
    );
    expect(importService).toMatch(
      /async function importAllergyIntolerance[\s\S]*return clinicalAssertionPromotionRequired\('AllergyIntolerance'/,
    );
    expect(importService).toMatch(
      /function receiptOutcome[\s\S]*outcome\?\.evidence \? outcome\.evidence : \{\}/,
    );
    expect(importService).toMatch(
      /status === 'failed'[\s\S]*results\.failed \+= resources\.length[\s\S]*results\.errors\.push/,
    );
    expect(routes).toMatch(
      /hasIncompleteOutcome[\s\S]*results\.errors\.length > 0[\s\S]*hasIncompleteOutcome \? 207 : 200/,
    );
    expect(routes).toMatch(
      /results\.errors\.length[\s\S]*\? 207[\s\S]*: 200/,
    );
    expect(receiptService).toMatch(
      /\.filter\(\(resource\) => resource\.status === 'failed'\)[\s\S]*clinical_import_reconciliation_items[\s\S]*clinical_import_reconciliation_events/,
    );
    expect(routes).not.toMatch(/router\.(?:post|put|patch)\([^)]*assertion[^)]*promotion/i);
  });

  test('clinical import receipts are wired through document import and serialize only hashed replay authority', () => {
    expect(importService).toMatch(
      /buildClinicalImportDocumentAuthority,[\s\S]*lockClinicalImportDocumentReceiptTx,[\s\S]*persistClinicalImportDocumentReceiptTx,[\s\S]*from '\.\/clinicalImportReceiptService\.js'/,
    );
    expect(importService).toMatch(
      /const receiptAuthority = buildClinicalImportDocumentAuthority\([\s\S]*documentFormat: 'fhir_bundle',[\s\S]*lockClinicalImportDocumentReceiptTx\(lockTx, receiptAuthority\)[\s\S]*persistClinicalImportDocumentReceiptTx\(lockTx, receiptAuthority/,
    );
    expect(importService).toMatch(
      /const receiptAuthority = buildClinicalImportDocumentAuthority\([\s\S]*documentFormat: 'ccda',[\s\S]*lockClinicalImportDocumentReceiptTx\(tx, receiptAuthority\)[\s\S]*persistClinicalImportDocumentReceiptTx\(tx, receiptAuthority/,
    );

    const receiptHelper = importService.match(
      /function medicationImportReceipt\([\s\S]*?return \{([\s\S]*?)\n {2}\};\n\}/,
    );
    expect(receiptHelper).not.toBeNull();
    expect(receiptHelper[1]).toMatch(/^\s*idempotency_key_sha256:/m);
    expect(receiptHelper[1]).not.toMatch(/^\s*idempotency_key\s*:/m);
    expect(receiptHelper[1]).not.toMatch(/authority\?\.idempotencyKey(?!Sha256)/);
    expect([...importService.matchAll(/const importReceipt = medicationImportReceipt\(/g)])
      .toHaveLength(2);
    expect(migration755).toContain("import_receipt ? 'idempotency_key'");
    expect(migration755).toMatch(/receipt hashes are incomplete or expose a raw idempotency key/);
  });

  test('source-author evidence requires stable identity behind a named external gate', () => {
    expect(importService).toMatch(/sourceAuthorEvidence: fhirSourceAuthorEvidence\(bundle\)/);
    expect(importService).toMatch(/sourceAuthorEvidence: ccdaSourceAuthorEvidence\(parsed\)/);
    expect(receiptService).toMatch(
      /SOURCE_AUTHOR_IDENTITY_AUTHORITY_GATE\s*=\s*'CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER'/,
    );
    expect(receiptService).toMatch(
      /sourceAuthorEvidence\.authors\.some[\s\S]*author\.reference[\s\S]*author\.identifier_value/,
    );
    expect(receiptService).toMatch(
      /if \(!hasBoundSourceAuthor\)[\s\S]*IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED[\s\S]*status: 'HELD_EXTERNAL_AUTHORITY',[\s\S]*required_authority: SOURCE_AUTHOR_IDENTITY_AUTHORITY_GATE/,
    );
    expect(routes).not.toMatch(/router\.(?:post|put|patch)\([^)]*source[^)]*author[^)]*identity/i);
  });

  test('receipt service uses explicit projections and locks source and idempotency identities', () => {
    const correctionLockFunction = receiptService.match(
      /async function lockClinicalImportCorrectionTx[\s\S]*?\n}\n\nexport async function lockClinicalImportDocumentReceiptTx/,
    );
    const receiptLockFunction = receiptService.match(
      /export async function lockClinicalImportDocumentReceiptTx[\s\S]*?\n}\n\nexport async function persistClinicalImportDocumentReceiptTx/,
    );
    expect(correctionLockFunction).not.toBeNull();
    expect(receiptLockFunction).not.toBeNull();
    expect(receiptService).not.toMatch(/\bSELECT\s+\*/i);
    // NO locking clause in the correction path. Migration 760 and
    // ensureTenantRlsRuntimeRoleGrants grant the runtime role SELECT plus a
    // column-scoped INSERT on the reconciliation tables and nothing more, and
    // PostgreSQL requires UPDATE/DELETE privilege for EVERY locking clause —
    // FOR UPDATE, FOR SHARE and FOR KEY SHARE all raise 42501 under a
    // SELECT-only grant (measured against a live database). A row lock here
    // would break every correction re-import in the deployed
    // AUTH_TENANT_RLS_RUNTIME_ROLE posture, and granting UPDATE to fix it
    // would hand the runtime role write access to an append-only ledger.
    // Serialization comes from the advisory lock asserted below instead.
    expect(correctionLockFunction[0]).not.toMatch(
      /\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i,
    );
    expect(receiptLockFunction[0]).not.toMatch(
      /\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i,
    );
    expect(receiptService).toMatch(/`source:\$\{expected\.sourceIdentitySha256\}`/);
    expect(receiptService).toMatch(/`idempotency:\$\{expected\.idempotencyKeySha256\}`/);
    // The correction item must still be serialized — by the advisory lock the
    // caller takes before lockClinicalImportCorrectionTx runs.
    expect(receiptService).toMatch(/`correction:\$\{expected\.correctionItemId\}`/);
    expect(receiptLockFunction[0]).toMatch(
      /for \(const lockIdentity of lockIdentities\)[\s\S]*pg_advisory_xact_lock\([\s\S]*expected\.tenantId,[\s\S]*lockIdentity/,
    );
    expect(receiptService).not.toContain(
      'raw.source_author_evidence AS raw_source_author_evidence',
    );
    expect(receiptService).toMatch(
      /document\.source_author_evidence,[\s\S]*document\.source_author_evidence_sha256/,
    );
    expect(receiptService).toMatch(
      /raw\.source_author_evidence_sha256 AS raw_source_author_evidence_sha256/,
    );
    expect(receiptService).toMatch(
      /receipt\.raw_source_author_evidence_sha256[\s\S]*receipt\.source_author_evidence_sha256/,
    );
  });

  test('migration 760 locks current exact owner authority and binds patient identity', () => {
    expect(migration760).toMatch(
      /CREATE OR REPLACE FUNCTION public\.lock_clinical_import_authority_760\([\s\S]*target_patient_uid uuid,[\s\S]*target_facility_id integer,[\s\S]*target_actor_uid uuid,[\s\S]*target_source_system text,[\s\S]*target_document_format text/,
    );
    expect(migration760).toMatch(
      /granted\.patient_uid IS DISTINCT FROM target_patient_uid[\s\S]*granted\.facility_id IS DISTINCT FROM target_facility_id[\s\S]*granted\.actor_uid IS DISTINCT FROM target_actor_uid[\s\S]*granted\.actor_role IS DISTINCT FROM 'MEDICAL_RECORDS'[\s\S]*granted\.source_system IS DISTINCT FROM target_source_system[\s\S]*target_document_format = ANY\(granted\.document_formats\)[\s\S]*clock_timestamp\(\) < granted\.valid_from[\s\S]*clock_timestamp\(\) >= granted\.valid_until[\s\S]*revoked\.event_type = 'REVOKED'/,
    );
    expect(migration760).toMatch(
      /tenant_context text := current_setting\('app\.current_tenant_id', true\)[\s\S]*tenant_context IS NULL[\s\S]*tenant_context = ''[\s\S]*tenant_context = 'bypass'[\s\S]*target_tenant_id::text IS DISTINCT FROM tenant_context[\s\S]*ERRCODE = '42501'/,
    );
    expect(receiptService).toMatch(
      /SELECT public\.lock_clinical_import_authority_760\([\s\S]*expected\.authorityGrantId,[\s\S]*expected\.patientUid,[\s\S]*expected\.sourceFacilityId,[\s\S]*expected\.actorUid,[\s\S]*expected\.sourceSystem,[\s\S]*expected\.documentFormat/,
    );
    expect(receiptService).toMatch(/signatureVerificationStatus: 'asserted_unverified'/);
    expect(importService).toMatch(
      /function clinicalImportPatientIdentityBinding\([\s\S]*patientIdentifierIds: sortedIds,[\s\S]*patientIdentityBindingSha256: clinicalImportSha256\([\s\S]*clinical-import-patient-identity-v1\|\$\{tenantId\}\|\$\{Number\(patientId\)\}/,
    );
    expect(migration760).toMatch(
      /clinical-import-patient-identity-v1\|'[\s\S]*NEW\.tenant_id::text[\s\S]*NEW\.patient_id::text[\s\S]*NEW\.patient_uid::text[\s\S]*array_to_string\(NEW\.patient_identifier_ids, ','\)/,
    );
  });

  test('migration 760 stores exact encrypted raw custody and opens reconciliation work', () => {
    expect(routes).toMatch(/Buffer\.isBuffer\(req\.clinicalImportRawBody\)/);
    expect(routes).toMatch(/rawDocument: Buffer\.from\(req\.clinicalImportRawBody\)/);
    expect(routes).toMatch(/rawContentType: String\(req\.get\('Content-Type'\)/);
    expect(receiptService).toMatch(
      /rawPayloadCiphertext = encryptField\(rawDocument\.toString\('base64'\)[\s\S]*rawPayloadSha256 = crypto\.createHash\('sha256'\)\.update\(rawDocument\)/,
    );
    expect(receiptService).toMatch(
      /INSERT INTO clinical_import_raw_artifacts[\s\S]*expected\.rawPayloadSha256,[\s\S]*expected\.rawPayloadBytes,[\s\S]*expected\.rawContentType,[\s\S]*expected\.rawPayloadCiphertext/,
    );
    expect(migration760).toMatch(
      /artifact\.authority_grant_id IS DISTINCT FROM NEW\.authority_grant_id[\s\S]*artifact\.patient_uid IS DISTINCT FROM NEW\.patient_uid[\s\S]*artifact\.source_document_id IS DISTINCT FROM NEW\.source_document_id[\s\S]*artifact\.canonical_payload_sha256 IS DISTINCT FROM NEW\.source_payload_sha256[\s\S]*artifact\.asserted_source_signature_sha256[\s\S]*NEW\.asserted_source_signature_sha256/,
    );

    expect(receiptService).toMatch(
      /\.filter\(\(resource\) => resource\.status === 'failed'\)[\s\S]*reconciliation_items: reconciliations\.map[\s\S]*resource_receipt_id: reconciliation\.resource\.id,[\s\S]*opened_event_id: reconciliation\.openedEventId,[\s\S]*status: 'OPENED'/,
    );
    expect(receiptService).toMatch(
      /INSERT INTO clinical_import_reconciliation_items[\s\S]*INSERT INTO clinical_import_reconciliation_events[\s\S]*'OPENED'/,
    );
    expect(migration760).toMatch(
      /CREATE CONSTRAINT TRIGGER clinical_import_failed_receipt_reconciliation_760[\s\S]*DEFERRABLE INITIALLY DEFERRED[\s\S]*WHEN \(NEW\.outcome = 'failed'\)[\s\S]*clinical_import_failed_receipt_reconciliation_guard_760\(\)/,
    );
    expect(migration760).toMatch(/requires exactly one owned reconciliation item and OPENED event/);
  });

  test('reconciliation routes are MR-only, current-authority bound, and PHI-safe', () => {
    expect(routes).toMatch(/router\.get\([\s\S]*'\/import\/reconciliation'/);
    expect(routes).toMatch(
      /router\.post\([\s\S]*'\/import\/reconciliation\/:itemId\/retry-request'[\s\S]*requestClinicalImportRetry/,
    );
    expect(routes).toMatch(
      /router\.post\([\s\S]*'\/import\/reconciliation\/:itemId\/resolve'[\s\S]*resolveClinicalImportReconciliation/,
    );
    expect(routes).toMatch(/idempotencyKey: req\.get\('Idempotency-Key'\)/);
    expect(routes).toMatch(
      /authorityGrantId: req\.get\('X-VH-Import-Authority-Grant-Id'\)/,
    );
    expect(routes).toMatch(/replacementResourceReceiptId = req\.body\?\.replacement_resource_receipt_id/);
    expect(routes).toMatch(/ACCESS_POLICY_CODES\.PATIENT_RECORD_UPLOAD/);
    expect(routes).toMatch(/cursor: req\.query\?\.cursor/);
    expect(routes).toMatch(/next_cursor: page\.nextCursor/);
    expect(reconciliationService).toMatch(/MEDICAL_RECORDS_ROLE = 'MEDICAL_RECORDS'/);
    expect(reconciliationService).toMatch(
      /lockCurrentAuthorityTx\(tx,[\s\S]*patientUid: survivor\.uid,[\s\S]*facilityId: Number\(itemRow\.facility_id\),[\s\S]*actorUid: actor,[\s\S]*sourceSystem: String\(itemRow\.source_system\),[\s\S]*documentFormat: String\(itemRow\.document_format\)/,
    );

    const worklistProjection = reconciliationService.match(
      /const ITEM_SELECT = `([\s\S]*?)`;[\s\S]*function publicItem\([\s\S]*?return \{([\s\S]*?)\n {2}\};/,
    );
    expect(worklistProjection).not.toBeNull();
    expect(worklistProjection.slice(1).join('\n')).not.toMatch(
      /raw_payload_ciphertext|raw_payload|raw_artifact_id|source_author_evidence/i,
    );
  });

  test('reconciliation worklist cursor is bounded, validated, and advances by stable keyset', () => {
    expect(reconciliationService).toMatch(/const LIST_LIMIT = 25/);
    expect(reconciliationService).toMatch(/const LIST_SCAN_BATCH_SIZE = 25/);
    expect(reconciliationService).toMatch(/const LIST_SCAN_ROW_LIMIT = 25/);
    expect(reconciliationService).toMatch(/const LIST_SCAN_QUERY_LIMIT = 1/);
    expect(reconciliationService).toMatch(/const LIST_SCAN_TIME_BUDGET_MS = 10_000/);
    expect(reconciliationService).toMatch(/const LIST_TRANSACTION_TIMEOUT_MS = 10_000/);
    expect(reconciliationService).toMatch(/const LIST_TOTAL_DB_QUERY_LIMIT = 38/);
    expect(reconciliationService).not.toMatch(/LIST_CONCURRENCY_SLOTS/);
    expect(reconciliationService).toMatch(
      /function decodeWorklistCursor[\s\S]*token\.length > 512[\s\S]*crypto\.timingSafeEqual[\s\S]*IMPORT_RECONCILIATION_CURSOR_INVALID/,
    );
    expect(reconciliationService).toMatch(
      /Buffer\.from\(encodedPayload, 'base64url'\)[\s\S]*toString\('base64url'\) !== encodedPayload[\s\S]*Object\.keys\(decoded\)\.join\(','\) !== 'v,tenant_id,created_at,item_id'[\s\S]*JSON\.stringify\(decoded\) !== decodedText[\s\S]*decoded\.tenant_id !== tenantId[\s\S]*createdAt\.toISOString\(\) !== decoded\.created_at/,
    );
    expect(reconciliationService).toMatch(
      /\(item\.created_at, item\.id\) > \(\$2::timestamptz, \$3::uuid\)[\s\S]*ORDER BY item\.created_at, item\.id[\s\S]*LIMIT \$4::int/,
    );
    expect(reconciliationService).toMatch(
      /while \(authorized\.length < LIST_LIMIT\)[\s\S]*resolveActivePatientSurvivorsTx\([\s\S]*authorizeAccessBatch\(\{[\s\S]*db,[\s\S]*entries: accessEntries[\s\S]*lastScannedRow = row[\s\S]*needsContinuation[\s\S]*auditReturnedItems\(\{ db, items }\)[\s\S]*encodeWorklistCursor\(lastScannedRow, tenant\)/,
    );
    expect(reconciliationService).toMatch(
      /Math\.max\(1, Math\.min\(3_000, remainingMs\)\)[\s\S]*SET LOCAL statement_timeout = '\$\{timeoutMs}ms'[\s\S]*timeout: LIST_TRANSACTION_TIMEOUT_MS/,
    );
    expect(migration760).toMatch(
      /CREATE INDEX idx_clinical_import_reconciliation_worklist_760[\s\S]*\(tenant_id, created_at, id\)/,
    );
  });

  test('receipt results expose replacement ids and retry remains governed manual work', () => {
    expect(receiptService).toMatch(
      /resource_receipts: resources\.map[\s\S]*id: resource\.id,[\s\S]*source_resource_type: resource\.source_resource_type,[\s\S]*source_resource_id: resource\.source_resource_id,[\s\S]*source_resource_index: resource\.source_resource_index,[\s\S]*outcome: resource\.status,[\s\S]*target_table: resource\.targetTable,[\s\S]*target_id: resource\.targetId/,
    );
    expect(reconciliationService).toMatch(
      /action: 'MANUAL_RESUBMISSION_REQUIRED'[\s\S]*original_source_document: true,[\s\S]*new_source_document_id: true,[\s\S]*new_idempotency_key: true,[\s\S]*current_authority_grant: true,[\s\S]*current_patient_access_decision: true/,
    );
    expect(reconciliationService).toMatch(
      /action: 'RESOLVE_WITH_REPLACEMENT_RECEIPT'[\s\S]*body_field: 'replacement_resource_receipt_id'/,
    );
    expect(reconciliationService).toMatch(
      /SUPERSESSION_AUTHORITY_GATE = 'CLINICAL_IMPORT_SUPERSESSION_OWNER'[\s\S]*action: 'SUPERSEDE',[\s\S]*status: 'HELD_EXTERNAL_AUTHORITY',[\s\S]*endpoint: null/,
    );
    expect(reconciliationService).toMatch(
      /action: 'OWNER_SUPERSESSION_REVIEW_REQUIRED'[\s\S]*status: 'HELD_EXTERNAL_AUTHORITY'[\s\S]*endpoint: null/,
    );
    expect(reconciliationService).toMatch(
      /ACTION_EVENT_TYPES = new Set\(\['RETRY_REQUESTED', 'RESOLVED'\]\)/,
    );
  });

  test('C-CDA route accepts the HL7 v3 XML media type', () => {
    expect(routes).toContain("type: ['application/xml', 'text/xml', 'application/hl7-v3+xml']");
    expect(routes).toMatch(/req\.is\('application\/hl7-v3\+xml'\)/);
  });

  test('migration 760 custody ledgers are tenant-forced, guarded, and runtime-scoped', () => {
    const newCustodyTables = [
      'clinical_import_authority_events',
      'clinical_import_raw_artifacts',
      'clinical_import_reconciliation_items',
      'clinical_import_reconciliation_events',
    ];
    for (const table of newCustodyTables) {
      expect(migration760).toContain(`CREATE TABLE public.${table} (`);
      expect(migration760).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(migration760).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
      expect(migration760).toContain(`CREATE POLICY tenant_isolation\nON public.${table}`);
    }
    const runtimeGuards = prismaRuntime.match(
      /runtime_guard_functions CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n {2}\];/,
    );
    expect(runtimeGuards).not.toBeNull();
    const normalizedMigration760 = migration760
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*/g, ',')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
    const runtimeGuardSignatures = [
      'clinical_import_append_only_guard_760()',
      'clinical_import_authority_event_guard_760()',
      'clinical_import_raw_artifact_guard_760()',
      'clinical_import_reconciliation_item_guard_760()',
      'clinical_import_active_patient_survivor_760(uuid,uuid)',
      'clinical_import_resource_correction_guard_760()',
      'clinical_import_reconciliation_event_guard_760()',
      'clinical_import_failed_receipt_reconciliation_guard_760()',
    ];
    for (const guard of runtimeGuardSignatures) {
      if (guard === 'clinical_import_active_patient_survivor_760(uuid,uuid)') {
        expect(normalizedMigration760).toContain(
          'CREATE OR REPLACE FUNCTION public.clinical_import_active_patient_survivor_760(target_tenant_id uuid,target_patient_uid uuid) RETURNS uuid',
        );
      } else {
        expect(normalizedMigration760).toContain(`CREATE OR REPLACE FUNCTION public.${guard}`);
      }
      expect(runtimeGuards[1]).toContain(`'${guard}'`);
    }

    const readOnly = prismaRuntime.match(
      /runtime_read_only_relations CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n {2}\];/,
    );
    expect(readOnly).not.toBeNull();
    expect(readOnly[1]).toContain("'clinical_import_authority_events'");
    const appendOnly = prismaRuntime.match(
      /runtime_append_only_relations CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n {2}\];/,
    );
    expect(appendOnly).not.toBeNull();
    for (const table of [
      'clinical_import_document_receipts',
      'clinical_import_resource_receipts',
      'clinical_import_reconciliation_items',
      'clinical_import_reconciliation_events',
    ]) expect(appendOnly[1]).not.toContain(`'${table}'`);
    expect(appendOnly[1]).not.toContain("'clinical_import_raw_artifacts'");
    expect(prismaRuntime).toMatch(
      /GRANT INSERT \([\s\S]*raw_payload_ciphertext[\s\S]*\) ON TABLE public\.clinical_import_raw_artifacts TO %I/,
    );
    expect(prismaRuntime).toMatch(
      /GRANT SELECT \([\s\S]*raw_payload_sha256[\s\S]*raw_payload_bytes[\s\S]*raw_content_type[\s\S]*\) ON TABLE public\.clinical_import_raw_artifacts TO %I/,
    );
    expect(prismaRuntime).not.toMatch(
      /GRANT SELECT \([\s\S]*raw_payload_ciphertext[\s\S]*\) ON TABLE public\.clinical_import_raw_artifacts/,
    );
    expect(prismaRuntime).not.toMatch(
      /GRANT SELECT \([\s\S]*source_author_evidence,[\s\S]*\) ON TABLE public\.clinical_import_raw_artifacts/,
    );
    expect(prismaRuntime).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.lock_clinical_import_authority_760\(\s*UUID\s*,\s*UUID\s*,\s*UUID\s*,\s*INTEGER\s*,\s*UUID\s*,\s*TEXT\s*,\s*TEXT\s*\) TO %I/,
    );
    expect(migration760).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.clinical_import_raw_artifacts FROM %I[\s\S]*GRANT INSERT \([\s\S]*raw_payload_ciphertext[\s\S]*\) ON TABLE public\.clinical_import_raw_artifacts TO %I[\s\S]*GRANT SELECT \([\s\S]*raw_payload_sha256[\s\S]*raw_content_type[\s\S]*\) ON TABLE public\.clinical_import_raw_artifacts TO %I/,
    );
    expect(migration760).not.toMatch(/GRANT INSERT \([^)]*created_at[^)]*\) ON TABLE public\.clinical_import_raw_artifacts/);
    expect(migration760).toMatch(
      /REVOKE INSERT ON TABLE public\.clinical_import_document_receipts[\s\S]*GRANT INSERT \([\s\S]*contract_version[\s\S]*\) ON TABLE public\.clinical_import_document_receipts/,
    );
    expect(migration760).toMatch(
      /REVOKE INSERT ON TABLE public\.clinical_import_resource_receipts[\s\S]*GRANT INSERT \([\s\S]*correction_retry_event_id[\s\S]*\) ON TABLE public\.clinical_import_resource_receipts/,
    );
    for (const table of [
      'clinical_import_raw_artifacts',
      'clinical_import_document_receipts',
      'clinical_import_resource_receipts',
      'clinical_import_reconciliation_items',
      'clinical_import_reconciliation_events',
    ]) {
      expect(prismaRuntime).toMatch(new RegExp(
        `GRANT INSERT \\([^)]*\\) ON TABLE public\\.${table} TO %I`,
      ));
      expect(prismaRuntime).not.toMatch(new RegExp(
        `GRANT INSERT \\([^)]*created_at[^)]*\\) ON TABLE public\\.${table} TO %I`,
      ));
      expect(prismaRuntime).not.toContain(
        `GRANT SELECT, INSERT ON TABLE public.${table} TO %I`,
      );
    }
    expect(migration760).not.toMatch(
      /GRANT SELECT \([\s\S]*raw_payload_ciphertext[\s\S]*\) ON TABLE public\.clinical_import_raw_artifacts/,
    );
    expect(migration760).not.toMatch(
      /GRANT SELECT \([\s\S]*source_author_evidence,[\s\S]*\) ON TABLE public\.clinical_import_raw_artifacts/,
    );
    expect(migration760).toMatch(
      /REVOKE ALL PRIVILEGES ON FUNCTION public\.lock_clinical_import_authority_760\(uuid,uuid,uuid,integer,uuid,text,text\) FROM %I[\s\S]*GRANT EXECUTE ON FUNCTION public\.lock_clinical_import_authority_760\(uuid,uuid,uuid,integer,uuid,text,text\) TO %I/,
    );
    const rawGuard = migration760.slice(
      migration760.indexOf('CREATE OR REPLACE FUNCTION public.clinical_import_raw_artifact_guard_760'),
      migration760.indexOf('CREATE OR REPLACE FUNCTION public.clinical_import_document_authority_guard_755'),
    );
    const documentGuard = migration760.slice(
      migration760.indexOf('CREATE OR REPLACE FUNCTION public.clinical_import_document_authority_guard_755'),
      migration760.indexOf('CREATE OR REPLACE FUNCTION public.clinical_import_reconciliation_item_guard_760'),
    );
    expect(rawGuard).toMatch(/clock_timestamp\(\) < granted\.valid_from[\s\S]*clock_timestamp\(\) >= granted\.valid_until/);
    expect(rawGuard).not.toContain('NEW.created_at < granted.valid_from');
    expect(rawGuard).not.toContain('NEW.created_at >= granted.valid_until');
    expect(documentGuard).toMatch(/clock_timestamp\(\) < granted\.valid_from[\s\S]*clock_timestamp\(\) >= granted\.valid_until/);
    expect(documentGuard).toMatch(/identifier\.expires_at IS NULL[\s\S]*identifier\.expires_at > clock_timestamp\(\)/);
    expect(documentGuard).not.toContain('NEW.created_at < granted.valid_from');
    expect(documentGuard).not.toContain('NEW.created_at >= granted.valid_until');
  });

  test('migration 760 rejects unauthorized terminal shapes and binds resolution to a receipt', () => {
    const eventTable = migration760.match(
      /CREATE TABLE public\.clinical_import_reconciliation_events \(([\s\S]*?)\n\);/,
    );
    expect(eventTable).not.toBeNull();
    expect(eventTable[1]).toContain('replacement_resource_receipt_id uuid');
    expect(eventTable[1]).toContain("event_type IN ('OPENED', 'RETRY_REQUESTED', 'RESOLVED')");
    expect(eventTable[1]).not.toContain("'SUPERSEDED'");
    expect(eventTable[1]).toMatch(
      /event_type = 'RESOLVED' AND replacement_resource_receipt_id IS NOT NULL/,
    );
    expect(migration760).toMatch(
      /FOREIGN KEY \(tenant_id, replacement_resource_receipt_id\)[\s\S]*REFERENCES public\.clinical_import_resource_receipts\(tenant_id, id\)/,
    );
    expect(migration760).toMatch(
      /IF NEW\.event_type = 'RESOLVED'[\s\S]*replacement\.id = NEW\.replacement_resource_receipt_id[\s\S]*replacement\.outcome IN \('imported', 'deduplicated'\)[\s\S]*replacement\.created_at > previous\.created_at[\s\S]*replacement\.patient_uid = active_patient_uid[\s\S]*original\.source_resource_id IS NOT NULL[\s\S]*replacement\.source_resource_id = original\.source_resource_id[\s\S]*original\.source_resource_id IS NULL[\s\S]*replacement\.source_resource_index = original\.source_resource_index[\s\S]*replacement_document\.source_facility_id = NEW\.facility_id/,
    );
    expect(reconciliationService).toMatch(
      /const sameSourceResource = item\.source_resource_id == null[\s\S]*replacement\.source_resource_index[\s\S]*item\.source_resource_index[\s\S]*replacement\.source_resource_id[\s\S]*item\.source_resource_id/,
    );
  });

  test('patient merge retains all six clinical-import custody ledgers in the read union', () => {
    const covered = patientMerge.match(
      /const MERGE_READ_UNION_COVERED_TABLES = new Set\(\[([\s\S]*?)\]\);/,
    );
    expect(covered).not.toBeNull();
    for (const table of [
      'clinical_import_authority_events',
      'clinical_import_document_receipts',
      'clinical_import_raw_artifacts',
      'clinical_import_resource_receipts',
      'clinical_import_reconciliation_items',
      'clinical_import_reconciliation_events',
    ]) expect(covered[1]).toContain(`'${table}'`);
  });

  test('migration 755 makes document and resource receipts tenant-forced and append-only', () => {
    expect(migration755).toMatch(/CREATE TABLE clinical_import_document_receipts \(/);
    expect(migration755).toMatch(/CREATE TABLE clinical_import_resource_receipts \(/);
    expect(migration755).toMatch(
      /CREATE TRIGGER clinical_import_document_receipt_append_only_755[\s\S]*BEFORE UPDATE OR DELETE ON clinical_import_document_receipts[\s\S]*clinical_import_receipt_append_only_755\(\)/,
    );
    expect(migration755).toMatch(
      /CREATE TRIGGER clinical_import_resource_receipt_append_only_755[\s\S]*BEFORE UPDATE OR DELETE ON clinical_import_resource_receipts[\s\S]*clinical_import_receipt_append_only_755\(\)/,
    );
    expect(migration755).toMatch(
      /CREATE CONSTRAINT TRIGGER clinical_import_history_receipt_guard_755[\s\S]*DEFERRABLE INITIALLY DEFERRED[\s\S]*clinical_import_history_receipt_guard_755\(\)/,
    );
    expect(migration755).toMatch(
      /CREATE TRIGGER clinical_import_history_update_immutable_755[\s\S]*BEFORE UPDATE ON e_prescriptions[\s\S]*clinical_import_history_immutable_755\(\)/,
    );
    expect(migration755).toMatch(
      /CREATE TRIGGER clinical_import_history_delete_immutable_755[\s\S]*BEFORE DELETE ON e_prescriptions[\s\S]*clinical_import_history_immutable_755\(\)/,
    );
    expect(migration755).toContain('jsonb_array_length(resource_manifest) > 0');
    expect(migration755).toContain('clinical_import_patient_merge_lock_held_755');
    expect(migration755).not.toContain('patient_merge_lock_held_753');
    for (const table of [
      'clinical_import_document_receipts',
      'clinical_import_resource_receipts',
    ]) {
      expect(migration755).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(migration755).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(migration755).toContain(`CREATE POLICY tenant_isolation\nON ${table}`);
    }
  });

  test('runtime ACL denies receipt mutation and protects all migration 755 guards', () => {
    expect(prismaRuntime).toContain(
      'GRANT INSERT (id, tenant_id, patient_id, patient_uid, source_facility_id, authority_grant_id',
    );
    expect(prismaRuntime).toContain(
      'GRANT INSERT (id, tenant_id, document_receipt_id, patient_uid, source_resource_type',
    );
    expect(prismaRuntime).toMatch(
      /runtime_guard_functions CONSTANT TEXT\[\] := ARRAY\[[\s\S]*'clinical_import_receipt_append_only_755\(\)',[\s\S]*'clinical_import_document_authority_guard_755\(\)',[\s\S]*'clinical_import_resource_authority_guard_755\(\)',[\s\S]*'clinical_import_patient_merge_lock_held_755\(uuid\)',[\s\S]*'clinical_import_history_immutable_755\(\)',[\s\S]*'clinical_import_history_receipt_guard_755\(\)'[\s\S]*\];/,
    );
    expect(migration755).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.clinical_import_document_receipts FROM %I[\s\S]*REVOKE ALL PRIVILEGES ON TABLE public\.clinical_import_resource_receipts FROM %I[\s\S]*GRANT SELECT, INSERT ON TABLE public\.clinical_import_document_receipts TO %I[\s\S]*GRANT SELECT, INSERT ON TABLE public\.clinical_import_resource_receipts TO %I/,
    );
    expect(migration755).toMatch(
      /REVOKE ALL PRIVILEGES ON FUNCTION public\.%s FROM %I/,
    );
  });

  test('C-CDA parsing is structured, namespace tolerant, and entity safe', () => {
    expect(packageJson.dependencies['fast-xml-parser']).toBe('5.10.1');
    expect(importService).toMatch(/new XMLParser\(/);
    expect(importService).toMatch(/removeNSPrefix: true/);
    expect(importService).toMatch(/XMLValidator\.validate/);
    expect(importService).toContain('/<!DOCTYPE|<!ENTITY/i');
    expect(importService).toMatch(/CCDA_STRUCTURE_LIMIT_EXCEEDED/);
    expect(importService).not.toMatch(/function extractCCDASection/);
    expect(importService).not.toMatch(/function extractCCDAPatient/);
  });
});
