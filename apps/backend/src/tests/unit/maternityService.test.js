// Unit tests for maternityService validation. The partograph alert/
// action line math has its own dedicated test file
// (partographAlerts.test.js); this one covers the validators that
// fire before any DB call.

import {
  createPregnancy,
  recordAncVisit,
  admitToLabor,
  recordPartographEntry,
  recordDelivery,
  recordNewborn,
  recordApgar,
  recordPostnatalVisit,
} from '../../services/maternity/maternityService.js';

const T = '00000000-0000-4000-8000-000000000001';
const P = '11111111-1111-4111-8111-111111111111';

describe('createPregnancy validation', () => {
  it('rejects missing patient_uid', async () => {
    await expect(createPregnancy({ tenantId: T })).rejects.toMatchObject({
      message: expect.stringMatching(/patient_uid/i),
    });
  });
});

describe('recordAncVisit validation', () => {
  it('rejects missing pregnancy_id', async () => {
    await expect(
      recordAncVisit({ tenantId: T, visit_date: '2026-01-01' }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/pregnancy_id/i),
    });
  });

  it('rejects missing visit_date', async () => {
    await expect(
      recordAncVisit({ tenantId: T, pregnancy_id: 1 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/visit_date/i),
    });
  });
});

describe('admitToLabor validation', () => {
  it('rejects missing pregnancy_id', async () => {
    await expect(admitToLabor({ tenantId: T })).rejects.toMatchObject({
      message: expect.stringMatching(/pregnancy_id/i),
    });
  });
});

describe('recordPartographEntry validation', () => {
  it('rejects missing labor_admission_id', async () => {
    await expect(
      recordPartographEntry({ tenantId: T }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/labor_admission_id/i),
    });
  });
});

describe('recordDelivery validation', () => {
  const valid = {
    tenantId: T,
    pregnancy_id: 1,
    delivery_datetime: '2026-01-01T12:00:00Z',
    delivery_mode: 'nvd',
  };

  it('rejects missing pregnancy_id', async () => {
    await expect(
      recordDelivery({ ...valid, pregnancy_id: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/pregnancy_id/i),
    });
  });

  it('rejects missing delivery_datetime', async () => {
    await expect(
      recordDelivery({ ...valid, delivery_datetime: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/delivery_datetime/i),
    });
  });

  it('rejects missing delivery_mode', async () => {
    await expect(
      recordDelivery({ ...valid, delivery_mode: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/delivery_mode/i),
    });
  });
});

describe('recordNewborn validation', () => {
  const valid = {
    tenantId: T,
    delivery_id: 1,
    birth_datetime: '2026-01-01T12:00:00Z',
  };

  it('rejects missing delivery_id', async () => {
    await expect(
      recordNewborn({ ...valid, delivery_id: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/delivery_id/i),
    });
  });

  it('rejects missing birth_datetime', async () => {
    await expect(
      recordNewborn({ ...valid, birth_datetime: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/birth_datetime/i),
    });
  });
});

describe('recordApgar validation', () => {
  const valid = {
    newborn_id: 1, time_minute: 1,
    appearance: 2, pulse: 2, grimace: 2, activity: 2, respiration: 2,
  };

  it('rejects missing newborn_id', async () => {
    await expect(
      recordApgar({ ...valid, newborn_id: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/newborn_id/i),
    });
  });

  it('rejects time_minute outside {1, 5, 10}', async () => {
    for (const t of [0, 2, 3, 7, 15]) {
      await expect(
        recordApgar({ ...valid, time_minute: t }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/time_minute/i),
      });
    }
  });

  it('rejects component score outside 0-2', async () => {
    for (const k of ['appearance', 'pulse', 'grimace', 'activity', 'respiration']) {
      await expect(
        recordApgar({ ...valid, [k]: 3 }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(new RegExp(k, 'i')),
      });
      await expect(
        recordApgar({ ...valid, [k]: -1 }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(new RegExp(k, 'i')),
      });
    }
  });
});

describe('recordPostnatalVisit validation', () => {
  it('rejects missing delivery_id', async () => {
    await expect(
      recordPostnatalVisit({ tenantId: T }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/delivery_id/i),
    });
  });
});

// Note: P (the test UUID) is intentionally exported but unused in
// validation-only tests. The DB-touching paths that consume it live
// in the e2e suite.
expect(P).toMatch(/^[0-9a-f]{8}-/);
