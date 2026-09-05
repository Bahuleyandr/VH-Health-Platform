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
import * as consumablesOverlay from '../../../scripts/openapi/schemas/cathConsumables.mjs';

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

describe('CssdDeviceQueueItem is the device row plus what the queue joins in', () => {
  const columns = selectColumns('DEVICE_SELECT');
  const schema = overlay.schemas.CssdDeviceQueueItem;

  it('publishes every device column plus facility_name and status_changed_at', () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([...columns, 'facility_name', 'status_changed_at']);
    expect(Object.keys(schema.properties)).toEqual([...columns, 'facility_name', 'status_changed_at']);
    // The device columns keep the SAME published shapes — the queue item is
    // the device row widened, not a second opinion about it.
    for (const column of columns) {
      expect(schema.properties[column]).toEqual(overlay.schemas.CathReprocessableDevice.properties[column]);
    }
  });

  it('the queue SELECT really returns those two, and only the queue does', () => {
    expect(SERVICE_SOURCE).toContain('AS facility_name');
    expect(SERVICE_SOURCE).toContain('AS status_changed_at');
    // DEVICE_SELECT is what every OTHER device surface reads; widening it
    // would make CathReprocessableDevice (additionalProperties:false) reject
    // its own responses.
    expect(selectColumns('DEVICE_SELECT')).not.toContain('display_name AS facility_name');
    expect(columns).toHaveLength(31);
  });

  it('status_changed_at is derived from TRANSITIONS, never the exposure stamp', () => {
    // The whole reason the column is derived rather than read from
    // updated_at: flagDeviceExposureTx moves updated_at without moving the
    // device. Counting cath_device.exposure_flagged here would restart a
    // queued device's clock on some other patient's lab result.
    const actions = SERVICE_SOURCE.match(
      /const DEVICE_STATUS_AUDIT_ACTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/,
    );
    expect(actions).not.toBeNull();
    expect(actions[1]).toContain("'cath_device.created'");
    expect(actions[1]).not.toContain('exposure_flagged');
    // ...and the writer really does use that action name, so the exclusion is
    // excluding something that exists.
    expect(SERVICE_SOURCE).toContain("action: 'cath_device.exposure_flagged'");
  });

  it('publishes both joined columns as NON-nullable, and the normaliser agrees', () => {
    // The contract says string, not string|null, because the SQL guarantees
    // it: an INNER join on a RESTRICT foreign key with a NOT NULL
    // display_name, and a COALESCE onto d.created_at (NOT NULL DEFAULT NOW(),
    // migration 765). A `?? null` in the normaliser would publish one thing
    // and answer another — the admin console's generated types say the null
    // cannot happen, so its sort would compare NaN and its clock would read
    // "-" forever, with nothing failing anywhere.
    expect(schema.properties.facility_name).toEqual({ type: 'string' });
    expect(schema.properties.status_changed_at.nullable).toBeUndefined();
    const normalizer = SERVICE_SOURCE.match(
      /function normalizeQueueDevice\(row\) \{([\s\S]*?)\n\}/,
    );
    expect(normalizer).not.toBeNull();
    expect(normalizer[1]).toContain('facility_name: row.facility_name,');
    expect(normalizer[1]).toContain('status_changed_at: row.status_changed_at,');
    expect(normalizer[1]).not.toContain('??');
  });

  it('the queue list response carries the queue item, not the bare device', () => {
    expect(overlay.schemas.CssdDeviceListResponse.properties.data.items).toEqual({
      $ref: '#/components/schemas/CssdDeviceQueueItem',
    });
    // ...while the single-device transition responses stay the device row:
    // those handlers return lockDeviceTx's row, which has neither column.
    expect(overlay.schemas.CssdDeviceResponse.properties.data).toEqual({
      $ref: '#/components/schemas/CathReprocessableDevice',
    });
  });
});

