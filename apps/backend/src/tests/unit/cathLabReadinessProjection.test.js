/**
 * The pure serology projection for the pre-cath lab readiness surfaces.
 *
 * The rule under test: cath REPORT-READ admits RECEPTIONIST and TECHNICIAN,
 * which is correct (the front desk needs "labs pending"), but the readiness
 * items carry value_text / value_numeric / abnormal_flag for hiv, hbsag and
 * hcv. Those three fields are blanked for those roles, and `is_critical` is
 * forced false on the same items — on a qualitative marker only a REACTIVE
 * result is critical, so the flag, and the item's name in `critical_items`,
 * disclose exactly what the blanked keys withhold. Everything else — `state`,
 * `observed_at`, `source`, the waiver trio, `critical_warning` — stays, and the
 * KEY SET never changes, because CathLabReadinessItem is
 * additionalProperties:false with all keys required.
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

const CRITICAL_POTASSIUM = itemFor({
  item_code: 'potassium',
  value_text: '6.9',
  value_numeric: 6.9,
  unit: 'mmol/L',
  abnormal_flag: 'HH',
  is_critical: true,
  lab_result_id: 42,
});

const readinessFor = (items, overrides = {}) => ({
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
  ...overrides,
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

  it.each(REPORT_READ_ONLY)('%s: criticality IS the serology result, so it goes too', (role) => {
    // A serology item is critical only when it is reactive. Leaving is_critical
    // true on the hbsag row, or its bare code in critical_items, would name the
    // result the three blanked keys withhold.
    const input = readinessFor([CRITICAL_POTASSIUM, REACTIVE_HBSAG], {
      critical_items: ['potassium', 'hbsag'],
    });
    const projected = projectLabReadinessForRole(input, role);
    const hbsag = projected.items.find((row) => row.item_code === 'hbsag');

    expect(hbsag.is_critical).toBe(false);
    // false, not null and not dropped: the schema types it boolean.
    expect(Object.keys(hbsag).sort()).toEqual(Object.keys(REACTIVE_HBSAG).sort());
    expect(projected.critical_items).toEqual(['potassium']);
    // The advisory survives — it says a critical value exists, never which.
    expect(projected.critical_warning).toBe(true);
    // ...and the quantitative item beside it is still named AND still flagged.
    const potassium = projected.items.find((row) => row.item_code === 'potassium');
    expect(potassium).toEqual(CRITICAL_POTASSIUM);
  });

  it.each(REPORT_READ_ONLY)('%s: all three markers leave critical_items', (role) => {
    const input = readinessFor([REACTIVE_HBSAG], {
      critical_items: ['hiv', 'hbsag', 'hcv', 'creatinine'],
    });
    expect(projectLabReadinessForRole(input, role).critical_items).toEqual(['creatinine']);
  });

  it('a serology-only critical list empties — the key is never dropped', () => {
    const projected = projectLabReadinessForRole(readinessFor([REACTIVE_HBSAG]), 'RECEPTIONIST');
    expect(projected.critical_items).toEqual([]);
    expect('critical_items' in projected).toBe(true);
    expect(projected.critical_warning).toBe(true);
  });

  it.each(CLINICAL)('%s: identity — the block is deep-equal to what came in', (role) => {
    const built = () => readinessFor([CRITICAL_POTASSIUM, REACTIVE_HBSAG], {
      critical_items: ['potassium', 'hbsag'],
    });
    expect(projectLabReadinessForRole(built(), role)).toEqual(built());
  });

  it('never mutates its input', () => {
    const input = readinessFor([REACTIVE_HBSAG]);
    projectLabReadinessForRole(input, 'RECEPTIONIST');
    expect(input.items[0].value_text).toBe('reactive');
    expect(input.items[0].is_critical).toBe(true);
    expect(input.critical_items).toEqual(['hbsag']);
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
    expect(projectLabReadinessItemsForRole([REACTIVE_HBSAG], 'RECEPTIONIST')[0].is_critical)
      .toBe(false);
    expect(projectLabReadinessItemsForRole([REACTIVE_HBSAG], 'DOCTOR')[0].value_text)
      .toBe('reactive');
    expect(projectLabReadinessItemsForRole([REACTIVE_HBSAG], 'DOCTOR')[0].is_critical)
      .toBe(true);
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
      critical_items: ['potassium', 'hbsag'],
      auto_pending_reason: 'hiv not ordered',
      live_evidence: [CRITICAL_POTASSIUM, REACTIVE_HBSAG],
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

  it.each(REPORT_READ_ONLY)('%s: metadata.critical_items is filtered too', (role) => {
    // The labs check row carries its own copy of the same list. Filtering only
    // lab_readiness.critical_items would leave the name one key over on the
    // very same GET /cases/:id response.
    const [row] = projectReadinessChecksForRole([checkRow()], role);

    expect(row.metadata.critical_items).toEqual(['potassium']);
    const evidence = row.metadata.live_evidence;
    expect(evidence.find((entry) => entry.item_code === 'hbsag').is_critical).toBe(false);
    expect(evidence.find((entry) => entry.item_code === 'potassium')).toEqual(CRITICAL_POTASSIUM);
    expect(row.metadata.critical_warning).toBe(true);
  });

  it('a check row with critical_items but no live_evidence is still filtered', () => {
    const row = {
      id: 5,
      check_type: 'labs',
      status: 'pending',
      metadata: { critical_warning: true, critical_items: ['hiv'], auto_managed: true },
    };
    const [projected] = projectReadinessChecksForRole([row], 'RECEPTIONIST');
    expect(projected.metadata.critical_items).toEqual([]);
    expect(projected.metadata.auto_managed).toBe(true);
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
