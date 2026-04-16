// src/tests/unit/sentryScopeMiddleware.test.js
//
// Unit tests for the per-request Sentry scope enrichment middleware. Pins
// the behaviour so error reports always carry requestId + route + user
// context without the error handler having to enrich manually.

import { jest } from '@jest/globals';

// Mock @sentry/node BEFORE importing the middleware.
const mockScope = {
  setTag: jest.fn(),
  setUser: jest.fn(),
};
jest.unstable_mockModule('@sentry/node', () => ({
  getCurrentScope: () => mockScope,
}));

const { sentryScopeMiddleware } = await import('../../middleware/sentryScopeMiddleware.js');

function makeReq(overrides = {}) {
  return {
    id: 'req-123',
    method: 'GET',
    originalUrl: '/api/v1/appointments/list?page=1',
    apiClient: 'patient',
    ...overrides,
  };
}

function makeRes() {
  const handlers = {};
  return {
    on: (ev, cb) => { handlers[ev] = cb; },
    _trigger: (ev) => handlers[ev] && handlers[ev](),
  };
}

describe('sentryScopeMiddleware', () => {
  beforeEach(() => {
    mockScope.setTag.mockClear();
    mockScope.setUser.mockClear();
  });

  test('sets requestId, method, route (without query), apiClient tags', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    sentryScopeMiddleware(req, res, next);

    expect(mockScope.setTag).toHaveBeenCalledWith('requestId', 'req-123');
    expect(mockScope.setTag).toHaveBeenCalledWith('method', 'GET');
    expect(mockScope.setTag).toHaveBeenCalledWith('route', '/api/v1/appointments/list');
    expect(mockScope.setTag).toHaveBeenCalledWith('apiClient', 'patient');
    expect(next).toHaveBeenCalled();
  });

  test('passes null for missing req.id / req.apiClient', () => {
    const req = makeReq({ id: undefined, apiClient: undefined });
    const res = makeRes();
    sentryScopeMiddleware(req, res, () => {});
    expect(mockScope.setTag).toHaveBeenCalledWith('requestId', null);
    expect(mockScope.setTag).toHaveBeenCalledWith('apiClient', null);
  });

  test('attaches user on response finish when req.user present', () => {
    const req = makeReq();
    req.user = { id: 42, role: 'DOCTOR' };
    const res = makeRes();
    sentryScopeMiddleware(req, res, () => {});

    expect(mockScope.setUser).not.toHaveBeenCalled();
    res._trigger('finish');
    expect(mockScope.setUser).toHaveBeenCalledWith({ id: 42, role: 'DOCTOR' });
  });

  test('prefers req.user.id over req.user.uid but falls back to uid', () => {
    const req = makeReq();
    req.user = { uid: 'uuid-abc', role: 'PATIENT' };
    const res = makeRes();
    sentryScopeMiddleware(req, res, () => {});
    res._trigger('finish');
    expect(mockScope.setUser).toHaveBeenCalledWith({ id: 'uuid-abc', role: 'PATIENT' });
  });

  test('does not set user when req.user missing', () => {
    const req = makeReq();
    const res = makeRes();
    sentryScopeMiddleware(req, res, () => {});
    res._trigger('finish');
    expect(mockScope.setUser).not.toHaveBeenCalled();
  });

  test('strips query string from route tag', () => {
    const req = makeReq({ originalUrl: '/api/v1/foo?a=1&b=2' });
    const res = makeRes();
    sentryScopeMiddleware(req, res, () => {});
    expect(mockScope.setTag).toHaveBeenCalledWith('route', '/api/v1/foo');
  });
});
