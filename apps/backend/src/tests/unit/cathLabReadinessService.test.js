// apps/backend/src/tests/unit/cathLabReadinessService.test.js
import {
  ITEM_CODES,
  SETTINGS_DEFAULTS,
  computeCheckDecision,
  isCriticalResult,
  resolveItemState,
} from '../../services/clinical/cathLabReadinessService.js';

const AS_OF = new Date('2026-09-04T10:00:00.000Z');
const daysAgo = (n) => new Date(AS_OF.getTime() - n * 86_400_000).toISOString();
const settings = { ...SETTINGS_DEFAULTS };

describe('resolveItemState', () => {
  const base = { item: 'potassium', windowDays: 30, asOf: AS_OF, results: [], orders: [], specimens: [] };

  test('no result, no order -> not_ordered', () => {
    expect(resolveItemState(base)).toMatchObject({ state: 'not_ordered', lab_result_id: null, investigation_id: null });
  });

  test('final signed result within window -> result_final with copied values', () => {
    const out = resolveItemState({ ...base, results: [
      { id: 7, test_code: 'K', value_text: '6.1', value_numeric: 6.1, unit: 'mmol/L', abnormal_flag: 'HH', is_critical: true, status: 'final', signed_off_at: daysAgo(1), performed_at: daysAgo(1), received_at: daysAgo(1), result_origin: 'analyzer' },
    ] });
    expect(out).toMatchObject({ state: 'result_final', lab_result_id: 7, value_numeric: 6.1, abnormal_flag: 'HH', is_critical: true, source: 'lab_result' });
  });

  test('preliminary result -> result_preliminary; external origin -> external_recorded', () => {
    expect(resolveItemState({ ...base, results: [{ id: 8, test_code: 'K', value_text: '4.0', status: 'preliminary', signed_off_at: null, performed_at: daysAgo(2), received_at: daysAgo(2), result_origin: 'manual_in_house' }] }).state).toBe('result_preliminary');
    expect(resolveItemState({ ...base, results: [{ id: 9, test_code: 'K', value_text: '4.0', status: 'preliminary', signed_off_at: null, performed_at: daysAgo(2), received_at: daysAgo(2), result_origin: 'external_lab' }] }).state).toBe('external_recorded');
  });

  test('latest result wins; cancelled rows are ignored', () => {
    const out = resolveItemState({ ...base, results: [
      { id: 1, test_code: 'K', value_text: '3.0', status: 'final', signed_off_at: daysAgo(5), performed_at: daysAgo(5), received_at: daysAgo(5) },
      { id: 2, test_code: 'K', value_text: '9.9', status: 'cancelled', signed_off_at: null, performed_at: daysAgo(1), received_at: daysAgo(1) },
      { id: 3, test_code: 'K', value_text: '4.2', status: 'final', signed_off_at: daysAgo(2), performed_at: daysAgo(2), received_at: daysAgo(2) },
    ] });
    expect(out.lab_result_id).toBe(3);
  });

  test('result older than the window with no open order -> stale, keeping the old value', () => {
    const out = resolveItemState({ ...base, results: [{ id: 4, test_code: 'K', value_text: '4.1', status: 'final', signed_off_at: daysAgo(40), performed_at: daysAgo(40), received_at: daysAgo(40) }] });
    expect(out).toMatchObject({ state: 'stale', lab_result_id: 4, value_text: '4.1' });
  });

  test('open order without collection -> ordered_awaiting_sample; with collection -> sample_sent_awaiting_result', () => {
    expect(resolveItemState({ ...base, orders: [{ id: 11, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), collected_at: null }] }))
      .toMatchObject({ state: 'ordered_awaiting_sample', investigation_id: 11 });
    expect(resolveItemState({ ...base, orders: [{ id: 12, test_code: 'ELECTROLYTES', status: 'IN_PROGRESS', requested_at: daysAgo(1), collected_at: daysAgo(0.5) }] }))
      .toMatchObject({ state: 'sample_sent_awaiting_result', investigation_id: 12 });
  });

  test('specimen state decides when present: in_transit -> sample_sent_awaiting_result even with collected_at null', () => {
    const out = resolveItemState({ ...base,
      orders: [{ id: 13, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), collected_at: null, booking_id: 99 }],
      specimens: [{ id: 5, booking_id: 99, status: 'in_transit' }],
    });
    expect(out).toMatchObject({ state: 'sample_sent_awaiting_result', specimen_id: 5 });
  });

  test('an open order beats a stale result', () => {
    const out = resolveItemState({ ...base,
      results: [{ id: 4, test_code: 'K', value_text: '4.1', status: 'final', signed_off_at: daysAgo(40), performed_at: daysAgo(40), received_at: daysAgo(40) }],
      orders: [{ id: 14, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), collected_at: null }],
    });
    expect(out.state).toBe('ordered_awaiting_sample');
  });

  test('hb resolves from HGB rows and CBC orders; hbsag from HBSAG rows and orders', () => {
    expect(resolveItemState({ ...base, item: 'hb', orders: [{ id: 15, test_code: 'CBC', status: 'REQUESTED', requested_at: daysAgo(1), collected_at: null }] }).state).toBe('ordered_awaiting_sample');
    expect(resolveItemState({ ...base, item: 'hbsag', windowDays: 90, results: [{ id: 16, test_code: 'HBSAG', value_text: 'Non-reactive', status: 'final', signed_off_at: daysAgo(3), performed_at: daysAgo(3), received_at: daysAgo(3) }] }).state).toBe('result_final');
  });

  test('a waiver overrides everything', () => {
    const out = resolveItemState({ ...base, waiver: { waived_by: 'u', waived_at: daysAgo(0), waive_reason: 'dialysis patient, K managed' } });
    expect(out.state).toBe('waived');
  });

  test('unreadable performed_at/received_at (both null) is not within the window: falls to stale when it is the latest and no order exists', () => {
    const out = resolveItemState({ ...base, results: [
      { id: 20, test_code: 'K', value_text: '4.5', status: 'final', signed_off_at: daysAgo(1), performed_at: null, received_at: null },
    ] });
    // Neither performed_at nor received_at parse to a usable timestamp, so
    // withinWindow(observedAt(row), ...) is false regardless of windowDays -
    // the row can never be treated as "within window" and the item falls
    // through to the stale branch (it is still the latest/only candidate and
    // there is no covering order).
    expect(out).toMatchObject({ state: 'stale', lab_result_id: 20, value_text: '4.5' });
  });
});

