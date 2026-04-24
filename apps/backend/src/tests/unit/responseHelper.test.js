// src/tests/unit/responseHelper.test.js
// Unit tests for response sanitizer — guards against schema-name leaks that
// would otherwise bubble raw Postgres / Prisma error strings to end users
// (HIPAA concern).

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('responseHelper.sanitizeErrorMessage', () => {
  let sanitizeErrorMessage;
  let LEAK_PATTERNS;

  beforeEach(async () => {
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    ({ sanitizeErrorMessage, LEAK_PATTERNS } = await import('../../utils/responseHelper.js'));
  });

  afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  describe('Postgres schema leaks (4xx — opt-in scrub)', () => {
    const leakyMessages = [
      'relation "diet_orders" does not exist',
      'column "ordered_date" does not exist',
      'table "referrals" already exists',
      'duplicate key value violates unique constraint "users_uid_key"',
      'insert or update on table "staff" violates foreign key constraint "staff_dept_fk"',
      'null value in column "encrypted_password" violates not-null constraint',
      'Invalid `prisma.$queryRawUnsafe()` invocation',
      'constraint "tenant_region_check" does not exist',
    ];

    it.each(leakyMessages)('scrubs: %s', (msg) => {
      const out = sanitizeErrorMessage(msg, 400);
      expect(out).toBe('Request could not be processed.');
      expect(out).not.toContain('"');
    });

    it('scrubs all patterns via LEAK_PATTERNS regex array', () => {
      for (const msg of leakyMessages) {
        const matched = LEAK_PATTERNS.some((re) => re.test(msg));
        expect(matched).toBe(true);
      }
    });
  });

  describe('5xx always scrubbed unless safe', () => {
    it('returns generic 5xx even if message is benign', () => {
      const out = sanitizeErrorMessage('User not found', 500);
      expect(out).toBe('An internal server error occurred. Please try again later.');
    });

    it('preserves safe 5xx messages', () => {
      const out = sanitizeErrorMessage('Upstream unavailable', 503, { safe: true });
      expect(out).toBe('Upstream unavailable');
    });

    it('scrubs safe 5xx if message itself looks leaky', () => {
      const out = sanitizeErrorMessage('relation "foo" does not exist', 500, { safe: true });
      expect(out).toBe('An internal server error occurred. Please try again later.');
    });
  });

  describe('benign 4xx messages pass through', () => {
    it('preserves plain-English errors', () => {
      const out = sanitizeErrorMessage('Invalid email address', 400);
      expect(out).toBe('Invalid email address');
    });

    it('preserves AppError-style validation messages', () => {
      const out = sanitizeErrorMessage('Patient uid is required', 400);
      expect(out).toBe('Patient uid is required');
    });
  });

  describe('non-production skips scrubbing', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'development';
      jest.resetModules();
      ({ sanitizeErrorMessage } = await import('../../utils/responseHelper.js'));
    });

    it('returns raw message in dev for easier debugging', () => {
      const out = sanitizeErrorMessage('relation "diet_orders" does not exist', 400);
      expect(out).toContain('diet_orders');
    });
  });
});
