// MEDIUM (audit 2026-06-18 §4 follow-up) — canonicalOperationalBridgeService
// safeCanonical swallow scope.
//
// Defect: safeCanonical(label, task) wrapped every operational-bridge emitter in
// a try/catch that swallowed ALL errors (logger.warn + return null). The inner
// canonicalClinicalPlatformService writers were already narrowed to swallow only
// SQLSTATE 42P01 for a canonical table and re-throw everything else (42703 column
// drift, transient/generic faults) — but the bridge's safeCanonical re-swallowed
// those propagated faults, defeating the narrowing for every emitter and silently
// degrading the atomic-timeline invariant (a source detail row with no
// timeline+audit row).
//
// Fix proven here:
//   - 42P01 for a canonical table  → still swallowed (canonical layer not migrated).
//   - any other error              → NOT swallowed:
//       * propagate:true  (emitter ran INSIDE the caller's tx)  → re-throw (abort tx).
//       * propagate:false (post-commit best-effort emitter)     → logger.error + null,
//                                                                  no re-throw.
// The propagate flag is derived per emitter from whether a transaction handle
// (`db`) was passed — the SAME emitter (emitPharmacyOrderEvent) is called both
// in-tx (orderService:169, db:tx) and post-commit (pharmacyService:41, no db).
//
// Pure unit test: a hand-rolled fake `db` client whose $queryRawUnsafe throws a
// chosen Prisma-shaped error. No real DB needed.

import { jest } from '@jest/globals';
import logger from '../../logging/logger.js';

const {
  safeCanonical,
  emitFinalDischargeCompleted,
  emitDischargeWorkflowOpened,
} = await import('../../services/clinical/canonicalOperationalBridgeService.js');

const PATIENT_UID = '00000000-0000-4000-8000-0000000000aa';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

// Fake transaction-shaped client (has $queryRawUnsafe) that throws a Prisma-style
// error carrying the given SQLSTATE on EVERY query. Passing this as `db` makes the
// emitter believe it is running inside a transaction (db != null ⇒ atomic).
function throwingDb(code, message) {
  const err = new Error(message || `error ${code}`);
  err.code = code; // Prisma surfaces driver SQLSTATE on .code for $queryRawUnsafe
  return { $queryRawUnsafe: jest.fn(async () => { throw err; }) };
}

// A bare Prisma-shaped error object (not a db) for direct safeCanonical() tests.
function sqlError(code, message) {
  const err = new Error(message || `error ${code}`);
  err.code = code;
  return err;
}

const admission = {
  id: 7,
  tenant_id: TENANT_ID,
  patient_uid: PATIENT_UID,
  encounter_id: null,
  status: 'discharged',
};

beforeEach(() => {
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('canonical operational bridge — safeCanonical narrowing (audit §4 follow-up)', () => {
  describe('safeCanonical() swallow policy', () => {
    test('42P01 for a canonical table is SWALLOWED regardless of propagate (null + warn, no error)', async () => {
      const task = async () => { throw sqlError('42P01', 'relation "clinical_timeline_events" does not exist'); };
      await expect(safeCanonical('x', task, { propagate: true })).resolves.toBeNull();
      await expect(safeCanonical('x', task, { propagate: false })).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    test('42703 (column drift) with propagate:true RE-THROWS (aborts the caller tx)', async () => {
      const task = async () => { throw sqlError('42703', 'column "occurred_at" does not exist'); };
      await expect(safeCanonical('x', task, { propagate: true })).rejects.toThrow(/column .* does not exist/i);
    });

    test('42703 (column drift) with propagate:false is LOUD but does NOT throw (post-commit)', async () => {
      const task = async () => { throw sqlError('42703', 'column "occurred_at" does not exist'); };
      await expect(safeCanonical('x', task, { propagate: false })).resolves.toBeNull();
      expect(logger.error).toHaveBeenCalled();   // alarm channel — not a silent warn
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('a generic write fault (XX000) is not treated as schema-missing', async () => {
      const task = async () => { throw sqlError('XX000', 'internal error during insert'); };
      await expect(safeCanonical('x', task, { propagate: true })).rejects.toThrow(/internal error/i);
      await expect(safeCanonical('x', task, { propagate: false })).resolves.toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    test('42P01 for a NON-canonical relation is NOT swallowed (defensive — only our tables)', async () => {
      const task = async () => { throw sqlError('42P01', 'relation "some_other_table" does not exist'); };
      await expect(safeCanonical('x', task, { propagate: true })).rejects.toThrow(/some_other_table/i);
    });

    test('default options (no propagate) behave as post-commit best-effort', async () => {
      const task = async () => { throw sqlError('42703', 'column "x" does not exist'); };
      await expect(safeCanonical('x', task)).resolves.toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('in-tx emitters (db handle present ⇒ atomic) re-throw a genuine fault', () => {
    test('emitFinalDischargeCompleted: 42703 propagates so the tx aborts', async () => {
      const db = throwingDb('42703', 'column "tags" does not exist');
      await expect(emitFinalDischargeCompleted({ db, admission })).rejects.toThrow(/column .* does not exist/i);
    });

    test('emitFinalDischargeCompleted: missing canonical table aborts a transactional patient write', async () => {
      const db = throwingDb('42P01', 'relation "clinical_timeline_events" does not exist');
      await expect(emitFinalDischargeCompleted({ db, admission }))
        .rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    });

    test('emitDischargeWorkflowOpened: 42703 propagates so the tx aborts', async () => {
      const db = throwingDb('42703', 'column "occurred_at" does not exist');
      await expect(emitDischargeWorkflowOpened({ db, admission, consults: [] }))
        .rejects.toThrow(/column .* does not exist/i);
    });

    test('emitDischargeWorkflowOpened: a generic fault (XX000) propagates', async () => {
      const db = throwingDb('XX000', 'internal error during insert');
      await expect(emitDischargeWorkflowOpened({ db, admission, consults: [] }))
        .rejects.toThrow(/internal error/i);
    });
  });
});
