import { reconcile } from '../../services/ai/operationalAlertService.js';

const cand = (over = {}) => ({
  module_key: 'pharmacy_stockout_predictor', domain: 'pharmacy', owner_role: 'MATERIALS_MANAGER',
  scope_key: 'SKU-1', alert_category: 'stockout_risk', severity: 'high', ...over,
});
const open = (over = {}) => ({
  id: 1, module_key: 'pharmacy_stockout_predictor', scope_key: 'SKU-1', severity: 'moderate',
  notified_at: null, ...over,
});

describe('reconcile (ops-alerts)', () => {
  it('inserts a brand-new candidate and notifies when high/critical', () => {
    const r = reconcile([], [cand()]);
    expect(r.toInsert).toHaveLength(1);
    expect(r.toUpdate).toHaveLength(0);
    expect(r.toResolve).toHaveLength(0);
    expect(r.toNotify.map((n) => n.scope_key)).toEqual(['SKU-1']);
  });

  it('updates a matching open alert and does NOT duplicate', () => {
    const r = reconcile([open()], [cand({ severity: 'moderate' })]);
    expect(r.toInsert).toHaveLength(0);
    expect(r.toUpdate).toHaveLength(1);
    expect(r.toUpdate[0].id).toBe(1);
    expect(r.toNotify).toHaveLength(0);
  });

  it('notifies once on escalation into high when not previously notified', () => {
    const r = reconcile([open({ severity: 'moderate', notified_at: null })], [cand({ severity: 'critical' })]);
    expect(r.toNotify).toHaveLength(1);
  });

  it('does NOT re-notify an already-notified alert', () => {
    const r = reconcile([open({ severity: 'high', notified_at: new Date() })], [cand({ severity: 'critical' })]);
    expect(r.toNotify).toHaveLength(0);
  });

  it('auto-resolves an open alert absent from this run', () => {
    const r = reconcile([open({ scope_key: 'SKU-GONE' })], [cand({ scope_key: 'SKU-1' })]);
    expect(r.toResolve.map((a) => a.scope_key)).toEqual(['SKU-GONE']);
    expect(r.toInsert).toHaveLength(1);
  });
});
