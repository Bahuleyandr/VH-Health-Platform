/**
 * Unit tests for the G3 AI outcome scoreboard pure functions — metric math
 * only, no database. The HTTP/database round trip lives in
 * src/tests/ai-outcome-scoreboard.deep.test.js.
 */

import {
  aggregateOutcomeScoreboard,
  draftToComparableText,
  median,
  normalizedWordEditDistance,
  pct,
  tokenizeForDiff,
} from '../../services/ai/aiOutcomeScoreboardService.js';

describe('pct', () => {
  it('returns null (not 0) when the denominator is zero — no data is not 0%', () => {
    expect(pct(0, 0)).toBeNull();
    expect(pct(5, 0)).toBeNull();
  });

  it('rounds to one decimal place', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(2, 3)).toBe(66.7);
    expect(pct(3, 4)).toBe(75);
  });
});

describe('median', () => {
  it('handles odd and even counts and empties', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median(['nope'])).toBeNull();
  });
});

describe('draftToComparableText', () => {
  it('is stable across object key insertion order', () => {
    const a = draftToComparableText({ b: 'world', a: 'hello' });
    const b = draftToComparableText({ a: 'hello', b: 'world' });
    expect(a).toBe(b);
    expect(a).toBe('hello\nworld');
  });

  it('walks nested arrays/objects, keeps numbers, skips null/empty', () => {
    const text = draftToComparableText({
      plan: ['rest', { dose_mg: 500, note: ' taper ' }],
      empty: null,
      blank: '   ',
    });
    expect(text).toBe('rest\n500\ntaper');
  });

  it('passes plain strings through', () => {
    expect(draftToComparableText('as written')).toBe('as written');
  });
});

describe('normalizedWordEditDistance', () => {
  it('is 0 for identical text (case-insensitive)', () => {
    expect(normalizedWordEditDistance('Continue Aspirin daily', 'continue aspirin daily')).toBe(0);
  });

  it('is 100 when one side is empty or nothing matches', () => {
    expect(normalizedWordEditDistance('', 'something here')).toBe(100);
    expect(normalizedWordEditDistance('alpha beta', 'gamma delta')).toBe(100);
  });

  it('is 0 when both sides are empty', () => {
    expect(normalizedWordEditDistance('', '')).toBe(0);
  });

  it('scores a one-word substitution in four words as 25', () => {
    expect(normalizedWordEditDistance('alpha beta gamma delta', 'alpha beta gamma echo')).toBe(25);
  });

  it('normalizes by the longer sequence on insertion', () => {
    // 1 insertion into a 3-word draft → 1/4 = 25%
    expect(normalizedWordEditDistance('alpha beta gamma', 'alpha beta gamma delta')).toBe(25);
  });

  it('caps token windows', () => {
    expect(tokenizeForDiff('a b c d e', 3)).toEqual(['a', 'b', 'c']);
    expect(normalizedWordEditDistance('a b c x', 'a b c y', { maxTokens: 3 })).toBe(0);
  });
});

