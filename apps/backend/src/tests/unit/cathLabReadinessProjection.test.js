/**
 * The pure serology projection for the pre-cath lab readiness surfaces.
 *
 * The rule under test: cath REPORT-READ admits RECEPTIONIST and TECHNICIAN,
 * which is correct (the front desk needs "labs pending"), but the readiness
 * items carry value_text / value_numeric / abnormal_flag for hiv, hbsag and
 * hcv. Those three fields are the only thing removed for those roles; every
 * other key — including `state`, `observed_at`, `is_critical`, `source` and the
 * waiver trio — stays, and the KEY SET never changes, because
 * CathLabReadinessItem is additionalProperties:false with all keys required.
 *
 * The wiring (that the router actually calls this) is pinned end to end in
 * cathDeviceReuseSurfaceEnforcement.test.js; this suite pins the rule itself.
 */

import { jest } from '@jest/globals';

// cathLabReadinessProjection imports roleSeesSerologyDetail from
// cathDeviceReuseService — deliberately the SAME predicate the reuse strip is
// projected through — which pulls the prisma client in behind it. The predicate
// itself is pure; only the module graph needs a stub.
const prismaStub = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
  $on: jest.fn(),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: prismaStub,
  prismaReadOnly: prismaStub,
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  isTenantTransactionClient: () => false,
  circuitBreakerStatus: () => ({}),
  pinSessionTimeZoneToUrl: (url) => url,
  evaluateTenantRlsPosture: () => ({}),
  tenantRlsRuntimeRole: () => null,
  tenantRlsRolePosture: async () => ({}),
  logTenantRlsRolePosture: async () => {},
  rlsDisabledLogLevel: () => 'warn',
  tenantRlsPostureMustFailClosed: () => false,
  ensureTenantRlsRuntimeRoleGrants: async () => {},
}));

const {
  isSerologyItemCode,
  projectLabReadinessForRole,
  projectLabReadinessItemsForRole,
  projectReadinessChecksForRole,
  REDACTED_SEROLOGY_ITEM_KEYS,
} = await import('../../services/clinical/cathLabReadinessProjection.js');
const { BLOODBORNE_MARKER_ITEM_CODES, LAB_ANALYTE_ITEM_CODES } =
  await import('../../services/lab/labAnalyteCodes.js');
const { roleSeesSerologyDetail } = await import('../../services/clinical/cathDeviceReuseService.js');

/** resolveItemState()'s full key set, so a redaction that DROPS a key fails. */
const itemFor = (overrides) => ({
  item_code: 'hb',
  required: true,
  state: 'result_final',
  value_text: '12.4',
  value_numeric: 12.4,
  unit: 'g/dL',
  abnormal_flag: null,
  is_critical: false,
  observed_at: '2026-09-01T04:00:00.000Z',
  source: 'lab_result',
  lab_result_id: 41,
  investigation_id: null,
  specimen_id: null,
  ordered_at: null,
  waived_by: null,
  waived_at: null,
  waive_reason: null,
  ...overrides,
});

const REACTIVE_HBSAG = itemFor({
  item_code: 'hbsag',
  state: 'result_final',
  value_text: 'reactive',
  value_numeric: null,
  unit: null,
  abnormal_flag: 'AA',
  is_critical: true,
  source: 'lab_result',
  lab_result_id: 77,
});

const readinessFor = (items) => ({
  case_id: 10,
  check_status: 'pending',
  auto_managed: true,
  critical_warning: true,
  critical_items: ['hbsag'],
  items,
  missing: [],
  orderable_now: [],
  open_order_codes: [],
  settings: {
    lab_validity_days: 30,
    serology_validity_days: 90,
    auto_pass: true,
    external_results_count: true,
    required_items: [...LAB_ANALYTE_ITEM_CODES],
  },
  case_started: false,
});

const CLINICAL = ['CATH_LAB_STAFF', 'DOCTOR'];
const REPORT_READ_ONLY = ['RECEPTIONIST', 'TECHNICIAN'];

