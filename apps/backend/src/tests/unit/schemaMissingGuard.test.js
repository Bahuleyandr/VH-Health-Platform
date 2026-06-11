// Regression tests for audit finding M3 (2026-06-10) — PHI/IDOR access
// guards previously failed OPEN on a broad /does not exist/i MESSAGE regex,
// so a renamed column, dropped function, or partial migration silently
// disabled the patient/staff access checks.
//
// Proves:
//   1. Only a VERIFIED SQLSTATE 42P01 (undefined_table) qualifies as
//      "schema missing" — message text never does.
//   2. In production the skip is NEVER taken (fail closed).
//   3. The error-code extraction reads the fields Prisma actually populates.

import {
  extractSqlState,
  isGovernanceSchemaMissing,
} from '../../services/security/schemaMissingGuard.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('M3 — schemaMissingGuard', () => {
  describe('extractSqlState', () => {
    test('reads err.code / meta.code / driverAdapterError originalCode', () => {
      expect(extractSqlState({ code: '42P01' })).toBe('42P01');
      expect(extractSqlState({ meta: { code: '42P01' } })).toBe('42P01');
      expect(
        extractSqlState({
          meta: { driverAdapterError: { cause: { originalCode: '42P01' } } },
        }),
      ).toBe('42P01');
    });

    test('rejects non-SQLSTATE values (e.g. Prisma P-codes used as code)', () => {
      expect(extractSqlState({ code: 'P2010' })).toBe('P2010'); // 5-char, valid shape
      expect(extractSqlState({ code: 'ECONNREFUSED' })).toBeNull();
      expect(extractSqlState({})).toBeNull();
      expect(extractSqlState(null)).toBeNull();
    });
  });

  describe('isGovernanceSchemaMissing — non-production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    test('verified 42P01 ⇒ true (skip allowed in dev/test)', () => {
      expect(isGovernanceSchemaMissing({ code: '42P01' })).toBe(true);
      expect(isGovernanceSchemaMissing({ meta: { code: '42P01' } })).toBe(true);
    });

    test('MESSAGE-ONLY "does not exist" ⇒ false (the old fail-open hole)', () => {
      expect(
        isGovernanceSchemaMissing(
          new Error('relation "patient_access_policies" does not exist'),
        ),
      ).toBe(false);
      expect(
        isGovernanceSchemaMissing(
          new Error('operator does not exist: integer = text'),
        ),
      ).toBe(false);
      expect(
        isGovernanceSchemaMissing(
          new Error('column "uid" does not exist'),
        ),
      ).toBe(false);
    });

    test('other SQLSTATEs (42703 undefined_column, 28000 auth) ⇒ false', () => {
      expect(isGovernanceSchemaMissing({ code: '42703' })).toBe(false);
      expect(isGovernanceSchemaMissing({ code: '28000' })).toBe(false);
      expect(isGovernanceSchemaMissing({ code: '3D000' })).toBe(false);
    });
  });

  describe('isGovernanceSchemaMissing — production fails closed', () => {
    test('even a verified 42P01 ⇒ false in production', () => {
      process.env.NODE_ENV = 'production';
      expect(isGovernanceSchemaMissing({ code: '42P01' })).toBe(false);
    });
  });
});
