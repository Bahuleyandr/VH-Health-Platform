import {
  CATH_CATEGORIES,
  DEVICE_ACTIONS,
  DEVICE_STATUSES,
  IMPLANT_CATEGORIES,
  __testing__,
  computePostUseOptions,
  deviceTransition,
  normalizeDeviceTag,
  projectReuseRestrictionForRole,
  roleSeesSerologyDetail,
  upsertCategoryPolicies,
  validatePolicyInput,
} from '../../services/clinical/cathDeviceReuseService.js';
import { CLINICAL_STAFF_ROUTE_ROLES } from '../../config/routeRolePolicy.js';

const policy = { reprocessable: true, max_cycles: 3, allowed_cycle_types: ['eto'], function_check_required: false };
const settings = { reactive_patient_rule: 'discard', unknown_serology_rule: 'warn', serology_validity_days: 90 };
const clear = { status: 'clear', reasons: [] };
const restricted = { status: 'restricted', reasons: ['HBsAg reactive 2026-08-12'] };
const unknown = { status: 'unknown', reasons: ['HCV not on record'] };
const firstUse = { id: 1, wasted: false, quantity: '2.0000', device_id: null, post_use_disposition: null };
const reusedRow = { id: 2, wasted: false, quantity: '1.0000', device_id: 9, reuse_cycle: 1, post_use_disposition: null };

describe('deviceTransition', () => {
  test.each([
    ['awaiting_reprocessing', 'receive', 'in_cssd'],
    ['awaiting_reprocessing', 'reprocessed', 'available'],
    ['in_cssd', 'reprocessed', 'available'],
    ['available', 'capture', 'in_case'],
    ['in_case', 'return', 'awaiting_reprocessing'],
    ['available', 'quarantine', 'quarantined'],
    ['quarantined', 'release', 'awaiting_reprocessing'],
    ['in_case', 'discard', 'discarded'],
    ['quarantined', 'discard', 'discarded'],
  ])('%s --%s--> %s', (from, action, to) => {
    expect(deviceTransition(from, action)).toEqual({ ok: true, to, allowedFrom: DEVICE_ACTIONS[action].from });
  });

  test.each([
    ['discarded', 'receive'], ['available', 'release'], ['in_case', 'reprocessed'],
    ['quarantined', 'capture'], ['discarded', 'discard'], ['awaiting_reprocessing', 'nonsense'],
  ])('%s --%s--> refused', (from, action) => {
    expect(deviceTransition(from, action).ok).toBe(false);
  });
});

describe('normalizeDeviceTag', () => {
  test('accepts RP + 8 digits in any case with surrounding whitespace', () => {
    expect(normalizeDeviceTag(' rp00000042 ')).toBe('RP00000042');
  });
  test('accepts longer ids once the register passes eight digits', () => {
    expect(normalizeDeviceTag('RP900000001')).toBe('RP900000001');
  });
  test.each(['RP42', 'XX00000042', '', null, 'RP0000004A', 'RP' + '1'.repeat(20)])('rejects %p', (value) => {
    expect(() => normalizeDeviceTag(value)).toThrow(/device tag/);
  });
});

