/**
 * SOURCE PIN for scripts/openapi/schemas/cathLabReadiness.mjs.
 *
 * Every published shape in that overlay is additionalProperties:false, so a key
 * the service returns and the overlay does not declare is a response that
 * violates its own contract — and nothing else in the repo would notice: the
 * spec gate (openapiContracts) only checks that the schemas COMPILE and that
 * every overlay key names a real route, never that they describe what the
 * handler actually sends.
 *
 * So this suite does not read the overlay against a hand-copied list. It DRIVES
 * the real service and compares key sets:
 *
 *   - resolveItemState() is pure, so it is called directly, on all four of its
 *     branches (nothing, a fresh result, an open order, a waiver), and the
 *     UNION of the keys it produces is what CathLabReadinessItem must declare;
 *   - refreshCaseLabReadiness() accepts an injected `db`, so it is run end to
 *     end against a stub client that answers each of its statements — the
 *     return is the real return, not a fixture that can drift from it;
 *   - getReadinessSettings() is driven in BOTH of its shapes (a configured
 *     tenant's row, and the compiled-in defaults for a tenant that has never
 *     saved one), because they differ: the defaults carry no updated_by,
 *     created_at or updated_at, which is exactly why those three are declared
 *     but not required.
 *
 * The two action payloads (order-missing, external-result) build their return
 * outside any injectable seam, so they are pinned against the service's return
 * statements as source text instead — still a real pin: editing either return
 * without editing the schema fails here.
 */

import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

const TENANT = '11111111-2222-4333-8444-555555555555';
const PATIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CASE_ID = 42;

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

const {
  ITEM_CODES,
  ITEM_SOURCES,
  ITEM_STATES,
  getReadinessSettings,
  refreshCaseLabReadiness,
  resolveItemState,
} = await import('../../services/clinical/cathLabReadinessService.js');
const { orderCodesCovering } = await import('../../services/lab/labAnalyteCodes.js');
const { ENUMS, operations, schemas } = await import(
  '../../../scripts/openapi/schemas/cathLabReadiness.mjs'
);
const { buildOpenApiDocument } = await import('../../../scripts/openapi/buildSpec.mjs');

const SERVICE_SOURCE = readFileSync(
  new URL('../../services/clinical/cathLabReadinessService.js', import.meta.url),
  'utf8',
);
const MIGRATION_482 = readFileSync(
  new URL('../../migrations/482_cath_lab_cases_readiness.sql', import.meta.url),
  'utf8',
);

const CASE_ROW = {
  id: 42n,
  tenant_id: TENANT,
  patient_uid: PATIENT,
  encounter_id: null,
  facility_id: 1,
  status: 'scheduled',
  urgency: 'elective',
  actual_start_at: null,
};

/**
 * A client that answers each statement refreshCaseLabReadiness issues. Matching
 * on the FROM target rather than on call order, so reordering the reads inside
 * the service does not silently start feeding one query another's rows.
 */
function stubDb({ settingsRow = null, caseRow = CASE_ROW } = {}) {
  return {
    $queryRawUnsafe: async (sql) => {
      if (/FROM cath_lab_cases/.test(sql)) return [caseRow];
      if (/FROM cath_lab_readiness_settings/.test(sql)) return settingsRow ? [settingsRow] : [];
      if (/FROM cath_reprocessing_settings/.test(sql)) return [];
      if (/FROM lab_results/.test(sql)) return [];
      // Before the investigations branch: the open-order read joins bookings to
      // investigations, and the booking-only read (spec §7 step 2) selects FROM
      // investigation_bookings, which the /FROM investigations/ pattern does
      // not match. Ordered so neither read can be answered with the other's
      // rows.
      if (/FROM investigation_bookings/.test(sql)) return [];
      if (/FROM investigations/.test(sql)) return [];
      if (/FROM lab_specimens/.test(sql)) return [];
      if (/FROM cath_case_lab_readiness_items/.test(sql)) return [];
      if (/FROM cath_lab_readiness_checks/.test(sql)) return [];
      throw new Error(`unstubbed query: ${sql.slice(0, 120)}`);
    },
    $executeRawUnsafe: async () => 1,
  };
}

