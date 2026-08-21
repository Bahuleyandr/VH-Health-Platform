import { jest } from '@jest/globals';

const transactionMock = jest.fn();
const queryRawMock = jest.fn();
const executeRawMock = jest.fn();

const tx = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};
const prismaMock = {
  $transaction: transactionMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const { adminDoctorService } = await import(
  '../../services/doctor/adminDoctorService.js'
);

// Acting admin's tenant — the mutations now require it (tenant scoping so a
// tenant-A admin cannot flip/delete a tenant-B doctor). Matches the tenant on
// the mocked doctor/appointment rows.
const TENANT_ID = '10000000-0000-4000-8000-000000000001';

function activeAppointment({ livePathway = true } = {}) {
  return {
    id: 71,
    tenant_id: '10000000-0000-4000-8000-000000000001',
    appointment_date: '2026-07-25',
    appointment_time: '10:00',
    pathway_mode: 'active',
    has_live_op_pathway: livePathway,
  };
}

function shadowAppointment() {
  return {
    ...activeAppointment(),
    pathway_mode: 'shadow',
    has_live_op_pathway: true,
  };
}

function isAppointmentImpactRead(sql) {
  return sql.includes('FROM appointments AS appointment');
}

beforeEach(() => {
  jest.clearAllMocks();
  transactionMock.mockImplementation(async callback => callback(tx));
  executeRawMock.mockResolvedValue(0);
});

test('bulk deactivate fails closed before doctor or appointment mutation in active mode', async () => {
  queryRawMock.mockImplementation(async sql => {
    if (isAppointmentImpactRead(sql)) return [activeAppointment()];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(
    adminDoctorService.performBulkOperation('deactivate', [31], {}, TENANT_ID)
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'DOCTOR_APPOINTMENT_PATHWAY_CONVERGENCE_REQUIRED',
    details: {
      operation: 'bulk_deactivate',
      affected_appointment_count: 1,
      live_pathway_count: 1,
      projection_pending_count: 0,
    },
  });

  expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE doctors'))).toBe(false);
  expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE appointments'))).toBe(false);
  expect(executeRawMock).toHaveBeenCalledWith(
    'LOCK TABLE appointments IN SHARE ROW EXCLUSIVE MODE'
  );
});

test('bulk deactivate preserves the legacy shadow-mode cancellation path', async () => {
  queryRawMock.mockImplementation(async sql => {
    if (isAppointmentImpactRead(sql)) return [shadowAppointment()];
    if (sql.includes('UPDATE doctors')) return [{ user_id: 31 }];
    if (sql.includes('UPDATE appointments')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(
    adminDoctorService.performBulkOperation('deactivate', [31], {}, TENANT_ID)
  ).resolves.toMatchObject({
    operation: 'deactivate',
    affected_doctors: [{ user_id: 31 }],
    count: 1,
  });

  expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE doctors'))).toBe(true);
  expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE appointments'))).toBe(true);
});

test('availability=false fails closed for an active-mode appointment even before projection', async () => {
  queryRawMock.mockImplementation(async sql => {
    if (sql.includes('FROM doctors') && sql.includes('FOR UPDATE')) {
      return [{
        id: 9,
        user_id: 31,
        is_available: true,
      }];
    }
    if (isAppointmentImpactRead(sql)) {
      return [activeAppointment({ livePathway: false })];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(
    adminDoctorService.updateDoctorAvailability(31, {
      is_available: false,
      reason: 'Roster change',
    }, TENANT_ID)
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'DOCTOR_APPOINTMENT_PATHWAY_CONVERGENCE_REQUIRED',
    details: {
      operation: 'availability_unavailable',
      affected_appointment_count: 1,
      live_pathway_count: 0,
      projection_pending_count: 1,
    },
  });

  expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE doctors'))).toBe(false);
  expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE appointments'))).toBe(false);
});

test('availability=false proceeds when no appointment is affected', async () => {
  queryRawMock.mockImplementation(async sql => {
    if (sql.includes('FROM doctors') && sql.includes('FOR UPDATE')) {
      return [{
        id: 9,
        user_id: 31,
        is_available: true,
      }];
    }
    if (isAppointmentImpactRead(sql)) return [];
    if (sql.includes('UPDATE doctors')) {
      return [{
        id: 9,
        user_id: 31,
        is_available: false,
      }];
    }
    if (sql.includes('UPDATE appointments')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(
    adminDoctorService.updateDoctorAvailability(31, {
      is_available: false,
      reason: 'Roster change',
    }, TENANT_ID)
  ).resolves.toMatchObject({
    doctor: {
      id: 9,
      user_id: 31,
      is_available: false,
    },
    affected_appointments: 0,
    cancelled_appointments: [],
  });
});

test('account deletion cannot raw-reassign an active-mode appointment', async () => {
  queryRawMock.mockImplementation(async sql => {
    if (sql.includes('FROM doctors d') && sql.includes('FOR UPDATE OF d')) {
      return [{
        id: 9,
        user_id: 31,
        tenant_id: '10000000-0000-4000-8000-000000000001',
        name: 'Dr Source',
      }];
    }
    if (isAppointmentImpactRead(sql)) return [activeAppointment()];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(
    adminDoctorService.deleteDoctorAccount(31, {
      reason: 'Left service',
      transfer_patients_to: 41,
    }, TENANT_ID)
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'DOCTOR_APPOINTMENT_PATHWAY_CONVERGENCE_REQUIRED',
    details: {
      operation: 'account_delete_transfer',
      affected_appointment_count: 1,
    },
  });

  expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('FROM users WHERE'))).toBe(false);
  expect(executeRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE appointments'))).toBe(false);
  expect(executeRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE doctors'))).toBe(false);
});

test('account deletion preserves shadow-mode transfer and soft-delete behavior', async () => {
  queryRawMock.mockImplementation(async sql => {
    if (sql.includes('FROM doctors d') && sql.includes('FOR UPDATE OF d')) {
      return [{
        id: 9,
        user_id: 31,
        tenant_id: '10000000-0000-4000-8000-000000000001',
        name: 'Dr Source',
      }];
    }
    if (isAppointmentImpactRead(sql)) return [shadowAppointment()];
    if (sql.includes('SELECT name FROM users')) return [{ name: 'Dr Target' }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(
    adminDoctorService.deleteDoctorAccount(31, {
      reason: 'Left service',
      transfer_patients_to: 41,
    }, TENANT_ID)
  ).resolves.toMatchObject({
    doctor: {
      id: 9,
      user_id: 31,
      name: 'Dr Source',
    },
    appointments_handled: {
      future_appointments: 1,
      action: 'transferred',
      transfer_to: 41,
    },
  });

  const appointmentTransfer = executeRawMock.mock.calls.find(
    ([sql]) => sql.includes('UPDATE appointments')
  );
  expect(appointmentTransfer?.slice(1)).toEqual([41, [9, 31], TENANT_ID]);
  expect(
    executeRawMock.mock.calls.some(([sql]) => sql.includes('UPDATE doctors'))
  ).toBe(true);
});
