import {
  I25_CUTOVER_CRASH_BOUNDARIES,
  I25_PARITY_GATES,
} from '../../services/security/siemCanonicalCutoverService.js';

describe('I25 canonical SIEM cutover contract', () => {
  it('exposes the required ten gates verbatim and in order', () => {
    expect(I25_PARITY_GATES).toEqual([
      'stable fenced cutoff',
      'shape parity',
      'capture completeness (recomputed payload SHA-256 per row)',
      'per-target delivery completeness from attempt lineage (never export_status)',
      'real acknowledgement policy',
      'cursor equality only where gate 4 passes, else pause at the greatest proven contiguous point with a reconciliation reason',
      'non-destructive fenced cutover (old cursor/events/attempts remain queryable; migrate the existing SIEM cursor only after parity; never delete old evidence)',
      'single writer after cutover (legacy writer frozen, canonical offsets authoritative; never both)',
      'crash/restart injection proofs at every boundary',
      'negative migration proof (any mismatch aborts with zero partial canonical rows)',
    ]);
  });

  it('offers an injection boundary for every gate and the final commit fence', () => {
    expect(I25_CUTOVER_CRASH_BOUNDARIES).toEqual([
      'after_stable_fenced_cutoff',
      'after_shape_parity',
      'after_capture_completeness',
      'after_per_target_delivery_completeness',
      'after_real_acknowledgement_policy',
      'after_cursor_plan',
      'after_non_destructive_evidence_check',
      'after_single_writer_offsets',
      'after_legacy_writer_freeze',
      'before_commit',
    ]);
  });
});