/** Every key resolveItemState can put on an item, across all four branches. */
function resolverKeys() {
  const asOf = new Date('2026-09-04T06:00:00.000Z');
  const fresh = {
    id: 9, test_code: 'HGB', value_text: '11.2', value_numeric: 11.2, unit: 'g/dL',
    abnormal_flag: 'L', is_critical: false, status: 'final',
    signed_off_at: '2026-09-03T06:00:00.000Z', performed_at: '2026-09-03T05:00:00.000Z',
    received_at: '2026-09-03T05:30:00.000Z', result_origin: 'analyzer',
  };
  const order = {
    id: 5, test_code: 'CBC', status: 'REQUESTED',
    requested_at: '2026-09-03T04:00:00.000Z', collected_at: null, booking_id: null,
  };
  const waiver = {
    waived_by: PATIENT, waived_at: '2026-09-04T05:00:00.000Z', waive_reason: 'on file elsewhere',
  };
  const branches = [
    { item: 'hb', windowDays: 30, asOf },
    { item: 'hb', results: [fresh], windowDays: 30, asOf },
    { item: 'hb', orders: [order], windowDays: 30, asOf },
    { item: 'hb', results: [fresh], waiver, windowDays: 30, asOf },
  ];
  const keys = new Set();
  for (const branch of branches) {
    for (const key of Object.keys(resolveItemState(branch))) keys.add(key);
  }
  // refreshCaseLabReadiness adds exactly one key of its own to every item.
  keys.add('required');
  return keys;
}

describe('cathLabReadiness overlay enums are the service vocabulary', () => {
  it('ITEMS and STATES are the service constants, in the service order', () => {
    expect(ENUMS.ITEMS).toEqual([...ITEM_CODES]);
    expect(ENUMS.STATES).toEqual([...ITEM_STATES]);
    expect(ENUMS.SOURCES).toEqual([...ITEM_SOURCES]);
  });

  it('ORDER_CODES is what orderCodesCovering can actually emit', () => {
    // Derived, not transcribed: the code that answers `orderable_now` is asked
    // for the widest possible answer and that is the published enum.
    expect(ENUMS.ORDER_CODES).toEqual(orderCodesCovering([...ITEM_CODES]));
  });

  it('CHECK_STATUSES is migration 482\'s readiness-check CHECK constraint', () => {
    const list = ENUMS.CHECK_STATUSES.map((status) => `'${status}'`).join(', ');
    expect(MIGRATION_482).toContain(`CHECK (status IN (${list}))`);
  });

  it('QUALITATIVE_VALUES is the token list recordExternalLabResult accepts', () => {
    const literal = ENUMS.QUALITATIVE_VALUES.map((token) => `'${token}'`).join(', ');
    expect(SERVICE_SOURCE.replace(/\s*\n\s*/g, ' ')).toContain(literal);
  });

  it('every enum in the overlay schemas draws from those lists', () => {
    expect(schemas.CathLabReadinessItem.properties.item_code.enum).toEqual(ENUMS.ITEMS);
    expect(schemas.CathLabReadinessItem.properties.state.enum).toEqual(ENUMS.STATES);
    expect(schemas.CathLabReadinessItem.properties.source.enum).toEqual(ENUMS.SOURCES);
    expect(schemas.CathLabReadiness.properties.check_status.enum).toEqual(ENUMS.CHECK_STATUSES);
    expect(schemas.CathLabReadiness.properties.orderable_now.items.enum).toEqual(ENUMS.ORDER_CODES);
    expect(schemas.CathLabReadinessSettings.properties.required_items.items.enum)
      .toEqual(ENUMS.ITEMS);
  });
});

