import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const tenantTxClient = {
  $queryRawUnsafe: queryRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: tenantTxClient,
  setTenantTx: async (_tenantId, fn) => fn(tenantTxClient),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('tenant required');
    return tenantId;
  },
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({}));

const { recordBodyRelease } = await import(
  '../../services/clinical/deathCertificationService.js'
);

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const RELEASE_INPUT = {
  tenantId: TENANT_ID,
  id: 7,
  body_released_to_name: 'Relative',
  body_released_to_relation: 'sibling',
  body_release_witnessed_by: ACTOR_UID,
  body_release_method: 'family',
};

beforeEach(() => {
  queryRawMock.mockReset();
});

describe('legacy body-release custody guard', () => {
  it('rejects before changing the death record when a custody obligation exists', async () => {
    queryRawMock
      .mockResolvedValueOnce([{
        id: 7,
        patient_uid: ACTOR_UID,
        is_medicolegal: false,
        police_clearance_at: null,
        body_released_at: null,
      }])
      .mockResolvedValueOnce([{
        has_custody: true,
        has_unclaimed_task: true,
        has_unclaimed_sla: true,
      }]);

    await expect(recordBodyRelease(RELEASE_INPUT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MORTUARY_CUSTODY_RELEASE_REQUIRED',
    });

    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(queryRawMock.mock.calls.some(([sql]) => /UPDATE death_records/.test(sql))).toBe(false);
  });

  it('preserves the legacy release behavior when no custody rail exists', async () => {
    const released = {
      id: 7,
      body_released_at: '2026-07-19T12:00:00.000Z',
      body_released_to_name: 'Relative',
    };
    queryRawMock
      .mockResolvedValueOnce([{
        id: 7,
        patient_uid: ACTOR_UID,
        is_medicolegal: false,
        police_clearance_at: null,
        body_released_at: null,
      }])
      .mockResolvedValueOnce([{
        has_custody: false,
        has_unclaimed_task: false,
        has_unclaimed_sla: false,
      }])
      .mockResolvedValueOnce([{
        id: 7,
        is_medicolegal: false,
        police_clearance_at: null,
      }])
      .mockResolvedValueOnce([released]);

    await expect(recordBodyRelease(RELEASE_INPUT)).resolves.toEqual(released);

    expect(queryRawMock).toHaveBeenCalledTimes(4);
    expect(queryRawMock.mock.calls[3][0]).toMatch(/UPDATE death_records/);
  });
});
