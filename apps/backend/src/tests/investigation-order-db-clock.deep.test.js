import { jest } from '@jest/globals';

const actualPrisma = await import('../lib/prisma.js');
const prisma = actualPrisma.default;
const TENANT = '00000000-0000-4000-8000-00000000c10c';
const PATIENT = '00000000-0000-4000-8000-00000000c10d';
const ACTOR = '00000000-0000-4000-8000-00000000c10e';
let capture = null;

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrisma,
  setTenantTx: (tenantId, fn, options) => actualPrisma.setTenantTx(tenantId, async (tx) => {
    if (!capture || tenantId !== TENANT) return fn(tx);
    const [before] = await tx.$queryRawUnsafe(
      `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS epoch_ms,
              current_user AS role, current_setting('app.current_tenant_id') AS tenant,
              txid_current()::text AS transaction_id`,
    );
    let clockMs;
    const recorder = new Proxy(tx, {
      get(target, key) {
        if (key === '$queryRawUnsafe') return async (sql, ...params) => {
          const rows = await target.$queryRawUnsafe(sql, ...params);
          if (sql.includes('AS requested_at_epoch_ms')) {
            expect(rows).toHaveLength(1);
            clockMs = Number(rows[0].requested_at_epoch_ms);
            capture.clocks.push(clockMs);
          }
          return rows;
        };
        if (key === 'investigations') return new Proxy(target.investigations, {
          get(delegate, method) {
            if (method === 'create') return async (args) => {
              // Emulate an ORM default from a clock one day ahead, only when the writer omits it.
              const requestedAt = args.data.requested_at ?? new Date(Number(before.epoch_ms) + 86_400_000);
              const row = await delegate.create({ ...args, data: { ...args.data, requested_at: requestedAt } });
              const [stored] = await target.$queryRawUnsafe(
                `SELECT (EXTRACT(EPOCH FROM (requested_at AT TIME ZONE 'UTC')) * 1000)::bigint AS requested_ms,
                        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS after_ms,
                        txid_current()::text AS transaction_id
                   FROM investigations WHERE tenant_id = $1::uuid AND id = $2::int`,
                TENANT, row.id,
              );
              capture.bindings.push({ before, clockMs, explicit: args.data.requested_at, stored });
              return row;
            };
            const value = delegate[method];
            return typeof value === 'function' ? value.bind(delegate) : value;
          },
        });
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return fn(recorder);
  }, options),
}));

const { createInvestigationOrder } = await import('../services/investigation/orderService.js');
const { ITEM_CODES, resolveItemState } = await import('../services/clinical/cathLabReadinessRules.js');
const { flushScheduledReadinessRefreshes } = await import('../services/clinical/cathLabReadinessHooks.js');
const { teardownTenantFixture } = await import('./helpers/tenantTeardown.js');
const d = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL ? describe : describe.skip;
let patientId;
let previousRole;
let previousEnforcement;

async function cleanup() {
  await teardownTenantFixture(prisma, {
    tenantIds: [TENANT],
    evidence: async (tx) => {
      for (const table of [
        'pathway_projector_inbox', 'event_outbox', 'investigations', 'notifications',
        'clinical_timeline_events', 'clinical_audit_events', 'audit_log', 'audit_logs',
      ]) {
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, TENANT);
      }
    },
  });
}