describe('aggregateOutcomeScoreboard', () => {
  const input = {
    registry: [
      { module_key: 'discharge_summary', display_name: 'Discharge Summary', enabled: true },
      { module_key: 'idle_enabled_module', display_name: 'Idle But Enabled', enabled: true },
      { module_key: 'disabled_idle_module', display_name: 'Disabled Idle', enabled: false },
    ],
    generations: [
      { module_key: 'discharge_summary', generation_count: 10, ai_generation_count: 8, fallback_count: 2 },
    ],
    reviews: [
      {
        module_key: 'discharge_summary',
        review_count: 8,
        accepted_count: 3,
        edited_count: 2,
        rejected_count: 1,
        needs_revision_count: 0,
        pending_count: 2,
        avg_review_latency_minutes: 42.42,
      },
    ],
    editPairs: [
      {
        module_key: 'discharge_summary',
        draft: { summary: 'alpha beta gamma delta' },
        edited_draft: { summary: 'alpha beta gamma echo' },
      },
      {
        module_key: 'discharge_summary',
        draft: { summary: 'one two three four' },
        edited_draft: { summary: 'one two three four' },
      },
    ],
    safety: [
      {
        module_key: 'discharge_summary',
        flagged_total: 5,
        flagged_decided: 4,
        flagged_confirmed: 3,
        flagged_overridden: 1,
        missed_reject_count: 2,
      },
    ],
    aiTimeToSign: [
      { module_key: 'discharge_summary', note_type: 'discharge', signed_count: 6, median_minutes: 12, avg_minutes: 14 },
    ],
    baselineTimeToSign: [
      { note_type: 'discharge', signed_count: 20, median_minutes: 30, avg_minutes: 31 },
      { note_type: 'progress', signed_count: 50, median_minutes: 9, avg_minutes: 10 },
    ],
    medicationSafety: [
      { review_type: 'drug_interaction', finding_count: 10, critical_count: 2, blocker_count: 4, overridden_count: 1 },
      { review_type: 'allergy', finding_count: 6, critical_count: 1, blocker_count: 0, overridden_count: 0 },
    ],
  };

  it('assembles per-module rates, edit stats, safety precision, and time-to-sign deltas', () => {
    const result = aggregateOutcomeScoreboard(input);
    const row = result.modules.find((m) => m.module_key === 'discharge_summary');
    expect(row).toBeTruthy();
    expect(row.display_name).toBe('Discharge Summary');
    expect(row.enabled).toBe(true);

    expect(row.generations).toEqual({ total: 10, ai_generated: 8, fallback: 2 });

    // decided = 3 + 2 + 1 + 0 = 6
    expect(row.reviews.decided).toBe(6);
    expect(row.reviews.pending).toBe(2);
    expect(row.reviews.acceptance_rate_pct).toBe(50);   // 3/6
    expect(row.reviews.edit_rate_pct).toBe(33.3);       // 2/6
    expect(row.reviews.rejection_rate_pct).toBe(16.7);  // 1/6
    expect(row.reviews.needs_revision_rate_pct).toBe(0); // 0/6
    expect(row.reviews.used_rate_pct).toBe(83.3);
    expect(row.reviews.avg_review_latency_minutes).toBe(42.4);

    // distances: 25 and 0 → mean 12.5, median 12.5
    expect(row.edits.sample_count).toBe(2);
    expect(row.edits.mean_edit_distance_pct).toBe(12.5);
    expect(row.edits.median_edit_distance_pct).toBe(12.5);

    expect(row.safety.flag_precision_pct).toBe(75);
    expect(row.safety.flag_override_rate_pct).toBe(25);
    expect(row.safety.missed_reject_count).toBe(2);

    expect(row.time_to_sign).toHaveLength(1);
    expect(row.time_to_sign[0]).toMatchObject({
      note_type: 'discharge',
      ai_signed_count: 6,
      ai_median_minutes: 12,
      baseline_signed_count: 20,
      baseline_median_minutes: 30,
      median_delta_minutes: -18,
    });
  });

  it('keeps enabled-but-idle modules on the board and omits disabled idle ones', () => {
    const result = aggregateOutcomeScoreboard(input);
    const idle = result.modules.find((m) => m.module_key === 'idle_enabled_module');
    expect(idle).toBeTruthy();
    expect(idle.generations.total).toBe(0);
    expect(idle.reviews.acceptance_rate_pct).toBeNull();
    expect(idle.edits.median_edit_distance_pct).toBeNull();
    expect(result.modules.find((m) => m.module_key === 'disabled_idle_module')).toBeUndefined();
  });

  it('computes totals and medication-safety override rates', () => {
    const result = aggregateOutcomeScoreboard(input);
    expect(result.totals.modules_with_activity).toBe(1);
    expect(result.totals.generations.total).toBe(10);
    expect(result.totals.reviews.acceptance_rate_pct).toBe(50);
    expect(result.totals.reviews.edit_rate_pct).toBe(33.3);        // 2/6
    expect(result.totals.reviews.rejection_rate_pct).toBe(16.7);   // 1/6
    expect(result.totals.reviews.needs_revision_rate_pct).toBe(0); // 0/6
    expect(result.totals.safety.flag_precision_pct).toBe(75);
    expect(result.totals.edits.sample_count).toBe(2);
    expect(result.totals.time_to_sign.ai_signed_count).toBe(6);
    expect(result.totals.time_to_sign.baseline_signed_count).toBe(20);

    expect(result.medication_safety.finding_count).toBe(16);
    expect(result.medication_safety.blocker_count).toBe(4);
    expect(result.medication_safety.overridden_count).toBe(1);
    expect(result.medication_safety.override_rate_pct).toBe(25);
    const allergyRow = result.medication_safety.by_type.find((r) => r.review_type === 'allergy');
    expect(allergyRow.override_rate_pct).toBeNull(); // no blockers → no rate
  });

  it('handles a completely empty window without inventing zeros-as-rates', () => {
    const result = aggregateOutcomeScoreboard({});
    expect(result.modules).toEqual([]);
    expect(result.totals.reviews.acceptance_rate_pct).toBeNull();
    expect(result.totals.reviews.edit_rate_pct).toBeNull();
    expect(result.totals.reviews.rejection_rate_pct).toBeNull();
    expect(result.totals.reviews.needs_revision_rate_pct).toBeNull();
    expect(result.totals.safety.flag_precision_pct).toBeNull();
    expect(result.medication_safety.override_rate_pct).toBeNull();
  });

  it('edit_rate_pct, rejection_rate_pct, needs_revision_rate_pct math with mixed decisions', () => {
    // 10 decided: 2 accepted, 4 edited, 3 rejected, 1 needs_revision
    const result = aggregateOutcomeScoreboard({
      registry: [{ module_key: 'opd_assist', display_name: 'OPD Assist', enabled: true }],
      reviews: [
        {
          module_key: 'opd_assist',
          review_count: 12,
          accepted_count: 2,
          edited_count: 4,
          rejected_count: 3,
          needs_revision_count: 1,
          pending_count: 2,
          avg_review_latency_minutes: 5.5,
        },
      ],
    });
    const row = result.modules.find((m) => m.module_key === 'opd_assist');
    expect(row).toBeTruthy();
    // decided = 2 + 4 + 3 + 1 = 10
    expect(row.reviews.decided).toBe(10);
    expect(row.reviews.acceptance_rate_pct).toBe(20);      // 2/10
    expect(row.reviews.edit_rate_pct).toBe(40);            // 4/10
    expect(row.reviews.rejection_rate_pct).toBe(30);       // 3/10
    expect(row.reviews.needs_revision_rate_pct).toBe(10);  // 1/10
    expect(row.reviews.used_rate_pct).toBe(60);            // 6/10 (accepted + edited)
    // Rates sum to 100% when no pending
    expect(
      row.reviews.acceptance_rate_pct +
      row.reviews.edit_rate_pct +
      row.reviews.rejection_rate_pct +
      row.reviews.needs_revision_rate_pct,
    ).toBe(100);
    // Totals mirror the single module
    expect(result.totals.reviews.edit_rate_pct).toBe(40);
    expect(result.totals.reviews.rejection_rate_pct).toBe(30);
    expect(result.totals.reviews.needs_revision_rate_pct).toBe(10);
  });

  it('all four rates are null when no reviews have been decided yet', () => {
    const result = aggregateOutcomeScoreboard({
      registry: [{ module_key: 'pending_module', display_name: 'Pending Only', enabled: true }],
      reviews: [
        {
          module_key: 'pending_module',
          review_count: 3,
          accepted_count: 0,
          edited_count: 0,
          rejected_count: 0,
          needs_revision_count: 0,
          pending_count: 3,
          avg_review_latency_minutes: null,
        },
      ],
    });
    const row = result.modules.find((m) => m.module_key === 'pending_module');
    expect(row).toBeTruthy();
    expect(row.reviews.decided).toBe(0);
    expect(row.reviews.acceptance_rate_pct).toBeNull();
    expect(row.reviews.edit_rate_pct).toBeNull();
    expect(row.reviews.rejection_rate_pct).toBeNull();
    expect(row.reviews.needs_revision_rate_pct).toBeNull();
    expect(row.reviews.used_rate_pct).toBeNull();
  });
});
