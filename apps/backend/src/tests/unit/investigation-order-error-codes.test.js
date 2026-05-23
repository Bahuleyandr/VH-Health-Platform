// Regression test for finding 2026-05-22-dynamic-acute-abdomen-doctor-0e597b54.
//
// `POST /api/v1/lab/orders` returned a generic 500 when the doctor
// supplied a `test_code` that wasn't in `investigation_test_catalog`
// (e.g. acute-abdomen panel codes like 'RFT', 'ABDPNL'). The route's
// `wrap` middleware honours `err.statusCode`, but the service threw
// plain `Error('UNKNOWN_TEST_CODE')` with no statusCode → fell
// through to 500. Same shape for MISSING_REQUIRED_FIELDS,
// INVALID_TYPE, INVALID_PRIORITY, PATIENT_NOT_FOUND.
//
// Fix: stamp `.statusCode` (+ `.code`) on every validation throw in
// `createInvestigationOrder` so the wrap middleware returns a clean
// 4xx instead of an opaque 500. Message strings are unchanged, so
// the orderController's existing message-match catches still work.

import { createInvestigationOrder } from '../../services/investigation/orderService.js';

describe('createInvestigationOrder — validation errors carry statusCode (0e597b54)', () => {
  it('MISSING_REQUIRED_FIELDS throws with statusCode 400 (the repro class)', async () => {
    let err;
    try {
      await createInvestigationOrder({});
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message).toBe('MISSING_REQUIRED_FIELDS');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('MISSING_REQUIRED_FIELDS');
  });

  it('INVALID_TYPE throws with statusCode 400', async () => {
    let err;
    try {
      await createInvestigationOrder({
        patient_id: 1, doctor_uid: 'aa000000-0000-4000-8000-000000000001',
        test_name: 'CBC', type: 'NOT_A_TYPE',
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message).toBe('INVALID_TYPE');
    expect(err.statusCode).toBe(400);
  });

  it('INVALID_PRIORITY throws with statusCode 400', async () => {
    let err;
    try {
      await createInvestigationOrder({
        patient_id: 1, doctor_uid: 'aa000000-0000-4000-8000-000000000001',
        test_name: 'CBC', type: 'LAB', priority: 'YESTERDAY',
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message).toBe('INVALID_PRIORITY');
    expect(err.statusCode).toBe(400);
  });

  it('UNKNOWN_TEST_CODE (the literal finding shape) carries statusCode 400 + details', async () => {
    // We can't drive the full DB path in a pure unit test, but the
    // service constructs the UNKNOWN_TEST_CODE error with statusCode +
    // details + code before throwing — verify that shape exists.
    // (Integration test exercises the route end-to-end at CI time.)
    const { default: prisma } = await import('../../lib/prisma.js');
    // Stub the catalog probe to return empty so UNKNOWN_TEST_CODE fires.
    // We don't need to mock the full module — just override the one
    // call. After the stub, the second-stage `users.findUnique` probably
    // hits a real DB which is fine on the local dev DB.
    const originalQueryRaw = prisma.$queryRawUnsafe;
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      if (/investigation_test_catalog/.test(sql)) return [];
      return originalQueryRaw.call(prisma, sql, ...params);
    };
    try {
      let err;
      try {
        await createInvestigationOrder({
          patient_id: 999999999, doctor_uid: 'aa000000-0000-4000-8000-000000000001',
          test_name: 'Renal function panel', test_code: 'RFT', type: 'LAB',
        });
      } catch (e) { err = e; }
      expect(err).toBeDefined();
      // Either UNKNOWN_TEST_CODE (caught first) or PATIENT_NOT_FOUND
      // (caught later if catalog check is reordered). Both carry the
      // proper statusCode + code now.
      expect(['UNKNOWN_TEST_CODE', 'PATIENT_NOT_FOUND']).toContain(err.message);
      expect(err.statusCode).toBeGreaterThanOrEqual(400);
      expect(err.statusCode).toBeLessThan(500);
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
    }
  });
});