describe('the published shapes cover every key the service returns', () => {
  it('CathLabReadinessItem declares exactly resolveItemState\'s keys plus `required`', () => {
    const item = schemas.CathLabReadinessItem;
    const keys = resolverKeys();
    expect(item.additionalProperties).toBe(false);
    expect(new Set(Object.keys(item.properties))).toEqual(keys);
    // Every branch spreads a full `base`, so every key is ALWAYS present — the
    // ones with nothing to say are null, never absent. That is what makes the
    // whole key set required rather than a handful of it.
    expect(new Set(item.required)).toEqual(keys);
  });

  it('CathLabReadiness declares exactly refreshCaseLabReadiness\'s keys', async () => {
    const readiness = await refreshCaseLabReadiness({
      tenantId: TENANT,
      caseId: CASE_ID,
      db: stubDb(),
      context: {},
    });
    const schema = schemas.CathLabReadiness;
    expect(schema.additionalProperties).toBe(false);
    expect(new Set(Object.keys(schema.properties))).toEqual(new Set(Object.keys(readiness)));
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(readiness)));
    // Named explicitly: an earlier draft of this overlay declared a
    // `_missing_items` the service has never emitted.
    expect(schema.properties).not.toHaveProperty('_missing_items');

    expect(new Set(Object.keys(schema.properties.settings.properties)))
      .toEqual(new Set(Object.keys(readiness.settings)));
    expect(new Set(schema.properties.settings.required))
      .toEqual(new Set(Object.keys(readiness.settings)));
    expect(new Set(Object.keys(schema.properties.missing.items.properties)))
      .toEqual(new Set(['item', 'state']));

    // case_id reaches the wire as a JSON number — cath_lab_cases.id is bigint,
    // but the service passes it through num(), so it is never the
    // decimal-string half of a bigint union the way a path parameter is.
    expect(typeof readiness.case_id).toBe('number');
    expect(schema.properties.case_id).toEqual({ type: 'integer', minimum: 1 });
    expect(schema.properties.case_id).not.toHaveProperty('oneOf');
  });

  it('the seven items the refresh returns validate against the item schema keys', async () => {
    const readiness = await refreshCaseLabReadiness({
      tenantId: TENANT, caseId: CASE_ID, db: stubDb(), context: {},
    });
    expect(readiness.items).toHaveLength(ENUMS.ITEMS.length);
    const declared = new Set(Object.keys(schemas.CathLabReadinessItem.properties));
    for (const item of readiness.items) {
      expect(new Set(Object.keys(item))).toEqual(declared);
      expect(ENUMS.ITEMS).toContain(item.item_code);
      expect(ENUMS.STATES).toContain(item.state);
    }
  });

  it('CathLabReadinessSettings covers BOTH getReadinessSettings shapes', async () => {
    const schema = schemas.CathLabReadinessSettings;
    const declared = new Set(Object.keys(schema.properties));

    const defaults = await getReadinessSettings({ tenantId: TENANT, db: stubDb() });
    const configured = await getReadinessSettings({
      tenantId: TENANT,
      db: stubDb({
        settingsRow: {
          tenant_id: TENANT,
          required_items: ['hb', 'hiv'],
          lab_validity_days: 21,
          auto_pass: false,
          external_results_count: true,
          updated_by: PATIENT,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-02T00:00:00.000Z',
        },
      }),
    });

    expect(schema.additionalProperties).toBe(false);
    for (const shape of [defaults, configured]) {
      for (const key of Object.keys(shape)) expect(declared).toContain(key);
    }
    // The union is what is DECLARED; the intersection is what is REQUIRED.
    expect(new Set(Object.keys(configured))).toEqual(declared);
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(defaults)));
    expect(defaults.configured).toBe(false);
    expect(configured.configured).toBe(true);
    // The three that only a saved row carries.
    for (const key of ['updated_by', 'created_at', 'updated_at']) {
      expect(schema.required).not.toContain(key);
      expect(schema.properties[key].nullable).toBe(true);
      expect(defaults).not.toHaveProperty(key);
    }
  });

  it('the two action payloads match the service\'s return statements', () => {
    // No injectable seam on either function, so the return literal is the pin.
    expect(SERVICE_SOURCE).toContain('return { created, skipped, readiness: after };');
    expect(schemas.CathLabReadinessOrderMissingData.required)
      .toEqual(['created', 'skipped', 'readiness']);
    expect(schemas.CathLabReadinessOrderMissingData.properties.readiness)
      .toEqual({ $ref: '#/components/schemas/CathLabReadiness' });
    expect(Object.keys(schemas.CathLabReadinessOrderMissingData.properties.created.items.properties))
      .toEqual(['code', 'investigation_id']);
    expect(Object.keys(schemas.CathLabReadinessOrderMissingData.properties.skipped.items.properties))
      .toEqual(['code', 'reason']);
    // `skipped` is only ever built from orderable_now, so its codes are the
    // same closed set the created ones are.
    expect(SERVICE_SOURCE).toContain(".map((code) => ({ code, reason: 'already_ordered' }))");
    expect(schemas.CathLabReadinessOrderMissingData.properties.skipped.items.properties.code.enum)
      .toEqual(ENUMS.ORDER_CODES);

    expect(SERVICE_SOURCE)
      .toContain('return { lab_result_id: Number(labResult.id), item, readiness };');
    expect(schemas.CathLabReadinessExternalResultData.required)
      .toEqual(['lab_result_id', 'item', 'readiness']);
    expect(schemas.CathLabReadinessExternalResultData.properties.readiness)
      .toEqual({ $ref: '#/components/schemas/CathLabReadiness' });
  });

  it('the external-result request is not stricter than the service', () => {
    const request = schemas.CathLabReadinessExternalResultRequest;
    // The service refuses a missing lab name or observed_on outright, so those
    // two are required. value_text is NOT: a quantitative item may arrive with
    // value_numeric alone (`Number(input.value_numeric ?? valueText)`), and a
    // contract that demanded value_text would refuse a request the handler
    // accepts.
    expect(request.required).toEqual(['observed_on', 'external_lab_name']);
    expect(Object.keys(request.properties).sort()).toEqual([
      'external_lab_name', 'external_report_ref', 'notes',
      'observed_on', 'unit', 'value_numeric', 'value_text',
    ]);
    expect(request.properties.value_text.maxLength).toBe(255);
    expect(request.properties.external_lab_name.maxLength).toBe(160);
    expect(request.properties.external_report_ref.maxLength).toBe(120);
    expect(request.properties.notes.maxLength).toBe(2000);
    expect(request.properties.unit.maxLength).toBe(40);
    expect(request.properties.value_numeric.minimum).toBe(0);
    expect(schemas.CathLabReadinessWaiveRequest.required).toEqual(['reason']);
    expect(schemas.CathLabReadinessWaiveRequest.properties.reason.maxLength).toBe(500);
  });
});

