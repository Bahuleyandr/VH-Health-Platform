import { readdirSync, readFileSync } from 'node:fs';

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function sourceTree(directoryUrl) {
  return readdirSync(directoryUrl, { withFileTypes: true }).map((entry) => {
    const entryUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directoryUrl);
    if (entry.isDirectory()) return sourceTree(entryUrl);
    return entry.name.endsWith('.js') ? readFileSync(entryUrl, 'utf8') : '';
  }).join('\n');
}

describe('clinical import reconciliation lifecycle contract', () => {
  const service = source('services/import/clinicalImportReconciliationService.js');
  const receiptService = source('services/import/clinicalImportReceiptService.js');
  const importService = source('services/import/patientDataImport.js');
  const migration760 = source('migrations/760_clinical_import_authority_custody_and_reconciliation.sql');
  const routes = source('routes/documents/documentRoutes.js');
  const accessDecisions = source('services/security/accessDecisionService.js');
  const hipaaAudit = source('utils/hipaaAudit.js');
  const securityAuditLogger = source('utils/securityAuditLogger.js');
  const allRoutes = sourceTree(new URL('../../routes/', import.meta.url));

  test('the worklist is tenant scoped, access filtered, and returns hashes instead of raw evidence', () => {
    const itemSelect = service.slice(
      service.indexOf('const ITEM_SELECT'),
      service.indexOf('async function loadItemTx'),
    );
    const publicItem = service.slice(
      service.indexOf('function publicItem'),
      service.indexOf('function publicEvent'),
    );
    const publicEvent = service.slice(
      service.indexOf('function publicEvent'),
      service.indexOf('function reconciliationNextAction'),
    );

    expect(service).toMatch(
      /setTenantTx\(tenant,[\s\S]*item\.tenant_id=\$1::uuid[\s\S]*latest\.event_type IN \('OPENED', 'RETRY_REQUESTED'\)/,
    );
    expect(service).toMatch(/authorizeAccessBatch\(\{[\s\S]*db,[\s\S]*entries: accessEntries/);
    expect(service).toMatch(/decision\?\.allowed === true/);
    expect(service).toMatch(/owned_by_caller:/);
    expect(service).toMatch(/latest_event:/);
    expect(service).not.toContain('raw_payload_ciphertext');
    expect(service).not.toContain('clinical_import_raw_artifacts');
    expect(itemSelect).toMatch(/latest\.evidence_sha256 AS latest_event_evidence_sha256/);
    expect(itemSelect).not.toMatch(/latest\.evidence\b/);
    expect(publicItem).toMatch(/evidence_sha256: String\(row\.latest_event_evidence_sha256\)/);
    expect(publicItem).not.toMatch(/\bevidence:\s/);
    expect(publicEvent).toMatch(/evidence_sha256: String\(row\.evidence_sha256\)/);
    expect(publicEvent).not.toMatch(/\bevidence:\s/);
    expect(routes).toContain("'/import/reconciliation'");
    expect(routes).toMatch(/ACCESS_POLICY_CODES\.PATIENT_RECORD_UPLOAD/);
    expect(routes).toMatch(/authorizeAccessBatch: async \(\{ db, entries \}\)[\s\S]*authorizeClinicalImportReconciliationAccessBatch/);
    expect(routes).toMatch(
      /'\/import\/reconciliation',[\s\S]*req\.suppressSuccessfulPhiAccessLog = true[\s\S]*auditReturnedItems:[\s\S]*logPhiAccessBatch/,
    );
    expect(routes).toMatch(/listError\?\.statusCode === 429[\s\S]*Retry-After', '1'/);
    expect(routes.match(/clinicalImportRateLimiter,/g)).toHaveLength(5);
  });

  test('the worklist is hard bounded and advances from the last evaluated source row', () => {
    expect(service).toMatch(/function decodeWorklistCursor\(value, tenantId\)/);
    expect(service).toContain("const WORKLIST_CURSOR_VERSION = 1");
    expect(service).toContain(
      "const WORKLIST_CURSOR_KEY_DOMAIN = 'vhhealth:clinical-import-reconciliation-cursor:key:v1'",
    );
    expect(service).toMatch(
      /process\.env\.JWT_SECRET[\s\S]*process\.env\.NODE_ENV === 'production' && secret\.length < 32[\s\S]*IMPORT_RECONCILIATION_CURSOR_SECRET_UNAVAILABLE/,
    );
    expect(service).toMatch(
      /createHmac\('sha256', secret\)[\s\S]*WORKLIST_CURSOR_KEY_DOMAIN[\s\S]*createHmac\('sha256', worklistCursorKey\(\)\)/,
    );
    expect(service).toMatch(/if \(value == null\) \{[\s\S]*createdAt: null, itemId: null/);
    expect(service).toMatch(
      /token\.length > 512[\s\S]*\^\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\$/,
    );
    expect(service).toMatch(/crypto\.timingSafeEqual\(suppliedSignatureBytes, expectedSignatureBytes\)/);
    expect(service).toMatch(/const decodedText = Buffer\.from\(encodedPayload, 'base64url'\)\.toString\('utf8'\)/);
    expect(service).toMatch(
      /Buffer\.from\(decodedText\)\.toString\('base64url'\) !== encodedPayload[\s\S]*non-canonical base64url/,
    );
    expect(service).toMatch(
      /Object\.keys\(decoded\)\.join\(','\) !== 'v,tenant_id,created_at,item_id'/,
    );
    expect(service).toMatch(/JSON\.stringify\(decoded\) !== decodedText/);
    expect(service).toMatch(/decoded\.v !== WORKLIST_CURSOR_VERSION/);
    expect(service).toMatch(/decoded\.tenant_id !== tenantId/);
    expect(service).toMatch(/typeof decoded\.created_at !== 'string'/);
    expect(service).toMatch(
      /requiredUuid\([\s\S]*decoded\?\.item_id,[\s\S]*'cursor\.item_id',[\s\S]*'IMPORT_RECONCILIATION_CURSOR_INVALID'/,
    );
    expect(service).toMatch(
      /Number\.isNaN\(createdAt\.getTime\(\)\)[\s\S]*createdAt\.toISOString\(\) !== decoded\.created_at/,
    );
    expect(service).toMatch(/IMPORT_RECONCILIATION_CURSOR_INVALID/);
    expect(service).toMatch(/function encodeWorklistCursor\(row, tenantId\)/);
    expect(service).toMatch(/\.toString\('base64url'\)/);
    expect(service).toMatch(
      /\(item\.created_at, item\.id\) > \(\$2::timestamptz, \$3::uuid\)/,
    );
    expect(service).toMatch(/ORDER BY item\.created_at, item\.id/);
    expect(service).toContain('const LIST_SCAN_BATCH_SIZE = 25');
    expect(service).toContain('const LIST_SCAN_ROW_LIMIT = 25');
    expect(service).toContain('const LIST_SCAN_QUERY_LIMIT = 1');
    expect(service).toContain('const LIST_SCAN_TIME_BUDGET_MS = 10_000');
    expect(service).toContain('const LIST_TRANSACTION_TIMEOUT_MS = 10_000');
    expect(service).toContain('const LIST_TOTAL_DB_QUERY_LIMIT = 38');
    expect(service).toContain('const LIST_CONCURRENCY_SLOTS = 4');
    expect(service).toMatch(/applyRemainingStatementTimeout[\s\S]*Math\.min\(3_000, remainingMs\)/);
    expect(service).toMatch(/function worklistDbBudget[\s\S]*IMPORT_RECONCILIATION_QUERY_BUDGET_EXHAUSTED/);
    expect(service).toMatch(/acquireWorklistConcurrencySlot[\s\S]*pg_try_advisory_xact_lock[\s\S]*IMPORT_RECONCILIATION_CONCURRENCY_EXHAUSTED/);
    expect(service).toMatch(/acquireTenantWorklistLock[\s\S]*IMPORT_RECONCILIATION_TENANT_CONCURRENCY_EXHAUSTED/);
    const listImplementation = service.slice(
      service.indexOf('export async function listClinicalImportReconciliationItems'),
      service.indexOf('async function lockCurrentAuthorityTx'),
    );
    expect(listImplementation.indexOf('acquireTenantWorklistLock')).toBeLessThan(
      listImplementation.indexOf('acquireWorklistConcurrencySlot'),
    );
    expect(service).toMatch(
      /async function resolveActivePatientSurvivorsTx[\s\S]*const uniquePatientUids[\s\S]*patient\.uid=ANY\(\$2::uuid\[\]\)[\s\S]*tenantId,[\s\S]*uniquePatientUids/,
    );
    expect(accessDecisions).toMatch(/authorizeClinicalImportReconciliationAccessBatchRequest[\s\S]*entries\.length > 25/);
    expect(accessDecisions).toMatch(/actorRoleOf\(req\) !== 'MEDICAL_RECORDS'[\s\S]*PATIENT_RECORD_UPLOAD[\s\S]*recordType !== 'MEDICAL_RECORD'/);
    expect(accessDecisions).toMatch(/UUID_RE\.test\(decisionKey\)[\s\S]*resourceContext\?\.resourceType !== 'clinical_import_reconciliation'[\s\S]*resourceContext\?\.resourceId/);
    expect(accessDecisions).toMatch(/jsonb_to_recordset\(\$2::jsonb\)[\s\S]*patient\.tenant_id=\$1::uuid[\s\S]*patient\.id=request\.patient_id[\s\S]*patient\.uid=request\.patient_uid/);
    expect(accessDecisions).toMatch(/patient\.is_active=TRUE[\s\S]*patient\.status='active'[\s\S]*patient\.is_deleted=FALSE[\s\S]*patient\.merged_into_uid IS NULL/);
    expect(accessDecisions).toMatch(/writePatientAccessAuditBatch[\s\S]*jsonb_to_recordset/);
    expect(hipaaAudit).toMatch(/export async function logPhiAccessBatch[\s\S]*entries\.length > 25[\s\S]*jsonb_to_recordset/);
    expect(routes).toMatch(/recordType: `clinical_import_reconciliation:\$\{item\.id\}`/);
    expect(service).toMatch(/LIMIT \$4::int/);
    expect(service).toMatch(/while \(authorized\.length < LIST_LIMIT\)/);
    expect(service).toMatch(/authorizeAccessBatch\(\{[\s\S]*db,[\s\S]*entries: accessEntries/);
    expect(service).toMatch(/decision\?\.allowed === true[\s\S]*authorized\.push\(\{ row, survivor \}\)/);
    expect(service).toMatch(
      /lastScannedRow = row[\s\S]*const needsContinuation = lastScannedRow != null[\s\S]*nextCursor: needsContinuation \? encodeWorklistCursor\(lastScannedRow, tenant\) : null/,
    );
    expect(service).toMatch(/rows\.length < batchLimit/);
    expect(service).toMatch(/scanCursor = \{[\s\S]*createdAt:[\s\S]*itemId:/);
    expect(service).toMatch(/isolationLevel: 'RepeatableRead',[\s\S]*timeout: LIST_TRANSACTION_TIMEOUT_MS/);
    expect(migration760).toMatch(
      /CREATE INDEX idx_clinical_import_reconciliation_worklist_760[\s\S]*\(tenant_id, created_at, id\)/,
    );
    expect(service).not.toMatch(/\bOFFSET\b/i);
    expect(routes).toMatch(/cursor: req\.query\?\.cursor/);
    expect(routes).toMatch(/next_cursor: page\.nextCursor/);
  });

  test('all entry points require an active Medical Records actor and current patient access', () => {
    expect(service).toMatch(/actor\.role='MEDICAL_RECORDS'/);
    expect(service).toMatch(/actor\.is_active=TRUE/);
    expect(service).toMatch(/actor\.status='active'/);
    expect(service).toMatch(/actor\.is_deleted=FALSE/);
    expect(service).toMatch(/IMPORT_RECONCILIATION_ROLE_REQUIRED/);
    expect(service).toMatch(/clinical-import-reconciliation-access-decision-v1/);
    expect(service).toContain("const PATIENT_RECORD_UPLOAD_POLICY = 'patient.record.upload'");
    expect(service).toMatch(/evidenceActorUid !== actorUid/);
    expect(service).toMatch(/evidencePatientUid !== patientUid/);
  });

  test('action routes prove grant authority before loading patient context without an item oracle', () => {
    const handlerStart = routes.indexOf('async function executeClinicalImportReconciliationAction');
    const handlerEnd = routes.indexOf('// =============================================================================', handlerStart);
    const handler = routes.slice(handlerStart, handlerEnd);
    const grantPreflight = handler.indexOf(
      'assertClinicalImportReconciliationActionAuthority',
    );
    const itemContext = handler.indexOf('getClinicalImportReconciliationActionContext');
    const patientAccess = handler.indexOf('authorizeClinicalImportReconciliationAccess');
    const authorityPreflight = service.slice(
      service.indexOf('export async function assertClinicalImportReconciliationActionAuthority'),
      service.indexOf('export async function listClinicalImportReconciliationItems'),
    );

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(grantPreflight).toBeGreaterThanOrEqual(0);
    expect(itemContext).toBeGreaterThan(grantPreflight);
    expect(patientAccess).toBeGreaterThan(itemContext);
    expect(service).toMatch(
      /if \(!rows\.length\) \{[\s\S]*AppError\.forbidden\([\s\S]*'The clinical import authority grant is unavailable or outside the exact current scope',[\s\S]*'IMPORT_RECONCILIATION_GRANT_UNAVAILABLE'/,
    );
    expect(service).toMatch(
      /lockClinicalImportAuthorityGrantTx\(tx,[\s\S]*unavailableCode: 'IMPORT_RECONCILIATION_GRANT_UNAVAILABLE',[\s\S]*unavailableMessage:[\s\S]*'The clinical import authority grant is unavailable or outside the exact current scope'/,
    );
    expect(authorityPreflight).toMatch(
      /const row = rows\[0\][\s\S]*resolveActivePatientSurvivorTx\(tx, tenant, row\.patient_uid\)[\s\S]*lockClinicalImportAuthorityGrantTx\(tx, \{[\s\S]*patientUid: survivor\.uid/,
    );
    expect(authorityPreflight.indexOf('resolveActivePatientSurvivorTx')).toBeLessThan(
      authorityPreflight.indexOf('lockClinicalImportAuthorityGrantTx'),
    );
  });

  test('role and grant preflight denials emit generic durable security evidence', () => {
    const denialLogger = routes.slice(
      routes.indexOf('function logClinicalImportAuthorityDenial'),
      routes.indexOf('// ---------------------------------------------------------------------------',
        routes.indexOf('function logClinicalImportAuthorityDenial')),
    );
    const importAuthority = routes.slice(
      routes.indexOf('async function resolveClinicalImportAuthority'),
      routes.indexOf('async function authorizeClinicalImportReconciliationAccess'),
    );
    const reconciliationAction = routes.slice(
      routes.indexOf('async function executeClinicalImportReconciliationAction'),
      routes.indexOf('// =============================================================================',
        routes.indexOf('async function executeClinicalImportReconciliationAction')),
    );

    expect(routes).toMatch(
      /import \{ logSecurityEvent \} from '\.\.\/\.\.\/utils\/securityAuditLogger\.js'/,
    );
    expect(denialLogger).toMatch(
      /function logClinicalImportAuthorityDenial\(req, tenantId, reason\) \{[\s\S]*logSecurityEvent\('CLINICAL_IMPORT_AUTHORITY_DENIED', \{[\s\S]*userId:[\s\S]*userRole:[\s\S]*tenantId,[\s\S]*path:[\s\S]*method:[\s\S]*statusCode: 403,[\s\S]*reason,[\s\S]*\}\)/,
    );
    expect(importAuthority).toMatch(
      /actorRole !== 'MEDICAL_RECORDS'[\s\S]*logClinicalImportAuthorityDenial\(req, tenantId, 'IMPORT_PARTNER_AUTHORITY_NOT_CONFIGURED'\)/,
    );
    expect(routes).toMatch(
      /importFhirBundle\(bundle,[\s\S]*catch \(importError\) \{[\s\S]*importError instanceof AppError && importError\.statusCode === 403[\s\S]*logClinicalImportAuthorityDenial\(req, tenantId, importError\.code\)/,
    );
    expect(routes).toMatch(
      /importCCDA\(xmlString,[\s\S]*catch \(importError\) \{[\s\S]*importError instanceof AppError && importError\.statusCode === 403[\s\S]*logClinicalImportAuthorityDenial\(req, tenantId, importError\.code\)/,
    );
    expect(reconciliationAction).toMatch(
      /assertClinicalImportReconciliationActionAuthority[\s\S]*catch \(error\) \{[\s\S]*error instanceof AppError && error\.statusCode === 403[\s\S]*logClinicalImportAuthorityDenial\(req, tenantId, error\.code\)/,
    );
    expect(securityAuditLogger).toMatch(
      /export function logSecurityEvent\(eventType, details = \{\}\)[\s\S]*INSERT INTO audit_log[\s\S]*'security',[\s\S]*eventType/,
    );
    expect(securityAuditLogger).toMatch(
      /catch \(err\) \{[\s\S]*_logToFile\(eventType, safeDetails, err\?\.message\)/,
    );
  });

  test('exact historical replay precedes current grant locking while new receipts remain fail closed', () => {
    const receiptLock = receiptService.slice(
      receiptService.indexOf('export async function lockClinicalImportDocumentReceiptTx'),
      receiptService.indexOf('function normalizedResourceOutcome'),
    );
    const existingReceiptLookup = receiptLock.indexOf('const rows = await tx.$queryRawUnsafe');
    const currentGrantLock = receiptLock.indexOf('lockClinicalImportAuthorityGrantTx');

    expect(existingReceiptLookup).toBeGreaterThanOrEqual(0);
    expect(currentGrantLock).toBeGreaterThan(existingReceiptLookup);
    expect(receiptLock).toMatch(
      /if \(!rows\.length\) \{[\s\S]*lockClinicalImportAuthorityGrantTx\(tx, expected\)[\s\S]*bindClinicalImportAccessDecision\(expected, ownerEvidenceSha256\)[\s\S]*lockClinicalImportCorrectionTx\(tx, expected\)[\s\S]*return null/,
    );
    expect(receiptLock).toMatch(
      /const receipt = rows\[0\][\s\S]*assertStoredReceiptMatches\(receipt, expected, resources, allowedPatientUids\)[\s\S]*replayed: true/,
    );
    expect(routes).not.toContain('setTenantTx(tenantId, (tx) => lockClinicalImportAuthorityGrantTx');
  });

  test('commands serialize per item and lock the exact current grant for the active survivor', () => {
    const currentAuthorityLock = service.slice(
      service.indexOf('async function lockCurrentAuthorityTx'),
      service.indexOf('async function findIdempotentEventTx'),
    );
    const sharedAuthorityLock = receiptService.slice(
      receiptService.indexOf('export async function lockClinicalImportAuthorityGrantTx'),
      receiptService.indexOf('function requiredText'),
    );

    expect(service).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\(\$1::text, 760\)\)::text/,
    );
    expect(service).toMatch(/vh:clinical_import_reconciliation:\$\{tenant\}:\$\{item\}/);
    expect(currentAuthorityLock).toMatch(
      /return lockClinicalImportAuthorityGrantTx\(tx, \{[\s\S]*tenantId,[\s\S]*authorityGrantId,[\s\S]*patientUid,[\s\S]*sourceFacilityId: facilityId,[\s\S]*actorUid,[\s\S]*sourceSystem,[\s\S]*documentFormat/,
    );
    expect(sharedAuthorityLock).toMatch(
      /SELECT public\.lock_clinical_import_authority_760\([\s\S]*\$1::uuid, \$2::uuid, \$3::uuid, \$4::int, \$5::uuid, \$6::text, \$7::text[\s\S]*tenantId,[\s\S]*authorityGrantId,[\s\S]*patientUid,[\s\S]*sourceFacilityId,[\s\S]*actorUid,[\s\S]*sourceSystem,[\s\S]*documentFormat/,
    );
    expect(service).toMatch(/resolveActivePatientSurvivorTx\(tx, tenant, itemRow\.patient_uid\)/);
    expect(routes).toContain("req.get('Idempotency-Key')");
    expect(routes).toContain("req.get('X-VH-Import-Authority-Grant-Id')");
    expect(routes).toContain("'/import/reconciliation/:itemId/retry-request'");
    expect(routes).toContain("'/import/reconciliation/:itemId/resolve'");
    expect(routes).toContain("sanitizeBody('reason')");
    expect(routes.match(/sanitizeClinicalImportReconciliationReason,/g)).toHaveLength(2);
  });

  test('state-changing commands hold patient-merge stability for the bounded transaction', () => {
    expect(service).toMatch(
      /lockTenantPatientMergeStability,[\s\S]*PATIENT_MERGE_STABILITY_TIMEOUT_MS[\s\S]*from '\.\.\/\.\.\/utils\/patientMergeStabilityLock\.js'/,
    );
    expect(service).toMatch(
      /async function appendReconciliationEvent\([\s\S]*setTenantTx\(tenant, async \(tx\) => \{[\s\S]*await lockTenantPatientMergeStability\(tx, tenant\)[\s\S]*isolationLevel: 'Serializable',[\s\S]*timeout: PATIENT_MERGE_STABILITY_TIMEOUT_MS/,
    );
  });

  test('state-changing commands revalidate patient access on the supplied transaction client', () => {
    expect(service).toMatch(
      /async function appendReconciliationEvent\([\s\S]*typeof revalidateAccess !== 'function'[\s\S]*setTenantTx\(tenant, async \(tx\) => \{[\s\S]*const itemRow = await loadItemTx\(tx, tenant, item\)[\s\S]*const survivor = await resolveActivePatientSurvivorTx\(tx, tenant, itemRow\.patient_uid\)[\s\S]*await revalidateAccess\(\{[\s\S]*db: tx,[\s\S]*context: currentContext,[\s\S]*\}\)/,
    );
    expect(routes).toMatch(
      /revalidateAccess: async \(\{ db, context: currentContext \}\) => \{[\s\S]*authorizeClinicalImportReconciliationAccess\([\s\S]*req,[\s\S]*activeContext,[\s\S]*\{ db, audit: false \},[\s\S]*\)/,
    );
    expect(routes).toMatch(
      /async function authorizeClinicalImportReconciliationAccess\([\s\S]*db = null,[\s\S]*authorizePatientAccessRequest\(req, \{[\s\S]*db,[\s\S]*audit,[\s\S]*requireResolvedPatient: true/,
    );
  });

  test('idempotency returns only an exact stored event and rejects changed reuse', () => {
    expect(service).toMatch(
      /idempotency_key_sha256=\$2::char\(64\)[\s\S]*isExactReplay\(existing, request\)/,
    );
    expect(service).toMatch(/IMPORT_RECONCILIATION_IDEMPOTENCY_MISMATCH/);
    expect(service).toMatch(
      /event: publicEvent\(existing\),[\s\S]*replayed: true,[\s\S]*next_action: String\(itemRow\.latest_event_type\) === eventType[\s\S]*\? reconciliationNextAction\(eventType, item, itemRow\.document_format\)[\s\S]*: null/,
    );
    expect(service).toMatch(/storedRequest\?\.event_type === request\.eventType/);
    expect(service).toMatch(/storedRequest\?\.reason === request\.reason/);
    expect(service).toMatch(/storedRequest\?\.authority_grant_id/);
    expect(service).toMatch(/storedRequest\?\.replacement_resource_receipt_id/);
  });

  test('document receipt replay compares the complete raw custody tuple', () => {
    expect(receiptService).toMatch(
      /document\.created_at, raw\.raw_payload_sha256,[\s\S]*raw\.raw_payload_bytes, raw\.raw_content_type,[\s\S]*raw\.canonicalization_version AS raw_canonicalization_version,[\s\S]*raw\.canonical_payload_sha256 AS raw_canonical_payload_sha256,[\s\S]*raw\.signature_verification_status[\s\S]*AS raw_signature_verification_status/,
    );
    expect(receiptService).toMatch(
      /raw_payload_sha256: expected\.rawPayloadSha256,[\s\S]*raw_payload_bytes: expected\.rawPayloadBytes,[\s\S]*raw_content_type: expected\.rawContentType,[\s\S]*raw_canonicalization_version: expected\.rawCanonicalizationVersion,[\s\S]*raw_canonical_payload_sha256: expected\.sourcePayloadSha256,[\s\S]*raw_signature_verification_status: expected\.signatureVerificationStatus/,
    );
    expect(receiptService).toMatch(
      /for \(const \[field, value\] of Object\.entries\(fields\)\)[\s\S]*String\(receipt\[field\] \?\? ''\) !== String\(value \?\? ''\)[\s\S]*mismatch_field: field/,
    );
    expect(receiptService).toMatch(/authority_grant_id: expected\.authorityGrantId/);
    expect(receiptService).toMatch(/Clinical import correction binding changed on replay/);
  });

  test('resolution requires committed matching replacement and records custody and canonical evidence', () => {
    expect(service).toMatch(
      /replacement\.id=\$2::uuid[\s\S]*replacement\.outcome IN \('imported', 'deduplicated'\)/,
    );
    expect(service).not.toMatch(/\bFOR\s+(?:UPDATE|SHARE)\b/i);
    expect(service).toMatch(/replacement\.source_resource_type/);
    expect(service).toMatch(/replacement\.source_resource_id/);
    expect(service).toMatch(/replacement\.correction_reconciliation_item_id/);
    expect(service).toMatch(/replacement\.correction_original_resource_receipt_id/);
    expect(service).toMatch(/replacement\.correction_retry_event_id/);
    expect(service).toMatch(/IMPORT_RECONCILIATION_RETRY_REQUIRED/);
    expect(service).toMatch(/replacementSurvivor\.uid !== activePatientUid/);
    expect(service).toMatch(/historical_patient_uid:/);
    expect(service).toMatch(/active_survivor_patient_uid:/);
    expect(service).toMatch(/resource_canonical_timeline_event_id:/);
    expect(service).toMatch(/resource_canonical_audit_event_id:/);
    expect(service).toMatch(/document_canonical_timeline_event_id:/);
    expect(service).toMatch(/document_canonical_audit_event_id:/);
    expect(service).toMatch(/owner_evidence_sha256:/);
    expect(service).toMatch(/patient_access: accessEvidence/);
    expect(service).toMatch(
      /INSERT INTO clinical_import_reconciliation_events[\s\S]*replacement_resource_receipt_id, idempotency_key_sha256[\s\S]*\$11::uuid/,
    );
    expect(service).toMatch(
      /replacement_resource_receipt_id: row\.replacement_resource_receipt_id == null[\s\S]*String\(row\.replacement_resource_receipt_id\)/,
    );
  });

  test('the database enforces typed exact replacement evidence for every resolution', () => {
    const replacementConstraint = migration760.slice(
      migration760.indexOf('CONSTRAINT ck_clinical_import_reconciliation_event_replacement_760'),
      migration760.indexOf('CONSTRAINT ck_clinical_import_reconciliation_event_contract_760'),
    );
    const replacementForeignKey = migration760.slice(
      migration760.indexOf('CONSTRAINT fk_clinical_import_reconciliation_event_replacement_760'),
      migration760.indexOf('CREATE INDEX idx_clinical_import_reconciliation_event_stream_760'),
    );
    const eventGuard = migration760.slice(
      migration760.indexOf('CREATE OR REPLACE FUNCTION public.clinical_import_reconciliation_event_guard_760'),
      migration760.indexOf('CREATE OR REPLACE FUNCTION public.clinical_import_failed_receipt_reconciliation_guard_760'),
    );

    expect(migration760).toMatch(/replacement_resource_receipt_id uuid/);
    expect(replacementConstraint).toMatch(
      /CONSTRAINT ck_clinical_import_reconciliation_event_replacement_760[\s\S]*event_type = 'RESOLVED' AND replacement_resource_receipt_id IS NOT NULL[\s\S]*event_type <> 'RESOLVED' AND replacement_resource_receipt_id IS NULL/,
    );
    expect(replacementForeignKey).toMatch(
      /CONSTRAINT fk_clinical_import_reconciliation_event_replacement_760[\s\S]*FOREIGN KEY \(tenant_id, replacement_resource_receipt_id\)[\s\S]*REFERENCES public\.clinical_import_resource_receipts\(tenant_id, id\)[\s\S]*ON DELETE RESTRICT/,
    );
    expect(eventGuard).toMatch(
      /IF NEW\.event_type = 'RESOLVED'[\s\S]*replacement\.id = NEW\.replacement_resource_receipt_id[\s\S]*replacement\.outcome IN \('imported', 'deduplicated'\)[\s\S]*replacement\.created_at > previous\.created_at/,
    );
    expect(migration760).toMatch(
      /CREATE UNIQUE INDEX ux_clinical_import_reconciliation_replacement_760[\s\S]*replacement_resource_receipt_id[\s\S]*WHERE event_type = 'RESOLVED'/,
    );
    expect(migration760).toMatch(
      /CREATE UNIQUE INDEX ux_clinical_import_reconciliation_resolved_item_760[\s\S]*reconciliation_item_id[\s\S]*WHERE event_type = 'RESOLVED'/,
    );
    expect(eventGuard).toMatch(
      /replacement\.correction_reconciliation_item_id = item\.id[\s\S]*replacement\.correction_original_resource_receipt_id = item\.resource_receipt_id[\s\S]*replacement\.correction_retry_event_id = previous\.id/,
    );
    expect(eventGuard).toMatch(
      /replacement\.patient_uid = active_patient_uid[\s\S]*replacement\.source_resource_type = original\.source_resource_type[\s\S]*original\.source_resource_id IS NOT NULL[\s\S]*replacement\.source_resource_id = original\.source_resource_id[\s\S]*original\.source_resource_id IS NULL[\s\S]*replacement\.source_resource_index = original\.source_resource_index/,
    );
    expect(eventGuard).toMatch(
      /replacement_document\.source_system = source_document\.source_system[\s\S]*replacement_document\.document_format = source_document\.document_format[\s\S]*replacement_document\.source_facility_id = NEW\.facility_id/,
    );
    expect(eventGuard).toMatch(
      /NEW\.evidence #>> '\{request,replacement_resource_receipt_id\}'[\s\S]*= replacement\.id::text[\s\S]*NEW\.evidence #>> '\{replacement_receipt,resource_receipt_id\}'[\s\S]*= replacement\.id::text/,
    );
  });

  test('replacement evidence is newer and closes both stable-ID and missing-ID failures', () => {
    expect(service).toMatch(/const replacementBoundary = item\.latest_event_created_at/);
    expect(service).toMatch(
      /replacement\.created_at\)\.getTime\(\) <= new Date\(replacementBoundary\)\.getTime\(\)/,
    );
    expect(service).toMatch(/IMPORT_RECONCILIATION_REPLACEMENT_STALE/);
    expect(service).toMatch(
      /const sameSourceResource = item\.source_resource_id == null[\s\S]*\? Number\(replacement\.source_resource_index\) === Number\(item\.source_resource_index\)[\s\S]*: String\(replacement\.source_resource_id\) === String\(item\.source_resource_id\)/,
    );
    expect(service).toMatch(
      /String\(replacement\.source_resource_type\) !== String\(item\.source_resource_type\)[\s\S]*\|\| !sameSourceResource/,
    );
  });

  test('retry responses direct governed manual resubmission and expose receipt IDs for closure', () => {
    expect(service).toMatch(/function reconciliationNextAction\(eventType, itemId, documentFormat\)/);
    expect(service).toContain("action: 'MANUAL_RESUBMISSION_REQUIRED'");
    expect(service).toContain("action: 'RESOLVE_WITH_REPLACEMENT_RECEIPT'");
    expect(service).toContain("body_field: 'replacement_resource_receipt_id'");
    expect(service).toMatch(/new_source_document_id: true/);
    expect(service).toMatch(/new_idempotency_key: true/);
    expect(service).toMatch(/current_authority_grant: true/);
    expect(service).toMatch(/current_patient_access_decision: true/);
    expect(service).toContain("name: 'X-VH-Import-Correction-Item-Id'");
    expect(service).toContain("name: 'X-VH-Import-Correction-Manifest-Index'");
    expect(service).toMatch(/next_action: reconciliationNextAction\(eventType, item, itemRow\.document_format\)/);
    expect(receiptService).toMatch(
      /resource_receipts: resources\.map\([\s\S]*id: resource\.id,[\s\S]*source_resource_type:[\s\S]*source_resource_id:[\s\S]*source_resource_index:[\s\S]*outcome:/,
    );
  });

  test('correction imports require a bounded header pair and persist an exact causal binding', () => {
    const correctionGuard = migration760.slice(
      migration760.indexOf(
        'CREATE OR REPLACE FUNCTION public.clinical_import_resource_correction_guard_760',
      ),
      migration760.indexOf(
        'CREATE OR REPLACE FUNCTION public.clinical_import_reconciliation_event_guard_760',
      ),
    );

    expect(routes).toContain("req.get('X-VH-Import-Correction-Item-Id')");
    expect(routes).toContain("req.get('X-VH-Import-Correction-Manifest-Index')");
    expect(routes).toMatch(/\^\(\?:0\|\[1-9\]\[0-9\]\{0,3\}\)\$/);
    expect(routes).toContain("'IMPORT_CORRECTION_BINDING_INVALID'");
    expect(receiptService).toMatch(
      /async function lockClinicalImportCorrectionTx\(tx, expected\)[\s\S]*latest\.event_type AS latest_event_type[\s\S]*latest_event_type !== 'RETRY_REQUESTED'/,
    );
    expect(receiptService).toMatch(
      /active_patient_uid[\s\S]*facility_id[\s\S]*source_system[\s\S]*document_format[\s\S]*retry_actor_uid[\s\S]*retry_authority_grant_id/,
    );
    expect(receiptService).toMatch(
      /correctionReconciliationItemId = expected\.correctionItemId[\s\S]*correctionOriginalResourceReceiptId =[\s\S]*correctionRetryEventId =/,
    );
    expect(migration760).toMatch(
      /ADD COLUMN correction_reconciliation_item_id uuid[\s\S]*ADD COLUMN correction_original_resource_receipt_id uuid[\s\S]*ADD COLUMN correction_retry_event_id uuid/,
    );
    expect(migration760).toMatch(
      /CREATE UNIQUE INDEX ux_clinical_import_resource_correction_item_760[\s\S]*correction_reconciliation_item_id[\s\S]*WHERE correction_reconciliation_item_id IS NOT NULL/,
    );
    expect(correctionGuard).toMatch(
      /NOT EXISTS \([\s\S]*FROM public\.clinical_import_reconciliation_events AS later[\s\S]*\(later\.created_at, later\.id\) > \(retry\.created_at, retry\.id\)[\s\S]*current exact retry binding/,
    );
    expect(service).toMatch(
      /eventType === 'RETRY_REQUESTED'[\s\S]*correction_reconciliation_item_id=\$2::uuid[\s\S]*IMPORT_RECONCILIATION_CORRECTION_PENDING_RESOLUTION/,
    );
    expect(migration760).toMatch(
      /NEW\.event_type = 'RETRY_REQUESTED'[\s\S]*replacement\.correction_reconciliation_item_id = item\.id[\s\S]*must be resolved before another retry/,
    );
  });

  test('the worklist names the held owner supersession gate without exposing an endpoint', () => {
    expect(service).toContain("const SUPERSESSION_AUTHORITY_GATE = 'CLINICAL_IMPORT_SUPERSESSION_OWNER'");
    expect(service).toMatch(
      /held_terminal_action: \{[\s\S]*action: 'SUPERSEDE',[\s\S]*status: 'HELD_EXTERNAL_AUTHORITY',[\s\S]*required_authority: SUPERSESSION_AUTHORITY_GATE,[\s\S]*endpoint: null/,
    );
    expect(service).toMatch(
      /if_no_legitimate_replacement_exists: \{[\s\S]*action: 'OWNER_SUPERSESSION_REVIEW_REQUIRED',[\s\S]*required_authority: SUPERSESSION_AUTHORITY_GATE,[\s\S]*endpoint: null/,
    );
  });

  test('the runtime can append only retry or explicit resolution and never exposes superseded events', () => {
    const eventTypeConstraint = migration760.slice(
      migration760.indexOf('CONSTRAINT ck_clinical_import_reconciliation_event_type_760'),
      migration760.indexOf('CONSTRAINT ck_clinical_import_reconciliation_event_actor_role_760'),
    );

    expect(service).toContain("const ACTION_EVENT_TYPES = new Set(['RETRY_REQUESTED', 'RESOLVED'])");
    expect(service).toMatch(/previous|latest_event_type/);
    expect(service).toMatch(/IMPORT_RECONCILIATION_ALREADY_TERMINAL/);
    expect(service).toMatch(/String\(row\.event_type\) === 'SUPERSEDED'/);
    expect(routes).not.toMatch(/SUPERSEDED/);
    expect(eventTypeConstraint).toMatch(
      /event_type IN \('OPENED', 'RETRY_REQUESTED', 'RESOLVED'\)/,
    );
    expect(eventTypeConstraint).not.toMatch(/SUPERSEDED/);
    expect(migration760).toMatch(
      /SUPERSEDED is a reserved terminal evidence shape, not runtime authority[\s\S]*CLINICAL_IMPORT_SUPERSESSION_OWNER/,
    );
  });

  test('C-CDA raw-body handling covers every accepted XML media type', () => {
    expect(routes).toMatch(
      /type: \['application\/xml', 'text\/xml', 'application\/hl7-v3\+xml'\]/,
    );
    expect(routes).toMatch(
      /req\.is\('application\/xml'\)[\s\S]*req\.is\('text\/xml'\)[\s\S]*req\.is\('application\/hl7-v3\+xml'\)/,
    );
  });

  test('diagnosis and allergy imports remain held behind named owner promotion authority', () => {
    expect(importService).toContain(
      "const CLINICAL_IMPORT_ASSERTION_PROMOTION_GATE =\n  'CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER'",
    );
    expect(importService).toMatch(
      /function clinicalAssertionPromotionRequired\(resourceType, resourceId = null\)[\s\S]*return \{[\s\S]*status: 'failed',[\s\S]*errorCode: 'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',[\s\S]*status: 'HELD_EXTERNAL_AUTHORITY',[\s\S]*required_authority: CLINICAL_IMPORT_ASSERTION_PROMOTION_GATE/,
    );
    expect([...importService.matchAll(/clinicalAssertionPromotionRequired\(/g)]).toHaveLength(5);
    expect(importService).not.toContain('GOVERNED_IMPORT_CLINICAL_ASSERTION_PROMOTION_ENABLED');
    expect(importService).not.toContain('gatedAssertion');
    expect(importService).toMatch(
      /async function importCondition\([\s\S]*clinicalAssertionPromotionRequired\('Condition', fhirCondition\.id \|\| null\)/,
    );
    expect(importService).toMatch(
      /async function importAllergyIntolerance\([\s\S]*clinicalAssertionPromotionRequired\('AllergyIntolerance', fhirAllergy\.id \|\| null\)/,
    );
    expect(importService).toMatch(
      /async function importDiagnosisFromCCDA\([\s\S]*clinicalAssertionPromotionRequired\(\s*'C-CDA_Problem',[\s\S]*problem\.id \|\| problem\.code \|\| null/,
    );
    expect(importService).toMatch(
      /async function importAllergyFromCCDA\([\s\S]*clinicalAssertionPromotionRequired\(\s*'C-CDA_Allergy',[\s\S]*allergy\.id \|\| allergy\.code \|\| null/,
    );
    expect(allRoutes).not.toMatch(/clinicalAssertionPromotion|CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER/);
  });
});
