import {
  ACKNOWLEDGEMENT_FLAG,
  READ_ONLY_CHECK_QUERY,
  REPORT_QUERIES,
  SECTION_KEYS,
  TENANT_INVENTORY_QUERY,
  assertOperationalSafety,
  buildPreflightReport,
  classifyDuplicatePregnancyGroup,
  collectAllTenantPreflight,
  parseArgs
} from '../../../scripts/maternity-duplicate-preflight.mjs';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function candidate(overrides = {}) {
  return {
    id: 1,
    pregnancy_number: 1,
    lmp_date: '2025-01-01',
    edd_date: '2025-10-08',
    gravida: 1,
    parity: 0,
    living_children: 0,
    abortions: 0,
    booking_status: 'booked',
    high_risk: false,
    created_at: '2025-01-10T10:00:00.000Z',
    created_by: '11111111-1111-4111-8111-111111111111',
    anc_visit_count: 0,
    latest_anc_visit_date: null,
    labour_admission_count: 0,
    delivery_count: 0,
    supplement_count: 0,
    fetal_kick_count: 0,
    ...overrides
  };
}

function emptyRowsBySection() {
  return Object.fromEntries(SECTION_KEYS.map(key => [key, []]));
}

describe('M-F F0 maternity duplicate preflight', () => {
  describe('operational safety', () => {
    it('requires the explicit all-tenant acknowledgement and a read replica URL', () => {
      expect(() =>
        assertOperationalSafety({
          acknowledged: false,
          env: { DATABASE_URL: 'postgres://primary' }
        })
      ).toThrow(ACKNOWLEDGEMENT_FLAG);
      expect(() =>
        assertOperationalSafety({
          acknowledged: true,
          env: { DATABASE_URL: 'postgres://primary' }
        })
      ).toThrow('DATABASE_READ_URL is required');
      expect(() =>
        assertOperationalSafety({
          acknowledged: true,
          env: { DATABASE_READ_URL: 'postgres://replica' }
        })
      ).not.toThrow();
    });

    it('has no tenant-sampled CLI mode', () => {
      expect(parseArgs([ACKNOWLEDGEMENT_FLAG, '--json'])).toEqual({
        acknowledged: true,
        json: true,
        help: false
      });
      expect(() => parseArgs(['--tenant', TENANT_A])).toThrow('Unknown argument: --tenant');
    });

    it('uses the super-admin read-only transaction and checks it before reports', async () => {
      const calls = [];
      let setTenantCalls = 0;
      const setTenantFn = async (tenantId, fn, options) => {
        setTenantCalls += 1;
        expect(tenantId).toBeNull();
        expect(options).toEqual({ superAdmin: true, readOnly: true });
        return fn({
          $queryRawUnsafe: async sql => {
            calls.push(sql);
            if (sql === READ_ONLY_CHECK_QUERY) return [{ transaction_read_only: 'on' }];
            if (sql === TENANT_INVENTORY_QUERY) return [{ tenant_id: TENANT_A }];
            return [];
          }
        });
      };

      const report = await collectAllTenantPreflight({ setTenantFn });

      expect(setTenantCalls).toBe(1);
      expect(calls).toEqual([
        READ_ONLY_CHECK_QUERY,
        TENANT_INVENTORY_QUERY,
        ...SECTION_KEYS.map(key => REPORT_QUERIES[key])
      ]);
      expect(report.scope).toBe('all_tenants');
      expect(report.tenants_scanned).toBe(1);
    });

    it('stops before inventory or report queries when the transaction is writable', async () => {
      const calls = [];
      const setTenantFn = async (_tenantId, fn) =>
        fn({
          $queryRawUnsafe: async sql => {
            calls.push(sql);
            return [{ transaction_read_only: 'off' }];
          }
        });

      await expect(collectAllTenantPreflight({ setTenantFn })).rejects.toThrow(
        'transaction is writable'
      );
      expect(calls).toEqual([READ_ONLY_CHECK_QUERY]);
    });
  });

  describe('query contracts', () => {
    it('defines exactly the eight required sections with SELECT-only SQL', () => {
      expect(Object.keys(REPORT_QUERIES)).toEqual(SECTION_KEYS);
      for (const sql of [TENANT_INVENTORY_QUERY, ...Object.values(REPORT_QUERIES)]) {
        expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i);
        expect(sql).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|COPY)\b/i
        );
        expect(sql).not.toMatch(/SELECT\s+\*/i);
      }
    });

    it('detects closed-range overlap for bounded and open-ended supplement courses', () => {
      const sql = REPORT_QUERIES.overlapping_supplement_courses;
      expect(sql).toContain('DATERANGE(');
      expect(sql).toContain("COALESCE(a.end_date, 'infinity'::date)");
      expect(sql).toContain("COALESCE(b.end_date, 'infinity'::date)");
      expect(sql).toContain("'[]'");
      expect(sql).toContain('b.id > a.id');
      expect(sql).toContain('a.end_date >= a.start_date');
      expect(sql).toContain('b.end_date >= b.start_date');
    });

    it('uses complete exact JSONB equality for partograph candidates', () => {
      const sql = REPORT_QUERIES.partograph_near_duplicate_candidates;
      for (const field of [
        'bp_systolic',
        'bp_diastolic',
        'pulse_bpm',
        'temperature_c',
        'urine_output_ml',
        'urine_protein',
        'urine_acetone',
        'cervix_dilation_cm',
        'descent_fifths_above_brim',
        'contractions_per_10min',
        'contractions_duration_sec',
        'contractions_intensity',
        'fetal_heart_rate_bpm',
        'fetal_decel',
        'amniotic_fluid',
        'moulding',
        'oxytocin_units_l',
        'oxytocin_drops_min',
        'drugs_given',
        'iv_fluids',
        'on_alert_line',
        'on_action_line',
        'notes'
      ]) {
        expect(sql).toMatch(new RegExp(`\\b${field}\\b`));
      }
      expect(sql).toContain('JSONB_BUILD_ARRAY(');
      expect(sql).toContain('b.clinical_payload = a.clinical_payload');
      expect(sql).toContain("INTERVAL '120 seconds'");
      expect(sql).not.toMatch(/\b(md5|hash|digest)\b/i);
    });

    it('keeps postnatal newborn identity and exact NULL-safe payload matching', () => {
      const sql = REPORT_QUERIES.postnatal_near_duplicate_candidates;
      expect(sql).toContain('a.newborn_id,');
      expect(sql).toContain('b.newborn_id IS NOT DISTINCT FROM a.newborn_id');
      expect(sql).toContain('b.clinical_payload = a.clinical_payload');
      expect(sql).toContain('red_flags');
      expect(sql).toContain('notes');
      expect(sql).toContain("INTERVAL '600 seconds'");
      expect(sql).not.toMatch(/\b(md5|hash|digest)\b/i);
    });
  });

  describe('pregnancy classification', () => {
    it('classifies a NULL-LMP, same-author, ten-minute retry without choosing a survivor', () => {
      const result = classifyDuplicatePregnancyGroup([
        candidate({ id: 1, lmp_date: null, edd_date: null }),
        candidate({
          id: 2,
          lmp_date: null,
          edd_date: null,
          created_at: '2025-01-10T10:10:00.000Z'
        })
      ]);
      expect(result.code).toBe('C-exact-retry');
      expect(result).not.toHaveProperty('survivor');
      expect(result).not.toHaveProperty('action');
    });

    it('classifies an old referenced episode separated by 42 weeks as stale-prior', () => {
      const result = classifyDuplicatePregnancyGroup([
        candidate({
          id: 1,
          lmp_date: '2023-01-01',
          edd_date: '2023-10-08',
          created_at: '2023-01-10T10:00:00.000Z',
          delivery_count: 1
        }),
        candidate({
          id: 2,
          lmp_date: '2024-01-01',
          edd_date: '2024-10-07',
          created_at: '2024-01-10T10:00:00.000Z'
        })
      ]);
      expect(result.code).toBe('C-stale-prior');
    });

    it('classifies a one-core-field difference with split references as typo/merge', () => {
      const result = classifyDuplicatePregnancyGroup([
        candidate({ id: 1, anc_visit_count: 1 }),
        candidate({
          id: 2,
          gravida: 2,
          anc_visit_count: 1,
          created_by: '22222222-2222-4222-8222-222222222222'
        })
      ]);
      expect(result).toEqual({
        code: 'C-typo/merge',
        evidence: ['one_core_field_diff:gravida', 'downstream_references_split_across_candidates']
      });
    });

    it('classifies overlapping, differently dated candidates with ANC evidence as ambiguous', () => {
      const result = classifyDuplicatePregnancyGroup([
        candidate({ id: 1, anc_visit_count: 2 }),
        candidate({
          id: 2,
          lmp_date: '2025-02-01',
          edd_date: '2025-11-08',
          parity: 1,
          anc_visit_count: 1,
          created_by: '22222222-2222-4222-8222-222222222222'
        })
      ]);
      expect(result.code).toBe('C-ambiguous');
      expect(result.evidence).toEqual([
        'different_lmp_dates',
        'lmp_windows_overlap',
        'anc_references_on_multiple_candidates'
      ]);
    });
  });

  describe('tenant-grouped deterministic output', () => {
    it('includes empty tenants, groups every section, and is stable across input ordering', () => {
      const pregnancyRow = {
        tenant_id: TENANT_B,
        patient_uid: 'bbbbbbbb-0000-4000-8000-000000000001',
        ongoing_count: 2,
        candidates: [
          candidate({ id: 8, created_at: '2025-01-10T10:05:00.000Z' }),
          candidate({ id: 7 })
        ]
      };
      const partographRows = [
        {
          tenant_id: TENANT_B,
          labor_admission_id: 11,
          earlier_entry_id: 30,
          later_entry_id: 31,
          earlier_recorded_at: new Date('2025-01-01T10:00:00.000Z'),
          later_recorded_at: new Date('2025-01-01T10:01:00.000Z'),
          gap_seconds: 60n,
          same_author: true
        }
      ];
      const postnatalRows = [
        {
          tenant_id: TENANT_B,
          delivery_id: 21,
          visit_kind: 'baby',
          newborn_id: 55,
          earlier_visit_id: 40,
          later_visit_id: 41,
          earlier_visit_at: '2025-01-02T10:00:00.000Z',
          later_visit_at: '2025-01-02T10:05:00.000Z',
          gap_seconds: 300,
          same_author: false
        }
      ];
      const firstRows = {
        ...emptyRowsBySection(),
        duplicate_ongoing_pregnancies: [pregnancyRow],
        partograph_near_duplicate_candidates: partographRows,
        postnatal_near_duplicate_candidates: postnatalRows
      };
      const secondRows = Object.fromEntries(
        Object.entries(firstRows)
          .reverse()
          .map(([key, rows]) => [key, [...rows].reverse()])
      );

      const first = buildPreflightReport({
        tenantRows: [{ tenant_id: TENANT_B }, { tenant_id: TENANT_A }],
        rowsBySection: firstRows
      });
      const second = buildPreflightReport({
        tenantRows: [{ tenant_id: TENANT_A }, { tenant_id: TENANT_B }],
        rowsBySection: secondRows
      });

      expect(second).toEqual(first);
      expect(first.classification_thresholds).toEqual({
        exact_retry_window_seconds: 600,
        stale_episode_separation_days: 294
      });
      expect(first.near_duplicate_windows_seconds).toEqual({
        partograph: 120,
        postnatal: 600
      });
      expect(first.tenants.map(tenant => tenant.tenant_id)).toEqual([TENANT_A, TENANT_B]);
      expect(first.tenants[0].sections.duplicate_ongoing_pregnancies).toEqual({
        candidate_count: 0,
        candidates: []
      });
      expect(first.totals).toMatchObject({
        duplicate_ongoing_pregnancies: 1,
        partograph_near_duplicate_candidates: 1,
        postnatal_near_duplicate_candidates: 1
      });

      const pregnancy = first.tenants[1].sections.duplicate_ongoing_pregnancies.candidates[0];
      expect(pregnancy.classification).toBe('C-exact-retry');
      expect(pregnancy).not.toHaveProperty('survivor');
      expect(pregnancy).not.toHaveProperty('action');
      expect(pregnancy.candidates[0]).toEqual({
        pregnancy_id: 7,
        lmp_date: '2025-01-01',
        created_at: '2025-01-10T10:00:00.000Z',
        created_by: '11111111-1111-4111-8111-111111111111',
        latest_anc_visit_date: null,
        downstream_reference_counts: {
          anc_visits: 0,
          labour_admissions: 0,
          deliveries: 0,
          supplements: 0,
          fetal_kicks: 0
        }
      });
      expect(
        first.tenants[1].sections.postnatal_near_duplicate_candidates.candidates[0].newborn_id
      ).toBe(55);
    });
  });
});
