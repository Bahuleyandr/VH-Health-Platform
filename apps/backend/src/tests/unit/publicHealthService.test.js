import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const prismaMock = { $queryRawUnsafe: queryUnsafeMock };
const txQueryMock = jest.fn();
const txMock = { $queryRawUnsafe: txQueryMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(txMock)),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
const settingsMock = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getPublicHealthRegistersSettings: settingsMock,
}));
const canonicalMock = jest.fn();
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: canonicalMock,
}));

const svc = await import('../../services/publicHealth/publicHealthService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  txQueryMock.mockReset();
  settingsMock.mockReset();
  canonicalMock.mockReset();
  delete process.env.PUBLIC_HEALTH_REGISTERS_ENABLED;
});

describe('dark gate', () => {
  test('env off → 503 NOT_ENABLED', async () => {
    await expect(svc.requirePublicHealthRegistersEnabled(TENANT)).rejects.toMatchObject({
      statusCode: 503, code: 'PUBLIC_HEALTH_REGISTERS_NOT_ENABLED',
    });
  });
  test('env on + tenant off → 403 DISABLED', async () => {
    process.env.PUBLIC_HEALTH_REGISTERS_ENABLED = 'true';
    settingsMock.mockResolvedValue({ enabled: false });
    await expect(svc.requirePublicHealthRegistersEnabled(TENANT)).rejects.toMatchObject({
      statusCode: 403, code: 'PUBLIC_HEALTH_REGISTERS_DISABLED',
    });
  });
});

describe('vocabulary', () => {
  test('tuberculosis defaults to the nikshay programme', () => {
    expect(svc.NOTIFIABLE_DISEASES.tuberculosis.program).toBe('nikshay');
    expect(svc.NOTIFIABLE_DISEASES.dengue.program).toBe('idsp');
  });
  test('STATUS_TRANSITIONS is fail-closed', () => {
    expect(svc._internal.STATUS_TRANSITIONS.draft).toEqual(['notified', 'cancelled']);
    expect(svc._internal.STATUS_TRANSITIONS.closed).toEqual([]);
  });
});

