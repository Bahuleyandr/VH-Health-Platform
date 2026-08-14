import {
  BLOCKED_EXIT_CODE,
  READY_EXIT_CODE,
  auditExitCode,
  buildReport,
  collectReadiness,
  evaluateTenantReadiness,
  parseArgs,
  READINESS_QUERY,
} from '../../../scripts/audit-care-team-enforcement-readiness.mjs';
import { CARE_TEAM_GOVERNED_RECORD_TYPES } from '../../config/careTeamGovernedRecordTypes.js';

const COMPLETE = {
  tenant_id: '11111111-1111-4111-8111-111111111111',
  slug: 'hospital',
  status: 'active',
  tenant_mode_configured: true,
  tenant_mode: 'shadow',
  shadow_decisions: 20,
  shadow_first_half_decisions: 8,
  shadow_second_half_decisions: 12,
  shadow_denials: 0,
  observed_record_types: [...CARE_TEAM_GOVERNED_RECORD_TYPES],
  appointments_missing_membership: 0,
  admission_doctors_missing_membership: 0,
  stale_episode_care_teams: 0,
  malformed_context_free_care_teams: 0,
  break_glass_exercises: 1,
  active_break_glass_sessions: 0,
};

describe('care-team enforcement readiness audit', () => {
  it('accepts only bounded, read-only audit arguments', () => {
    expect(parseArgs(['--tenant-id', COMPLETE.tenant_id, '--window-days=14', '--advisory']))
      .toMatchObject({ tenantId: COMPLETE.tenant_id, windowDays: 14, advisory: true });
    expect(() => parseArgs(['--window-days=1'])).toThrow('between 2 and 90');
    expect(() => parseArgs(['--tenant-id=not-a-uuid'])).toThrow('Invalid --tenant-id');
    expect(() => parseArgs(['--apply'])).toThrow('Unknown argument');
  });

  it('reports ready only with distributed shadow evidence, complete teams, and a break-glass exercise', () => {
    expect(evaluateTenantReadiness(COMPLETE)).toMatchObject({
      effective_mode: 'shadow',
      mode_source: 'tenant_settings',
      blockers: [],
      ready_for_owner_review: true,
    });
  });

  it('returns explicit blockers instead of treating missing evidence as ready', () => {
    const result = evaluateTenantReadiness({
      ...COMPLETE,
      tenant_mode_configured: false,
      tenant_mode: null,
      shadow_first_half_decisions: 0,
      shadow_denials: 3,
      observed_record_types: ['PATIENT_RECORD'],
      appointments_missing_membership: 2,
      admission_doctors_missing_membership: 1,
      stale_episode_care_teams: 2,
      malformed_context_free_care_teams: 1,
      break_glass_exercises: 0,
      active_break_glass_sessions: 1,
    }, { deploymentMode: 'shadow' });

    expect(result.mode_source).toBe('deployment_fallback');
    expect(result.blockers).toEqual(expect.arrayContaining([
      'SHADOW_WINDOW_FIRST_HALF_EMPTY',
      'SHADOW_DENIALS_REQUIRE_REVIEW',
      'SHADOW_RECORD_TYPE_COVERAGE_INCOMPLETE',
      'APPOINTMENT_CARE_TEAM_INCOMPLETE',
      'ADMISSION_CARE_TEAM_INCOMPLETE',
      'STALE_EPISODE_CARE_TEAM_AUTHORITY',
      'MALFORMED_CONTEXT_FREE_CARE_TEAM',
      'BREAK_GLASS_EXERCISE_MISSING',
      'BREAK_GLASS_SESSION_ACTIVE',
    ]));
    expect(result.ready_for_owner_review).toBe(false);
  });

  it('mirrors runtime lifecycle predicates and inventories malformed context-free teams', () => {
    expect(READINESS_QUERY)
      .toMatch(/UPPER\(BTRIM\(COALESCE\(a\.status, ''\)\)\) NOT IN \('CANCELLED', 'NO_SHOW', 'RESCHEDULED'\)/);
    expect(READINESS_QUERY)
      .toMatch(/LOWER\(BTRIM\(COALESCE\(admission\.status, ''\)\)\) IN \('admitted', 'transferred'\)/);
    expect(READINESS_QUERY)
      .toMatch(/LOWER\(BTRIM\(COALESCE\(team\.team_kind, ''\)\)\) <> 'longitudinal'/);
  });

  it('never calls an off deployment ready', () => {
    expect(evaluateTenantReadiness({
      ...COMPLETE,
      tenant_mode_configured: false,
      tenant_mode: null,
    }, { deploymentMode: 'off' }))
      .toMatchObject({ blockers: expect.arrayContaining(['CARE_TEAM_ABAC_DISABLED']) });
  });

  it('fails closed on an explicitly invalid tenant mode instead of using the deployment fallback', () => {
    expect(evaluateTenantReadiness({
      ...COMPLETE,
      tenant_mode_configured: true,
      tenant_mode: 'observe',
    }, { deploymentMode: 'shadow' })).toMatchObject({
      effective_mode: null,
      mode_source: 'tenant_settings',
      blockers: expect.arrayContaining([
        'CARE_TEAM_MODE_INVALID',
        'CARE_TEAM_MODE_UNAVAILABLE',
      ]),
      ready_for_owner_review: false,
    });
  });

  it('uses a fail-closed aggregate exit code, including an empty inventory', () => {
    const ready = buildReport([COMPLETE]);
    const mixed = buildReport([COMPLETE, { ...COMPLETE, tenant_id: '22222222-2222-4222-8222-222222222222', shadow_denials: 1 }]);
    const empty = buildReport([]);

    expect(auditExitCode(ready)).toBe(READY_EXIT_CODE);
    expect(auditExitCode(mixed)).toBe(BLOCKED_EXIT_CODE);
    expect(auditExitCode(empty)).toBe(BLOCKED_EXIT_CODE);
  });

  it('runs the inventory in one repeatable-read, read-only transaction', async () => {
    const queries = [];
    const client = {
      query: async (sql, params) => {
        queries.push([sql, params]);
        if (sql.includes("current_setting('transaction_read_only')")) {
          return { rows: [{ transaction_read_only: 'on' }] };
        }
        if (sql.includes('WITH requested AS')) return { rows: [COMPLETE] };
        return { rows: [] };
      },
    };

    await expect(collectReadiness(client, { tenantId: null, windowDays: 7 }))
      .resolves.toEqual([COMPLETE]);
    expect(queries[0][0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(queries.at(-1)[0]).toBe('COMMIT');
  });

  it('rolls back and refuses a writable transaction', async () => {
    const queries = [];
    const client = {
      query: async (sql) => {
        queries.push(sql);
        if (sql.includes("current_setting('transaction_read_only')")) {
          return { rows: [{ transaction_read_only: 'off' }] };
        }
        return { rows: [] };
      },
    };

    await expect(collectReadiness(client, { tenantId: null, windowDays: 7 }))
      .rejects.toThrow('writable');
    expect(queries.at(-1)).toBe('ROLLBACK');
  });
});
