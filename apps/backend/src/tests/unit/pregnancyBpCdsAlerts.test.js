// Unit regression for finding H' D26 (b6dc4ea4).
//
// `checkVitalAnomalies` correctly generates gestational-hypertension
// and pre-eclampsia screen alerts for pregnant patients with BP
// ≥140/90, but only persisted them to `clinical_alerts`. The doctor's
// CDS dashboard reads from `cds_alerts` (separate table), so during
// an ANC visit the dashboard showed zero pregnancy-BP warnings even
// though the alerts had fired — clinically dangerous for early-
// pre-eclampsia detection.
//
// The fix mirrors pregnancy-BP signals (preeclampsia_screen + any
// alert whose range carries `preeclampsia: true`) to `cds_alerts`
// alongside the existing `clinical_alerts` write. Non-pregnancy
// vital alerts stay clinical_alerts-only (existing behaviour
// preserved).
//
// Asserts:
//   * Gestational HTN (BP 142/91, no proteinuria, pregnant) → both
//     clinical_alerts + cds_alerts get written.
//   * Pre-eclampsia screen (BP 145/92 with proteinuria, pregnant)
//     → both writes happen with the CRITICAL severity / specific
//     alert_type.
//   * Non-pregnant patient with high BP (165/105) → only
//     clinical_alerts gets written. cds_alerts stays untouched.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Realtime + notification side-effects are out of scope for this unit
// test — the regression is about the DB-mirror surface only.
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitVitalAnomaly: jest.fn(),
  emitCodeBlue: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn().mockResolvedValue(undefined),
}));

const { checkVitalAnomalies } = await import('../../utils/clinical/vitalSignMonitor.js');

const PATIENT_ID = 7777;
const PATIENT_UID = 'd0000000-1111-4222-8333-aaaaaaaa9912';

function setupPatient({ isPregnant }) {
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  // resolvePatientContext is one query returning {age_years, is_pregnant}.
  // The cds_alerts mirror runs a follow-up users SELECT for uid; supply
  // it second so it lands when the mirror actually fires.
  queryRawMock
    .mockResolvedValueOnce([{ age_years: 30, is_pregnant: isPregnant }])
    .mockResolvedValueOnce([{ uid: PATIENT_UID }])
    // Subsequent clinical_alerts INSERTs use $queryRawUnsafe too; an
    // empty-array result is harmless for the INSERT pattern.
    .mockResolvedValue([]);
  executeRawMock.mockResolvedValue(1);
}

describe('checkVitalAnomalies — pregnancy BP mirror to cds_alerts (H D26)', () => {
  it('mirrors gestational HTN (no proteinuria) to cds_alerts with PREGNANCY_HYPERTENSION alert_type', async () => {
    setupPatient({ isPregnant: true });

    const alerts = await checkVitalAnomalies(PATIENT_ID, {
      systolic_bp: 142,
      diastolic_bp: 91,
    }, { recordedBy: 'nurse-uid' });

    // The systolic+diastolic both trip the >139/89 WARNING (pregnancy
    // override), so two pregnancy-BP alerts fire. Both should mirror.
    const cdsCalls = executeRawMock.mock.calls.filter((args) =>
      /INSERT INTO cds_alerts/.test(args[0]),
    );
    expect(cdsCalls.length).toBeGreaterThanOrEqual(1);
    expect(cdsCalls[0][2]).toBe('PREGNANCY_HYPERTENSION'); // alert_type ($2)
    expect(cdsCalls[0][3]).toBe('WARNING'); // severity ($3)
    expect(cdsCalls[0][1]).toBe(PATIENT_UID); // patient_uid ($1)
    expect(alerts.length).toBeGreaterThanOrEqual(2);
  });

  it('mirrors a positive pre-eclampsia screen (BP + proteinuria) with PREECLAMPSIA_SCREEN_POSITIVE / CRITICAL', async () => {
    setupPatient({ isPregnant: true });

    const alerts = await checkVitalAnomalies(PATIENT_ID, {
      systolic_bp: 145,
      diastolic_bp: 92,
      urine_albumin: '2+',
    }, { recordedBy: 'nurse-uid' });

    const cdsCalls = executeRawMock.mock.calls.filter((args) =>
      /INSERT INTO cds_alerts/.test(args[0]),
    );
    // Three pregnancy-BP signals fire here: systolic warning, diastolic
    // warning, plus the preeclampsia screen. All should mirror.
    expect(cdsCalls.length).toBeGreaterThanOrEqual(3);
    const screenCall = cdsCalls.find((args) => args[2] === 'PREECLAMPSIA_SCREEN_POSITIVE');
    expect(screenCall).toBeTruthy();
    expect(screenCall[3]).toBe('CRITICAL');
    // The preeclampsia screen alert appears in the returned alerts list.
    expect(alerts.find((a) => a.vital_name === 'preeclampsia_screen')).toBeTruthy();
  });

  it('does NOT mirror non-pregnant high-BP alerts to cds_alerts (existing behaviour preserved)', async () => {
    setupPatient({ isPregnant: false });

    const alerts = await checkVitalAnomalies(PATIENT_ID, {
      systolic_bp: 165,
      diastolic_bp: 105,
    }, { recordedBy: 'nurse-uid' });

    // High-BP alerts still land in clinical_alerts but cds_alerts must
    // NOT be touched — the pregnancy-BP mirror only fires for
    // pregnant patients.
    const cdsCalls = executeRawMock.mock.calls.filter((args) =>
      /INSERT INTO cds_alerts/.test(args[0]),
    );
    expect(cdsCalls.length).toBe(0);
    expect(alerts.length).toBeGreaterThan(0);
  });
});