describe('computePostUseOptions', () => {
  test('wasted rows offer nothing', () => {
    const out = computePostUseOptions({ usage: { ...firstUse, wasted: true }, category: 'catheter', isImplant: false, policy, settings, restriction: clear });
    expect(out).toMatchObject({ dispositions: [], reason_codes: ['wasted'] });
  });
  test('rows already dispositioned offer nothing', () => {
    const out = computePostUseOptions({ usage: { ...firstUse, post_use_disposition: 'sent_for_reprocessing' }, category: 'catheter', isImplant: false, policy, settings, restriction: clear });
    expect(out).toMatchObject({ dispositions: [], reason_codes: ['already_recorded'] });
  });
  test('implants and non-reprocessable categories offer nothing', () => {
    expect(computePostUseOptions({ usage: firstUse, category: 'stent', isImplant: true, policy: { ...policy }, settings, restriction: clear }).reason_codes).toEqual(['not_reprocessable']);
    expect(computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy: null, settings, restriction: clear }).reason_codes).toEqual(['not_reprocessable']);
    expect(computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy: { ...policy, reprocessable: false }, settings, restriction: clear }).reason_codes).toEqual(['not_reprocessable']);
  });
  test('clear serology: reprocess and discard, no acknowledgement, units up to the row quantity', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: clear });
    expect(out).toEqual({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: false, exposure: false, discard_reason: null, blocked_code: null, reason_codes: [], units_max: 2 });
  });
  test('restricted + discard rule: discard only, reason bloodborne_exposure', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: restricted });
    expect(out).toMatchObject({ dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['bloodborne_restricted'] });
  });
  test('restricted + override_allowed: reprocess with acknowledgement, device flagged', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings: { ...settings, reactive_patient_rule: 'override_allowed' }, restriction: restricted });
    expect(out).toMatchObject({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, exposure: true, reason_codes: ['bloodborne_restricted_override'] });
  });
  test('unknown + warn: reprocess with acknowledgement', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: unknown });
    expect(out).toMatchObject({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, exposure: false, reason_codes: ['serology_unknown'] });
  });
  test('unknown + block_return: discard only with the blocking code', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings: { ...settings, unknown_serology_rule: 'block_return' }, restriction: unknown });
    expect(out).toMatchObject({ dispositions: ['discard'], blocked_code: 'CATH_REPROCESSING_SEROLOGY_REQUIRED', reason_codes: ['serology_required'] });
  });
  test('a reused row whose device is at max cycles: discard only, reason max_cycles_reached, one unit', () => {
    const out = computePostUseOptions({ usage: reusedRow, category: 'catheter', isImplant: false, policy, settings, restriction: clear, device: { cycle_count: 3, max_cycles_snapshot: 3, status: 'in_case' } });
    expect(out).toMatchObject({ dispositions: ['discard'], discard_reason: 'max_cycles_reached', reason_codes: ['max_cycles_reached'], units_max: 1 });
  });
  test('a reused row below max cycles follows the serology rules with one unit', () => {
    const out = computePostUseOptions({ usage: reusedRow, category: 'catheter', isImplant: false, policy, settings, restriction: clear, device: { cycle_count: 1, max_cycles_snapshot: 3, status: 'in_case' } });
    expect(out).toMatchObject({ dispositions: ['reprocess', 'discard'], units_max: 1 });
  });
  test('a device carrying its own exposure flag is discard-only under the discard rule, even for a clear patient', () => {
    // The flag is a DIFFERENT fact from this patient's restriction status: the
    // late-reactive sweep stamps it from a PREVIOUS patient's reactive result.
    const out = computePostUseOptions({
      usage: reusedRow, category: 'catheter', isImplant: false, policy, settings, restriction: clear,
      device: { cycle_count: 1, max_cycles_snapshot: 3, status: 'in_case', exposure_flag: true },
    });
    expect(out).toMatchObject({ dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['device_exposure_flagged'], units_max: 1 });
  });
  test('an exposure-flagged device stays overridable while the tenant allows overrides', () => {
    const out = computePostUseOptions({
      usage: reusedRow, category: 'catheter', isImplant: false, policy,
      settings: { ...settings, reactive_patient_rule: 'override_allowed' }, restriction: clear,
      device: { cycle_count: 1, max_cycles_snapshot: 3, status: 'in_case', exposure_flag: true },
    });
    expect(out).toMatchObject({ dispositions: ['reprocess', 'discard'], reason_codes: [] });
  });
  test('max cycles still wins over the device exposure flag', () => {
    const out = computePostUseOptions({
      usage: reusedRow, category: 'catheter', isImplant: false, policy, settings, restriction: clear,
      device: { cycle_count: 3, max_cycles_snapshot: 3, status: 'in_case', exposure_flag: true },
    });
    expect(out.reason_codes).toEqual(['max_cycles_reached']);
  });
  test('a missing or malformed restriction is treated as unknown, never as clear', () => {
    expect(computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: null }).reason_codes).toEqual(['serology_unknown']);
    expect(computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: { status: 'bogus' } }).reason_codes).toEqual(['serology_unknown']);
  });
});

describe('DEVICE_ACTIONS', () => {
  test('every from-state is a real status and no action starts from the terminal one', () => {
    for (const [action, rule] of Object.entries(DEVICE_ACTIONS)) {
      expect(DEVICE_STATUSES).toContain(rule.to);
      for (const from of rule.from) {
        expect({ action, from, known: DEVICE_STATUSES.includes(from) }).toEqual({ action, from, known: true });
        expect({ action, from }).not.toEqual({ action, from: 'discarded' });
      }
    }
  });
});

