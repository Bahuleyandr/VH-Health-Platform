// F-M5 — deep (enforced-RLS) regression for the reconciliation sweep's
// PROJECTOR_GENERATION_DEBT check.
//
// ROOT CAUSE this test now guards:
//   event_consumer_offsets is ENABLE + FORCE ROW LEVEL SECURITY (migration
//   603) and its RESTRICTIVE policy admits `pathway_registry` rows only when
//   current_user is the table owner. The reconciliation sweep runs via
//   setTenantTx, which does `SET LOCAL ROLE <AUTH_TENANT_RLS_RUNTIME_ROLE>`
//   (prod: vhhealth_app — NOSUPERUSER NOBYPASSRLS, not the owner). The old
//   projectorCoverage SQL raw-joined the table, so under any RLS-enforcing
//   deployment the join yielded NULLs: two phantom debt findings per run
//   (`consumer_key IS NULL` + `backfill_completed_at IS NULL`) AND — worse —
//   the missing-event LATERAL (gated on `offsets.consumer_key IS NOT NULL`)
//   silently reported 0, a false-clean of the exact condition the check
//   exists to catch. The fix reads the offsets row through the sanctioned
//   SECURITY DEFINER accessor public.pathway_projector_offset_get.
//
// Why a non-owner role: Postgres exempts superusers/BYPASSRLS roles from RLS
// even under FORCE, so every assertion here runs under the sealed
// rls_test_app role (SET LOCAL ROLE + transaction-local tenant GUC), exactly
// mirroring the production sweep's runtime role. Harness mirrors
// tenant-rls.deep.test.js / resultsInboxSlaRuleRls.deep.test.js.

import { randomUUID } from 'node:crypto';

import pg from 'pg';

import prisma from '../lib/prisma.js';
import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../config/pathwayProjectorConfig.js';
import { pathwayReconciliationRegistry } from '../services/pathways/pathwayReconciliationRegistry.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const APP_ROLE = 'rls_test_app';

// The REAL production check, resolved through the production registry — the
// test pins the exact SQL the sweep executes, not a copy.
const projectorCheck = pathwayReconciliationRegistry.resolveCommonCheck('projector_generation');

function token() {
  return randomUUID().replaceAll('-', '');
}

