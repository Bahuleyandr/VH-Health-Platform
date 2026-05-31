import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

const logPhiAccessMock = jest.fn();

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: logPhiAccessMock,
}));

const {
  phiAccessLoggerForPaths,
  shouldLogPhiAccessPath,
} = await import('../../middleware/conditionalPhiAccessMiddleware.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';

function makeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

function makeReq(path) {
  return {
    method: 'GET',
    originalUrl: path,
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    id: 'req-command-board-phi',
    tenantId: TENANT,
    user: {
      uid: ACTOR,
      role: 'DOCTOR',
      tenant_id: TENANT,
      deviceType: 'desktop',
    },
  };
}

beforeEach(() => {
  logPhiAccessMock.mockReset();
});

describe('conditional PHI access middleware', () => {
  it('matches exact paths, child paths, regexes, and ignores query strings', () => {
    expect(shouldLogPhiAccessPath(
      '/api/v1/emr/command-board?limit=20',
      ['/api/v1/emr/command-board'],
    )).toBe(true);
    expect(shouldLogPhiAccessPath(
      '/api/v1/emr/admissions/123/case-sheet',
      ['/api/v1/emr/admissions'],
    )).toBe(true);
    expect(shouldLogPhiAccessPath(
      '/api/v1/emr/55/case-sheet',
      [/^\/api\/v1\/emr\/\d+\//],
    )).toBe(true);
    expect(shouldLogPhiAccessPath(
      '/api/v1/emr/command-center',
      ['/api/v1/emr/command-board'],
    )).toBe(false);
  });

  it('logs the documented EMR command-board PHI read path', () => {
    const req = makeReq('/api/v1/emr/command-board?limit=20');
    const res = makeRes(200);
    const next = jest.fn();

    phiAccessLoggerForPaths('ADMISSION', ['/api/v1/emr/command-board'])(
      req,
      res,
      next,
    );
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: ACTOR,
      userRole: 'DOCTOR',
      patientId: null,
      recordType: 'ADMISSION',
      action: 'VIEW',
      requestId: 'req-command-board-phi',
      deviceType: 'desktop',
      tenantId: TENANT,
    }));
  });

  it('does not attach PHI logging for unmatched EMR paths', () => {
    const req = makeReq('/api/v1/emr/clinical-ai/config');
    const res = makeRes(200);
    const next = jest.fn();

    phiAccessLoggerForPaths('ADMISSION', ['/api/v1/emr/command-board'])(
      req,
      res,
      next,
    );
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).not.toHaveBeenCalled();
  });
});