describe('validatePolicyInput', () => {
  const base = { category: 'catheter', reprocessable: true, max_cycles: 3, allowed_cycle_types: ['eto'], function_check_required: false };

  test.each(IMPLANT_CATEGORIES)('%s can never be reprocessable', (category) => {
    expect(() => validatePolicyInput({ ...base, category })).toThrow(expect.objectContaining({ code: 'CATH_REPROCESSING_IMPLANT_FORBIDDEN', statusCode: 400 }));
  });
  test('an implant category is still allowed while it stays non-reprocessable', () => {
    expect(validatePolicyInput({ category: 'stent', reprocessable: false })).toMatchObject({ category: 'stent', reprocessable: false, maxCycles: null, cycleTypes: [] });
  });
  test('reprocessable without max_cycles is incomplete', () => {
    expect(() => validatePolicyInput({ ...base, max_cycles: null })).toThrow(expect.objectContaining({ code: 'CATH_REPROCESSING_POLICY_INCOMPLETE', statusCode: 400 }));
  });
  test('reprocessable without any cycle type is incomplete', () => {
    expect(() => validatePolicyInput({ ...base, allowed_cycle_types: [] })).toThrow(expect.objectContaining({ code: 'CATH_REPROCESSING_POLICY_INCOMPLETE', statusCode: 400 }));
  });
  test('duplicate cycle types are deduped', () => {
    expect(validatePolicyInput({ ...base, allowed_cycle_types: ['eto', 'ETO', ' eto ', 'steam'] }).cycleTypes).toEqual(['eto', 'steam']);
  });
  test.each([0, 51, -1, '0'])('max_cycles %p is rejected', (max_cycles) => {
    expect(() => validatePolicyInput({ ...base, max_cycles })).toThrow(expect.objectContaining({ code: 'CATH_LAB_BAD_ID', statusCode: 400 }));
  });
  test.each([1, 50])('max_cycles %p is accepted at the CHECK boundary', (max_cycles) => {
    expect(validatePolicyInput({ ...base, max_cycles }).maxCycles).toBe(max_cycles);
  });
  test('a valid entry normalises the category and returns the persisted shape', () => {
    expect(validatePolicyInput({ category: 'Catheter', reprocessable: 'true', max_cycles: '5', allowed_cycle_types: ['Steam'], function_check_required: 1 }))
      .toEqual({ category: 'catheter', reprocessable: true, maxCycles: 5, cycleTypes: ['steam'], functionCheck: true });
  });
  test('an unknown category is refused', () => {
    expect(() => validatePolicyInput({ ...base, category: 'defibrillator' })).toThrow(expect.objectContaining({ code: 'CATH_LAB_BAD_ENUM' }));
  });
});

describe('positiveInt is strict about how a number is SPELLED', () => {
  const { positiveInt } = __testing__;

  test('plain decimal digits, trimmed, in either type', () => {
    expect(positiveInt(7, 'x')).toBe(7);
    expect(positiveInt('7', 'x')).toBe(7);
    // Surrounding whitespace is a transport artefact, not a different value.
    expect(positiveInt(' 7 ', 'x')).toBe(7);
  });

  test.each(['7e2', '0x10', '+7', '7.0', '1e1', ' ', '', null, undefined, '-7', 'seven', '1_0', '٧'])(
    'rejects %p',
    (value) => {
      expect(() => positiveInt(value, 'device_id')).toThrow(
        expect.objectContaining({ code: 'CATH_LAB_BAD_ID', statusCode: 400 }),
      );
    },
  );

  test('the rejected spellings are exactly the ones Number() used to accept as a DIFFERENT number', () => {
    // This is the whole point: the old implementation was `Number(value)`, so
    // '7e2' reached a bigint id as 700 and '0x10' as 16.
    expect(Number('7e2')).toBe(700);
    expect(Number('0x10')).toBe(16);
    expect(Number('+7')).toBe(7);
    expect(Number('7.0')).toBe(7);
  });

  test('the bounds still apply on top of the shape', () => {
    expect(positiveInt('50', 'max_cycles', { max: 50 })).toBe(50);
    expect(() => positiveInt('51', 'max_cycles', { max: 50 })).toThrow(/positive integer/);
    expect(() => positiveInt('0', 'max_cycles')).toThrow(/positive integer/);
    expect(() => positiveInt(String(Number.MAX_SAFE_INTEGER) + '0', 'id')).toThrow(/positive integer/);
  });

  test('every tag the register can mint still parses (normalizeDeviceTag is unaffected)', () => {
    expect(normalizeDeviceTag('rp00000042')).toBe('RP00000042');
  });
});

