import { jest } from '@jest/globals';

import { AppError } from '../../utils/AppError.js';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const transitionTaskMock = jest.fn();
const getTaskMock = jest.fn();
const createTaskMock = jest.fn();

const tenantTxClient = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
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

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createTask: createTaskMock,
  getTask: getTaskMock,
  transitionTask: transitionTaskMock,
}));

const { recordMortuaryBodyRelease } = await import(
  '../../services/clinical/deathCertificationService.js'
);

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

function seedReleaseQueries() {
  queryRawMock
    .mockResolvedValueOnce([{
      id: 7,
      is_medicolegal: false,
      police_clearance_at: null,
      body_released_at: null,
    }])
    .mockResolvedValueOnce([{ id: 11 }])
    .mockResolvedValueOnce([{
      id: 7,
      is_medicolegal: false,
      police_clearance_at: null,
    }])
    .mockResolvedValueOnce([{
      id: 7,
      body_released_at: '2026-07-18T10:00:00.000Z',
    }])
    .mockResolvedValueOnce([{
      id: 13,
      event_type: 'release',
    }])
    .mockResolvedValueOnce([{
      id: 17,
      status: 'in_progress',
    }]);
  executeRawMock.mockResolvedValueOnce(1);
}

beforeEach(() => {
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  transitionTaskMock.mockReset();
  getTaskMock.mockReset();
  createTaskMock.mockReset();
});

describe('mortuary task completion concurrency', () => {
  it('continues body release when a task CAS loser verifies terminal state in the same tx', async () => {
    seedReleaseQueries();
    transitionTaskMock.mockRejectedValueOnce(
      AppError.conflict('Task status changed', 'TASK_TRANSITION_CONFLICT'),
    );
    getTaskMock.mockResolvedValueOnce({ id: 17, status: 'completed' });

    const result = await recordMortuaryBodyRelease({
      tenantId: TENANT_ID,
      id: 7,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
      body_released_to_name: 'Relative',
      body_released_to_relation: 'sibling',
      release_method: 'family',
    });

    expect(result.death_record.body_released_at).toBeTruthy();
    expect(result.custody_event.event_type).toBe('release');
    expect(getTaskMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      id: 17,
      tx: tenantTxClient,
    });
  });

  it('retries from the re-read status only while a legal completion path remains', async () => {
    seedReleaseQueries();
    transitionTaskMock
      .mockRejectedValueOnce(AppError.conflict('Task status changed', 'TASK_TRANSITION_CONFLICT'))
      .mockResolvedValueOnce({ id: 17, status: 'in_progress' })
      .mockResolvedValueOnce({ id: 17, status: 'completed' });
    getTaskMock.mockResolvedValueOnce({ id: 17, status: 'blocked' });

    await expect(recordMortuaryBodyRelease({
      tenantId: TENANT_ID,
      id: 7,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
      body_released_to_name: 'Relative',
      body_released_to_relation: 'sibling',
      release_method: 'family',
    })).resolves.toMatchObject({
      death_record: { id: 7 },
      custody_event: { event_type: 'release' },
    });

    expect(transitionTaskMock.mock.calls.map(([options]) => options.nextStatus))
      .toEqual(['completed', 'in_progress', 'completed']);
  });
});
