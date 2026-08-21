// Gap-audit 2026-08 (PHI mounts): five PHI-serving mounts had no mount- or
// router-level access-trail logging — revenue-cycle billing (incl. the X12
// 837P claim-document endpoint), insurance claims, PM-JAY, patient-linked
// staff messaging, and the unified EMR timeline (whose reads provably
// bypassed the later path-scoped CLINICAL_NOTE logger because the timeline
// router is mounted first and terminates the request).
//
// This pins the wiring: each mount carries the phiAccessLogger (identified by
// its phiRecordType introspection tag) BEFORE the router it protects, so
// every access lands in hipaa_access_log. DB-side row assertions live in the
// deep suites; this is the mock-level mount contract (same approach as
// patientNamespaceRoutes.test.js).
import app from '../../app.js';
import { shouldLogPhiAccessPath } from '../../middleware/conditionalPhiAccessMiddleware.js';

/** All app-level layers mounted at exactly mountPath, with stack indexes. */
function mountLayers(mountPath) {
  const targetPath = `${mountPath}/__probe__`;
  return app.router.stack
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) =>
      layer.matchers?.some((matcher) => matcher(targetPath)?.path === mountPath),
    );
}

function loggerEntry(mountPath, recordType) {
  return mountLayers(mountPath).find(
    ({ layer }) => layer.handle?.phiRecordType === recordType,
  );
}

/**
 * The mount carries phiAccessLogger(recordType) and at least one router is
 * mounted AFTER it at the same path (the logger must run before the routes).
 */
function expectLoggerBeforeRouter(mountPath, recordType) {
  const entries = mountLayers(mountPath);
  const logger = entries.find(({ layer }) => layer.handle?.phiRecordType === recordType);
  expect(logger).toBeDefined();
  const routersAfter = entries.filter(
    ({ layer, index }) => layer.handle?.stack && index > logger.index,
  );
  expect(routersAfter.length).toBeGreaterThan(0);
}

describe('gap-audit PHI mounts carry access-trail logging', () => {
  it('logs revenue-cycle billing PHI access (incl. the X12 837P claim endpoint)', () => {
    expectLoggerBeforeRouter('/api/v1/billing', 'REVENUE_CYCLE');
    expectLoggerBeforeRouter('/api/v1/billing/revenue-cycle', 'REVENUE_CYCLE');
  });

  it('logs insurance claims PHI access', () => {
    expectLoggerBeforeRouter('/api/v1/insurance', 'INSURANCE_CLAIM');
  });

  it('logs PM-JAY beneficiary/case PHI access', () => {
    expectLoggerBeforeRouter('/api/v1/pmjay', 'PMJAY_CLAIM');
  });

  it('logs patient-linked staff messaging, path-scoped to the CAN-013/014 guard set', () => {
    expectLoggerBeforeRouter('/api/v1/messaging', 'STAFF_MESSAGING');

    const { layer } = loggerEntry('/api/v1/messaging', 'STAFF_MESSAGING');
    const matchers = layer.handle.phiPathMatchers;
    expect(Array.isArray(matchers)).toBe(true);
    // Exactly the guard's route set is logged...
    for (const phiPath of [
      '/api/v1/messaging/send',
      '/api/v1/messaging/broadcast',
      '/api/v1/messaging/threads/0f5c2f4e-1111-4222-8333-444455556666/attachments',
      '/api/v1/messaging/patient/0f5c2f4e-1111-4222-8333-444455556666',
    ]) {
      expect(shouldLogPhiAccessPath(phiPath, matchers)).toBe(true);
    }
    // ...while patient-free ops chatter stays out of the breach-detection trail.
    for (const opsPath of [
      '/api/v1/messaging/targets',
      '/api/v1/messaging/threads',
      '/api/v1/messaging/inbox',
      '/api/v1/messaging/unread-count',
    ]) {
      expect(shouldLogPhiAccessPath(opsPath, matchers)).toBe(false);
    }
  });

  it('logs unified EMR timeline reads on the timeline mount itself', () => {
    expectLoggerBeforeRouter('/api/v1/emr/timeline', 'EMR_TIMELINE');
  });

  it('keeps the logged timeline mount ahead of the broad EMR gate (order that bypassed the CLINICAL_NOTE logger)', () => {
    // The timeline router terminates timeline reads before the later
    // /api/v1/emr mounts run, so timeline logging MUST live on this earlier
    // mount — a regression that moves it after the broad gate would re-open
    // the unlogged window this fix closed.
    const timelineLogger = loggerEntry('/api/v1/emr/timeline', 'EMR_TIMELINE');
    const firstBroadEmr = mountLayers('/api/v1/emr')[0];
    expect(timelineLogger).toBeDefined();
    expect(firstBroadEmr).toBeDefined();
    expect(timelineLogger.index).toBeLessThan(firstBroadEmr.index);
  });
});