describeIfDb('pathway reconciliation projectorCoverage under enforced RLS (F-M5)', () => {
  let owner;
  let tenantId;
  let originalOffset = null;
  let createdOffset = false;

  async function ownerQuery(text, params = []) {
    const result = await owner.query(text, params);
    return result;
  }

  // Run the real projectorCoverage check exactly the way the production sweep
  // runs it: inside one transaction, as the sealed non-owner app role, with
  // the transaction-local tenant GUC pinned (mirrors setTenantTx +
  // AUTH_TENANT_RLS_RUNTIME_ROLE).
  async function runProjectorCoverageAsAppRole() {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        tenantId,
      );
      const clock = await tx.$queryRawUnsafe('SELECT clock_timestamp() AS captured_at');
      return projectorCheck.run({
        tx,
        tenantId,
        capturedAt: new Date(clock[0].captured_at),
      });
    });
  }

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();

    // Sealed non-owner app role + the minimum grants the check needs.
    // Idempotent; normally provisioned by scripts/provision-rls-test-roles.mjs
    // (which also grants EXECUTE on all functions), re-asserted here so the
    // suite is self-sufficient on any migrated DB.
    await ownerQuery(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} NOLOGIN;
        END IF;
      END $$;
    `);
    await ownerQuery(`ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS`);
    await ownerQuery(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await ownerQuery(
      `GRANT SELECT ON event_consumer_offsets, pathway_projector_inbox, event_outbox, tenants TO ${APP_ROLE}`,
    );
    await ownerQuery(
      `GRANT EXECUTE ON FUNCTION public.pathway_projector_offset_get(TEXT, INTEGER, BOOLEAN) TO ${APP_ROLE}`,
    );

    tenantId = randomUUID();
    await ownerQuery(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'Projector RLS reconciliation test', '{}'::jsonb)`,
      [tenantId, `projector-rls-${token()}`],
    );

    // Seed a healthy pathway_registry offsets row for the projector consumer
    // through the migration-603 accessors (the sanctioned lifecycle path).
    // Completion is constrained: event_consumer_offsets_completion_check
    // (migration 578) requires backfill_cursor_event_id =
    // historical_cutoff_event_id before backfill_completed_at may be set, so
    // register(..., TRUE) — which inserts cursor 0 + completed_at now() —
    // violates it on any DB whose cutoff is > 0. Always use the two-step
    // lifecycle: register incomplete, then advance the cursor to the cutoff
    // with completed = TRUE.
    const existing = await ownerQuery(
      `SELECT consumer_key, historical_cutoff_event_id, backfill_cursor_event_id,
              backfill_completed_at, intake_retired_at, updated_at
         FROM public.pathway_projector_offset_get($1::text, $2::integer, FALSE)`,
      [PATHWAY_PROJECTOR_CONSUMER_KEY, PATHWAY_PROJECTOR_GENERATION],
    );
    originalOffset = existing.rows[0] || null;
    if (existing.rowCount === 0) {
      createdOffset = true;
      const cutoff = await ownerQuery(
        'SELECT COALESCE(MAX(id), 0)::bigint AS cutoff FROM event_outbox',
      );
      await ownerQuery(
        `SELECT consumer_key
           FROM public.pathway_projector_offset_register($1::text, $2::integer, $3::bigint, FALSE)`,
        [PATHWAY_PROJECTOR_CONSUMER_KEY, PATHWAY_PROJECTOR_GENERATION, cutoff.rows[0].cutoff],
      );
      await ownerQuery(
        `SELECT consumer_key
           FROM public.pathway_projector_offset_advance($1::text, $2::integer, $3::bigint, TRUE)`,
        [PATHWAY_PROJECTOR_CONSUMER_KEY, PATHWAY_PROJECTOR_GENERATION, cutoff.rows[0].cutoff],
      );
    } else if (!existing.rows[0].backfill_completed_at) {
      // Advance to the row's own cutoff (not its current cursor — completing
      // at cursor < cutoff trips the same completion check).
      await ownerQuery(
        `SELECT consumer_key
           FROM public.pathway_projector_offset_advance($1::text, $2::integer, $3::bigint, TRUE)`,
        [
          PATHWAY_PROJECTOR_CONSUMER_KEY,
          PATHWAY_PROJECTOR_GENERATION,
          existing.rows[0].historical_cutoff_event_id,
        ],
      );
    }
  });

  afterAll(async () => {
    if (owner) {
      await owner
        .query('DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid', [tenantId])
        .catch(() => {});
      await owner
        .query('DELETE FROM event_outbox WHERE tenant_id = $1::uuid', [tenantId])
        .catch(() => {});
      await owner
        .query('DELETE FROM tenants WHERE id = $1::uuid', [tenantId])
        .catch(() => {});
      if (createdOffset) {
        await owner.query(
          `DELETE FROM event_consumer_offsets
            WHERE scope_kind = 'pathway_registry'
              AND consumer_key = $1::text
              AND generation = $2::integer`,
          [PATHWAY_PROJECTOR_CONSUMER_KEY, PATHWAY_PROJECTOR_GENERATION],
        );
      } else if (originalOffset) {
        await owner.query(
          `UPDATE event_consumer_offsets
              SET backfill_cursor_event_id = $3::bigint,
                  backfill_completed_at = $4::timestamptz,
                  updated_at = $5::timestamptz
            WHERE scope_kind = 'pathway_registry'
              AND consumer_key = $1::text
              AND generation = $2::integer`,
          [
            PATHWAY_PROJECTOR_CONSUMER_KEY,
            PATHWAY_PROJECTOR_GENERATION,
            originalOffset.backfill_cursor_event_id,
            originalOffset.backfill_completed_at,
            originalOffset.updated_at,
          ],
        );
      }
      await owner.end().catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });

  it('precondition: the registered pathway offsets row is RLS-hidden from the app role on a raw join', async () => {
    // Owner (via the accessor) sees a healthy registration…
    const viaAccessor = await ownerQuery(
      `SELECT consumer_key, backfill_completed_at, intake_retired_at
         FROM public.pathway_projector_offset_get($1::text, $2::integer, FALSE)`,
      [PATHWAY_PROJECTOR_CONSUMER_KEY, PATHWAY_PROJECTOR_GENERATION],
    );
    expect(viaAccessor.rowCount).toBe(1);
    expect(viaAccessor.rows[0].backfill_completed_at).not.toBeNull();
    expect(viaAccessor.rows[0].intake_retired_at).toBeNull();

    // …but the pre-fix raw join, run as the sweep's non-owner runtime role,
    // cannot see the row at all. This is what fabricated the phantom debt and
    // muted the missing-event LATERAL before the fix.
    const rawRows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        tenantId,
      );
      return tx.$queryRawUnsafe(
        `SELECT consumer_key
           FROM event_consumer_offsets
          WHERE consumer_key = $1::text
            AND generation = $2::integer`,
        PATHWAY_PROJECTOR_CONSUMER_KEY,
        PATHWAY_PROJECTOR_GENERATION,
      );
    });
    expect(rawRows).toHaveLength(0);
  });

  it('reports zero phantom debt for a healthy registration when run as the app role (pre-fix: >= 2)', async () => {
    const result = await runProjectorCoverageAsAppRole();
    expect(result.code).toBe('PROJECTOR_GENERATION_DEBT');
    expect(result.finding_count).toBe(0);
  });

  it('still detects an outbox event that never reached the projector inbox (pre-fix: silently 0)', async () => {
    const baseline = await runProjectorCoverageAsAppRole();

    const inserted = await ownerQuery(
      `INSERT INTO event_outbox
         (event_type, aggregate_type, aggregate_id, payload, tenant_id, status, available_at, created_at)
       VALUES ($1::text, 'projector_rls_test', $2::text, '{}'::jsonb, $3::uuid, 'pending', NOW(), NOW())
       RETURNING id::text`,
      [`test.projector.rls.${token()}`, token(), tenantId],
    );
    expect(inserted.rowCount).toBe(1);

    // The pathway_projector_enqueue_new_event trigger fans the event out to
    // pathway_projector_inbox on insert. Delete that row (as owner) to
    // simulate a lost enqueue — the exact gap the missing-event LATERAL
    // exists to detect.
    await ownerQuery(
      `DELETE FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid AND event_id = $2::bigint`,
      [tenantId, inserted.rows[0].id],
    );

    try {
      const withMissing = await runProjectorCoverageAsAppRole();
      expect(withMissing.code).toBe('PROJECTOR_GENERATION_DEBT');
      // Exactly one new debt unit: the seeded event is > the historical
      // cutoff and has no pathway_projector_inbox row.
      expect(withMissing.finding_count).toBe(baseline.finding_count + 1);
    } finally {
      await ownerQuery('DELETE FROM event_outbox WHERE id = $1::bigint', [
        inserted.rows[0].id,
      ]);
    }
  });
});

if (!databaseUrl) {
  console.warn(
    'pathwayReconciliationRls.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.',
  );
}