d('investigation order database-clock binding', () => {
  beforeAll(async () => {
    previousRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    previousEnforcement = process.env.AUTH_ENFORCE_TENANT_RLS;
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    await actualPrisma.ensureTenantRlsRuntimeRoleGrants();
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'investigation-clock-test', 'Investigation Clock Test')`, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, '9011881901', 'Clock Patient', 'PATIENT', TRUE, 'active', NOW()),
              ($1::uuid, $3::uuid, '9011881902', 'Clock Doctor', 'DOCTOR', TRUE, 'active', NOW())`,
      TENANT, PATIENT, ACTOR,
    );
    const [patient] = await prisma.$queryRawUnsafe('SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid', TENANT, PATIENT);
    patientId = patient.id;
  }, 120000);

  afterAll(async () => {
    capture = null;
    try {
      await flushScheduledReadinessRefreshes();
      await cleanup();
      expect(await prisma.$queryRawUnsafe('SELECT id FROM tenants WHERE id = $1::uuid', TENANT)).toHaveLength(0);
    } finally {
      if (previousRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRole;
      if (previousEnforcement === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
      else process.env.AUTH_ENFORCE_TENANT_RLS = previousEnforcement;
    }
  }, 120000);

  it('binds database instants under default-clock skew and preserves future-evidence rejection', async () => {
    capture = { clocks: [], bindings: [] };
    const created = [];
    for (const code of ['CBC', 'ELECTROLYTES', 'CREATININE', 'HIV', 'HBSAG', 'HCV']) {
      created.push(await createInvestigationOrder({ patient_id: patientId, doctor_uid: ACTOR, actorRole: 'DOCTOR', tenantId: TENANT, test_name: code, test_code: code, type: 'LAB' }));
    }
    expect(created).toHaveLength(6);
    const [counts] = await prisma.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM investigations WHERE tenant_id = $1::uuid) AS orders,
              (SELECT count(*)::int FROM clinical_timeline_events WHERE tenant_id = $1::uuid AND event_type = 'investigation.ordered') AS timeline,
              (SELECT count(*)::int FROM clinical_audit_events WHERE tenant_id = $1::uuid AND action = 'investigation.ordered') AS audit`, TENANT,
    );
    expect(counts).toEqual({ orders: 6, timeline: 6, audit: 6 });
    const readStates = () => actualPrisma.setTenantTx(TENANT, async tx => {
      const orders = await tx.$queryRawUnsafe(
        `SELECT id, test_code, test_name, status,
                (EXTRACT(EPOCH FROM (requested_at AT TIME ZONE 'UTC')) * 1000)::bigint AS requested_at_epoch_ms
           FROM investigations WHERE tenant_id = $1::uuid`, TENANT,
      );
      const [clock] = await tx.$queryRawUnsafe('SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS epoch_ms');
      expect(orders).toHaveLength(6);
      expect(ITEM_CODES).toHaveLength(7);
      return ITEM_CODES.map(item => resolveItemState({ item, orders, windowDays: 7, asOf: Number(clock.epoch_ms) }));
    });
    const current = await readStates();
    expect(current.map(item => item.state)).toEqual(Array(7).fill('ordered_awaiting_sample'));
    expect(capture.clocks).toHaveLength(6);
    expect(capture.bindings).toHaveLength(6);
    for (const { before, clockMs, explicit, stored } of capture.bindings) {
      expect(explicit).toEqual(new Date(clockMs));
      expect(Number(stored.requested_ms)).toBe(clockMs);
      expect(clockMs).toBeGreaterThanOrEqual(Number(before.epoch_ms));
      expect(clockMs).toBeLessThanOrEqual(Number(stored.after_ms));
      expect(before.role).toBe('vhhealth_app');
      expect(before.tenant).toBe(TENANT);
      expect(stored.transaction_id).toBe(before.transaction_id);
    }
    capture = null;
    const updated = await actualPrisma.setTenantTx(TENANT, tx => tx.$executeRawUnsafe(
      `UPDATE investigations SET requested_at = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 day'
       WHERE tenant_id = $1::uuid AND id = $2::int`, TENANT, created[5].investigation.id,
    ));
    expect(updated).toBe(1);
    const future = await readStates();
    expect(future.find(item => item.item_code === 'hcv').state).toBe('not_ordered');
    expect(future.filter(item => item.item_code !== 'hcv').map(item => item.state)).toEqual(Array(6).fill('ordered_awaiting_sample'));
  }, 60000);
});
