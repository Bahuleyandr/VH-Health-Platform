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
  setSupplementReminder,
  obgynLabourWardGateConfig,
} from '../../services/maternity/maternityService.js';

const T = '00000000-0000-4000-8000-000000000001';
const P = '11111111-1111-4111-8111-111111111111';

describe('obgynLabourWardGateConfig (credential-hardening)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it('is inert by default with the canonical privilege key', () => {
    delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
    delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_KEY;
    expect(obgynLabourWardGateConfig()).toEqual({ key: 'obgyn_labour_ward_access', enabled: false });
  });

  it('honours the env enable flag and key override', () => {
    process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = 'true';
    process.env.OBGYN_LABOUR_WARD_PRIVILEGE_KEY = 'OBGyn Labour Ward Access';
    expect(obgynLabourWardGateConfig()).toEqual({ key: 'obgyn_labour_ward_access', enabled: true });
  });
});

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

// BE-M1 (review 2026-08-09): clinical numerics on the ANC and labour-ward
// writers are range-validated BEFORE any DB call — a garbled FHR of 15 or
// 1600 must be a 400 (MATERNITY_CLINICAL_VALUE_OUT_OF_RANGE), never a stored
// clinical fact, because FHR / cervical findings drive intrapartum
// escalation. Rejection, not clamping (mirrors recordFetalKick's kick_count
// 0..999 guard in the same file).
describe('recordAncVisit clinical range validation (BE-M1)', () => {
  const base = { tenantId: T, pregnancy_id: 1, visit_date: '2026-08-01' };

  it.each([
    ['fetal_heart_rate_bpm', 15], // the audit's garble example — below the 30 floor
    ['fetal_heart_rate_bpm', 1600],
    ['fetal_heart_rate_bpm', 0],
    ['fetal_heart_rate_bpm', 140.5], // int column — whole numbers only
    ['fetal_heart_rate_bpm', 'garbled'],
    ['gestational_age_weeks', 0],
    ['gestational_age_weeks', 60],
    ['fundal_height_cm', 2],
    ['fundal_height_cm', 400],
    // SF-2: maternal vitals feed the post-commit pre-eclampsia engine — a
    // 9999 systolic must be a 400, never a stored fact + CRITICAL alert.
    ['bp_systolic', 9999],
    ['bp_systolic', 30],
    ['bp_diastolic', 999],
    ['bp_diastolic', 10],
    ['pulse_bpm', 5],
    ['pulse_bpm', 999],
  ])('rejects out-of-range %s=%p before touching the DB', async (field, value) => {
    await expect(
      recordAncVisit({ ...base, [field]: value }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'MATERNITY_CLINICAL_VALUE_OUT_OF_RANGE',
      message: expect.stringMatching(new RegExp(field, 'i')),
    });
  });

  it('accepts FHR 30 — terminal fetal bradycardia is charted, not garble (SF-1)', async () => {
    // Passes range validation; whatever the environment rejects next
    // (pregnancy lookup / DB availability) must NOT be the range guard.
    await expect(
      recordAncVisit({ ...base, pregnancy_id: 999999999, fetal_heart_rate_bpm: 30 }),
    ).rejects.not.toMatchObject({ code: 'MATERNITY_CLINICAL_VALUE_OUT_OF_RANGE' });
  });
});

describe('admitToLabor clinical range validation (BE-M1)', () => {
  const base = { tenantId: T, pregnancy_id: 1 };

  it.each([
    ['fetal_heart_rate_bpm', 15],
    ['fetal_heart_rate_bpm', 1600],
    ['cervix_dilation_cm', 15],
    ['cervix_dilation_cm', -1],
    ['cervix_effacement_pct', 150],
    ['cervix_effacement_pct', 42.5], // int column — whole numbers only
    ['gestational_age_weeks', 60],
  ])('rejects out-of-range %s=%p before touching the DB', async (field, value) => {
    await expect(
      admitToLabor({ ...base, [field]: value }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'MATERNITY_CLINICAL_VALUE_OUT_OF_RANGE',
      message: expect.stringMatching(new RegExp(field, 'i')),
    });
  });

  it('accepts FHR 30 — terminal fetal bradycardia is charted, not garble (SF-1)', async () => {
    await expect(
      admitToLabor({ ...base, pregnancy_id: 999999999, fetal_heart_rate_bpm: 30 }),
    ).rejects.not.toMatchObject({ code: 'MATERNITY_CLINICAL_VALUE_OUT_OF_RANGE' });
  });
});

// SF-2: the partograph writer is now an escalation trigger (BE-M2), so its
// numerics get the same reject-not-clamp guard — a garbled dilation or FHR
// must not auto-raise (or suppress) a CRITICAL escalation.
describe('recordPartographEntry clinical range validation (SF-2)', () => {
  const base = { tenantId: T, labor_admission_id: 1 };

  it.each([
    ['cervix_dilation_cm', 15],
    ['cervix_dilation_cm', -1],
    ['fetal_heart_rate_bpm', 15],
    ['fetal_heart_rate_bpm', 1600],
    ['fetal_heart_rate_bpm', 120.5], // int column — whole numbers only
  ])('rejects out-of-range %s=%p before touching the DB', async (field, value) => {
    await expect(
      recordPartographEntry({ ...base, [field]: value }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'MATERNITY_CLINICAL_VALUE_OUT_OF_RANGE',
      message: expect.stringMatching(new RegExp(field, 'i')),
    });
  });

  it('accepts FHR 30 — terminal fetal bradycardia is charted, not garble (SF-1)', async () => {
    await expect(
      recordPartographEntry({ ...base, labor_admission_id: 999999999, fetal_heart_rate_bpm: 30 }),
    ).rejects.not.toMatchObject({ code: 'MATERNITY_CLINICAL_VALUE_OUT_OF_RANGE' });
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

describe('setSupplementReminder validation', () => {
  it('rejects invalid pregnancy, supplement, and reminder inputs before DB access', async () => {
    await expect(
      setSupplementReminder({ tenantId: T, pregnancy_id: 0, supplement_id: 1, reminder_enabled: true }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/pregnancy_id/i) });

    await expect(
      setSupplementReminder({ tenantId: T, pregnancy_id: 1, supplement_id: 0, reminder_enabled: true }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/supplement_id/i) });

    await expect(
      setSupplementReminder({ tenantId: T, pregnancy_id: 1, supplement_id: 1, reminder_enabled: 'yes' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/reminder_enabled/i) });
  });
});

// Note: P (the test UUID) is intentionally exported but unused in
// validation-only tests. The DB-touching paths that consume it live
// in the e2e suite.
expect(P).toMatch(/^[0-9a-f]{8}-/);