describe('who the projection applies to', () => {
  it.each(REPORT_READ_ONLY)('%s does NOT see serology detail', (role) => {
    expect(roleSeesSerologyDetail(role)).toBe(false);
  });

  it.each(CLINICAL)('%s does', (role) => {
    expect(roleSeesSerologyDetail(role)).toBe(true);
  });

  it('the serology item set is the analyte map marker items, not a second list', () => {
    expect([...BLOODBORNE_MARKER_ITEM_CODES]).toEqual(['hiv', 'hbsag', 'hcv']);
    for (const code of BLOODBORNE_MARKER_ITEM_CODES) expect(isSerologyItemCode(code)).toBe(true);
    for (const code of ['hb', 'platelets', 'creatinine', 'potassium']) {
      expect(isSerologyItemCode(code)).toBe(false);
    }
    expect(isSerologyItemCode(undefined)).toBe(false);
  });

  it('exactly three value-bearing keys are redacted', () => {
    expect([...REDACTED_SEROLOGY_ITEM_KEYS])
      .toEqual(['value_text', 'value_numeric', 'abnormal_flag']);
  });
});

describe('projectLabReadinessForRole', () => {
  it.each(REPORT_READ_ONLY)('%s: a reactive HBsAg keeps its state and loses its value', (role) => {
    const projected = projectLabReadinessForRole(readinessFor([itemFor({}), REACTIVE_HBSAG]), role);
    const hbsag = projected.items.find((row) => row.item_code === 'hbsag');

    expect(hbsag.value_text).toBeNull();
    expect(hbsag.value_numeric).toBeNull();
    expect(hbsag.abnormal_flag).toBeNull();
    // What the front desk IS admitted for survives.
    expect(hbsag.state).toBe('result_final');
    expect(hbsag.observed_at).toBe('2026-09-01T04:00:00.000Z');
    expect(hbsag.is_critical).toBe(true);
    expect(hbsag.source).toBe('lab_result');
    expect(hbsag.required).toBe(true);
  });

  it.each(REPORT_READ_ONLY)('%s: the key set is identical — blanked, never dropped', (role) => {
    const projected = projectLabReadinessForRole(readinessFor([REACTIVE_HBSAG]), role);
    expect(Object.keys(projected.items[0]).sort()).toEqual(Object.keys(REACTIVE_HBSAG).sort());
    expect(Object.keys(projected).sort()).toEqual(Object.keys(readinessFor([])).sort());
  });

  it.each(REPORT_READ_ONLY)('%s: a waived serology item keeps who/when/why', (role) => {
    const waived = itemFor({
      item_code: 'hiv',
      state: 'waived',
      source: 'waiver',
      value_text: 'reactive',
      waived_by: '11111111-1111-4111-8111-111111111111',
      waived_at: '2026-09-02T00:00:00.000Z',
      waive_reason: 'emergency PCI',
    });
    const [projected] = projectLabReadinessForRole(readinessFor([waived]), role).items;
    expect(projected.value_text).toBeNull();
    expect(projected).toMatchObject({
      state: 'waived',
      source: 'waiver',
      waive_reason: 'emergency PCI',
      waived_by: '11111111-1111-4111-8111-111111111111',
    });
  });

  it.each(REPORT_READ_ONLY)('%s: the four quantitative items are untouched', (role) => {
    const items = ['hb', 'platelets', 'creatinine', 'potassium']
      .map((itemCode) => itemFor({ item_code: itemCode, abnormal_flag: 'HH', is_critical: true }));
    const projected = projectLabReadinessForRole(readinessFor(items), role);
    expect(projected.items).toEqual(items);
  });

  it.each(CLINICAL)('%s reads the reactive value, and the object is not even copied', (role) => {
    const input = readinessFor([REACTIVE_HBSAG]);
    const projected = projectLabReadinessForRole(input, role);
    expect(projected).toBe(input);
    expect(projected.items[0].value_text).toBe('reactive');
    expect(projected.items[0].abnormal_flag).toBe('AA');
  });

  it('never mutates its input', () => {
    const input = readinessFor([REACTIVE_HBSAG]);
    projectLabReadinessForRole(input, 'RECEPTIONIST');
    expect(input.items[0].value_text).toBe('reactive');
  });

  it('null, undefined and a degraded block pass straight through', () => {
    // getCase answers lab_readiness: null when the read-through refresh failed,
    // and the key is absent entirely on a case row that never carried one.
    expect(projectLabReadinessForRole(null, 'RECEPTIONIST')).toBeNull();
    expect(projectLabReadinessForRole(undefined, 'RECEPTIONIST')).toBeUndefined();
    expect(projectLabReadinessForRole({ case_id: 10 }, 'RECEPTIONIST')).toEqual({ case_id: 10 });
  });

  it('an unknown role is treated as NOT clinical — fail closed', () => {
    const projected = projectLabReadinessForRole(readinessFor([REACTIVE_HBSAG]), null);
    expect(projected.items[0].value_text).toBeNull();
    expect(projectLabReadinessForRole(readinessFor([REACTIVE_HBSAG]), 'NO_SUCH_ROLE')
      .items[0].value_text).toBeNull();
  });

  it('projectLabReadinessItemsForRole is the same rule on a bare array', () => {
    expect(projectLabReadinessItemsForRole([REACTIVE_HBSAG], 'RECEPTIONIST')[0].value_text)
      .toBeNull();
    expect(projectLabReadinessItemsForRole([REACTIVE_HBSAG], 'DOCTOR')[0].value_text)
      .toBe('reactive');
    expect(projectLabReadinessItemsForRole(null, 'RECEPTIONIST')).toBeNull();
  });
});

