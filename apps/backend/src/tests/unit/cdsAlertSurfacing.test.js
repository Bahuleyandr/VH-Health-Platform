import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: { $queryRawUnsafe: queryRawUnsafe } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const persistCdsAlert = jest.fn();
jest.unstable_mockModule('../../services/emr/cdsEngine.js', () => ({ persistCdsAlert, default: { persistCdsAlert } }));

const { raiseCdsAlert } = await import('../../services/cds/cdsAlertSurfacing.js');

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafe.mockResolvedValue([]); // no standing alert
});

test('raises a cds_alert when none is standing', async () => {
  const r = await raiseCdsAlert({ patientUid: 'p1', alertType: 'POLYPHARMACY_RISK', severity: 'warning', title: 't', description: 'd', sourceData: { a: 1 } });
  expect(r.raised).toBe(true);
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({
    patientUid: 'p1', alertType: 'POLYPHARMACY_RISK', severity: 'warning', title: 't', description: 'd',
  }));
});

test('de-dups against a standing unacknowledged alert of equal-or-higher severity', async () => {
  queryRawUnsafe.mockResolvedValueOnce([{ severity: 'warning' }]);
  const r = await raiseCdsAlert({ patientUid: 'p1', alertType: 'POLYPHARMACY_RISK', severity: 'warning', title: 't', description: 'd', sourceData: {} });
  expect(r.raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});

test('escalates when the new severity outranks the standing one', async () => {
  queryRawUnsafe.mockResolvedValueOnce([{ severity: 'warning' }]);
  const r = await raiseCdsAlert({ patientUid: 'p1', alertType: 'POLYPHARMACY_RISK', severity: 'critical', title: 't', description: 'd', sourceData: {} });
  expect(r.raised).toBe(true);
  expect(persistCdsAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
});

test('de-dup keys on alert_type — a different type is independent', async () => {
  // The standing alert query is parameterized by alert_type; a fresh type sees no standing row.
  queryRawUnsafe.mockResolvedValueOnce([]); // query for OTHER_TYPE returns none
  const r = await raiseCdsAlert({ patientUid: 'p1', alertType: 'OTHER_TYPE', severity: 'warning', title: 't', description: 'd', sourceData: {} });
  expect(r.raised).toBe(true);
  const sql = queryRawUnsafe.mock.calls[0][0];
  expect(sql).toMatch(/alert_type = \$2/);
});

test('no-ops on missing args or an unknown severity', async () => {
  expect((await raiseCdsAlert({ alertType: 'X', severity: 'warning' })).raised).toBe(false);
  expect((await raiseCdsAlert({ patientUid: 'p1', alertType: 'X', severity: 'bogus' })).raised).toBe(false);
  expect(persistCdsAlert).not.toHaveBeenCalled();
});
