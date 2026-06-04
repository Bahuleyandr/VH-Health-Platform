import { jest } from '@jest/globals';

const decisionServiceMock = {
  authorizeStaffAccessRequest: jest.fn(),
  shouldSkipStaffAccessCheckError: jest.fn(() => false),
  staffAccessErrorPayload: jest.fn((decision) => ({
    success: false,
    code: 'STAFF_ACCESS_DENIED',
    message: decision.safe_denial_message || 'denied',
  })),
};

jest.unstable_mockModule('../../services/security/staffAccessDecisionService.js', () => ({
  ...decisionServiceMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { staffAccessGuard } = await import('../../middleware/staffAccessMiddleware.js');

function resStub() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

afterEach(() => {
  decisionServiceMock.authorizeStaffAccessRequest.mockReset();
  decisionServiceMock.shouldSkipStaffAccessCheckError.mockReset();
  decisionServiceMock.shouldSkipStaffAccessCheckError.mockReturnValue(false);
  decisionServiceMock.staffAccessErrorPayload.mockClear();
});

describe('staffAccessGuard', () => {
  it('passes through allowed staff access decisions', async () => {
    decisionServiceMock.authorizeStaffAccessRequest.mockResolvedValueOnce({ allowed: true });
    const next = jest.fn();
    const res = resStub();

    await staffAccessGuard('staff.profile.view', { targetParam: 'staff_id' })({
      params: { staff_id: '42' },
      user: { role: 'HR_STAFF' },
    }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(decisionServiceMock.authorizeStaffAccessRequest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        policyCode: 'staff.profile.view',
        targetParam: 'staff_id',
      }),
    );
  });

  it('returns a safe 403 payload for denied staff access decisions', async () => {
    decisionServiceMock.authorizeStaffAccessRequest.mockResolvedValueOnce({
      allowed: false,
      safe_denial_message: 'Staff record access denied',
    });
    const next = jest.fn();
    const res = resStub();

    await staffAccessGuard('staff.profile.view')({ user: { role: 'OP_INCHARGE' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'STAFF_ACCESS_DENIED',
    }));
  });

  it('skips the guard when governance tables are not migrated yet', async () => {
    const error = new Error('relation "staff_access_audit_log" does not exist');
    decisionServiceMock.authorizeStaffAccessRequest.mockRejectedValueOnce(error);
    decisionServiceMock.shouldSkipStaffAccessCheckError.mockReturnValueOnce(true);
    const next = jest.fn();
    const res = resStub();

    await staffAccessGuard('staff.profile.view')({ originalUrl: '/api/v1/staff/1' }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
