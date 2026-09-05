// apps/backend/src/tests/unit/cathLabReadinessService.test.js
import {
  ITEM_CODES,
  SETTINGS_DEFAULTS,
  computeCheckDecision,
  externalNumericValue,
  isCriticalResult,
  itemWriteValues,
  orderPriorityForUrgency,
  pendingReasonFor,
  positiveInt,
  recordExternalLabResult,
  resolveItemState,
} from '../../services/clinical/cathLabReadinessService.js';

const TENANT = '00000000-0000-4000-8000-0000000c1a00';
const CTX = { actorUid: '00000000-0000-4000-8000-0000000c1aaa', actorRole: 'DOCTOR' };

const AS_OF = new Date('2026-09-04T10:00:00.000Z');
const daysAgo = (n) => new Date(AS_OF.getTime() - n * 86_400_000).toISOString();
// Postgres always returns the `<col>_epoch_ms` twin beside a twinned column and
// the resolver prefers it over the driver-materialised Date
// (src/utils/dbInstant.js), so the fixtures below carry both. Derived from the
// same offset as daysAgo(), so the twin and the ISO string beside it describe
// one instant and no assertion changes outcome.
const epochAgo = (n) => BigInt(AS_OF.getTime() - n * 86_400_000);
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
      { id: 7, test_code: 'K', value_text: '6.1', value_numeric: 6.1, unit: 'mmol/L', abnormal_flag: 'HH', is_critical: true, status: 'final', signed_off_at: daysAgo(1), signed_off_at_epoch_ms: epochAgo(1), performed_at: daysAgo(1), performed_at_epoch_ms: epochAgo(1), received_at: daysAgo(1), received_at_epoch_ms: epochAgo(1), result_origin: 'analyzer' },
    ] });
    expect(out).toMatchObject({ state: 'result_final', lab_result_id: 7, value_numeric: 6.1, abnormal_flag: 'HH', is_critical: true, source: 'lab_result' });
  });

  test('preliminary result -> result_preliminary; external origin -> external_recorded', () => {
    expect(resolveItemState({ ...base, results: [{ id: 8, test_code: 'K', value_text: '4.0', status: 'preliminary', signed_off_at: null, signed_off_at_epoch_ms: null, performed_at: daysAgo(2), performed_at_epoch_ms: epochAgo(2), received_at: daysAgo(2), received_at_epoch_ms: epochAgo(2), result_origin: 'manual_in_house' }] }).state).toBe('result_preliminary');
    expect(resolveItemState({ ...base, results: [{ id: 9, test_code: 'K', value_text: '4.0', status: 'preliminary', signed_off_at: null, signed_off_at_epoch_ms: null, performed_at: daysAgo(2), performed_at_epoch_ms: epochAgo(2), received_at: daysAgo(2), received_at_epoch_ms: epochAgo(2), result_origin: 'external_lab' }] }).state).toBe('external_recorded');
  });

  test('latest result wins; cancelled rows are ignored', () => {
    const out = resolveItemState({ ...base, results: [
      { id: 1, test_code: 'K', value_text: '3.0', status: 'final', signed_off_at: daysAgo(5), signed_off_at_epoch_ms: epochAgo(5), performed_at: daysAgo(5), performed_at_epoch_ms: epochAgo(5), received_at: daysAgo(5), received_at_epoch_ms: epochAgo(5) },
      { id: 2, test_code: 'K', value_text: '9.9', status: 'cancelled', signed_off_at: null, signed_off_at_epoch_ms: null, performed_at: daysAgo(1), performed_at_epoch_ms: epochAgo(1), received_at: daysAgo(1), received_at_epoch_ms: epochAgo(1) },
      { id: 3, test_code: 'K', value_text: '4.2', status: 'final', signed_off_at: daysAgo(2), signed_off_at_epoch_ms: epochAgo(2), performed_at: daysAgo(2), performed_at_epoch_ms: epochAgo(2), received_at: daysAgo(2), received_at_epoch_ms: epochAgo(2) },
    ] });
    expect(out.lab_result_id).toBe(3);
  });

  test('result older than the window with no open order -> stale, keeping the old value', () => {
    const out = resolveItemState({ ...base, results: [{ id: 4, test_code: 'K', value_text: '4.1', status: 'final', signed_off_at: daysAgo(40), signed_off_at_epoch_ms: epochAgo(40), performed_at: daysAgo(40), performed_at_epoch_ms: epochAgo(40), received_at: daysAgo(40), received_at_epoch_ms: epochAgo(40) }] });
    expect(out).toMatchObject({ state: 'stale', lab_result_id: 4, value_text: '4.1' });
  });

  test('open order without collection -> ordered_awaiting_sample; with collection -> sample_sent_awaiting_result', () => {
    expect(resolveItemState({ ...base, orders: [{ id: 11, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), requested_at_epoch_ms: epochAgo(1), collected_at: null, collected_at_epoch_ms: null }] }))
      .toMatchObject({ state: 'ordered_awaiting_sample', investigation_id: 11 });
    expect(resolveItemState({ ...base, orders: [{ id: 12, test_code: 'ELECTROLYTES', status: 'IN_PROGRESS', requested_at: daysAgo(1), requested_at_epoch_ms: epochAgo(1), collected_at: daysAgo(0.5), collected_at_epoch_ms: epochAgo(0.5) }] }))
      .toMatchObject({ state: 'sample_sent_awaiting_result', investigation_id: 12 });
  });

  test('specimen state decides when present: in_transit -> sample_sent_awaiting_result even with collected_at null', () => {
    const out = resolveItemState({ ...base,
      orders: [{ id: 13, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), requested_at_epoch_ms: epochAgo(1), collected_at: null, collected_at_epoch_ms: null, booking_id: 99 }],
      specimens: [{ id: 5, booking_id: 99, status: 'in_transit' }],
    });
    expect(out).toMatchObject({ state: 'sample_sent_awaiting_result', specimen_id: 5 });
  });

  test('an open order beats a stale result', () => {
    const out = resolveItemState({ ...base,
      results: [{ id: 4, test_code: 'K', value_text: '4.1', status: 'final', signed_off_at: daysAgo(40), signed_off_at_epoch_ms: epochAgo(40), performed_at: daysAgo(40), performed_at_epoch_ms: epochAgo(40), received_at: daysAgo(40), received_at_epoch_ms: epochAgo(40) }],
      orders: [{ id: 14, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), requested_at_epoch_ms: epochAgo(1), collected_at: null, collected_at_epoch_ms: null }],
    });
    expect(out.state).toBe('ordered_awaiting_sample');
  });

  test('hb resolves from HGB rows and CBC orders; hbsag from HBSAG rows and orders', () => {
    expect(resolveItemState({ ...base, item: 'hb', orders: [{ id: 15, test_code: 'CBC', status: 'REQUESTED', requested_at: daysAgo(1), requested_at_epoch_ms: epochAgo(1), collected_at: null, collected_at_epoch_ms: null }] }).state).toBe('ordered_awaiting_sample');
    expect(resolveItemState({ ...base, item: 'hbsag', windowDays: 90, results: [{ id: 16, test_code: 'HBSAG', value_text: 'Non-reactive', status: 'final', signed_off_at: daysAgo(3), signed_off_at_epoch_ms: epochAgo(3), performed_at: daysAgo(3), performed_at_epoch_ms: epochAgo(3), received_at: daysAgo(3), received_at_epoch_ms: epochAgo(3) }] }).state).toBe('result_final');
  });

  test('a waiver overrides everything', () => {
    const out = resolveItemState({ ...base, waiver: { waived_by: 'u', waived_at: daysAgo(0), waive_reason: 'dialysis patient, K managed' } });
    expect(out.state).toBe('waived');
  });

  test('unreadable performed_at/received_at (both null) is not within the window: falls to stale when it is the latest and no order exists', () => {
    const out = resolveItemState({ ...base, results: [
      { id: 20, test_code: 'K', value_text: '4.5', status: 'final', signed_off_at: daysAgo(1), signed_off_at_epoch_ms: epochAgo(1), performed_at: null, performed_at_epoch_ms: null, received_at: null, received_at_epoch_ms: null },
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
      status: 'final', signed_off_at: daysAgo(-2), signed_off_at_epoch_ms: epochAgo(-2), performed_at: daysAgo(-2), performed_at_epoch_ms: epochAgo(-2), received_at: daysAgo(-2), received_at_epoch_ms: epochAgo(-2),
    };
    const real = {
      id: 29, test_code: 'K', value_text: '4.2', status: 'final',
      signed_off_at: daysAgo(1), signed_off_at_epoch_ms: epochAgo(1), performed_at: daysAgo(1), performed_at_epoch_ms: epochAgo(1), received_at: daysAgo(1), received_at_epoch_ms: epochAgo(1),
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

  // The ORDER-side twin of the test above. cathLabReadinessRules.js's
  // withinWindow comment claims open orders inherit the same lower bound — "a
  // future-dated order is dropped and the item reads not_ordered rather than
  // ordered_awaiting_sample" — and until now only the result half was pinned.
  // It is the half that matters clinically: a future-dated order that survived
  // the filter would read ordered_awaiting_sample, which tells the team the
  // draw is already in flight and suppresses the order-missing action for a
  // requisition nobody has raised.
  test('a future-dated order is not an open order: the item reads not_ordered', () => {
    // Fixed AS_OF, hard-coded epoch twins: no DB clock, so the day this runs
    // cannot move the answer.
    const order = (id, offsetDays) => ({
      id,
      test_code: 'ELECTROLYTES',
      status: 'REQUESTED',
      requested_at: daysAgo(offsetDays),
      requested_at_epoch_ms: epochAgo(offsetDays),
      collected_at: null,
      collected_at_epoch_ms: null,
    });
    const future = order(70, -2);
    expect(resolveItemState({ ...base, orders: [future] }))
      .toMatchObject({ state: 'not_ordered', investigation_id: null, ordered_at: null });

    // ...and it does not outrank a real one either: the surviving pointer is
    // the order that was actually raised, not the newest by clock.
    expect(resolveItemState({ ...base, orders: [future, order(69, 1)] }))
      .toMatchObject({ state: 'ordered_awaiting_sample', investigation_id: 69 });

    // A future-dated order over a stale result leaves the stale result
    // standing — the item does not get promoted out of stale by a requisition
    // dated tomorrow.
    const staleResult = {
      id: 71, test_code: 'K', value_text: '4.1', status: 'final',
      signed_off_at: daysAgo(40), signed_off_at_epoch_ms: epochAgo(40),
      performed_at: daysAgo(40), performed_at_epoch_ms: epochAgo(40),
      received_at: daysAgo(40), received_at_epoch_ms: epochAgo(40),
    };
    expect(resolveItemState({ ...base, results: [staleResult], orders: [future] }))
      .toMatchObject({ state: 'stale', lab_result_id: 71, investigation_id: null });
  });

  test('exactly windowDays old is fresh; one millisecond older is stale', () => {
    const at = (ms) => {
      const iso = new Date(ms).toISOString();
      return {
        id: 31, test_code: 'K', value_text: '4.0', status: 'final',
        signed_off_at: iso, signed_off_at_epoch_ms: BigInt(ms),
        performed_at: iso, performed_at_epoch_ms: BigInt(ms),
        received_at: iso, received_at_epoch_ms: BigInt(ms),
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
      id: 32, test_code: 'K', value_text: '4.0', status: 'preliminary', signed_off_at: null, signed_off_at_epoch_ms: null,
      performed_at: daysAgo(0), performed_at_epoch_ms: epochAgo(0), received_at: daysAgo(0), received_at_epoch_ms: epochAgo(0),
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
      signed_off_at_epoch_ms: BigInt(ms),
      performed_at_epoch_ms: BigInt(ms), received_at_epoch_ms: BigInt(ms),
    }] });
    expect(out.state).toBe('stale');
    expect(out.observed_at).toBe(new Date(ms).toISOString());
  });

  test('a same-instant tie is broken on id, highest first', () => {
    const at = daysAgo(1);
    const atMs = epochAgo(1);
    const row = (id, value) => ({
      id, test_code: 'K', value_text: value, status: 'final',
      signed_off_at: at, signed_off_at_epoch_ms: atMs,
      performed_at: at, performed_at_epoch_ms: atMs,
      received_at: at, received_at_epoch_ms: atMs,
    });
    expect(resolveItemState({ ...base, results: [row(40, 'a'), row(41, 'b'), row(39, 'c')] }))
      .toMatchObject({ lab_result_id: 41, value_text: 'b' });
  });

  test('completed and cancelled orders are ignored whatever case they arrive in', () => {
    const order = (id, status) => ({
      id, test_code: 'ELECTROLYTES', status, requested_at: daysAgo(1), requested_at_epoch_ms: epochAgo(1), collected_at: null, collected_at_epoch_ms: null,
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
        signed_off_at: daysAgo(2), signed_off_at_epoch_ms: epochAgo(2), performed_at: daysAgo(2), performed_at_epoch_ms: epochAgo(2), received_at: daysAgo(2), received_at_epoch_ms: epochAgo(2),
      }],
      orders: [{
        id: 61, test_code: 'ELECTROLYTES', status: 'REQUESTED',
        requested_at: daysAgo(0.5), requested_at_epoch_ms: epochAgo(0.5), collected_at: null, collected_at_epoch_ms: null, booking_id: 70,
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
        requested_at: daysAgo(1), requested_at_epoch_ms: epochAgo(1), collected_at: null, collected_at_epoch_ms: null, booking_id: 80,
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
        signed_off_at: daysAgo(1), signed_off_at_epoch_ms: epochAgo(1), performed_at: daysAgo(1), performed_at_epoch_ms: epochAgo(1), received_at: daysAgo(1), received_at_epoch_ms: epochAgo(1),
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

  // The mirror of the retraction case above. Both automation branches stop at
  // the knife: an in_progress/completed case reopened in the ward would
  // otherwise flip a pending labs check to pass with completed_at = NOW() and
  // an auto_pass audit row, stamping a readiness claim AFTER the procedure it
  // existed to gate.
  test('a started case is never auto-passed, however complete the items are', () => {
    const out = computeCheckDecision({
      items: allAvailable, settings, check: pendingCheck, caseRow: caseStarted,
    });
    expect(out.nextStatus).toBeNull();
    expect(out.autoPendingReason).toBeNull();
    expect(out.missing).toEqual([]);
    // The same items on an OPEN case still pass, so this is the start gate and
    // not a change to what counts as available.
    expect(computeCheckDecision({
      items: allAvailable, settings, check: pendingCheck, caseRow: caseOpen,
    }).nextStatus).toBe('pass');
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

// ---------------------------------------------------------------------------
// An outside quantitative value: what counts as a value at all
// ---------------------------------------------------------------------------
describe('externalNumericValue', () => {
  const refusal = (fn) => { try { fn(); return null; } catch (err) { return err; } };

  // `Number(x ?? y)` used to stand here. Every one of these reached the record
  // as a stored number: null, '' and [] as 0, true as 1. A creatinine of 0 is
  // not a missing value on the screen — it reads as normal and clears the gate.
  test.each([
    ['nothing at all', undefined, null],
    ['an empty value_text', undefined, ''],
    ['an explicit null', null, null],
    ['a boolean', true, null],
    ['an array', [], null],
    ['an object', {}, null],
    ['a non-numeric string', 'high', null],
    ['a negative number', -1, null],
    // value_numeric is NUMERIC(15, 4) in lab_results and in the readiness item
    // it is copied to: eleven digits ahead of the point. 1e11 overflows the
    // column, and unchecked it is Postgres that says so -- as a 22003 raised
    // halfway through the insert, which the ward reads as a 500.
    ['a number that overflows NUMERIC(15, 4)', 1e11, null],
    ['a decimal STRING that overflows it', undefined, '100000000000'],
    ['an overflowing value in either field', 1e15, '1.2'],
  ])('%s is refused', (_label, numeric, text) => {
    expect(refusal(() => externalNumericValue(numeric, text)))
      .toMatchObject({ statusCode: 400, code: 'CATH_LAB_READINESS_VALUE_INVALID' });
  });

  test('an explicit number, or a plain decimal string in either field, is accepted', () => {
    expect(externalNumericValue(1.2, null)).toBe(1.2);
    expect(externalNumericValue(undefined, '1.2')).toBe(1.2);
    expect(externalNumericValue('1.2', null)).toBe(1.2);
    // Zero is a legitimate reading when somebody actually sent it.
    expect(externalNumericValue(0, null)).toBe(0);
  });

  test('the largest value NUMERIC(15, 4) can hold is still accepted', () => {
    // The bound is the COLUMN's, not a guess at a plausible lab value: the
    // last value that fits has to pass, or the refusal is refusing real data.
    expect(externalNumericValue(99999999999.9999, null)).toBe(99999999999.9999);
    expect(externalNumericValue(undefined, '99999999999.9999')).toBe(99999999999.9999);
  });
});

// ---------------------------------------------------------------------------
// What the UPSERT actually binds: shapes, not just values
// ---------------------------------------------------------------------------
describe('itemWriteValues', () => {
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T.*Z$/;
  const WAIVED_AT = new Date('2026-09-03T06:30:00.000Z');
  const waived = () => resolveItemState({
    item: 'hcv',
    windowDays: 90,
    asOf: AS_OF,
    results: [],
    orders: [],
    specimens: [],
    // Shaped as the STORED row the refresh reads its waiver from: the driver
    // materialises a TIMESTAMPTZ as a Date, which is exactly the shape the
    // house rule says must never be bound.
    waiver: {
      state: 'waived',
      waived_by: CTX.actorUid,
      waived_at: WAIVED_AT,
      waive_reason: 'Repeat HCV from last month on file elsewhere',
    },
  });

  test('waived_at is bound as an ISO string, not as a driver Date', () => {
    const item = waived();
    expect(item.waived_at).toBeInstanceOf(Date);
    const values = itemWriteValues(item);
    expect(typeof values.waived_at).toBe('string');
    expect(values.waived_at).toMatch(ISO_INSTANT);
    expect(values.waived_at).toBe(WAIVED_AT.toISOString());
  });

  test('the ISO string names the SAME instant, so a no-op refresh rewrites nothing', () => {
    // storedItemMatches compares the stored Date and this value through toMs.
    // If the conversion moved the instant by so much as a millisecond, every
    // read of a waived case would rewrite the row and churn refreshed_at.
    const values = itemWriteValues(waived());
    expect(Date.parse(values.waived_at)).toBe(WAIVED_AT.getTime());
  });

  test('every instant it binds is a string or null, on a waived and an unwaived item', () => {
    const withResult = resolveItemState({
      item: 'hb',
      windowDays: 30,
      asOf: AS_OF,
      orders: [],
      specimens: [],
      results: [{
        id: 21, test_code: 'HGB', value_text: '11.4', value_numeric: 11.4, unit: 'g/dL',
        status: 'final', signed_off_at: daysAgo(1), signed_off_at_epoch_ms: epochAgo(1), performed_at: daysAgo(1), performed_at_epoch_ms: epochAgo(1),
        received_at: daysAgo(1), received_at_epoch_ms: epochAgo(1), result_origin: 'analyzer',
      }],
    });
    for (const item of [waived(), withResult]) {
      const values = itemWriteValues(item);
      for (const column of ['observed_at', 'ordered_at', 'waived_at']) {
        const bound = values[column];
        expect(bound === null || typeof bound === 'string').toBe(true);
        if (bound !== null) expect(bound).toMatch(ISO_INSTANT);
      }
    }
  });

  test('an item with no waiver binds three explicit nulls', () => {
    const values = itemWriteValues(resolveItemState({
      item: 'hcv', windowDays: 90, asOf: AS_OF, results: [], orders: [], specimens: [],
    }));
    expect(values).toMatchObject({ waived_by: null, waived_at: null, waive_reason: null });
  });
});

describe('recordExternalLabResult input refusals (nothing is written)', () => {
  const entry = (extra) => recordExternalLabResult(1, 'creatinine', {
    tenantId: TENANT,
    external_lab_name: 'City Path Lab',
    observed_on: '2026-01-05',
    ...extra,
  }, CTX);

  // These all refuse before the first statement — the case row is not even
  // read — so the suite needs no database.
  test.each([
    ['no value', {}],
    ['an empty value_text', { value_text: '' }],
    ['a null value_numeric', { value_numeric: null }],
    ['a boolean value_numeric', { value_numeric: true }],
    ['an array value_numeric', { value_numeric: [] }],
  ])('%s is a 400, not a stored zero', async (_label, extra) => {
    await expect(entry(extra))
      .rejects.toMatchObject({ statusCode: 400, code: 'CATH_LAB_READINESS_VALUE_INVALID' });
  });

  // The shape regex alone accepts 2026-13-45, which then raises 22008 on the
  // ::date cast in the middle of the write and reaches the ward as a 500.
  test.each(['2026-13-45', '2026-02-30', '2026-00-10', '2026-01-32'])(
    'observed_on %s is refused as a 400, not left to the ::date cast',
    async (observedOn) => {
      await expect(recordExternalLabResult(1, 'creatinine', {
        tenantId: TENANT,
        external_lab_name: 'City Path Lab',
        observed_on: observedOn,
        value_numeric: 1.2,
      }, CTX)).rejects.toMatchObject({
        statusCode: 400, code: 'CATH_LAB_READINESS_VALUE_INVALID',
      });
    },
  );
});

describe('orderPriorityForUrgency', () => {
  // The lab worklist sorts on the SLA clock the priority sets: NORMAL is a
  // 24-hour target, URGENT 4, STAT 1. A primary-PCI patient's pre-procedure
  // bloods must not queue behind an elective case's.
  test.each([
    ['emergency', 'STAT'],
    ['urgent', 'URGENT'],
    ['routine', 'NORMAL'],
    ['elective', 'NORMAL'],
    ['EMERGENCY', 'STAT'],
    [null, 'NORMAL'],
    ['something new', 'NORMAL'],
  ])('%s -> %s', (urgency, expected) => {
    expect(orderPriorityForUrgency(urgency)).toBe(expected);
  });

  test('every priority it can emit is one createInvestigationOrder accepts', () => {
    // PRIORITY_LEVELS in src/config/investigationConfig.js.
    const accepted = new Set(['STAT', 'URGENT', 'HIGH', 'NORMAL', 'LOW']);
    for (const urgency of ['elective', 'routine', 'urgent', 'emergency', null]) {
      expect(accepted.has(orderPriorityForUrgency(urgency))).toBe(true);
    }
  });
});

describe('pendingReasonFor', () => {
  test('names every missing item and its state, and is null when nothing is missing', () => {
    expect(pendingReasonFor([])).toBeNull();
    expect(pendingReasonFor([
      { item: 'hb', state: 'not_ordered' },
      { item: 'hiv', state: 'sample_sent_awaiting_result' },
    ])).toBe('hb not ordered; hiv sample sent awaiting result');
  });
});

describe('positiveInt bounds', () => {
  test('the third positional argument is the upper bound', () => {
    expect(positiveInt('40', 'slot', 64)).toBe(40);
    expect(() => positiveInt('65', 'slot', 64))
      .toThrow(expect.objectContaining({ code: 'CATH_LAB_BAD_ID' }));
  });

  // A bound that is not a finite number would be LOST, not applied: `n > max`
  // is false for every n when max is an object, so the guard keeps answering
  // "valid" for exactly the values it was called to refuse. The failure mode
  // is real — the device-reuse service's near-identical copy takes its bound
  // as `{ max }`, one import away — so it has to be loud.
  test.each([
    ['an options object, the device service’s shape', { max: 64 }],
    ['a numeric string', '64'],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('a %s bound throws TypeError instead of silently dropping the bound', (_label, max) => {
    expect(() => positiveInt('65', 'slot', max)).toThrow(TypeError);
    // Not an AppError: this is our bug, not the caller's input, so it must not
    // reach a client as a 400 blaming them.
    expect(() => positiveInt('65', 'slot', max))
      .toThrow(/max must be a finite number/);
    // ...and it throws BEFORE the value is judged, so a value that would have
    // been accepted under the intended bound is refused too — no request slips
    // through on a bound that was never applied.
    expect(() => positiveInt('1', 'slot', max)).toThrow(TypeError);
  });

  test('an omitted bound is still the safe-integer default', () => {
    expect(positiveInt('9007199254740991', 'id')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => positiveInt('9007199254740992', 'id'))
      .toThrow(expect.objectContaining({ code: 'CATH_LAB_BAD_ID' }));
    expect(() => positiveInt('9007199254740991', 'id', undefined))
      .not.toThrow();
  });
});

/**
 * m7 — the facade is the contract.
 *
 * cathLabReadinessService.js re-exports every name from the three modules the
 * split created, using explicit name lists rather than `export *`, so that a
 * name added to a sibling reaches the public surface as a reviewed line. The
 * cost of that choice is that a new export can be FORGOTTEN, and the only
 * symptom is an importer of the facade that cannot see it. This compares the
 * real module namespaces rather than a transcribed list.
 */
describe('cathLabReadinessService facade', () => {
  const siblings = async () => ({
    'cathLabReadinessRules.js': await import('../../services/clinical/cathLabReadinessRules.js'),
    'cathLabReadinessActions.js': await import('../../services/clinical/cathLabReadinessActions.js'),
    'cathParamGuards.js': await import('../../services/clinical/cathParamGuards.js'),
  });

  test('every export of every sibling module is re-exported by the facade', async () => {
    const facade = await import('../../services/clinical/cathLabReadinessService.js');
    const facadeNames = new Set(Object.keys(facade));
    const missing = [];
    for (const [file, mod] of Object.entries(await siblings())) {
      for (const name of Object.keys(mod)) {
        if (name === 'default') continue;
        if (!facadeNames.has(name)) missing.push(`${file}#${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('a re-exported name is the SAME binding, not a same-named copy', async () => {
    const facade = await import('../../services/clinical/cathLabReadinessService.js');
    for (const mod of Object.values(await siblings())) {
      for (const [name, value] of Object.entries(mod)) {
        if (name === 'default') continue;
        expect({ name, same: facade[name] === value }).toEqual({ name, same: true });
      }
    }
  });

  test('the facade publishes more than any one sibling — the split really is behind it', async () => {
    const facade = await import('../../services/clinical/cathLabReadinessService.js');
    const rules = await import('../../services/clinical/cathLabReadinessRules.js');
    // Guards against the whole comparison passing because an import resolved to
    // an empty namespace.
    expect(Object.keys(rules).length).toBeGreaterThan(10);
    expect(Object.keys(facade).length).toBeGreaterThan(Object.keys(rules).length);
    // The names the routes and cathLabService import by name, spot-checked so a
    // rename cannot pass by removing a name from BOTH sides at once.
    for (const name of [
      'ITEM_CODES', 'resolveItemState', 'computeCheckDecision',
      'waiveLabItem', 'unwaiveLabItem', 'orderMissingLabs', 'recordExternalLabResult',
      'refreshCaseLabReadiness', 'refreshOpenCasesForPatient',
      'positiveInt', 'requireUuid', 'cleanText', 'withTenant',
    ]) {
      expect({ name, published: facade[name] !== undefined }).toEqual({ name, published: true });
    }
  });
});