describe('projectReuseRestrictionForRole', () => {
  const full = {
    status: 'restricted',
    reasons: ['HBsAg reactive 2026-08-12'],
    markers: [{ marker: 'hbsag', result: 'reactive', tested_on: '2026-08-12' }],
    validity_days: 90,
    evaluated_at: '2026-09-04T00:00:00.000Z',
  };

  test('a clinical role sees the object untouched, by identity', () => {
    expect(projectReuseRestrictionForRole(full, 'DOCTOR')).toBe(full);
    expect(roleSeesSerologyDetail('DOCTOR')).toBe(true);
  });

  test.each(['RECEPTIONIST', 'TECHNICIAN', 'BILLING_STAFF', 'STORES_PURCHASE_INCHARGE', 'HR_STAFF'])(
    '%s sees the decision but not the serology narrative',
    (role) => {
      expect(projectReuseRestrictionForRole(full, role)).toEqual({
        status: 'restricted',
        validity_days: 90,
        evaluated_at: '2026-09-04T00:00:00.000Z',
        reasons: [],
        markers: [],
      });
    },
  );

  test.each([null, undefined, '', 'NOT_A_ROLE', 'quality_officer'])(
    'an unrecognised role %p is projected, never trusted',
    (role) => {
      const projected = projectReuseRestrictionForRole(full, role);
      expect(projected.reasons).toEqual([]);
      expect(projected.markers).toEqual([]);
      // ...and the status still comes through, so the capture sheet can still
      // refuse a reuse it should refuse.
      expect(projected.status).toBe('restricted');
    },
  );

  test('the projected shape keeps EVERY published key — emptied, never dropped', () => {
    // BloodborneReuseStatus is additionalProperties:false with all five keys
    // required, so a dropped key would be a contract violation, not a redaction.
    expect(Object.keys(projectReuseRestrictionForRole(full, 'RECEPTIONIST')).sort())
      .toEqual(Object.keys(full).sort());
  });

  test('the audience is the platform clinical-staff list, not a private copy', () => {
    for (const role of CLINICAL_STAFF_ROUTE_ROLES) expect(roleSeesSerologyDetail(role)).toBe(true);
    // CLINICAL_STAFF_ROUTE_ROLES excludes reception by construction; that is
    // what makes the projection do anything on the cath surfaces.
    expect(CLINICAL_STAFF_ROUTE_ROLES).not.toContain('RECEPTIONIST');
  });

  test('a non-object restriction is returned as-is rather than fabricated', () => {
    expect(projectReuseRestrictionForRole(null, 'RECEPTIONIST')).toBeNull();
    expect(projectReuseRestrictionForRole(undefined, 'DOCTOR')).toBeUndefined();
  });
});

describe('upsertCategoryPolicies refuses an ambiguous batch before it opens a transaction', () => {
  const TENANT = '00000000-0000-4000-8000-000000000001';
  const ACTOR = '11111111-1111-4111-8111-111111111111';
  const entry = (category) => ({ category, reprocessable: false });

  test('the same category twice is a 400, not a last-writer-wins race', async () => {
    // Both rows key on (tenant_id, category); upserting the same key twice in
    // one request leaves the caller unable to say which of its entries won.
    await expect(upsertCategoryPolicies(
      { tenantId: TENANT, policies: [entry('catheter'), entry('balloon'), entry('catheter')] },
      { actorUid: ACTOR },
    )).rejects.toEqual(expect.objectContaining({ code: 'CATH_REPROCESSING_POLICY_DUPLICATE', statusCode: 400 }));
  });

  test('more entries than there are categories is refused before validation work', async () => {
    await expect(upsertCategoryPolicies(
      { tenantId: TENANT, policies: CATH_CATEGORIES.map(entry).concat([entry('other')]) },
      { actorUid: ACTOR },
    )).rejects.toEqual(expect.objectContaining({ code: 'CATH_REPROCESSING_POLICY_DUPLICATE', statusCode: 400 }));
  });

  test('an empty batch is still the INCOMPLETE code, not the new one', async () => {
    await expect(upsertCategoryPolicies(
      { tenantId: TENANT, policies: [] },
      { actorUid: ACTOR },
    )).rejects.toEqual(expect.objectContaining({ code: 'CATH_REPROCESSING_POLICY_INCOMPLETE' }));
  });
});