describe('createNotification', () => {
  beforeEach(() => {
    process.env.PUBLIC_HEALTH_REGISTERS_ENABLED = 'true';
    settingsMock.mockResolvedValue({ enabled: true });
  });

  test('rejects an unknown disease code', async () => {
    await expect(svc.createNotification({
      tenantId: TENANT, patient_uid: PATIENT, date_of_diagnosis: '2026-08-01',
      disease_code: 'not_a_disease',
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('inserts row + records canonical event, defaulting the programme', async () => {
    txQueryMock
      .mockResolvedValueOnce([{ uid: PATIENT }]) // tenant-scoped patient resolution
      .mockResolvedValueOnce([{ id: 5, patient_uid: PATIENT, disease_code: 'tuberculosis', program: 'nikshay' }]);
    const rec = await svc.createNotification({
      tenantId: TENANT, patient_uid: PATIENT, date_of_diagnosis: '2026-08-01',
      disease_code: 'tuberculosis', created_by: PATIENT,
    });
    expect(rec.id).toBe(5);
    // Resolution query runs first, tenant-scoped and PATIENT-role-scoped.
    expect(txQueryMock).toHaveBeenCalledTimes(2);
    expect(txQueryMock.mock.calls[0][0]).toMatch(/tenant_id = \$1::uuid/);
    expect(txQueryMock.mock.calls[0][0]).toMatch(/role = 'PATIENT'/);
    expect(canonicalMock).toHaveBeenCalledTimes(1);
    const [input, options] = canonicalMock.mock.calls[0];
    expect(input.resourceTable).toBe('notifiable_disease_notifications');
    expect(options).toMatchObject({ db: txMock, strict: true });
  });

  test('rejects a non-UUID patient_uid with 400, before any SQL runs', async () => {
    await expect(svc.createNotification({
      tenantId: TENANT, patient_uid: 'not-a-uuid', date_of_diagnosis: '2026-08-01',
      disease_code: 'dengue',
    })).rejects.toMatchObject({ statusCode: 400, code: 'PUBLIC_HEALTH_PATIENT_UID_INVALID' });
    expect(txQueryMock).not.toHaveBeenCalled();
  });

  test('rejects a dangling / cross-tenant patient UUID with 404', async () => {
    txQueryMock.mockResolvedValueOnce([]); // resolution finds no patient in tenant
    await expect(svc.createNotification({
      tenantId: TENANT, patient_uid: PATIENT, date_of_diagnosis: '2026-08-01',
      disease_code: 'dengue',
    })).rejects.toMatchObject({ statusCode: 404, code: 'PUBLIC_HEALTH_PATIENT_NOT_FOUND' });
    expect(canonicalMock).not.toHaveBeenCalled();
  });
});

describe('exports', () => {
  beforeEach(() => {
    process.env.PUBLIC_HEALTH_REGISTERS_ENABLED = 'true';
    settingsMock.mockResolvedValue({ enabled: true });
  });

  test('exportNikshayTb emits a TB CSV header + rows', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      patient_name: 'TB Patient', patient_age_years: 40, patient_sex: 'male',
      case_classification: 'confirmed', lab_confirmed: true, lab_test: 'CBNAAT',
      lab_result: 'MTB detected', date_of_diagnosis: '2026-08-01', program_details: { hiv_status: 'negative' },
    }]);
    const out = await svc.exportNikshayTb({ tenantId: TENANT });
    expect(out.format).toBe('nikshay_tb_csv');
    expect(out.case_count).toBe(1);
    expect(out.content).toContain('PatientName,Age,Gender');
    expect(out.content).toContain('microbiologically_confirmed');
    expect(out.content).toContain('negative');
  });

  test('exportNikshayTb neutralizes spreadsheet formula injection in text cells', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      patient_name: '=HYPERLINK("http://evil")', patient_sex: '+cmd',
      patient_address: '@SUM(A1:A9)', patient_district: '-2+3',
      case_classification: 'confirmed', lab_confirmed: true,
      date_of_diagnosis: '2026-08-01', program_details: {},
    }]);
    const out = await svc.exportNikshayTb({ tenantId: TENANT });
    // Formula-leading cells are prefixed with a single quote (and RFC-4180
    // quoted where needed) so Excel renders literal text, never a formula.
    expect(out.content).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(out.content).toContain("'+cmd");
    expect(out.content).toContain("'@SUM(A1:A9)");
    expect(out.content).toContain("'-2+3");
    expect(out.content).not.toContain(',=HYPERLINK');
  });

  test('exportIdspWeekly P form excludes suspected cases', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { patient_name: 'A', case_classification: 'confirmed', disease_name: 'Dengue', date_of_diagnosis: '2026-08-01', lab_confirmed: true },
      { patient_name: 'B', case_classification: 'suspected', disease_name: 'Dengue', date_of_diagnosis: '2026-08-02', lab_confirmed: false },
    ]);
    const out = await svc.exportIdspWeekly({ tenantId: TENANT, form: 'P' });
    expect(out.form).toBe('P');
    expect(out.case_count).toBe(1);
  });

  test('exportHmisMonthly validates month and aggregates', async () => {
    await expect(svc.exportHmisMonthly({ tenantId: TENANT, month: 13, year: 2026 }))
      .rejects.toMatchObject({ statusCode: 400 });
    queryUnsafeMock.mockResolvedValueOnce([
      { disease_code: 'dengue', disease_name: 'Dengue', total_cases: 3, lab_confirmed: 2, confirmed: 2, deaths: 0 },
    ]);
    const out = await svc.exportHmisMonthly({ tenantId: TENANT, month: 8, year: 2026 });
    expect(out.format).toBe('hmis_monthly_csv');
    expect(out.period).toMatchObject({ month: 8, year: 2026 });
    expect(out.content).toContain('Dengue,dengue,3,2,2,0');
  });
});
