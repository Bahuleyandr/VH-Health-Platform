/**
 * The device-reuse OpenAPI overlay is a SECOND copy of facts that live in
 * cathDeviceReuseService.js: the columns each SELECT returns, and five enum
 * vocabularies. Two copies drift silently, and both directions are a contract
 * lie — a column added to the SELECT but not the overlay is a response the
 * published contract forbids (every row schema is additionalProperties:false),
 * and a value published but never emitted is a promise the API does not keep.
 *
 * So the pins are read from the service's own SOURCE (the SELECT lists) and
 * from its exported frozen constants (the vocabularies). Same technique as
 * bloodborneMarkerRoutes.test.js's MARKER_SELECT pin.
 */

import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import * as overlay from '../../../scripts/openapi/schemas/cathDeviceReuse.mjs';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
  $on: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: prismaMock,
  prismaReadOnly: prismaMock,
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

const service = await import('../../services/clinical/cathDeviceReuseService.js');

const SERVICE_SOURCE = readFileSync(
  new URL('../../services/clinical/cathDeviceReuseService.js', import.meta.url),
  'utf8',
);

/** Columns of a `const NAME = \`...\`` SELECT list, with table aliases stripped. */
function selectColumns(constName) {
  const match = SERVICE_SOURCE.match(new RegExp(`const ${constName} = \`([^\`]*)\``));
  expect(match).not.toBeNull();
  return match[1]
    .split(',')
    .map((column) => column.trim().replace(/^[a-z]\./, ''))
    .filter(Boolean);
}

describe('CathReprocessableDevice mirrors DEVICE_SELECT exactly', () => {
  const columns = selectColumns('DEVICE_SELECT');
  const schema = overlay.schemas.CathReprocessableDevice;

  it('reads 27 device columns plus the four catalogue columns the join adds', () => {
    expect(columns).toHaveLength(31);
    expect(columns.slice(-4)).toEqual(['item_name', 'category', 'manufacturer', 'model']);
    expect(columns).toContain('device_tag');
  });

  it('publishes every column as required, and nothing else', () => {
    // additionalProperties:false makes the property set load-bearing, not just
    // the required list: a column the SELECT returns and the overlay omits is
    // a response the generated clients reject.
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(columns);
    expect(Object.keys(schema.properties)).toEqual(columns);
  });

  it('the published tag pattern accepts every tag the generated column can mint', () => {
    // device_tag is 'RP' || lpad(id, GREATEST(8, len(id)), '0'), so it is RP +
    // 8 digits today and keeps every digit past 10^8 (bigint max = 19 digits).
    expect(overlay.ENUMS.DEVICE_TAG_OUT_PATTERN).toBe(service.DEVICE_TAG_PATTERN.source);
    const out = new RegExp(overlay.ENUMS.DEVICE_TAG_OUT_PATTERN);
    expect(out.test('RP00000042')).toBe(true);
    expect(out.test(`RP${'9'.repeat(19)}`)).toBe(true);
    expect(out.test('RP0000004')).toBe(false);
    expect(out.test('rp00000042')).toBe(false);
    // Inputs are case-insensitive because normalizeDeviceTag upper-cases first.
    const inp = new RegExp(overlay.ENUMS.DEVICE_TAG_IN_PATTERN);
    expect(inp.test('rp00000042')).toBe(true);
    expect(service.normalizeDeviceTag('rp00000042')).toBe('RP00000042');
  });
});

