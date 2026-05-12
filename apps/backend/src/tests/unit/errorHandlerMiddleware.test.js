// src/tests/unit/errorHandlerMiddleware.test.js

import { jest } from '@jest/globals';

const mockCaptureException = jest.fn();
const mockGetErrorSource = jest.fn(() => null);

jest.unstable_mockModule('@sentry/node', () => ({
  captureException: mockCaptureException,
}));

jest.unstable_mockModule('source-map-support', () => ({
  default: { getErrorSource: mockGetErrorSource },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_EXPOSE_DEV_STACK = process.env.EXPOSE_DEV_STACK;

function makeResponse() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('errorHandlerMiddleware', () => {
  let errorHandlerMiddleware;

  beforeEach(async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.EXPOSE_DEV_STACK;
    jest.resetModules();
    mockCaptureException.mockClear();
    mockGetErrorSource.mockClear();
    ({ errorHandlerMiddleware } = await import('../../middleware/errorHandlerMiddleware.js'));
  });

  afterAll(() => {
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
    if (ORIGINAL_EXPOSE_DEV_STACK === undefined) {
      delete process.env.EXPOSE_DEV_STACK;
    } else {
      process.env.EXPOSE_DEV_STACK = ORIGINAL_EXPOSE_DEV_STACK;
    }
  });

  it('scrubs Prisma validation errors and omits stack traces from client responses', () => {
    const err = new Error([
      'Invalid `prisma.vitals_chart.create()` invocation:',
      'PrismaClientValidationError: Unknown argument `encounter_id`.',
    ].join('\n'));
    err.stack = 'D:\\Dev\\Projects\\VH Health\\VH-Health-Platform\\apps\\backend\\node_modules\\@prisma\\client\\src\\runtime\\core\\errorRendering\\throwValidationException.ts:45';

    const req = {
      originalUrl: '/api/v1/emr/vitals',
      method: 'POST',
      ip: '127.0.0.1',
      id: 'req-123',
    };
    const res = makeResponse();

    errorHandlerMiddleware(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({
      success: false,
      message: 'An internal server error occurred. Please try again later.',
      requestId: 'req-123',
    });
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('PrismaClient');
    expect(JSON.stringify(body)).not.toContain('D:\\Dev');
  });
});
