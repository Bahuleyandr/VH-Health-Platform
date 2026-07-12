// NL13-P1f unit coverage: emergency bypass, soft-conflict flags, fail-closed
// thresholds, complication mapping, review transitions, cockpit registration.

import {
  BOOKABLE_CASE_STATUSES,
  REGISTRY_REVIEW_TRANSITIONS,
  assertCaseBookable,
  computeSoftConflicts,
  evaluateDoseRecordAgainstThresholds,
  mapComplicationElement
} from '../../services/clinical/cathSchedulingRegistryService.js';
import {
  INDICATOR_CODES,
  INDICATOR_DEFINITIONS
} from '../../services/quality/nabhIndicatorService.js';

describe('NL13-P1f cath scheduling + registry unit', () => {
  describe('assertCaseBookable (emergency bypass)', () => {
    it('allows elective/routine/urgent cases in bookable states', () => {
      for (const urgency of ['elective', 'routine', 'urgent']) {
        for (const status of BOOKABLE_CASE_STATUSES) {
          expect(assertCaseBookable({ urgency, status })).toBe(true);
        }
      }
    });

    it('rejects emergency cases with the documented bypass code', () => {
      try {
        assertCaseBookable({ urgency: 'emergency', status: 'requested' });
        throw new Error('expected bypass rejection');
      } catch (err) {
        expect(err.code).toBe('CATH_SCHED_EMERGENCY_BYPASS');
        expect(err.statusCode).toBe(400);
      }
    });

    it('rejects non-bookable case states', () => {
      for (const status of ['in_progress', 'completed', 'cancelled']) {
        expect(() => assertCaseBookable({ urgency: 'routine', status })).toThrow();
      }
    });

    it('rejects a missing case as not found', () => {
      try {
        assertCaseBookable(null);
        throw new Error('expected not found');
      } catch (err) {
        expect(err.statusCode).toBe(404);
      }
    });
  });

  describe('computeSoftConflicts', () => {
    const booking = (id, startsAt, endsAt) => ({
      link_id: id,
      starts_at: startsAt,
      ends_at: endsAt
    });

    it('flags bookings overlapped by an active emergency and never blocks them', () => {
      const bookings = [
        booking(1, '2026-07-12T04:00:00Z', '2026-07-12T05:00:00Z'),
        booking(2, '2026-07-12T09:00:00Z', '2026-07-12T10:00:00Z')
      ];
      const emergencies = [{
        id: 77,
        status: 'in_progress',
        actual_start_at: '2026-07-12T03:30:00Z',
        actual_end_at: null,
        planned_start_at: null,
        planned_end_at: null,
        created_at: '2026-07-12T03:25:00Z'
      }];
      const flagged = computeSoftConflicts(bookings, emergencies);
      // Open-ended emergency contends with everything after it starts.
      expect(flagged[0].soft_conflict).toBe(true);
      expect(flagged[0].conflicting_emergency_case_ids).toEqual([77]);
      expect(flagged[1].soft_conflict).toBe(true);
      // The bookings themselves are untouched (no cancel/block fields).
      expect(flagged[0].starts_at).toBe(bookings[0].starts_at);
    });

    it('does not flag when the emergency completed before the booking window', () => {
      const flagged = computeSoftConflicts(
        [booking(1, '2026-07-12T09:00:00Z', '2026-07-12T10:00:00Z')],
        [{
          id: 5,
          status: 'in_progress',
          actual_start_at: '2026-07-12T03:00:00Z',
          actual_end_at: '2026-07-12T04:00:00Z'
        }]
      );
      expect(flagged[0].soft_conflict).toBe(false);
      expect(flagged[0].conflicting_emergency_case_ids).toEqual([]);
    });

    it('ignores completed/cancelled emergencies entirely', () => {
      const flagged = computeSoftConflicts(
        [booking(1, '2026-07-12T04:00:00Z', '2026-07-12T05:00:00Z')],
        [
          { id: 1, status: 'completed', actual_start_at: '2026-07-12T03:00:00Z' },
          { id: 2, status: 'cancelled', actual_start_at: '2026-07-12T03:00:00Z' }
        ]
      );
      expect(flagged[0].soft_conflict).toBe(false);
    });
  });

  describe('evaluateDoseRecordAgainstThresholds (fail-closed)', () => {
    const record = {
      fluoroscopy_time_min: 30,
      dose_area_product_gy_cm2: 250,
      air_kerma_mgy: 1200,
      contrast_volume_ml: 180
    };

    it('reports thresholds_pending with no settings and never flags', () => {
      const result = evaluateDoseRecordAgainstThresholds(record, null);
      expect(result.thresholds_status).toBe('thresholds_pending');
      expect(result.breaches).toEqual([]);
    });

    it('flags only fields exceeding an owner-configured threshold', () => {
      const result = evaluateDoseRecordAgainstThresholds(record, {
        fluoro_time_alert_min: 20,
        dap_alert_gy_cm2: 300,
        air_kerma_alert_mgy: null,
        contrast_volume_alert_ml: 150
      });
      expect(result.thresholds_status).toBe('configured');
      const fields = result.breaches.map(b => b.field).sort();
      expect(fields).toEqual(['contrast_volume_ml', 'fluoroscopy_time_min']);
    });

    it('never flags when the record value is missing', () => {
      const result = evaluateDoseRecordAgainstThresholds(
        { fluoroscopy_time_min: null },
        { fluoro_time_alert_min: 10 }
      );
      expect(result.breaches).toEqual([]);
    });
  });

  describe('mapComplicationElement', () => {
    it('maps a bare string to an uncategorised description entry', () => {
      expect(mapComplicationElement('Access-site hematoma')).toEqual({
        complication_code: null,
        complication_category: 'uncategorised',
        description: 'Access-site hematoma',
        severity: 'unspecified',
        outcome: null
      });
    });

    it('maps a structured element and keeps owner taxonomy free-form', () => {
      const mapped = mapComplicationElement({
        code: 'OWNER-CODE-7',
        category: 'vascular_access',
        description: 'Pseudoaneurysm',
        severity: 'moderate',
        outcome: 'resolved'
      });
      expect(mapped.complication_code).toBe('OWNER-CODE-7');
      expect(mapped.complication_category).toBe('vascular_access');
      expect(mapped.severity).toBe('moderate');
      expect(mapped.outcome).toBe('resolved');
    });

    it('coerces unknown severity/outcome to safe defaults instead of failing the log write', () => {
      const mapped = mapComplicationElement({
        category: 'arrhythmia',
        severity: 'catastrophic-nonsense',
        outcome: 'made-up'
      });
      expect(mapped.severity).toBe('unspecified');
      expect(mapped.outcome).toBeNull();
    });

    it('drops empty elements', () => {
      expect(mapComplicationElement('')).toBeNull();
      expect(mapComplicationElement(null)).toBeNull();
      expect(mapComplicationElement(42)).toBeNull();
    });
  });

  describe('registry review lifecycle map', () => {
    it('closed is terminal except reopen to under_review', () => {
      expect(REGISTRY_REVIEW_TRANSITIONS.closed).toEqual(['under_review']);
    });
    it('every non-terminal state can reach closed', () => {
      for (const from of ['open', 'under_review', 'reviewed']) {
        expect(REGISTRY_REVIEW_TRANSITIONS[from]).toContain('closed');
      }
    });
  });

  describe('quality-cockpit registration', () => {
    it('registers the three cath indicators on the NABH rails', () => {
      for (const code of ['cath_case_volume', 'cath_complication_rate_pct', 'cath_dose_outlier_count']) {
        expect(INDICATOR_CODES).toContain(code);
        expect(INDICATOR_DEFINITIONS[code]).toBeDefined();
        expect(INDICATOR_DEFINITIONS[code].source_tables.length).toBeGreaterThan(0);
      }
    });
  });
});
