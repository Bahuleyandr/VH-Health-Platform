// Item 3 (auth-hygiene audit §5): the local-storage stream route previously
// returned `res.status(400).json({ message: e.message })`, leaking the raw
// resolver error verbatim and bypassing the central scrubbing in the error()
// helper. It must now log server-side and return a generic message.
//
// We mock r2Storage so the route believes local storage is active, the token
// is valid, and resolveLocalKey throws a leaky internal error.
import { jest } from '@jest/globals';

const LEAKY_MESSAGE = 'ENOENT: D:\\Dev\\Projects\\secret\\path traversal blocked for key';

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  isLocalStorage: true,
  verifyLocalToken: () => true,
  resolveLocalKey: () => {
    throw new Error(LEAKY_MESSAGE);
  },
}));

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const storageRouter = (await import('../../routes/storage/storageRoutes.js')).default;

function buildApp() {
  const app = express();
  // requestId shim so responseHelper can read res.req.id without the full chain.
  app.use((req, _res, next) => { req.id = 'test-req'; next(); });
  app.use('/api/v1/storage', storageRouter);
  return app;
}

describe('storage route error leak (Item 3)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does NOT leak the raw resolver error and returns a generic message', async () => {
    const res = await request(buildApp())
      .get('/api/v1/storage/file/some/key?token=anything');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // The verbose internal message must not reach the client.
    expect(JSON.stringify(res.body)).not.toContain('D:\\Dev');
    expect(JSON.stringify(res.body)).not.toContain('traversal');
    expect(res.body.message).toBe('Invalid storage key');
    // But it MUST still be logged server-side (logging not suppressed).
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('resolveLocalKey failed')
    );
  });
});
