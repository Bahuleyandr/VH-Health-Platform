// escalationMetrics — the counters that make an escalation trim audible.
//
// These back a clinical-safety claim: when the escalation engine cannot page
// every clinician a tier matched, the shortfall must be visible on the scrape
// endpoint rather than inferred from silence. So this suite pins the exposition
// text itself (that is what Prometheus reads), plus the label-bounding guards —
// role codes come from operator-authored escalation_rules.action_payload, so a
// typo must not be able to mint an unbounded label dimension.
//
// Counters are module-scope and live for the process lifetime; metricPrimitives
// exposes no reset hook. Every assertion below is therefore either a per-series
// absolute on a label combination unique to this file, or a before/after delta.

import {
  recordEscalationCandidateLockSkipped,
  recordEscalationCandidatePageFull,
  recordEscalationRecipientRankingFailure,
  recordEscalationRecipientsTrimmed,
  recordEscalationRecipientsTrimmedByRank,
  serializeEscalationMetrics,
} from '../../observability/escalationMetrics.js';

const TRIM = 'vhhealth_escalation_recipients_trimmed_total';
const PAGE_FULL = 'vhhealth_escalation_candidate_page_full_total';
const LOCK_SKIPPED = 'vhhealth_escalation_candidate_lock_skipped_total';
const TRIM_BY_RANK = 'vhhealth_escalation_recipients_trimmed_by_rank_total';
const RANK_FAILURE = 'vhhealth_escalation_recipient_ranking_failures_total';

function seriesValue(name, labelPart) {
  const prefix = `${name}{${labelPart}} `;
  const line = serializeEscalationMetrics().split('\n').find((l) => l.startsWith(prefix));
  return line ? Number(line.slice(prefix.length)) : 0;
}

