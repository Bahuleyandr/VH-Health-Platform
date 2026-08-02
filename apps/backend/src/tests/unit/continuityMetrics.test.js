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
      facilityId: 7,
      freshUntil: '2026-07-30T06:30:00.000Z',
      complete: true,
    });
    recordContinuityVerificationFailure({
      facilityId: 7,
      reason: 'ACCESS_REVISION_ROLLBACK',
    });
    recordContinuityEdgeSyncSuccess({
      facilityId: 7,
      succeededAt: '2026-07-30T06:20:00.000Z',
      replicationLagSeconds: 17,
    });

    const output = serializeContinuityMetrics();

    expect(output).toContain(
      'vhhealth_continuity_pack_fresh_until_timestamp_seconds{facility_id="7"} 1785393000',
    );
    expect(output).toContain(
      'vhhealth_continuity_verification_failures_total{facility_id="7",reason="ACCESS_REVISION_ROLLBACK"} 1',
    );
    expect(output).toContain(
      'vhhealth_continuity_coverage_complete{facility_id="7"} 1',
    );
    expect(output).toContain(
      'vhhealth_continuity_edge_last_sync_success_timestamp_seconds{facility_id="7"} 1785392400',
    );
    expect(output).toContain(
      'vhhealth_continuity_edge_replication_lag_seconds{facility_id="7"} 17',
    );
  });

  it('marks incomplete coverage and rejects unbounded failure labels', () => {
    recordContinuityCoverageIncomplete({ facilityId: 7 });
    setContinuityEdgeReplicationLag({ facilityId: 7, replicationLagSeconds: 0 });

    expect(serializeContinuityMetrics()).toContain(
      'vhhealth_continuity_coverage_complete{facility_id="7"} 0',
    );
    expect(serializeContinuityMetrics()).toContain(
      'vhhealth_continuity_coverage_incomplete_total{facility_id="7"} 1',
    );
    expect(() =>
      recordContinuityVerificationFailure({
        facilityId: 7,
        reason: 'free form reason',
      }),
    ).toThrow('stable upper-snake-case');
    expect(() =>
      setContinuityEdgeReplicationLag({ facilityId: 7, replicationLagSeconds: -1 }),
    ).toThrow('finite non-negative');
  });

  // The alert rules aggregate `by (facility_id)`. Two facilities must therefore
  // land on two distinct series — one healthy facility must never be able to
  // supply the max()/min() that hides a sick one.
  it('keeps one facility series from masking another facility series', () => {
    recordContinuityPublication({
      facilityId: 41,
      freshUntil: '2026-07-30T00:00:00.000Z',
      complete: false,
    });
    recordContinuityEdgeSyncSuccess({
      facilityId: 41,
      succeededAt: '2026-07-30T00:00:00.000Z',
      replicationLagSeconds: 3600,
    });
    recordContinuityPublication({
      facilityId: 42,
      freshUntil: '2026-07-30T12:00:00.000Z',
      complete: true,
    });
    recordContinuityEdgeSyncSuccess({
      facilityId: 42,
      succeededAt: '2026-07-30T11:59:00.000Z',
      replicationLagSeconds: 5,
    });

    const output = serializeContinuityMetrics();

    expect(output).toContain(
      'vhhealth_continuity_pack_fresh_until_timestamp_seconds{facility_id="41"} 1785369600',
    );
    expect(output).toContain(
      'vhhealth_continuity_pack_fresh_until_timestamp_seconds{facility_id="42"} 1785412800',
    );
    expect(output).toContain('vhhealth_continuity_coverage_complete{facility_id="41"} 0');
    expect(output).toContain('vhhealth_continuity_coverage_complete{facility_id="42"} 1');
    expect(output).toContain(
      'vhhealth_continuity_edge_replication_lag_seconds{facility_id="41"} 3600',
    );
    expect(output).toContain(
      'vhhealth_continuity_edge_replication_lag_seconds{facility_id="42"} 5',
    );
  });

  // A sample with no facility_id would aggregate into its own phantom group and
  // reintroduce exactly the cross-facility masking these labels exist to stop.
  it('never emits an unlabelled continuity sample', () => {
    const samples = serializeContinuityMetrics()
      .split('\n')
      .filter((line) => line.startsWith('vhhealth_continuity_'));

    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample).toMatch(/^vhhealth_continuity_[a-z_]+\{facility_id="[^"]+"/);
    }
  });

  // ContinuityCoverageIncomplete alerts on this counter, NOT on the gauge: a
  // facility that has never published successfully has no pack_fresh_until
  // series for the old gauge join to match against, so its coverage failure was
  // silent (#710). The counter needs no join.
  it('counts every coverage failure per facility, with no publication required', () => {
    recordContinuityCoverageIncomplete({ facilityId: 61 });
    recordContinuityCoverageIncomplete({ facilityId: 61 });
    recordContinuityCoverageIncomplete({ facilityId: 62 });

    const output = serializeContinuityMetrics();

    expect(output).toContain(
      'vhhealth_continuity_coverage_incomplete_total{facility_id="61"} 2',
    );
    expect(output).toContain(
      'vhhealth_continuity_coverage_incomplete_total{facility_id="62"} 1',
    );
    // Neither facility ever published, so neither has a pack_fresh_until series
    // — which is exactly the case the gauge join could not see.
    expect(output).not.toContain(
      'vhhealth_continuity_pack_fresh_until_timestamp_seconds{facility_id="61"}',
    );
    expect(output).not.toContain(
      'vhhealth_continuity_pack_fresh_until_timestamp_seconds{facility_id="62"}',
    );
  });

  // A successful publication must not touch the counter, or every healthy
  // facility would page.
  it('leaves the coverage-failure counter alone on a complete publication', () => {
    recordContinuityPublication({
      facilityId: 63,
      freshUntil: '2026-07-30T06:30:00.000Z',
      complete: true,
    });

    expect(serializeContinuityMetrics()).not.toContain(
      'vhhealth_continuity_coverage_incomplete_total{facility_id="63"}',
    );
  });

  // An unusable facility id must still produce a sample: dropping it would make
  // the failure invisible to a `by (facility_id)` rule.
  it('collapses an unusable facility id to a bounded unknown label', () => {
    recordContinuityVerificationFailure({ reason: 'MANIFEST_HASH_MISMATCH' });
    recordContinuityVerificationFailure({
      facilityId: 'not-a-facility',
      reason: 'MANIFEST_HASH_MISMATCH',
    });

    expect(serializeContinuityMetrics()).toContain(
      'vhhealth_continuity_verification_failures_total{facility_id="unknown",reason="MANIFEST_HASH_MISMATCH"} 2',
    );
  });
});