describe('projectReadinessChecksForRole — the live_evidence copy', () => {
  const checkRow = () => ({
    id: 5,
    check_type: 'labs',
    status: 'pending',
    required: true,
    metadata: {
      auto_managed: true,
      critical_warning: true,
      critical_items: ['hbsag'],
      auto_pending_reason: 'hiv not ordered',
      live_evidence: [itemFor({}), REACTIVE_HBSAG],
      live_evidence_refreshed_at: '2026-09-04T00:00:00.000Z',
    },
  });

  it.each(REPORT_READ_ONLY)('%s: values inside metadata.live_evidence are blanked too', (role) => {
    const [row] = projectReadinessChecksForRole([checkRow()], role);
    const hbsag = row.metadata.live_evidence.find((entry) => entry.item_code === 'hbsag');
    expect(hbsag.value_text).toBeNull();
    expect(hbsag.abnormal_flag).toBeNull();
    expect(hbsag.state).toBe('result_final');
    // The list is projected, not stripped: the rest of metadata is intact.
    expect(row.metadata.auto_pending_reason).toBe('hiv not ordered');
    expect(row.metadata.live_evidence_refreshed_at).toBe('2026-09-04T00:00:00.000Z');
    expect(row.metadata.live_evidence).toHaveLength(2);
    expect(row.check_type).toBe('labs');
  });

  it.each(CLINICAL)('%s reads live_evidence whole', (role) => {
    const rows = [checkRow()];
    expect(projectReadinessChecksForRole(rows, role)).toBe(rows);
  });

  it('rows without live_evidence — the other seven checks — are returned as-is', () => {
    const other = { id: 6, check_type: 'consent', status: 'pass', metadata: { note: 'signed' } };
    const nullMeta = { id: 7, check_type: 'imaging', status: 'pending', metadata: null };
    const [a, b] = projectReadinessChecksForRole([other, nullMeta], 'RECEPTIONIST');
    expect(a).toBe(other);
    expect(b).toBe(nullMeta);
  });

  it('a non-array (a case row that carried no checks) passes through', () => {
    expect(projectReadinessChecksForRole(undefined, 'RECEPTIONIST')).toBeUndefined();
    expect(projectReadinessChecksForRole(null, 'RECEPTIONIST')).toBeNull();
  });
});