describe('isCriticalResult', () => {
  test.each([
    [{ is_critical: true, abnormal_flag: 'H' }, true],
    [{ is_critical: false, abnormal_flag: 'HH' }, true],
    [{ is_critical: false, abnormal_flag: 'LL' }, true],
    [{ is_critical: false, abnormal_flag: 'AA' }, true],
    [{ is_critical: false, abnormal_flag: 'H' }, false],
    [{ is_critical: false, abnormal_flag: null }, false],
  ])('%p -> %s', (row, expected) => {
    expect(isCriticalResult(row)).toBe(expected);
  });
});

describe('computeCheckDecision', () => {
  const item = (code, state, extra = {}) => ({ item_code: code, required: true, state, is_critical: false, abnormal_flag: null, ...extra });
  const allAvailable = ITEM_CODES.map((c) => item(c, 'result_final'));
  const pendingCheck = { status: 'pending', metadata: {} };
  const autoPassCheck = { status: 'pass', metadata: { auto_managed: true } };
  const humanPassCheck = { status: 'pass', metadata: {}, completed_by: 'u' };
  const caseOpen = { actual_start_at: null };
  const caseStarted = { actual_start_at: '2026-09-04T09:00:00Z' };

  test('all required items available + pending check -> pass, no critical warning', () => {
    expect(computeCheckDecision({ items: allAvailable, settings, check: pendingCheck, caseRow: caseOpen }))
      .toEqual({ nextStatus: 'pass', criticalWarning: false, criticalItems: [], missing: [], autoPendingReason: null });
  });

  test('critical potassium still passes, with the warning naming the item', () => {
    const items = allAvailable.map((i) => (i.item_code === 'potassium' ? { ...i, is_critical: true, abnormal_flag: 'HH' } : i));
    const out = computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen });
    expect(out.nextStatus).toBe('pass');
    expect(out.criticalWarning).toBe(true);
    expect(out.criticalItems).toEqual(['potassium']);
  });

  test('external_recorded counts when the policy allows it, and not otherwise', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hcv' ? { ...i, state: 'external_recorded' } : i));
    expect(computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen }).nextStatus).toBe('pass');
    expect(computeCheckDecision({ items, settings: { ...settings, external_results_count: false }, check: pendingCheck, caseRow: caseOpen }).nextStatus).toBeNull();
  });

  test('a missing required item leaves a pending check pending and lists it', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hbsag' ? { ...i, state: 'sample_sent_awaiting_result' } : i));
    const out = computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen });
    expect(out.nextStatus).toBeNull();
    expect(out.missing).toEqual([{ item: 'hbsag', state: 'sample_sent_awaiting_result' }]);
  });

  test('an auto-managed pass flips back to pending when an item goes missing before start, not after', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hb' ? { ...i, state: 'stale' } : i));
    const before = computeCheckDecision({ items, settings, check: autoPassCheck, caseRow: caseOpen });
    expect(before.nextStatus).toBe('pending');
    expect(before.autoPendingReason).toBe('hb stale');
    expect(computeCheckDecision({ items, settings, check: autoPassCheck, caseRow: caseStarted }).nextStatus).toBeNull();
  });

  test('a human pass is never altered by automation', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hb' ? { ...i, state: 'not_ordered' } : i));
    expect(computeCheckDecision({ items, settings, check: humanPassCheck, caseRow: caseOpen }).nextStatus).toBeNull();
  });

  test('auto_pass off never sets pass; not-required items are ignored; waived counts as available', () => {
    expect(computeCheckDecision({ items: allAvailable, settings: { ...settings, auto_pass: false }, check: pendingCheck, caseRow: caseOpen }).nextStatus).toBeNull();
    const items = allAvailable.map((i) => (i.item_code === 'hcv' ? { ...i, required: false, state: 'not_ordered' } : i.item_code === 'hiv' ? { ...i, state: 'waived' } : i));
    expect(computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen }).nextStatus).toBe('pass');
  });

  // computeCheckDecision reads item.required, not settings.required_items -
  // by design. Task 3's refresh step is where settings.required_items gets
  // turned into each persisted item's `required` flag before the items are
  // ever handed to computeCheckDecision; the pure decision function itself
  // has no settings.required_items dependency (confirmed: settings is passed
  // through untouched and only its auto_pass / external_results_count fields
  // are read here). This test locks in that contract so Task 3 cannot
  // silently start reading settings.required_items directly in this function.
  test('computeCheckDecision ignores settings.required_items and relies solely on item.required', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hcv' ? { ...i, required: false, state: 'not_ordered' } : i));
    const out = computeCheckDecision({
      items,
      settings: { ...settings, required_items: ['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv'] },
      check: pendingCheck,
      caseRow: caseOpen,
    });
    // hcv is marked required: false on the item itself even though settings
    // still lists it in required_items - the function must ignore settings
    // here and pass regardless.
    expect(out.nextStatus).toBe('pass');
  });

  test('an external_recorded item that is also critical is included in criticalItems', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hbsag'
      ? { ...i, state: 'external_recorded', is_critical: true, abnormal_flag: 'H' }
      : i));
    const out = computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen });
    expect(out.nextStatus).toBe('pass');
    expect(out.criticalWarning).toBe(true);
    expect(out.criticalItems).toEqual(['hbsag']);
  });
});