describe('escalationMetrics', () => {
  it('always exposes every escalation counter with HELP and TYPE', () => {
    const out = serializeEscalationMetrics();
    expect(out).toContain(`# TYPE ${TRIM} counter`);
    expect(out).toContain(`# TYPE ${PAGE_FULL} counter`);
    expect(out).toContain(`# TYPE ${LOCK_SKIPPED} counter`);
    expect(out).toContain(`# TYPE ${TRIM_BY_RANK} counter`);
    expect(out).toContain(`# TYPE ${RANK_FAILURE} counter`);
    // The HELP text is what an on-call engineer reads in Grafana at 3am; it must
    // say what was lost, not merely name the counter.
    expect(out).toMatch(/# HELP vhhealth_escalation_recipients_trimmed_total .*dropped.*cap/i);
  });

  it('counts recipients dropped, by role and by which resolution arm trimmed', () => {
    recordEscalationRecipientsTrimmed({ role: 'DUTY_DOCTOR', arm: 'family', dropped: 3 });
    expect(serializeEscalationMetrics())
      .toContain(`${TRIM}{role="DUTY_DOCTOR",arm="family"} 3`);

    // Increments by the DROPPED COUNT, not by one per event: "how many clinicians
    // went unpaged" is the actionable number, not "how many times we trimmed".
    recordEscalationRecipientsTrimmed({ role: 'DUTY_DOCTOR', arm: 'family', dropped: 4 });
    expect(serializeEscalationMetrics())
      .toContain(`${TRIM}{role="DUTY_DOCTOR",arm="family"} 7`);

    // The two arms are separate series — a family-fallback trim means something
    // clinically different from an exact-role trim.
    recordEscalationRecipientsTrimmed({ role: 'DUTY_DOCTOR', arm: 'exact', dropped: 1 });
    expect(seriesValue(TRIM, 'role="DUTY_DOCTOR",arm="family"')).toBe(7);
    expect(seriesValue(TRIM, 'role="DUTY_DOCTOR",arm="exact"')).toBe(1);
  });

  it('bounds label cardinality: operator-authored role codes cannot mint free-form series', () => {
    recordEscalationRecipientsTrimmed({ role: 'not a role code!', arm: 'exact', dropped: 2 });
    recordEscalationRecipientsTrimmed({ role: null, arm: 'exact', dropped: 2 });
    expect(seriesValue(TRIM, 'role="UNKNOWN",arm="exact"')).toBe(4);
    expect(serializeEscalationMetrics()).not.toContain('not a role code!');

    // Anything that is not the family arm is the exact arm — no third value.
    recordEscalationRecipientsTrimmed({ role: 'CMO', arm: 'nonsense', dropped: 5 });
    expect(seriesValue(TRIM, 'role="CMO",arm="exact"')).toBe(5);
  });

  it('rejects a non-positive dropped count rather than recording a meaningless trim', () => {
    // A "trim" of zero or fewer recipients is a caller bug. Recording it would
    // put a permanent 0-valued series on the dashboard and dilute the signal.
    expect(() => recordEscalationRecipientsTrimmed({ role: 'CMO', arm: 'exact', dropped: 0 }))
      .toThrow(TypeError);
    expect(() => recordEscalationRecipientsTrimmed({ role: 'CMO', arm: 'exact', dropped: -1 }))
      .toThrow('finite positive');
    expect(() => recordEscalationRecipientsTrimmed({ role: 'CMO', arm: 'exact', dropped: 'lots' }))
      .toThrow('finite positive');
  });

  it('counts full candidate pages by trigger condition, with the same label bounding', () => {
    const before = seriesValue(PAGE_FULL, 'trigger_condition="sla_breach"');
    recordEscalationCandidatePageFull({ triggerCondition: 'sla_breach' });
    expect(seriesValue(PAGE_FULL, 'trigger_condition="sla_breach"')).toBe(before + 1);

    recordEscalationCandidatePageFull({ triggerCondition: 'Robert; DROP TABLE tasks' });
    expect(seriesValue(PAGE_FULL, 'trigger_condition="unknown"')).toBe(1);
    expect(serializeEscalationMetrics()).not.toContain('DROP TABLE');
  });

  it('counts every lock-skipped candidate and bounds the trigger label', () => {
    const before = seriesValue(LOCK_SKIPPED, 'trigger_condition="sla_breach"');
    recordEscalationCandidateLockSkipped({ triggerCondition: 'sla_breach', count: 4 });
    expect(seriesValue(LOCK_SKIPPED, 'trigger_condition="sla_breach"')).toBe(before + 4);
    expect(() => recordEscalationCandidateLockSkipped({ triggerCondition: 'sla_breach', count: 0 }))
      .toThrow(TypeError);
  });

  it('partitions trimmed recipients by bounded rank and failure reason', () => {
    recordEscalationRecipientsTrimmedByRank({
      role: 'DOCTOR', arm: 'exact', rank: 1, dropped: 20,
    });
    recordEscalationRecipientsTrimmedByRank({
      role: 'DOCTOR', arm: 'exact', rank: 'not-a-rank', dropped: 80,
    });
    expect(seriesValue(TRIM_BY_RANK, 'role="DOCTOR",arm="exact",rank="1"')).toBe(20);
    expect(seriesValue(TRIM_BY_RANK, 'role="DOCTOR",arm="exact",rank="unranked"')).toBe(80);

    recordEscalationRecipientRankingFailure({
      role: 'DOCTOR', arm: 'exact', reason: 'mapping_count_mismatch',
    });
    recordEscalationRecipientRankingFailure({
      role: 'DOCTOR', arm: 'exact', reason: 'zero_ranked_candidates',
    });
    expect(seriesValue(
      RANK_FAILURE,
      'role="DOCTOR",arm="exact",reason="mapping_count_mismatch"',
    )).toBe(1);
    expect(seriesValue(
      RANK_FAILURE,
      'role="DOCTOR",arm="exact",reason="zero_ranked_candidates"',
    )).toBe(1);
  });

  it('serializes as valid Prometheus exposition text', () => {
    recordEscalationRecipientsTrimmed({ role: 'RESIDENT', arm: 'family', dropped: 1 });
    const out = serializeEscalationMetrics();
    expect(out.endsWith('\n')).toBe(true);
    for (const line of out.split('\n').filter(Boolean)) {
      // Every line is either a HELP/TYPE comment or `name{labels} <number>`.
      expect(line).toMatch(/^(#\s(HELP|TYPE)\s\S+\s.+|[a-z_][a-z0-9_]*(\{[^}]*\})?\s-?\d+(\.\d+)?)$/);
    }
  });
});