describe('settings and policy rows mirror their SELECT lists', () => {
  it('CathReprocessingSettings = SETTINGS_SELECT + the derived `configured` flag', () => {
    const columns = [...selectColumns('SETTINGS_SELECT'), 'configured'];
    const schema = overlay.schemas.CathReprocessingSettings;
    expect(schema.required).toEqual(columns);
    expect(Object.keys(schema.properties)).toEqual(columns);
  });

  it('CathReprocessingCategoryPolicy = POLICY_SELECT', () => {
    const columns = selectColumns('POLICY_SELECT');
    const schema = overlay.schemas.CathReprocessingCategoryPolicy;
    expect(schema.required).toEqual(columns);
    expect(Object.keys(schema.properties)).toEqual(columns);
  });

  it('the unconfigured settings row really does carry every published key', async () => {
    // getReprocessingSettings() synthesises a default row when the tenant has
    // saved nothing; that row must satisfy the same required list.
    const { setTenant } = await import('../../lib/prisma.js');
    setTenant.mockImplementationOnce((_tenantId, fn) => fn({ $queryRawUnsafe: async () => [] }));
    const settings = await service.getReprocessingSettings({
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
    expect(Object.keys(settings).sort())
      .toEqual([...overlay.schemas.CathReprocessingSettings.required].sort());
    expect(settings.configured).toBe(false);
  });
});

describe('published vocabularies are the service vocabularies', () => {
  it.each([
    ['CATEGORIES', 'CATH_CATEGORIES'],
    ['DEVICE_STATUSES', 'DEVICE_STATUSES'],
    ['CYCLE_TYPES', 'CYCLE_TYPES'],
    ['FUNCTION_CHECKS', 'FUNCTION_CHECK_RESULTS'],
    ['DISCARD_REASONS', 'DISCARD_REASONS'],
    ['POST_USE_DISPOSITIONS', 'POST_USE_DISPOSITIONS'],
    ['REACTIVE_PATIENT_RULES', 'REACTIVE_PATIENT_RULES'],
    ['UNKNOWN_SEROLOGY_RULES', 'UNKNOWN_SEROLOGY_RULES'],
  ])('overlay %s === service %s', (overlayName, serviceName) => {
    expect(overlay.ENUMS[overlayName]).toEqual([...service[serviceName]]);
  });

  it('the device row publishes those vocabularies on the columns that carry them', () => {
    const { properties } = overlay.schemas.CathReprocessableDevice;
    expect(properties.status.enum).toEqual([...service.DEVICE_STATUSES]);
    expect(properties.last_cycle_type.enum).toEqual([...service.CYCLE_TYPES]);
    expect(properties.last_function_check.enum).toEqual([...service.FUNCTION_CHECK_RESULTS]);
    expect(properties.discard_reason.enum).toEqual([...service.DISCARD_REASONS]);
    expect(properties.category.enum).toEqual([...service.CATH_CATEGORIES]);
  });
});

describe('CathPostUseOptions mirrors computePostUseOptions()', () => {
  it('publishes exactly the keys the function returns on every branch', () => {
    // The function spreads one `base` object on every return, so the key set is
    // invariant; take it from a real call rather than from the source text.
    const options = service.computePostUseOptions({
      usage: { quantity: 3 },
      category: 'balloon',
      isImplant: false,
      policy: { reprocessable: true, max_cycles: 5 },
      settings: { reactive_patient_rule: 'discard', unknown_serology_rule: 'warn' },
      restriction: { status: 'clear', reasons: [], markers: [] },
      device: null,
    });
    const schema = overlay.schemas.CathPostUseOptions;
    expect(Object.keys(options).sort()).toEqual(Object.keys(schema.properties).sort());
    expect([...schema.required].sort()).toEqual(Object.keys(options).sort());
    expect(schema.properties.units_max).toMatchObject({ type: 'integer', minimum: 0 });
    // units_max is the recorded quantity for a first-use row and 1 for a device.
    expect(options.units_max).toBe(3);
  });

  it('discard_reason and blocked_code publish the vocabularies the branches emit', () => {
    const schema = overlay.schemas.CathPostUseOptions;
    expect(schema.properties.discard_reason.enum).toEqual([...service.DISCARD_REASONS]);
    expect(schema.properties.blocked_code.nullable).toBe(true);
    // reason_codes stays an open string list — see the overlay's own note.
    expect(schema.properties.reason_codes.items).toEqual({ type: 'string' });
  });
});

describe('the post-use result contract admits the non-ordinary outcomes', () => {
  it('declares the replay and already-discarded flags recordPostUse can add', () => {
    // Both are real return keys (an idempotent replay, and a usage row settled
    // from a device CSSD discarded while it was still in the case). Under
    // additionalProperties:false, omitting either would make a genuine response
    // invalid against the published contract.
    const schema = overlay.schemas.CathPostUseResultData;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.idempotent_replay).toEqual({ type: 'boolean' });
    expect(schema.properties.device_already_discarded).toEqual({ type: 'boolean' });
    expect(SERVICE_SOURCE).toContain('idempotent_replay: true');
    expect(SERVICE_SOURCE).toContain('device_already_discarded: true');
    // ...and they are optional, because the ordinary result carries neither.
    expect(schema.required).not.toContain('idempotent_replay');
    expect(schema.required).not.toContain('device_already_discarded');
  });
});