describe('CssdDeviceLabel mirrors the fields the label actually carries', () => {
  const schema = overlay.schemas.CssdDeviceLabel;

  it('publishes exactly DEVICE_LABEL_FIELDS, in order, all required', () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([...service.DEVICE_LABEL_FIELDS]);
    expect(Object.keys(schema.properties)).toEqual([...service.DEVICE_LABEL_FIELDS]);
  });

  it('carries NO serology, exposure or patient column', () => {
    // The label is printed and travels with the device. exposure_markers names
    // a blood-borne marker a PREVIOUS patient tested reactive for, and it is
    // on the device row one join away — publishing it here would put a
    // serology disclosure on a sticker.
    for (const forbidden of [
      'exposure_flag', 'exposure_markers', 'patient_uid', 'reuse_screen',
      'post_use_screen', 'reuse_restriction', 'current_usage_id', 'origin_usage_id',
    ]) {
      expect(Object.keys(schema.properties)).not.toContain(forbidden);
    }
  });

  it('speaks the category vocabulary and bounds the cycle counters', () => {
    expect(schema.properties.category.enum).toEqual([...service.CATH_CATEGORIES]);
    expect(schema.properties.device_tag.pattern).toBe(overlay.ENUMS.DEVICE_TAG_OUT_PATTERN);
    // cycle_count starts at 0 and max_cycles_snapshot at 1, the same bounds
    // the device row publishes for the columns these two are read from.
    expect(schema.properties.reuse_cycle).toMatchObject({ type: 'integer', minimum: 0 });
    expect(schema.properties.max_cycles).toMatchObject({ type: 'integer', minimum: 1 });
  });

  it('the operation declares BOTH answers the route can send', () => {
    const operation = overlay.operations['GET /api/v1/cssd/devices/{id}/label'];
    const content = operation.additionalResponses[200].content;
    expect(Object.keys(content).sort()).toEqual(['application/json', 'application/pdf']);
    expect(content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CssdDeviceLabelResponse',
    });
    expect(content['application/pdf'].schema).toEqual({ type: 'string', format: 'binary' });
    // The format switch is published with the two values the service accepts.
    const format = operation.parameters.find((parameter) => parameter.name === 'format');
    expect(format.schema.enum).toEqual([...service.DEVICE_LABEL_FORMATS]);
    expect(format.required).toBe(false);
  });

  it('publishes the 409 a discarded device answers, and the code it carries', () => {
    // The console hides the button; the SERVICE is the authority and the spec
    // is what a second client reads. All three have to say the same thing.
    const operation = overlay.operations['GET /api/v1/cssd/devices/{id}/label'];
    const conflict = operation.additionalResponses[409];
    expect(conflict.description).toContain('CSSD_DEVICE_LABEL_NOT_PRINTABLE');
    expect(conflict.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CssdDeviceLabelErrorResponse',
    });
    expect(overlay.schemas.CssdDeviceLabelErrorResponse.properties.code.enum)
      .toContain('CSSD_DEVICE_LABEL_NOT_PRINTABLE');
    // ...and the code the service throws is that one, spelled the same way.
    expect(SERVICE_SOURCE).toContain("'CSSD_DEVICE_LABEL_NOT_PRINTABLE'");
    // The refused status is the register's ONE terminal state — a wider gate
    // would take the tag away from CSSD while it still holds the device.
    expect(service.DEVICE_LABEL_BLOCKED_STATUS).toBe('discarded');
    expect([...service.DEVICE_STATUSES]).toContain(service.DEVICE_LABEL_BLOCKED_STATUS);
  });

  it('the published error codes are the ones this route can actually answer', () => {
    for (const code of overlay.ENUMS.DEVICE_LABEL_ERROR_CODES) {
      // Every published code is thrown by the service or by the shared id
      // guard the route sits behind — no aspirational vocabulary.
      expect(
        SERVICE_SOURCE.includes(`'${code}'`) || code === 'CATH_LAB_BAD_ID',
      ).toBe(true);
    }
    expect(overlay.ENUMS.DEVICE_LABEL_ERROR_CODES).toContain('CATH_DEVICE_NOT_FOUND');
    expect(overlay.ENUMS.DEVICE_LABEL_ERROR_CODES).toContain('CSSD_DEVICE_LABEL_FORMAT_INVALID');
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

describe('the cath-consumables overlay speaks the register vocabularies', () => {
  it('device_status on the decorated usage row publishes DEVICE_STATUSES', () => {
    // decorateConsumablesWithReuse copies cath_reprocessable_devices.status
    // verbatim onto the row, so a bare string here published a wider contract
    // than the register can ever emit.
    const property = consumablesOverlay.schemas.CathCaseConsumableUsage.properties.device_status;
    expect(property.enum).toEqual([...service.DEVICE_STATUSES]);
    expect(property.nullable).toBe(true);
  });

  it('the unbilled worklist item publishes the two reuse columns its SELECT returns', () => {
    // cathLabService.listUnbilledConsumableUsage selects u.reuse_cycle and
    // c.reused_billing_item_code, and this schema is additionalProperties:false
    // — omitting either made every reused row a response the contract forbids.
    const schema = consumablesOverlay.schemas.CathConsumableUnbilledUsageItem;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.reuse_cycle).toEqual({ type: 'integer', nullable: true });
    expect(schema.properties.reused_billing_item_code).toEqual({ type: 'string', nullable: true });
    expect(schema.required).toEqual(expect.arrayContaining(['reuse_cycle', 'reused_billing_item_code']));
  });

  it('the published units ceiling is the service constant, not a second opinion', () => {
    expect(overlay.schemas.CathPostUseRequest.properties.units.maximum)
      .toBe(service.POST_USE_UNITS_CAP);
    expect(service.POST_USE_UNITS_CAP).toBe(50);
  });
});
