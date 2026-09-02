import crypto from 'node:crypto';
import { jest } from '@jest/globals';

process.env.JWT_SECRET ||= 'clinical-import-pagination-test-secret-at-least-32-characters';

const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../utils/patientMergeStabilityLock.js', () => ({
  lockTenantPatientMergeStability: jest.fn(),
  PATIENT_MERGE_STABILITY_TIMEOUT_MS: 30_000,
}));

jest.unstable_mockModule('../../services/import/clinicalImportReceiptService.js', () => ({
  clinicalImportSha256: jest.fn(() => 'a'.repeat(64)),
  lockClinicalImportAuthorityGrantTx: jest.fn(),
}));

const {
  listClinicalImportReconciliationItems,
} = await import('../../services/import/clinicalImportReconciliationService.js');
const { AppError } = await import('../../utils/AppError.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const UNLISTABLE_PATIENT_UID = '33333333-3333-4333-8333-333333333333';
const PAGE_SIZE = 25;
const SENSITIVE_SENTINEL = 'must-not-leave-the-database-row';

let transactionDb;

function entityUuid(prefix, index) {
  return `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function makeRow(index) {
  const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
  return {
    id: entityUuid('1', index),
    patient_uid: PATIENT_UID,
    facility_id: 7,
    owner_actor_uid: ACTOR_UID,
    owner_actor_role: 'MEDICAL_RECORDS',
    item_reason: `Clinical import failure ${index} requires governed reconciliation`,
    item_created_at: createdAt,
    resource_receipt_id: entityUuid('2', index),
    source_resource_type: 'Observation',
    source_resource_id: `observation-${index}`,
    source_resource_index: index,
    resource_outcome: 'failed',
    resource_error_code: 'IMPORT_RESOURCE_FAILED',
    resource_error: `Resource ${index} failed validation`,
    document_receipt_id: entityUuid('3', index),
    source_system: 'pagination-test-source',
    source_document_id: `document-${index}`,
    document_format: 'fhir_bundle',
    source_facility_id: 7,
    latest_event_id: entityUuid('4', index),
    latest_event_type: 'OPENED',
    latest_event_actor_uid: ACTOR_UID,
    latest_event_reason: `Clinical import failure ${index} opened for reconciliation`,
    latest_event_evidence: { raw_evidence: SENSITIVE_SENTINEL },
    latest_event_evidence_sha256: 'b'.repeat(64),
    latest_event_created_at: createdAt,
    raw_payload_ciphertext: SENSITIVE_SENTINEL,
  };
}

function activePatient(patientUid, overrides = {}) {
  return {
    id: 19,
    uid: patientUid,
    merged_into_uid: null,
    role: 'PATIENT',
    is_active: true,
    status: 'active',
    is_deleted: false,
    cycle: false,
    depth: 0,
    ...overrides,
  };
}

function tupleAfter(row, createdAt, itemId) {
  if (createdAt == null) return true;
  const rowTime = new Date(row.item_created_at).getTime();
  const cursorTime = new Date(createdAt).getTime();
  return rowTime > cursorTime || (rowTime === cursorTime && row.id > itemId);
}

function transactionFor(rows, {
  resolvePatient = (patientUid) => [activePatient(patientUid)],
  concurrencyAvailable = true,
  tenantConcurrencyAvailable = true,
} = {}) {
  return {
    $executeRawUnsafe: jest.fn(async () => 0),
    $queryRawUnsafe: jest.fn(async (sql, ...parameters) => {
      const query = String(sql);
      if (query.includes('pg_try_advisory_xact_lock')) {
        return [{
          acquired: String(parameters[0]).includes(':tenant:')
            ? tenantConcurrencyAvailable
            : concurrencyAvailable,
        }];
      }
      if (query.includes('budget_probe')) return [{ ok: true }];
      if (query.includes('exact_patient_access_batch')) return [{ ok: true }];
      if (query.includes('FROM users AS actor')) return [{ uid: ACTOR_UID }];
      if (query.includes('WITH RECURSIVE patient_chain')) {
        const requested = Array.isArray(parameters[1]) ? parameters[1] : [parameters[1]];
        return requested.flatMap(patientUid => resolvePatient(patientUid).map(row => ({
          origin_uid: patientUid,
          ...row,
        })));
      }
      if (query.includes('FROM clinical_import_reconciliation_items AS item')) {
        const [, createdAt, itemId, limit] = parameters;
        return rows
          .filter((row) => tupleAfter(row, createdAt, itemId))
          .slice(0, Number(limit));
      }
      throw new Error(`Unexpected reconciliation pagination query: ${query}`);
    }),
  };
}

function listInput(authorizeAccessBatch, cursor = null, auditReturnedItems = jest.fn()) {
  return {
    tenantId: TENANT_ID,
    actorUid: ACTOR_UID,
    actorRole: 'MEDICAL_RECORDS',
    authorizeAccessBatch,
    auditReturnedItems,
    cursor,
  };
}

function authorizerFor(allowedIds) {
  return jest.fn(async ({ entries }) => entries.map(entry => ({
    decisionKey: entry.decisionKey,
    allowed: allowedIds.has(entry.decisionKey),
  })));
}

async function collectPages(authorizeAccessBatch, firstCursor = null) {
  const pages = [];
  let cursor = firstCursor;
  do {
    const page = await listClinicalImportReconciliationItems(
      listInput(authorizeAccessBatch, cursor),
    );
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor != null);
  return pages;
}

function decodeCursor(cursor) {
  const [payload] = cursor.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function cursorJson(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const payload = Buffer.from(json).toString('base64url');
  const key = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update('vhhealth:clinical-import-reconciliation-cursor:key:v1')
    .digest();
  const signature = crypto.createHmac('sha256', key)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function validCursorPayload(overrides = {}) {
  return {
    v: 1,
    tenant_id: TENANT_ID,
    created_at: '2026-01-01T00:00:01.000Z',
    item_id: entityUuid('1', 1),
    ...overrides,
  };
}

beforeEach(() => {
  transactionDb = null;
  setTenantTxMock.mockReset();
  setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(transactionDb));
});

describe('clinical import reconciliation worklist pagination', () => {
  it('returns only the latest-event evidence hash even when the row carries raw sentinels', async () => {
    const row = makeRow(1);
    transactionDb = transactionFor([row]);
    const authorizeAccess = authorizerFor(new Set([row.id]));

    const page = await listClinicalImportReconciliationItems(listInput(authorizeAccess));

    expect(row.latest_event_evidence).toEqual({ raw_evidence: SENSITIVE_SENTINEL });
    expect(row.raw_payload_ciphertext).toBe(SENSITIVE_SENTINEL);
    expect(page.items[0].latest_event.evidence_sha256).toBe(row.latest_event_evidence_sha256);
    expect(page.items[0].latest_event).not.toHaveProperty('evidence');
    expect(page.items[0]).not.toHaveProperty('raw_payload_ciphertext');
    expect(JSON.stringify(page.items[0])).not.toContain(SENSITIVE_SENTINEL);
  });

  it('continues across bounded empty pages to return a later visible item', async () => {
    const rows = Array.from({ length: 101 }, (_, offset) => makeRow(offset + 1));
    transactionDb = transactionFor(rows);
    const authorizeAccess = authorizerFor(new Set([rows[100].id]));

    const pages = await collectPages(authorizeAccess);

    expect(pages.flatMap(page => page.items).map((item) => item.id)).toEqual([rows[100].id]);
    expect(pages.slice(0, 4).every(page => page.items.length === 0)).toBe(true);
    expect(pages.at(-1).nextCursor).toBeNull();
    expect(authorizeAccess.mock.calls.flatMap(([input]) => input.entries)).toHaveLength(101);
  });

  it('paginates interleaved visible rows without gaps, duplicates, or a denied-row cursor', async () => {
    const rows = Array.from({ length: 260 }, (_, offset) => makeRow(offset + 1));
    const visibleRows = rows.filter((_row, index) => index % 2 === 0);
    const visibleIds = new Set(visibleRows.map((row) => row.id));
    transactionDb = transactionFor(rows);
    const authorizeAccess = authorizerFor(visibleIds);

    const pages = await collectPages(authorizeAccess);
    const firstCursor = decodeCursor(pages[0].nextCursor);

    expect(pages[0].items.map((item) => item.id))
      .toEqual(visibleRows.slice(0, 13).map((row) => row.id));
    expect(firstCursor).toEqual({
      v: 1,
      tenant_id: TENANT_ID,
      created_at: rows[PAGE_SIZE - 1].item_created_at,
      item_id: rows[PAGE_SIZE - 1].id,
    });
    expect(pages.at(-1).nextCursor).toBeNull();

    const combinedIds = pages.flatMap(page => page.items.map(item => item.id));
    expect(combinedIds).toEqual(visibleRows.map((row) => row.id));
    expect(new Set(combinedIds)).toHaveProperty('size', combinedIds.length);
  });

  it('stops at 25 visible rows and continues after the last evaluated source row', async () => {
    const rows = Array.from({ length: 200 }, (_, offset) => makeRow(offset + 1));
    const visibleIds = new Set(rows.slice(0, PAGE_SIZE).map((row) => row.id));
    transactionDb = transactionFor(rows);
    const authorizeAccess = jest.fn(async ({ db, entries }) => {
      expect(db).not.toBe(transactionDb);
      expect(db).toEqual(expect.objectContaining({
        $queryRawUnsafe: expect.any(Function),
        $executeRawUnsafe: expect.any(Function),
      }));
      return entries.map(entry => ({
        decisionKey: entry.decisionKey,
        allowed: visibleIds.has(entry.decisionKey),
      }));
    });

    const page = await listClinicalImportReconciliationItems(listInput(authorizeAccess));

    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(decodeCursor(page.nextCursor)).toEqual({
      v: 1,
      tenant_id: TENANT_ID,
      created_at: rows[PAGE_SIZE - 1].item_created_at,
      item_id: rows[PAGE_SIZE - 1].id,
    });
    expect(authorizeAccess).toHaveBeenCalledTimes(1);
    expect(authorizeAccess.mock.calls[0][0].entries).toHaveLength(PAGE_SIZE);
    expect(setTenantTxMock).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: 'RepeatableRead',
        timeout: 10_000,
      }),
    );
  });

  it('returns an empty page cursor after the hard row budget without rescanning denied rows', async () => {
    const rows = Array.from({ length: 260 }, (_, offset) => makeRow(offset + 1));
    transactionDb = transactionFor(rows);
    const authorizeAccess = authorizerFor(new Set());

    const firstPage = await listClinicalImportReconciliationItems(listInput(authorizeAccess));
    const firstCursor = decodeCursor(firstPage.nextCursor);
    const firstCallCount = authorizeAccess.mock.calls.flatMap(([input]) => input.entries).length;
    const remainingPages = await collectPages(authorizeAccess, firstPage.nextCursor);

    expect(firstPage.items).toEqual([]);
    expect(firstCallCount).toBe(25);
    expect(firstCursor).toEqual({
      v: 1,
      tenant_id: TENANT_ID,
      created_at: rows[24].item_created_at,
      item_id: rows[24].id,
    });
    expect(remainingPages.every(page => page.items.length === 0)).toBe(true);
    expect(remainingPages.at(-1).nextCursor).toBeNull();
    const allAuthorizedEntries = authorizeAccess.mock.calls.flatMap(([input]) => input.entries);
    expect(allAuthorizedEntries).toHaveLength(rows.length);
    const remainingPageIds = authorizeAccess.mock.calls
      .flatMap(([input]) => input.entries)
      .slice(firstCallCount)
      .map(entry => entry.decisionKey);
    expect(remainingPageIds).toEqual(rows.slice(25).map((row) => row.id));
  });

  it('rejects work that exceeds the counted total database query budget', async () => {
    const row = makeRow(1);
    transactionDb = transactionFor([row]);
    const authorizeAccess = authorizerFor(new Set([row.id]));
    const auditReturnedItems = jest.fn(async ({ db }) => {
      for (let index = 0; index < 40; index += 1) {
        await db.$executeRawUnsafe('SELECT 1');
      }
    });

    await expect(listClinicalImportReconciliationItems(
      listInput(authorizeAccess, null, auditReturnedItems),
    ))
      .rejects.toMatchObject({
        statusCode: 503,
        code: 'IMPORT_RECONCILIATION_QUERY_BUDGET_EXHAUSTED',
      });
  });

  it('keeps a full 25-row page to one source, survivor, access verification, access audit, and HIPAA audit operation', async () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, offset) => makeRow(offset + 1));
    transactionDb = transactionFor(rows);
    const authorizeAccessBatch = jest.fn(async ({ db, entries }) => {
      await db.$queryRawUnsafe('SELECT exact_patient_access_batch');
      await db.$executeRawUnsafe('INSERT INTO patient_access_audit_log SELECT batch');
      return entries.map(entry => ({ decisionKey: entry.decisionKey, allowed: true }));
    });
    const auditReturnedItems = jest.fn(async ({ db }) => {
      await db.$executeRawUnsafe('INSERT INTO hipaa_access_log SELECT batch');
    });

    const page = await listClinicalImportReconciliationItems(
      listInput(authorizeAccessBatch, null, auditReturnedItems),
    );

    expect(page.items).toHaveLength(PAGE_SIZE);
    const queryTexts = transactionDb.$queryRawUnsafe.mock.calls.map(([sql]) => String(sql));
    const executeTexts = transactionDb.$executeRawUnsafe.mock.calls.map(([sql]) => String(sql));
    expect(queryTexts.filter(sql => sql.includes('FROM clinical_import_reconciliation_items AS item'))).toHaveLength(1);
    expect(queryTexts.filter(sql => sql.includes('WITH RECURSIVE patient_chain'))).toHaveLength(1);
    expect(queryTexts.filter(sql => sql.includes('exact_patient_access_batch'))).toHaveLength(1);
    expect(executeTexts.filter(sql => sql.includes('INSERT INTO patient_access_audit_log'))).toHaveLength(1);
    expect(executeTexts.filter(sql => sql.includes('INSERT INTO hipaa_access_log'))).toHaveLength(1);
    expect(transactionDb.$queryRawUnsafe.mock.calls.length
      + transactionDb.$executeRawUnsafe.mock.calls.length).toBeLessThanOrEqual(38);
  });

  it('derives shrinking statement timeouts from the hard request deadline', async () => {
    const row = makeRow(1);
    transactionDb = transactionFor([row]);
    const nowSpy = jest.spyOn(Date, 'now');
    let now = 0;
    nowSpy.mockImplementation(() => {
      now += 1_500;
      return now;
    });
    try {
      await listClinicalImportReconciliationItems(
        listInput(authorizerFor(new Set([row.id]))),
      );
    } finally {
      nowSpy.mockRestore();
    }

    const statementTimeouts = transactionDb.$executeRawUnsafe.mock.calls
      .map(([sql]) => /statement_timeout = '(\d+)ms'/.exec(String(sql))?.[1])
      .filter(Boolean)
      .map(Number);
    expect(statementTimeouts[0]).toBe(3_000);
    expect(statementTimeouts.at(-1)).toBeLessThan(statementTimeouts[0]);
    expect(statementTimeouts.every((value, index) => index === 0
      || value <= statementTimeouts[index - 1])).toBe(true);
  });

  it('aborts the page when the awaited HIPAA batch audit fails', async () => {
    const row = makeRow(1);
    const auditFailure = new Error('HIPAA batch audit unavailable');
    transactionDb = transactionFor([row]);

    await expect(listClinicalImportReconciliationItems(listInput(
      authorizerFor(new Set([row.id])),
      null,
      jest.fn(async () => { throw auditFailure; }),
    ))).rejects.toBe(auditFailure);
  });

  it('rejects work when every database-coordinated concurrency slot is held', async () => {
    transactionDb = transactionFor([makeRow(1)], { concurrencyAvailable: false });

    await expect(listClinicalImportReconciliationItems(listInput(jest.fn())))
      .rejects.toMatchObject({
        statusCode: 429,
        code: 'IMPORT_RECONCILIATION_CONCURRENCY_EXHAUSTED',
      });
    expect(transactionDb.$queryRawUnsafe).toHaveBeenCalledTimes(5);
  });

  it('rejects a second scan for the same tenant before consuming a fleet slot', async () => {
    transactionDb = transactionFor([makeRow(1)], { tenantConcurrencyAvailable: false });

    await expect(listClinicalImportReconciliationItems(listInput(jest.fn())))
      .rejects.toMatchObject({
        statusCode: 429,
        code: 'IMPORT_RECONCILIATION_TENANT_CONCURRENCY_EXHAUSTED',
      });
    expect(transactionDb.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('admits four fleet-wide scans and rejects the N+1 concurrent scan', async () => {
    const heldSlots = new Set();
    let releaseScans;
    const scanBarrier = new Promise(resolve => { releaseScans = resolve; });
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => {
      let ownedSlot = null;
      const db = {
        $executeRawUnsafe: jest.fn(async () => 0),
        $queryRawUnsafe: jest.fn(async (sql, ...parameters) => {
          const query = String(sql);
          if (query.includes('pg_try_advisory_xact_lock')
            && parameters[0] === 'vh:clinical-import-reconciliation-worklist') {
            const slot = Number(parameters[1]);
            if (heldSlots.has(slot)) return [{ acquired: false }];
            heldSlots.add(slot);
            ownedSlot = slot;
            return [{ acquired: true }];
          }
          if (query.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
          if (query.includes('FROM users AS actor')) return [{ uid: ACTOR_UID }];
          if (query.includes('FROM clinical_import_reconciliation_items AS item')) {
            await scanBarrier;
            return [];
          }
          throw new Error(`Unexpected concurrent worklist query: ${query}`);
        }),
      };
      try {
        return await callback(db);
      } finally {
        if (ownedSlot != null) heldSlots.delete(ownedSlot);
      }
    });

    const calls = Array.from({ length: 5 }, () => (
      listClinicalImportReconciliationItems(listInput(jest.fn()))
    ));
    await expect(calls[4]).rejects.toMatchObject({
      statusCode: 429,
      code: 'IMPORT_RECONCILIATION_CONCURRENCY_EXHAUSTED',
    });
    expect(heldSlots.size).toBe(4);
    releaseScans();
    await expect(Promise.all(calls.slice(0, 4))).resolves.toHaveLength(4);
    expect(heldSlots.size).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['padded base64url', `${cursorJson(validCursorPayload())}=`],
    ['non-base64url alphabet', 'not+base64/url'],
    [
      'noncanonical JSON key order',
      cursorJson(`{"tenant_id":"${TENANT_ID}","v":1,"item_id":"${entityUuid('1', 1)}","created_at":"2026-01-01T00:00:01.000Z"}`),
    ],
    ['extra JSON key', cursorJson(validCursorPayload({ extra: true }))],
    ['invalid timestamp', cursorJson(validCursorPayload({ created_at: 'not-a-timestamp' }))],
    [
      'noncanonical timestamp',
      cursorJson(validCursorPayload({ created_at: '2026-01-01T00:00:01Z' })),
    ],
    ['invalid UUID', cursorJson(validCursorPayload({ item_id: 'not-a-uuid' }))],
  ])('rejects a %s cursor before opening a tenant transaction', async (_label, cursor) => {
    const authorizeAccess = jest.fn();

    await expect(listClinicalImportReconciliationItems(
      listInput(authorizeAccess, cursor),
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'IMPORT_RECONCILIATION_CURSOR_INVALID',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(authorizeAccess).not.toHaveBeenCalled();
  });

  it('rejects modified and foreign-tenant signed cursors before opening a transaction', async () => {
    const valid = cursorJson(validCursorPayload());
    const [payload, signature] = valid.split('.');
    const modifiedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    const foreignTenantCursor = cursorJson(validCursorPayload({
      tenant_id: '00000000-0000-4000-8000-000000000002',
    }));

    for (const cursor of [`${modifiedPayload}.${signature}`, foreignTenantCursor]) {
      await expect(listClinicalImportReconciliationItems(
        listInput(jest.fn(), cursor),
      )).rejects.toMatchObject({
        statusCode: 400,
        code: 'IMPORT_RECONCILIATION_CURSOR_INVALID',
      });
    }
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it.each([
    ['patient not found', () => []],
    [
      'invalid patient custody',
      (patientUid) => [activePatient(patientUid, { is_active: false, status: 'inactive' })],
    ],
  ])('skips a row with %s and returns a later authorized row', async (_label, unlistableResult) => {
    const rows = [makeRow(1), makeRow(2)];
    rows[0].patient_uid = UNLISTABLE_PATIENT_UID;
    transactionDb = transactionFor(rows, {
      resolvePatient: (patientUid) => (
        patientUid === UNLISTABLE_PATIENT_UID
          ? unlistableResult(patientUid)
          : [activePatient(patientUid)]
      ),
    });
    const authorizeAccess = authorizerFor(new Set([rows[1].id]));

    const page = await listClinicalImportReconciliationItems(listInput(authorizeAccess));

    expect(page.items.map((item) => item.id)).toEqual([rows[1].id]);
    expect(authorizeAccess).toHaveBeenCalledTimes(1);
    expect(authorizeAccess.mock.calls[0][0].entries).toEqual([
      expect.objectContaining({ decisionKey: rows[1].id }),
    ]);
  });

  it.each([
    ['database error', () => new Error('patient lookup database unavailable')],
    [
      'unrelated AppError',
      () => AppError.internal('Unrelated patient lookup failure', 'UNRELATED_PATIENT_LOOKUP_FAILURE'),
    ],
  ])('rethrows an unrelated %s from patient resolution', async (_label, createError) => {
    const error = createError();
    const row = makeRow(1);
    transactionDb = transactionFor([row], {
      resolvePatient: () => {
        throw error;
      },
    });
    const authorizeAccess = authorizerFor(new Set([row.id]));

    await expect(listClinicalImportReconciliationItems(listInput(authorizeAccess)))
      .rejects.toBe(error);
    expect(authorizeAccess).not.toHaveBeenCalled();
  });
});
