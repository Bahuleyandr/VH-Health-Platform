import {
  DEVICE_ACTIONS,
  computePostUseOptions,
  deviceTransition,
  normalizeDeviceTag,
} from '../../services/clinical/cathDeviceReuseService.js';

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
  test('a missing or malformed restriction is treated as unknown, never as clear', () => {
    expect(computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: null }).reason_codes).toEqual(['serology_unknown']);
    expect(computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: { status: 'bogus' } }).reason_codes).toEqual(['serology_unknown']);
  });
});