describe('the seven operations describe the routes that exist', () => {
  const CATH = '/api/v1/cath-lab/cases/{id}/readiness/labs';
  const SETTINGS = '/api/v1/cath-reprocessing/lab-readiness-settings';
  // Documented in prose only: it predates this overlay and still answers the
  // generic Success envelope, so it carries a description and nothing else.
  const EVIDENCE = 'POST /api/v1/cath-lab/cases/{id}/readiness/evidence/refresh';

  const COMMANDS = [
    [`POST ${CATH}/order-missing`, 'CathLabReadinessOrderMissingResponse', '201'],
    [`POST ${CATH}/{item}/external-result`, 'CathLabReadinessExternalResultResponse', '201'],
    [`POST ${CATH}/{item}/waive`, 'CathLabReadinessResponse', '200'],
    [`PUT ${SETTINGS}`, 'CathLabReadinessSettingsResponse', '200'],
  ];
  const READS = [
    [`GET ${CATH}`, 'CathLabReadinessResponse'],
    [`GET ${SETTINGS}`, 'CathLabReadinessSettingsResponse'],
  ];

  function generated(key) {
    const [method, path] = key.split(' ');
    const document = buildOpenApiDocument(
      [{ method: method.toLowerCase(), path }],
      {
        openapi: '3.0.3',
        components: { schemas },
        tagRegistry: [{ slug: 'cath-lab' }, { slug: 'cath-reprocessing' }],
      },
      operations,
    );
    return document.paths[path][method.toLowerCase()];
  }

  it('covers exactly the four cath routes, evidence-refresh and the two governance routes', () => {
    expect(Object.keys(operations).sort()).toEqual(
      [...COMMANDS.map(([key]) => key), ...READS.map(([key]) => key), EVIDENCE].sort(),
    );
  });

  it.each([...COMMANDS.map(([key]) => key), ...READS.map(([key]) => key), EVIDENCE])(
    '%s carries a description',
    (key) => {
      expect(operations[key].description).toEqual(expect.any(String));
      expect(operations[key].description.trim().length).toBeGreaterThan(40);
    },
  );

  it('the evidence refresh is documented but still generically typed', () => {
    // Honesty rather than a shape it does not have: the handler answers
    // { ...evidence refresh result, labs: CathLabReadiness | null }, and only
    // the `labs` half has a schema here — so the description says so and the
    // response stays the generic Success envelope.
    expect(operations[EVIDENCE]).not.toHaveProperty('response');
    expect(operations[EVIDENCE]).not.toHaveProperty('request');
    expect(operations[EVIDENCE].description).toMatch(/labs: null/);
    expect(generated(EVIDENCE).responses['200'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/Success' });
  });

  it.each(COMMANDS)('%s claims an Idempotency-Key and answers %s at %s', (key, response, status) => {
    // The header is documented because the route REQUIRES it: all four are
    // clinical or governance writes, the waive included.
    expect(operations[key].parameters).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]);
    expect(operations[key].response).toBe(response);
    const responses = generated(key).responses;
    expect(Object.keys(responses)).toContain(status);
    // Everything else on the operation is a documented §11 failure, and every
    // one of them answers the SAME envelope — `code` at the root, not nested.
    for (const [code, body] of Object.entries(responses)) {
      if (code === status) continue;
      expect({ key, code, schema: body.content['application/json'].schema })
        .toEqual({ key, code, schema: { $ref: '#/components/schemas/CathLabReadinessErrorResponse' } });
    }
  });

  it.each(READS)('%s is a read: no Idempotency-Key, answers %s', (key, response) => {
    expect(operations[key].parameters ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key' }),
    ]));
    expect(generated(key).parameters ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key' }),
    ]));
    expect(operations[key].response).toBe(response);
    expect(operations[key]).not.toHaveProperty('request');
  });

  it('the {item} path parameter is the closed item vocabulary, {id} a bigint', () => {
    for (const key of [
      `POST ${CATH}/{item}/external-result`,
      `POST ${CATH}/{item}/waive`,
    ]) {
      expect(operations[key].pathParameters.item).toEqual({ type: 'string', enum: ENUMS.ITEMS });
      expect(operations[key].pathParameters.id.oneOf).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'string', pattern: '^[1-9][0-9]*$' }),
      ]));
    }
  });

  it('the documented §11 codes are the ones the readiness service and route raise', () => {
    // The overlay's ERROR_CODES enum against the throw sites themselves: a code
    // added to the readiness service/route and not documented, or documented
    // and never raised, fails here rather than being discovered by a client.
    // Scope is deliberately narrow — SERVICE_SOURCE is
    // services/clinical/cathLabReadinessService.js only. cathLabService.js
    // (case management/scheduling) raises its own CATH_LAB_READINESS_BLOCKED
    // and CATH_LAB_READINESS_REVIEW_FAILED for operations this overlay does
    // not type, so this test does not and should not see them.
    const ROUTE_SOURCE = readFileSync(
      new URL('../../routes/clinical/cathLabRoutes.js', import.meta.url),
      'utf8',
    );
    const raised = new Set(
      [...`${SERVICE_SOURCE}${ROUTE_SOURCE}`.matchAll(/'(CATH_LAB_READINESS_[A-Z_]+)'/g)]
        .map((match) => match[1])
        // Not a failure: the audit action name for a settings write.
        .filter((code) => code !== 'CATH_LAB_READINESS_SETTINGS_UPDATED'),
    );
    expect([...ENUMS.ERROR_CODES].sort()).toEqual([...raised].sort());
    expect(schemas.CathLabReadinessErrorResponse.properties.code.enum)
      .toEqual([...ENUMS.ERROR_CODES]);
    // The route's own :item guard answers the SAME code the service does, so a
    // client reads one envelope whichever layer refused it.
    expect(ROUTE_SOURCE).toContain("topLevel: { code: 'CATH_LAB_READINESS_ITEM_UNKNOWN' }");
  });

  it('an external result must carry a value in one field or the other', () => {
    // `required` cannot say this — WHICH field carries the value depends on the
    // item — so without the anyOf a body with no value at all was
    // contract-valid and only the service's 400 caught it.
    expect(schemas.CathLabReadinessExternalResultRequest.anyOf)
      .toEqual([{ required: ['value_text'] }, { required: ['value_numeric'] }]);
  });

  it('the governance operations name the mount that owns them, not the admin console', () => {
    // The read names the audience outright; the write names the claim scope it
    // shares with the reprocessing policy writes, which is the same statement
    // about which screen and which mount owns it.
    expect(operations[`GET ${SETTINGS}`].description).toMatch(/QUALITY_OFFICER/);
    expect(operations[`PUT ${SETTINGS}`].description).toMatch(/cath_reprocessing_policy/);
    // The paths themselves are the load-bearing part: /api/v1/admin/... would
    // put this behind ADMIN_ROUTE_ROLES, which admits neither officer.
    expect(Object.keys(operations).every((key) => !key.includes('/api/v1/admin/'))).toBe(true);
  });
});
