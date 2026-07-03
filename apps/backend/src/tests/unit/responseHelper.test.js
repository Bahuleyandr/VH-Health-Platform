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
      'operator does not exist: uuid = text',
      'operator does not exist: uuid = text[]',
      'No operator matches the given name and argument types',
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

  describe('non-production leak scrubbing', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'development';
      jest.resetModules();
      ({ sanitizeErrorMessage } = await import('../../utils/responseHelper.js'));
    });

    it('scrubs schema leaks in dev responses', () => {
      const out = sanitizeErrorMessage('relation "diet_orders" does not exist', 400);
      expect(out).toBe('Request could not be processed.');
    });

    it('scrubs Prisma validation stacks with Windows paths in dev responses', () => {
      const msg = [
        'Invalid `prisma.vitals_chart.create()` invocation:',
        'PrismaClientValidationError: Unknown argument `encounter_id`.',
        '    at D:\\Dev\\Projects\\VH Health\\VH-Health-Platform\\apps\\backend\\node_modules\\@prisma\\client\\src\\runtime\\core\\errorRendering\\throwValidationException.ts:45:9',
      ].join('\n');

      const out = sanitizeErrorMessage(msg, 500);

      expect(out).toBe('An internal server error occurred. Please try again later.');
      expect(out).not.toContain('PrismaClient');
      expect(out).not.toContain('D:\\Dev');
    });

    it('still preserves benign dev validation messages', () => {
      const out = sanitizeErrorMessage('patient_uid is required', 400);
      expect(out).toBe('patient_uid is required');
    });
  });
});

describe('responseHelper.error', () => {
  let error;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    jest.resetModules();
    ({ error } = await import('../../utils/responseHelper.js'));
  });

  afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  function makeRes() {
    const res = {
      req: { originalUrl: '/unit/error' },
      statusCode: null,
      body: null,
      status: jest.fn((statusCode) => {
        res.statusCode = statusCode;
        return res;
      }),
      json: jest.fn((payload) => {
        res.body = payload;
        return res;
      }),
    };
    return res;
  }

  it('can preserve additive top-level fields while emitting the standard error envelope', () => {
    const res = makeRes();

    error(res, 'Validation failed', 400, {
      topLevel: {
        errors: [{ msg: 'Phone is required', path: 'phone' }],
        code: 'VALIDATION_FAILED',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      message: 'Validation failed',
      errors: [{ msg: 'Phone is required', path: 'phone' }],
      code: 'VALIDATION_FAILED',
    });
  });
});
