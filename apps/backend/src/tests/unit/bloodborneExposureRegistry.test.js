import {
  __clearExposureHandlersForTests,
  exposureHandlerCount,
  listExposureHandlers,
  notifyExposureHandlers,
  registerExposureHandler,
} from '../../services/clinical/bloodborneMarkerRules.js';

const settled = () => ({
  remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 0,
});

describe('stable bloodborne exposure registry', () => {
  afterEach(() => __clearExposureHandlersForTests());

  test('reports explicit failure while continuing the full handler population', async () => {
    const seen = [];
    const handlers = [
      { id: 'first.v1', apply: async () => { seen.push('first'); return settled(); } },
      { id: 'second.v1', apply: async () => { seen.push('second'); throw new Error('mid-sweep'); } },
      { id: 'third.v1', apply: async () => { seen.push('third'); return settled(); } },
    ];
    expect(handlers).toHaveLength(3);
    for (const handler of handlers) registerExposureHandler(handler);
    expect(listExposureHandlers()).toHaveLength(3);
    const outcome = await notifyExposureHandlers([{ marker: 'hbsag' }]);
    expect(outcome.deliveries).toHaveLength(3);
    expect(seen).toEqual(['first', 'second', 'third']);
    expect(outcome.complete).toBe(false);
    expect(outcome.deliveries.map(row => row.complete)).toEqual([true, false, true]);
  });

  test('resolution without valid zero obligation counts cannot complete', async () => {
    const results = [undefined, {}, { ...settled(), remaining_device_count: -1 },
      { ...settled(), remaining_alert_count: 1 }, { ...settled(), remaining_notification_count: NaN }];
    expect(results).toHaveLength(5);
    for (const [index, result] of results.entries()) {
      registerExposureHandler({ id: `invalid-${index}.v1`, apply: async () => result });
    }
    const outcome = await notifyExposureHandlers([{}]);
    expect(outcome.deliveries).toHaveLength(5);
    expect(outcome.deliveries.map(row => row.complete)).toEqual([false, false, false, false, false]);
  });

  test('rejects unstable identities and cannot silently replace a required consumer', () => {
    expect(() => registerExposureHandler(async () => settled())).toThrow(TypeError);
    const unregister = registerExposureHandler({ id: 'first.v1', apply: async () => settled() });
    expect(exposureHandlerCount()).toBe(1);
    expect(() => registerExposureHandler({ id: 'first.v1', apply: async () => settled() })).toThrow(TypeError);
    unregister();
    expect(exposureHandlerCount()).toBe(0);
  });
});
