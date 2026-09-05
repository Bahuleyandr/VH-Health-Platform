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
  // The refusal is the assertion; returning it keeps the code check on one line.
  const refusal = (fn) => { try { fn(); return null; } catch (err) { return err; } };

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

  // ---- freshness has a LOWER bound: nothing dated in the future is evidence --
  test('a future-dated row never outranks a real one, and on its own resolves as stale', () => {
    const future = {
      id: 30, test_code: 'K', value_text: '9.9', abnormal_flag: 'HH', is_critical: true,
      status: 'final', signed_off_at: daysAgo(-2), performed_at: daysAgo(-2), received_at: daysAgo(-2),
    };
    const real = {
      id: 29, test_code: 'K', value_text: '4.2', status: 'final',
      signed_off_at: daysAgo(1), performed_at: daysAgo(1), received_at: daysAgo(1),
    };
    // The critical value is the newer one by clock, and the lower id: neither
    // recency nor the id tiebreak may let it win.
    expect(resolveItemState({ ...base, results: [future, real] }))
      .toMatchObject({ state: 'result_final', lab_result_id: 29, is_critical: false });
    // Alone it is still the latest candidate, but it is not fresh, so the item
    // falls through to stale rather than passing the gate on a future date.
    expect(resolveItemState({ ...base, results: [future] }))
      .toMatchObject({ state: 'stale', lab_result_id: 30 });
  });

  test('exactly windowDays old is fresh; one millisecond older is stale', () => {
    const at = (ms) => {
      const iso = new Date(ms).toISOString();
      return {
        id: 31, test_code: 'K', value_text: '4.0', status: 'final',
        signed_off_at: iso, performed_at: iso, received_at: iso,
      };
    };
    const edge = AS_OF.getTime() - 30 * 86_400_000;
    expect(resolveItemState({ ...base, results: [at(edge)] }).state).toBe('result_final');
    expect(resolveItemState({ ...base, results: [at(edge - 1)] }).state).toBe('stale');
  });

  // ---- an outside value is dated from the REPORT, not from data entry --------
  test('an external result is dated from external_reported_on, not from when it was keyed in', () => {
    const reportedOn = new Date(AS_OF.getTime() - 200 * 86_400_000).toISOString().slice(0, 10);
    const out = resolveItemState({ ...base, results: [{
      id: 32, test_code: 'K', value_text: '4.0', status: 'preliminary', signed_off_at: null,
      performed_at: daysAgo(0), received_at: daysAgo(0),
      result_origin: 'external_lab', external_reported_on: reportedOn,
    }] });
    // Entered today, reported 200 days ago, 30-day window: stale, not
    // external_recorded — the patient's value is 200 days old either way.
    expect(out).toMatchObject({ state: 'stale', source: 'external', lab_result_id: 32 });
    expect(out.observed_at).toBe(new Date(`${reportedOn}T00:00:00+05:30`).toISOString());
  });

  test('an epoch-ms twin is preferred over the driver-materialised Date beside it', () => {
    const ms = AS_OF.getTime() - 200 * 86_400_000;
    const out = resolveItemState({ ...base, results: [{
      id: 33, test_code: 'K', value_text: '4.0', status: 'final',
      // The Dates say two days ago (fresh); the twins say 200 days ago. The
      // twin is the absolute instant, so the item is stale.
      signed_off_at: daysAgo(2), performed_at: daysAgo(2), received_at: daysAgo(2),
      performed_at_epoch_ms: BigInt(ms), received_at_epoch_ms: BigInt(ms),
    }] });
    expect(out.state).toBe('stale');
    expect(out.observed_at).toBe(new Date(ms).toISOString());
  });

  test('a same-instant tie is broken on id, highest first', () => {
    const at = daysAgo(1);
    const row = (id, value) => ({
      id, test_code: 'K', value_text: value, status: 'final',
      signed_off_at: at, performed_at: at, received_at: at,
    });
    expect(resolveItemState({ ...base, results: [row(40, 'a'), row(41, 'b'), row(39, 'c')] }))
      .toMatchObject({ lab_result_id: 41, value_text: 'b' });
  });

  test('completed and cancelled orders are ignored whatever case they arrive in', () => {
    const order = (id, status) => ({
      id, test_code: 'ELECTROLYTES', status, requested_at: daysAgo(1), collected_at: null,
    });
    for (const status of ['COMPLETED', 'completed', 'CANCELLED', 'cancelled']) {
      expect(resolveItemState({ ...base, orders: [order(50, status)] }).state).toBe('not_ordered');
    }
    expect(resolveItemState({ ...base, orders: [order(51, 'requested')] }).state)
      .toBe('ordered_awaiting_sample');
  });

  // ---- an in-flight repeat draw stays visible on an answered item -----------
  test('a fresh result keeps its state but carries the covering open order pointers', () => {
    const out = resolveItemState({ ...base,
      results: [{
        id: 60, test_code: 'K', value_text: '5.9', status: 'final',
        signed_off_at: daysAgo(2), performed_at: daysAgo(2), received_at: daysAgo(2),
      }],
      orders: [{
        id: 61, test_code: 'ELECTROLYTES', status: 'REQUESTED',
        requested_at: daysAgo(0.5), collected_at: null, booking_id: 70,
      }],
      specimens: [{ id: 71, booking_id: 70, status: 'collected' }],
    });
    expect(out).toMatchObject({
      state: 'result_final', lab_result_id: 60, investigation_id: 61, specimen_id: 71,
    });
    expect(out.ordered_at).toBe(daysAgo(0.5));
  });

  test('the highest specimen id wins, whatever order the rows arrive in', () => {
    const out = resolveItemState({ ...base,
      orders: [{
        id: 62, test_code: 'ELECTROLYTES', status: 'REQUESTED',
        requested_at: daysAgo(1), collected_at: null, booking_id: 80,
      }],
      specimens: [
        { id: 90, booking_id: 80, status: 'rejected' },
        { id: 92, booking_id: 80, status: 'in_transit' },
        { id: 91, booking_id: 81, status: 'received' },
      ],
    });
    expect(out).toMatchObject({ state: 'sample_sent_awaiting_result', specimen_id: 92 });
  });

  // ---- waivers -------------------------------------------------------------
  test('a waiver keeps the value that prompted it, so the item still reads critical', () => {
    const out = resolveItemState({ ...base,
      results: [{
        id: 63, test_code: 'K', value_text: '6.9', value_numeric: 6.9, unit: 'mmol/L',
        abnormal_flag: 'HH', is_critical: true, status: 'final',
        signed_off_at: daysAgo(1), performed_at: daysAgo(1), received_at: daysAgo(1),
      }],
      waiver: { waived_by: 'u', waived_at: daysAgo(0), waive_reason: 'dialysis patient' },
    });
    expect(out).toMatchObject({
      state: 'waived', source: 'waiver', value_numeric: 6.9, abnormal_flag: 'HH',
      is_critical: true, lab_result_id: 63,
    });
  });

  test('a waiver missing who/when/why is refused; an unwaived item clears all three', () => {
    expect(refusal(() => resolveItemState({
      ...base, waiver: { waived_by: 'u', waived_at: null, waive_reason: 'x' },
    }))).toMatchObject({ code: 'CATH_LAB_READINESS_VALUE_INVALID' });
    // The three keys are on every item so an UPSERT built from the object
    // CLEARS a lifted waiver instead of leaving the old one in the row.
    expect(resolveItemState(base))
      .toMatchObject({ waived_by: null, waived_at: null, waive_reason: null });
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

  // ---- criticality is read across ALL items; `missing` stays required-only ---
  test('a waived item still reports the critical value that prompted the waiver', () => {
    const items = allAvailable.map((i) => (i.item_code === 'potassium'
      ? { ...i, state: 'waived', is_critical: true, abnormal_flag: 'HH' }
      : i));
    const out = computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen });
    expect(out.nextStatus).toBe('pass');
    expect(out.criticalWarning).toBe(true);
    expect(out.criticalItems).toContain('potassium');
  });

  test('an item nobody required is still named when its value is critical', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hcv'
      ? { ...i, required: false, abnormal_flag: 'AA' }
      : i));
    const out = computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen });
    expect(out.missing).toEqual([]);
    expect(out.criticalItems).toEqual(['hcv']);
    expect(out.criticalWarning).toBe(true);
  });

  // ---- idempotence and the auto_pass boundary ------------------------------
  test('an auto-managed pass with nothing missing is left alone', () => {
    expect(computeCheckDecision({
      items: allAvailable, settings, check: autoPassCheck, caseRow: caseOpen,
    }).nextStatus).toBeNull();
  });

  test('auto_pass off still retracts an assertion automation itself made', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hb' ? { ...i, state: 'not_ordered' } : i));
    // Turning auto-pass off stops NEW assertions; it does not strand a pass
    // automation already wrote over evidence that has since gone missing.
    expect(computeCheckDecision({
      items, settings: { ...settings, auto_pass: false }, check: autoPassCheck, caseRow: caseOpen,
    }).nextStatus).toBe('pending');
  });

  test('a case with no labs check row yet is read as pending', () => {
    expect(computeCheckDecision({
      items: allAvailable, settings, check: null, caseRow: caseOpen,
    }).nextStatus).toBe('pass');
  });
});
