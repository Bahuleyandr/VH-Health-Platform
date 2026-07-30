import {
  recordContinuityCoverageIncomplete,
  recordContinuityEdgeSyncSuccess,
  recordContinuityPublication,
  recordContinuityVerificationFailure,
  serializeContinuityMetrics,
  setContinuityEdgeReplicationLag,
} from '../../observability/continuityMetrics.js';

describe('continuityMetrics', () => {
  it('exports the exact continuity publication and edge-sync metrics', () => {
    recordContinuityPublication({
      freshUntil: '2026-07-30T06:30:00.000Z',
      complete: true,
    });
    recordContinuityVerificationFailure('ACCESS_REVISION_ROLLBACK');
    recordContinuityEdgeSyncSuccess({
      succeededAt: '2026-07-30T06:20:00.000Z',
      replicationLagSeconds: 17,
    });

    const output = serializeContinuityMetrics();

    expect(output).toContain(
      'vhhealth_continuity_pack_fresh_until_timestamp_seconds 1785393000',
    );
    expect(output).toContain(
      'vhhealth_continuity_verification_failures_total{reason="ACCESS_REVISION_ROLLBACK"} 1',
    );
    expect(output).toContain('vhhealth_continuity_coverage_complete 1');
    expect(output).toContain(
      'vhhealth_continuity_edge_last_sync_success_timestamp_seconds 1785392400',
    );
    expect(output).toContain('vhhealth_continuity_edge_replication_lag_seconds 17');
  });

  it('marks incomplete coverage and rejects unbounded failure labels', () => {
    recordContinuityCoverageIncomplete();
    setContinuityEdgeReplicationLag(0);

    expect(serializeContinuityMetrics()).toContain(
      'vhhealth_continuity_coverage_complete 0',
    );
    expect(() => recordContinuityVerificationFailure('free form reason'))
      .toThrow('stable upper-snake-case');
    expect(() => setContinuityEdgeReplicationLag(-1))
      .toThrow('finite non-negative');
  });
});
