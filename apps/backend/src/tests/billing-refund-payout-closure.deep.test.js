import { randomUUID } from 'node:crypto';

import express from 'express';
import request from 'supertest';

import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';
import billingV2Routes from '../routes/billing/billingV2Routes.js';
import * as billing from '../services/billing/billingV2Service.js';
import * as cashDrawer from '../services/billing/cashDrawerService.js';
import {
  claimIdempotencyKey,
  hashRequestBody,
  releaseIdempotencyKey,
} from '../services/idempotency/idempotencyService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const PATIENT = randomUUID();
const APPROVER = randomUUID();
const PAYER = randomUUID();
const OTHER_CASHIER = randomUUID();
const OTHER_TENANT_CASHIER = randomUUID();
const PHONE_BASE = String(Math.floor(100000000 + Math.random() * 899999999));
const RUNTIME_ROLES = ['vhhealth_app', 'vhhealth_runtime'];
let previousRuntimeRole;

function appFor({ uid = PAYER, role = 'FINANCE_INCHARGE' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-refund-payout-deep';
    req.tenantId = TENANT;
    req.user = {
      uid,
      role,
      tenant_id: TENANT,
      deviceType: 'desktop',
    };
    next();
  });
  app.use('/', billingV2Routes);
  return app;
}

async function createInvoice({
  mode,
  paymentAmount = 1000,
  reference,
  collectedBy = PAYER,
  shift = null,
  collectedAt = new Date(Date.now() - 10 * 60_000),
} = {}) {
  const invoiceRows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (patient_uid, invoice_type, status, subtotal, total_amount,
        amount_paid, amount_due, tenant_id)
     VALUES ($1::uuid, 'OP', 'PAID', $2::numeric, $2::numeric,
             $2::numeric, 0, $3::uuid)
     RETURNING id`,
    PATIENT,
    paymentAmount,
    TENANT,
  );
  const invoiceId = Number(invoiceRows[0].id);
  let paymentId = null;
  if (mode) {
    const paymentRows = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_payments
         (invoice_id, patient_uid, amount, mode, reference,
          collected_by, collected_at, shift, tenant_id)
       VALUES ($1::int, $2::uuid, $3::numeric, $4, $5,
               $6::uuid, $7::timestamptz, $8, $9::uuid)
       RETURNING id`,
      invoiceId,
      PATIENT,
      paymentAmount,
      mode,
      reference || null,
      collectedBy,
      collectedAt,
      shift,
      TENANT,
    );
    paymentId = Number(paymentRows[0].id);
  }
  return { invoiceId, paymentId };
}

async function createApprovedRefund({
  invoiceId,
  mode,
  amount = 100,
  approvedBy = APPROVER,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_refunds
       (patient_uid, invoice_id, amount, reason, mode, raised_by, tenant_id)
     VALUES ($1::uuid, $2::int, $3::numeric, 'deep payout closure', $4,
             $5::uuid, $6::uuid)
     RETURNING id`,
    PATIENT,
    invoiceId,
    amount,
    mode,
    PAYER,
    TENANT,
  );
  const refundId = Number(rows[0].id);
  await prisma.$executeRawUnsafe(
    `UPDATE billing_refunds
        SET approval_status = 'APPROVED',
            approved_by = $1::uuid,
            approved_at = NOW(),
            updated_at = NOW()
      WHERE tenant_id = $2::uuid AND id = $3::int`,
    approvedBy,
    TENANT,
    refundId,
  );
  return refundId;
}

async function openDrawer({
  cashier = PAYER,
  shift = 'MORNING',
  openingFloat = 500,
  tenant = TENANT,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO cash_drawer_sessions
       (tenant_id, cashier_uid, shift, opening_float)
     VALUES ($1::uuid, $2::uuid, $3, $4::numeric)
     RETURNING id::text`,
    tenant,
    cashier,
    shift,
    openingFloat,
  );
  return rows[0].id;
}

async function refundRow(refundId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM billing_refunds WHERE tenant_id = $1::uuid AND id = $2::int`,
    TENANT,
    refundId,
  );
  return rows[0];
}

async function expectConstraintFailure(operation, pattern) {
  let failure;
  try {
    await operation;
  } catch (err) {
    failure = err;
  }
  const text = `${failure?.message || ''} ${failure?.meta?.message || ''}`;
  expect(text).toMatch(/23514/);
  expect(text).toMatch(pattern);
}

async function expectForeignKeyFailure(operation, pattern) {
  let failure;
  try {
    await operation;
  } catch (err) {
    failure = err;
  }
  const text = `${failure?.message || ''} ${failure?.meta?.message || ''}`;
  expect(text).toMatch(/23503/);
  expect(text).toMatch(pattern);
}

async function setRuntimeBypassContext(tx, role) {
  const setRoleStatement = role === 'vhhealth_app'
    ? 'SET LOCAL ROLE vhhealth_app'
    : 'SET LOCAL ROLE vhhealth_runtime';
  await tx.$executeRawUnsafe(setRoleStatement);
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.current_tenant_id', $1::text, true)`,
    TENANT,
  );
  await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
}

d('billing refund payout closure (migration 747 + live services)', () => {
  beforeAll(async () => {
    process.env.LEDGER_AUTHORITATIVE_MODE = 'off';
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    for (const role of RUNTIME_ROLES) {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role;
      await ensureTenantRlsRuntimeRoleGrants();
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES
         ($1::uuid, $2, 'Refund payout deep tenant', '{"ledger_authoritative_mode":"off"}'::jsonb),
         ($3::uuid, $4, 'Refund payout cross tenant', '{"ledger_authoritative_mode":"off"}'::jsonb)`,
      TENANT,
      `refund-payout-${TENANT.slice(0, 8)}`,
      OTHER_TENANT,
      `refund-payout-other-${OTHER_TENANT.slice(0, 8)}`,
    );
    const users = [
      [PATIENT, 'PATIENT', TENANT, `7${PHONE_BASE}`],
      [APPROVER, 'ADMIN', TENANT, `6${PHONE_BASE}`],
      [PAYER, 'FINANCE_INCHARGE', TENANT, `5${PHONE_BASE}`],
      [OTHER_CASHIER, 'CASHIER', TENANT, `4${PHONE_BASE}`],
      [OTHER_TENANT_CASHIER, 'CASHIER', OTHER_TENANT, `3${PHONE_BASE}`],
    ];
    for (const [uid, role, tenant, phone] of users) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
         VALUES ($1::uuid, $2, 'Refund payout deep user', $3, $4::uuid, NOW())`,
        uid,
        phone,
        role,
        tenant,
      );
    }
  });

  afterAll(async () => {
    if (!DB_CONFIGURED) return;
    if (previousRuntimeRole === undefined) {
      delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    } else {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
        TENANT,
        OTHER_TENANT,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
    }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  test('CASH payout is exact-replay safe and drawer close stores inflow/refund/net totals', async () => {
    const drawerId = await openDrawer();
    const { invoiceId, paymentId } = await createInvoice({
      mode: 'CASH',
      reference: `CASH-IN-${randomUUID()}`,
      shift: 'MORNING',
      collectedAt: new Date(),
    });
    const refundId = await createApprovedRefund({ invoiceId, mode: 'CASH', amount: 100 });
    const key = `cash-refund-${randomUUID()}`;
    const body = { cash_drawer_session_id: drawerId, reference: `CV-${randomUUID()}` };
    const app = appFor();

    const first = await request(app)
      .post(`/refunds/${refundId}/pay`)
      .set('Idempotency-Key', key)
      .send(body);
    const replay = await request(app)
      .post(`/refunds/${refundId}/pay`)
      .set('Idempotency-Key', key)
      .send(body);
    const mismatch = await request(app)
      .post(`/refunds/${refundId}/pay`)
      .set('Idempotency-Key', key)
      .send({ ...body, reference: `${body.reference}-changed` });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(mismatch.status).toBe(422);
    expect(first.body.data).toMatchObject({
      id: refundId,
      approval_status: 'PAID',
      payout_rail: 'manual',
      cash_drawer_session_id: Number(drawerId),
      cash_inflow_total: 1000,
      cash_refund_total: 100,
      system_total: 900,
    });
    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM audit_logs
        WHERE tenant_id = $1::uuid
          AND action = 'FRONT_OFFICE_BILLING_REFUND_PAID'
          AND resource_id = $2`,
      TENANT,
      String(refundId),
    );
    expect(auditRows[0].count).toBe(1);

    const closed = await cashDrawer.closeSession({
      tenantId: TENANT,
      id: drawerId,
      cashier_uid: PAYER,
      counted_denominations: { 500: 2, 200: 2 },
    });
    expect(closed.status).toBe('reviewed');
    expect(Number(closed.cash_inflow_total)).toBe(1000);
    expect(Number(closed.cash_refund_total)).toBe(100);
    expect(Number(closed.system_total)).toBe(900);
    expect(Number(closed.variance)).toBe(0);

    await expect(billing.reversePayment(paymentId, {
      tenantId: TENANT,
      reversed_by: APPROVER,
      reason: 'attempted post-close correction',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_CASH_PAYMENT_CLOSED_DRAWER_REVERSAL_FORBIDDEN',
    });

    let directSqlError;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE billing_payments
            SET reversed = TRUE,
                reversed_at = NOW(),
                reversed_by = $1::uuid,
                reversal_reason = 'forged post-close reversal'
          WHERE tenant_id = $2::uuid AND id = $3::int`,
        APPROVER,
        TENANT,
        paymentId,
      );
    } catch (err) {
      directSqlError = err;
    }
    expect(`${directSqlError?.message || ''} ${directSqlError?.meta?.message || ''}`)
      .toMatch(/23514/);
    expect(`${directSqlError?.message || ''} ${directSqlError?.meta?.message || ''}`)
      .toMatch(/immutable closed drawer/i);
    const paymentRows = await prisma.$queryRawUnsafe(
      `SELECT reversed FROM billing_payments
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      paymentId,
    );
    expect(paymentRows[0].reversed).toBe(false);
  });

  test('payment reversal remains available for open drawers, non-CASH, and legacy unmatched CASH', async () => {
    await openDrawer({ cashier: OTHER_CASHIER, shift: 'NIGHT', openingFloat: 0 });
    const openCash = await createInvoice({
      mode: 'CASH',
      reference: `OPEN-CASH-${randomUUID()}`,
      collectedBy: OTHER_CASHIER,
      shift: 'NIGHT',
    });
    await expect(billing.reversePayment(openCash.paymentId, {
      tenantId: TENANT, reversed_by: APPROVER, reason: 'same-shift correction',
    })).resolves.toMatchObject({ id: openCash.paymentId, reversed: true });

    const nonCashDrawerId = await openDrawer({ shift: 'GENERAL', openingFloat: 0 });
    const nonCash = await createInvoice({
      mode: 'UPI',
      reference: `CLOSED-UPI-${randomUUID()}`,
      shift: 'GENERAL',
    });
    await cashDrawer.closeSession({
      tenantId: TENANT,
      id: nonCashDrawerId,
      cashier_uid: PAYER,
      counted_denominations: {},
    });
    await expect(billing.reversePayment(nonCash.paymentId, {
      tenantId: TENANT, reversed_by: APPROVER, reason: 'non-cash correction',
    })).resolves.toMatchObject({ id: nonCash.paymentId, reversed: true });

    const unmatchedCash = await createInvoice({
      mode: 'CASH',
      reference: `LEGACY-CASH-${randomUUID()}`,
      collectedBy: PAYER,
      shift: 'NIGHT',
    });
    await expect(billing.reversePayment(unmatchedCash.paymentId, {
      tenantId: TENANT, reversed_by: APPROVER, reason: 'legacy unmatched correction',
    })).resolves.toMatchObject({ id: unmatchedCash.paymentId, reversed: true });
  });

  test('cash reversal trigger is installed and not executable by PUBLIC or runtime roles', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (
                SELECT 1
                  FROM pg_trigger
                 WHERE tgname = 'billing_cash_payment_reversal_guard_747'
                   AND tgenabled <> 'D'
                   AND NOT tgisinternal
              ) AS trigger_enabled,
              NOT EXISTS (
                SELECT 1
                  FROM pg_proc function_row
                  CROSS JOIN LATERAL aclexplode(
                    COALESCE(function_row.proacl, acldefault('f', function_row.proowner))
                  ) acl
                 WHERE function_row.oid = 'public.billing_cash_payment_reversal_guard_747()'::regprocedure
                   AND acl.grantee = 0
                   AND acl.privilege_type = 'EXECUTE'
              ) AS public_execute_revoked,
              COALESCE((
                SELECT BOOL_AND(NOT has_function_privilege(
                  role_row.rolname,
                  'public.billing_cash_payment_reversal_guard_747()',
                  'EXECUTE'
                ))
                  FROM pg_roles role_row
                 WHERE role_row.rolname IN ('vhhealth_app', 'vhhealth_runtime')
              ), TRUE) AS runtime_execute_revoked`,
    );
    expect(rows[0]).toEqual({
      trigger_enabled: true,
      public_execute_revoked: true,
      runtime_execute_revoked: true,
    });
  });

  test.each(RUNTIME_ROLES)(
    '%s receives exact refund and drawer columns without table DML or sequence mutation',
    async (role) => {
      const tableGrants = await prisma.$queryRawUnsafe(
        `SELECT table_name::text AS table_name,
                array_agg(privilege_type::text ORDER BY privilege_type::text)::text[]
                  AS privileges
           FROM information_schema.role_table_grants
          WHERE grantee = $1::name
            AND table_schema = 'public'
            AND table_name IN (
              'billing_refunds',
              'cash_drawer_sessions',
              'billing_refund_offline_electronic_evidence'
            )
          GROUP BY table_name
          ORDER BY table_name`,
        role,
      );
      expect(tableGrants).toEqual([
        {
          table_name: 'billing_refund_offline_electronic_evidence',
          privileges: ['SELECT'],
        },
        { table_name: 'billing_refunds', privileges: ['SELECT'] },
        { table_name: 'cash_drawer_sessions', privileges: ['SELECT'] },
      ]);

      const columnGrants = await prisma.$queryRawUnsafe(
        `SELECT grant_row.table_name::text AS table_name,
                grant_row.privilege_type::text AS privilege_type,
                array_agg(grant_row.column_name::text ORDER BY column_row.ordinal_position)::text[]
                  AS columns
           FROM information_schema.role_column_grants grant_row
           JOIN information_schema.columns column_row
             ON column_row.table_schema = grant_row.table_schema
            AND column_row.table_name = grant_row.table_name
            AND column_row.column_name = grant_row.column_name
          WHERE grant_row.grantee = $1::name
            AND grant_row.table_schema = 'public'
            AND grant_row.table_name IN (
              'billing_refunds',
              'cash_drawer_sessions',
              'billing_refund_offline_electronic_evidence'
            )
            AND grant_row.privilege_type IN ('INSERT', 'UPDATE')
          GROUP BY grant_row.table_name, grant_row.privilege_type
          ORDER BY grant_row.table_name, grant_row.privilege_type`,
        role,
      );
      expect(columnGrants).toEqual([
        {
          table_name: 'billing_refund_offline_electronic_evidence',
          privilege_type: 'INSERT',
          columns: [
            'tenant_id', 'refund_id', 'original_payment_id', 'original_advance_id',
            'mode', 'amount', 'provider_name', 'original_payment_reference',
            'provider_refund_reference', 'provider_refunded_at', 'recorded_by',
          ],
        },
        {
          table_name: 'billing_refunds',
          privilege_type: 'INSERT',
          columns: [
            'patient_uid', 'invoice_id', 'advance_id', 'amount', 'reason', 'mode',
            'approval_status', 'raised_by', 'tenant_id', 'counter_sale_void_request_id',
          ],
        },
        {
          table_name: 'billing_refunds',
          privilege_type: 'UPDATE',
          columns: [
            'reference', 'approval_status', 'approved_by', 'approved_at',
            'rejected_by', 'rejected_at', 'rejection_reason', 'paid_at', 'paid_by',
            'updated_at', 'payout_rail', 'payout_rail_claimed_at', 'gateway_refund_id',
            'cash_drawer_session_id', 'offline_electronic_evidence_id',
          ],
        },
        {
          table_name: 'cash_drawer_sessions',
          privilege_type: 'INSERT',
          columns: ['tenant_id', 'cashier_uid', 'shift', 'opening_float'],
        },
        {
          table_name: 'cash_drawer_sessions',
          privilege_type: 'UPDATE',
          columns: [
            'closed_at', 'counted_total', 'counted_denominations', 'system_total',
            'variance', 'short_count', 'over_count', 'requires_review',
            'variance_reason', 'status', 'reviewed_by', 'reviewed_at', 'review_notes',
            'updated_at', 'cash_inflow_total', 'cash_refund_total',
          ],
        },
      ]);

      const sequenceGrants = await prisma.$queryRawUnsafe(
        `SELECT sequence_name::text AS sequence_name,
                has_sequence_privilege($1::name, 'public.' || sequence_name, 'USAGE')
                  AS can_use,
                has_sequence_privilege($1::name, 'public.' || sequence_name, 'SELECT')
                  AS can_select,
                has_sequence_privilege($1::name, 'public.' || sequence_name, 'UPDATE')
                  AS can_update
           FROM unnest(ARRAY[
             'billing_refund_offline_electronic_evidence_id_seq',
             'billing_refunds_id_seq',
             'cash_drawer_sessions_id_seq'
           ]::text[]) AS sequence_name
          ORDER BY sequence_name`,
        role,
      );
      expect(sequenceGrants).toEqual([
        {
          sequence_name: 'billing_refund_offline_electronic_evidence_id_seq',
          can_use: true,
          can_select: true,
          can_update: false,
        },
        {
          sequence_name: 'billing_refunds_id_seq',
          can_use: true,
          can_select: true,
          can_update: false,
        },
        {
          sequence_name: 'cash_drawer_sessions_id_seq',
          can_use: true,
          can_select: true,
          can_update: false,
        },
      ]);
    },
  );

  test('direct SQL cannot forge refund or drawer lifecycle identity and system evidence', async () => {
    const beforeInsert = Date.now() - 1000;
    const { invoiceId } = await createInvoice();
    await expectForeignKeyFailure(
      prisma.$executeRawUnsafe(
        `INSERT INTO billing_refunds
           (patient_uid, invoice_id, amount, reason, mode,
            approval_status, raised_by, tenant_id)
         VALUES ($1::uuid, $2::int, 75, 'cross-tenant actor proof',
                 'CHEQUE', 'PENDING', $3::uuid, $4::uuid)`,
        PATIENT,
        invoiceId,
        OTHER_TENANT_CASHIER,
        TENANT,
      ),
      /fk_billing_refund_raiser_tenant_747/i,
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `INSERT INTO billing_refunds
           (patient_uid, invoice_id, amount, reason, mode, reference,
            approval_status, raised_by, tenant_id)
         VALUES ($1::uuid, $2::int, 75, 'premature payout reference proof',
                 'CHEQUE', 'FORGED-PREMATURE-REFERENCE', 'PENDING',
                 $3::uuid, $4::uuid)`,
        PATIENT,
        invoiceId,
        PAYER,
        TENANT,
      ),
      /unapproved pending request/i,
    );
    const chosenRefundId = 2_000_000_000;
    const [pending] = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_refunds
         (id, patient_uid, invoice_id, amount, reason, mode, approval_status,
          raised_by, raised_at, tenant_id, created_at, updated_at)
       VALUES ($1::int, $2::uuid, $3::int, 75, 'lifecycle adversarial proof',
               'CHEQUE', 'PENDING', $4::uuid, '2000-01-01'::timestamptz,
               $5::uuid, '2000-01-01'::timestamptz, '2000-01-01'::timestamptz)
       RETURNING id, raised_at, created_at, updated_at`,
      chosenRefundId,
      PATIENT,
      invoiceId,
      PAYER,
      TENANT,
    );
    const refundId = Number(pending.id);
    expect(refundId).not.toBe(chosenRefundId);
    for (const value of [pending.raised_at, pending.created_at, pending.updated_at]) {
      expect(new Date(value).getTime()).toBeGreaterThanOrEqual(beforeInsert);
    }

    const [approved] = await prisma.$queryRawUnsafe(
      `UPDATE billing_refunds
          SET approval_status = 'APPROVED',
              approved_by = $1::uuid,
              approved_at = '2000-01-01'::timestamptz,
              updated_at = '2000-01-01'::timestamptz
        WHERE tenant_id = $2::uuid AND id = $3::int
        RETURNING approved_by, approved_at, updated_at`,
      APPROVER,
      TENANT,
      refundId,
    );
    expect(String(approved.approved_by)).toBe(APPROVER);
    expect(new Date(approved.approved_at).getTime()).toBeGreaterThanOrEqual(beforeInsert);
    expect(new Date(approved.updated_at).getTime()).toBeGreaterThanOrEqual(beforeInsert);

    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `UPDATE billing_refunds
            SET approval_status = 'PAID', amount = 1,
                approved_by = $1::uuid, approved_at = '2000-01-01'::timestamptz,
                paid_by = $1::uuid, paid_at = NOW(), reference = 'FORGED-PAID',
                payout_rail = 'manual', payout_rail_claimed_at = NOW()
          WHERE tenant_id = $2::uuid AND id = $3::int`,
        PAYER,
        TENANT,
        refundId,
      ),
      /request identity|approval evidence/i,
    );
    const unchangedRefund = await refundRow(refundId);
    expect(unchangedRefund).toMatchObject({
      approval_status: 'APPROVED',
      approved_by: APPROVER,
    });
    expect(Number(unchangedRefund.amount)).toBe(75);

    const paid = await billing.markRefundPaid(refundId, {
      tenantId: TENANT,
      paid_by: PAYER,
      reference: `LEGIT-CHEQUE-${randomUUID()}`,
    });
    expect(paid).toMatchObject({ approval_status: 'PAID', approved_by: APPROVER, paid_by: PAYER });
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `UPDATE billing_refunds SET amount = 1 WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        refundId,
      ),
      /request identity|terminal/i,
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `DELETE FROM billing_refunds WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        refundId,
      ),
      /append-only/i,
    );

    const chosenDrawerId = '900000000000000000';
    const [drawer] = await prisma.$queryRawUnsafe(
      `INSERT INTO cash_drawer_sessions
         (id, tenant_id, cashier_uid, shift, opened_at, opening_float, created_at, updated_at)
       VALUES ($1::bigint, $2::uuid, $3::uuid, 'GENERAL',
               '2000-01-01'::timestamptz, 100,
               '2000-01-01'::timestamptz, '2000-01-01'::timestamptz)
       RETURNING id::text, opened_at, created_at, updated_at`,
      chosenDrawerId,
      TENANT,
      PAYER,
    );
    expect(drawer.id).not.toBe(chosenDrawerId);
    for (const value of [drawer.opened_at, drawer.created_at, drawer.updated_at]) {
      expect(new Date(value).getTime()).toBeGreaterThanOrEqual(beforeInsert);
    }
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `UPDATE cash_drawer_sessions
            SET cashier_uid = $1::uuid, opening_float = 999,
                opened_at = '2000-01-01'::timestamptz,
                created_at = '2000-01-01'::timestamptz
          WHERE tenant_id = $2::uuid AND id = $3::bigint`,
        OTHER_CASHIER,
        TENANT,
        drawer.id,
      ),
      /identity and opening float/i,
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `UPDATE cash_drawer_sessions SET system_total = 999
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT,
        drawer.id,
      ),
      /cannot acquire close or review evidence/i,
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `DELETE FROM cash_drawer_sessions WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT,
        drawer.id,
      ),
      /append-only/i,
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `UPDATE cash_drawer_sessions
            SET closed_at = NOW(), counted_total = 100,
                counted_denominations = '{"100":1}'::jsonb,
                cash_inflow_total = 0, cash_refund_total = 0,
                system_total = 0, variance = 0,
                short_count = FALSE, over_count = FALSE,
                requires_review = FALSE, status = 'reviewed',
                reviewed_by = $1::uuid, reviewed_at = NOW()
          WHERE tenant_id = $2::uuid AND id = $3::bigint`,
        OTHER_CASHIER,
        TENANT,
        drawer.id,
      ),
      /exact reviewer evidence/i,
    );
    const closed = await cashDrawer.closeSession({
      tenantId: TENANT,
      id: drawer.id,
      cashier_uid: PAYER,
      counted_denominations: { 100: 1 },
    });
    expect(closed).toMatchObject({ status: 'reviewed', reviewed_by: PAYER });
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `UPDATE cash_drawer_sessions SET review_notes = 'forged terminal edit'
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT,
        drawer.id,
      ),
      /reviewed cash drawer evidence is immutable/i,
    );

    const [maintenanceAuthority] = await prisma.$queryRawUnsafe(
      `SELECT current_user = pg_catalog.pg_get_userbyid(refund.relowner)
                AS owns_refunds,
              current_user = pg_catalog.pg_get_userbyid(drawer.relowner)
                AS owns_drawers
         FROM pg_catalog.pg_class refund
         CROSS JOIN pg_catalog.pg_class drawer
        WHERE refund.oid = 'public.billing_refunds'::pg_catalog.regclass
          AND drawer.oid = 'public.cash_drawer_sessions'::pg_catalog.regclass`,
    );
    expect(maintenanceAuthority).toEqual({ owns_refunds: true, owns_drawers: true });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_refunds WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        refundId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM cash_drawer_sessions WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT,
        drawer.id,
      );
    });
  });

  test.each(RUNTIME_ROLES)(
    '%s cannot turn the audit bypass GUC into refund, drawer, or offline-evidence authority',
    async (role) => {
      const { invoiceId: pendingInvoiceId } = await createInvoice();
      const [pendingRefund] = await prisma.$queryRawUnsafe(
        `INSERT INTO billing_refunds
           (patient_uid, invoice_id, amount, reason, mode, raised_by, tenant_id)
         VALUES ($1::uuid, $2::int, 45, 'runtime bypass probe', 'CHEQUE',
                 $3::uuid, $4::uuid)
         RETURNING id`,
        PATIENT,
        pendingInvoiceId,
        PAYER,
        TENANT,
      );
      const drawerId = await openDrawer({ shift: 'GENERAL' });
      const originalReference = `BYPASS-UPI-${role}-${randomUUID()}`;
      const electronicSource = await createInvoice({
        mode: 'UPI',
        paymentAmount: 500,
        reference: originalReference,
      });
      const electronicRefundId = await createApprovedRefund({
        invoiceId: electronicSource.invoiceId,
        mode: 'UPI',
        amount: 125,
      });

      await expect(prisma.$transaction(async (tx) => {
        await setRuntimeBypassContext(tx, role);
        await tx.$executeRawUnsafe(
          `UPDATE billing_refunds
              SET approval_status = 'PAID',
                  paid_by = $1::uuid,
                  paid_at = NOW(),
                  payout_rail = 'manual',
                  payout_rail_claimed_at = NOW()
            WHERE tenant_id = $2::uuid AND id = $3::int`,
          PAYER,
          TENANT,
          pendingRefund.id,
        );
      })).rejects.toThrow(/can only leave PENDING through APPROVED or REJECTED/i);

      await expect(prisma.$transaction(async (tx) => {
        await setRuntimeBypassContext(tx, role);
        await tx.$executeRawUnsafe(
          `UPDATE cash_drawer_sessions
              SET system_total = 999
            WHERE tenant_id = $1::uuid AND id = $2::bigint`,
          TENANT,
          drawerId,
        );
      })).rejects.toThrow(/cannot acquire close or review evidence without closing/i);

      await expect(prisma.$transaction(async (tx) => {
        await setRuntimeBypassContext(tx, role);
        await tx.$executeRawUnsafe(
          `INSERT INTO billing_refund_offline_electronic_evidence
             (tenant_id, refund_id, original_payment_id, mode, amount,
              provider_name, original_payment_reference, provider_refund_reference,
              provider_refunded_at, recorded_by)
           VALUES ($1::uuid, $2::int, $3::int, 'UPI', 999,
                   'Forged Provider', $4, $5, NOW(), $6::uuid)`,
          TENANT,
          electronicRefundId,
          electronicSource.paymentId,
          originalReference,
          `FORGED-OFFLINE-${role}-${randomUUID()}`,
          PAYER,
        );
      })).rejects.toThrow(/does not match an independently approved refund/i);

      expect(await refundRow(Number(pendingRefund.id))).toMatchObject({
        approval_status: 'PENDING',
        paid_by: null,
        payout_rail: null,
      });
      const [drawer] = await prisma.$queryRawUnsafe(
        `SELECT status, system_total
           FROM cash_drawer_sessions
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT,
        drawerId,
      );
      expect(drawer).toMatchObject({ status: 'open', system_total: null });
      const [evidenceCount] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM billing_refund_offline_electronic_evidence
          WHERE tenant_id = $1::uuid AND refund_id = $2::int`,
        TENANT,
        electronicRefundId,
      );
      expect(evidenceCount.count).toBe(0);
      const [approved] = await prisma.$transaction(async (tx) => {
        await setRuntimeBypassContext(tx, role);
        return tx.$queryRawUnsafe(
          `UPDATE billing_refunds
              SET approval_status = 'APPROVED',
                  approved_by = $1::uuid,
                  approved_at = NOW(),
                  updated_at = NOW()
            WHERE tenant_id = $2::uuid AND id = $3::int
            RETURNING approval_status, approved_by`,
          APPROVER,
          TENANT,
          pendingRefund.id,
        );
      });
      expect(approved).toMatchObject({
        approval_status: 'APPROVED',
        approved_by: APPROVER,
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
        await tx.$executeRawUnsafe(
          `DELETE FROM cash_drawer_sessions
            WHERE tenant_id = $1::uuid AND id = $2::bigint`,
          TENANT,
          drawerId,
        );
      });
    },
  );

  test('manual payout fails closed for actor, mode, drawer, and voucher violations', async () => {
    const { invoiceId: actorInvoice } = await createInvoice();
    const actorRefund = await createApprovedRefund({
      invoiceId: actorInvoice,
      mode: 'CHEQUE',
      approvedBy: PAYER,
    });
    await expect(billing.markRefundPaid(actorRefund, {
      tenantId: TENANT, paid_by: PAYER, reference: `SAME-${randomUUID()}`,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER' });

    const { invoiceId: upiInvoice } = await createInvoice({
      mode: 'UPI', reference: `UPI-${randomUUID()}`,
    });
    const upiRefund = await createApprovedRefund({ invoiceId: upiInvoice, mode: 'UPI' });
    await expect(billing.markRefundPaid(upiRefund, {
      tenantId: TENANT, paid_by: PAYER, reference: `MANUAL-UPI-${randomUUID()}`,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_MANUAL_ELECTRONIC_FORBIDDEN' });

    const drawerOtherOwner = await openDrawer({ cashier: OTHER_CASHIER, shift: 'GENERAL' });
    const { invoiceId: cashInvoice } = await createInvoice({
      mode: 'CASH', reference: `CASH-${randomUUID()}`, collectedBy: OTHER_CASHIER, shift: 'GENERAL',
    });
    const cashRefund = await createApprovedRefund({ invoiceId: cashInvoice, mode: 'CASH' });
    await expect(billing.markRefundPaid(cashRefund, {
      tenantId: TENANT,
      paid_by: PAYER,
      reference: `CASH-OWNER-${randomUUID()}`,
      cash_drawer_session_id: drawerOtherOwner,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_CASH_DRAWER_OWNER_MISMATCH' });

    const crossDrawer = await openDrawer({
      cashier: OTHER_TENANT_CASHIER,
      tenant: OTHER_TENANT,
      shift: 'MORNING',
    });
    await expect(billing.markRefundPaid(cashRefund, {
      tenantId: TENANT,
      paid_by: PAYER,
      reference: `CASH-CROSS-${randomUUID()}`,
      cash_drawer_session_id: crossDrawer,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_CASH_DRAWER_NOT_OPEN' });
    await expect(billing.markRefundPaid(cashRefund, {
      tenantId: TENANT,
      paid_by: PAYER,
      reference: '',
      cash_drawer_session_id: drawerOtherOwner,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_PAYOUT_REFERENCE_REQUIRED' });

    const duplicateReference = `CHEQUE-DUP-${randomUUID()}`;
    const { invoiceId: firstInvoice } = await createInvoice();
    const { invoiceId: secondInvoice } = await createInvoice();
    const firstRefund = await createApprovedRefund({ invoiceId: firstInvoice, mode: 'CHEQUE' });
    const secondRefund = await createApprovedRefund({ invoiceId: secondInvoice, mode: 'CHEQUE' });
    await billing.markRefundPaid(firstRefund, {
      tenantId: TENANT, paid_by: PAYER, reference: duplicateReference,
    });
    await expect(billing.markRefundPaid(secondRefund, {
      tenantId: TENANT, paid_by: PAYER, reference: duplicateReference,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_PAYOUT_REFERENCE_DUPLICATE' });
  });

  test('offline electronic evidence is exact, immutable, unique, and never substitutes for gateway capture', async () => {
    const originalReference = `UPI-COLLECT-${randomUUID()}`;
    const { invoiceId, paymentId } = await createInvoice({
      mode: 'UPI', reference: originalReference, paymentAmount: 500,
    });
    const refundId = await createApprovedRefund({ invoiceId, mode: 'UPI', amount: 125 });
    const providerReference = `UPI-REFUND-${randomUUID()}`;
    const [providerClock] = await prisma.$queryRawUnsafe(
      `SELECT clock_timestamp() AS provider_refunded_at`,
    );
    const paid = await billing.markOfflineElectronicRefundPaid(refundId, {
      tenantId: TENANT,
      paid_by: PAYER,
      original_payment_reference: originalReference,
      provider_name: 'External Acquirer',
      provider_refund_reference: providerReference,
      provider_refunded_at: providerClock.provider_refunded_at.toISOString(),
    });
    expect(paid).toMatchObject({
      approval_status: 'PAID',
      payout_rail: 'offline_electronic',
      reference: providerReference,
    });
    const detail = await billing.getRefund(refundId, { tenantId: TENANT });
    expect(detail).toMatchObject({
      workflow_status: 'paid',
      allowed_payout_rails: [],
      original_payment: {
        id: paymentId,
        mode: 'UPI',
        reference: originalReference,
        provider_name: 'External Acquirer',
      },
      offline_electronic_evidence: {
        refund_id: refundId,
        original_payment_id: paymentId,
        provider_refund_reference: providerReference,
      },
    });
    await expect(prisma.$executeRawUnsafe(
      `UPDATE billing_refund_offline_electronic_evidence
          SET provider_name = 'forged'
        WHERE tenant_id = $1::uuid AND refund_id = $2::int`,
      TENANT,
      refundId,
    )).rejects.toThrow(/append-only/i);
    const [evidenceMaintenanceAuthority] = await prisma.$queryRawUnsafe(
      `SELECT current_user = pg_catalog.pg_get_userbyid(class.relowner)
                AS owns_evidence
         FROM pg_catalog.pg_class class
        WHERE class.oid =
          'public.billing_refund_offline_electronic_evidence'::pg_catalog.regclass`,
    );
    expect(evidenceMaintenanceAuthority.owns_evidence).toBe(true);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      const [updated] = await tx.$queryRawUnsafe(
        `UPDATE billing_refund_offline_electronic_evidence
            SET provider_name = 'Owner maintenance proof'
          WHERE tenant_id = $1::uuid AND refund_id = $2::int
          RETURNING provider_name`,
        TENANT,
        refundId,
      );
      expect(updated.provider_name).toBe('Owner maintenance proof');
      await tx.$executeRawUnsafe(
        `UPDATE billing_refund_offline_electronic_evidence
            SET provider_name = 'External Acquirer'
          WHERE tenant_id = $1::uuid AND refund_id = $2::int`,
        TENANT,
        refundId,
      );
    });

    const gatewayReference = `UPI-GATEWAY-${randomUUID()}`;
    const gatewaySource = await createInvoice({
      mode: 'UPI', reference: gatewayReference, paymentAmount: 300,
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO payment_gateway_orders
         (tenant_id, provider, environment, patient_uid, invoice_id, amount,
          provider_payment_id, method, status, billing_payment_id, captured_at,
          webhook_credential_version)
       VALUES ($1::uuid, 'dry_run', 'sandbox', $2::uuid, $3::int, 300,
               $4, 'upi', 'paid', $5::int, NOW(), 1)`,
      TENANT,
      PATIENT,
      gatewaySource.invoiceId,
      `pay_${randomUUID()}`,
      gatewaySource.paymentId,
    );
    const gatewayRefund = await createApprovedRefund({
      invoiceId: gatewaySource.invoiceId, mode: 'UPI', amount: 100,
    });
    await expect(billing.markOfflineElectronicRefundPaid(gatewayRefund, {
      tenantId: TENANT,
      paid_by: PAYER,
      original_payment_reference: gatewayReference,
      provider_name: 'External Acquirer',
      provider_refund_reference: `FORGED-${randomUUID()}`,
      provider_refunded_at: new Date(Date.now() - 60_000).toISOString(),
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_GATEWAY_CAPTURE_AUTHORITATIVE' });
  });

  test('refund rejection has permanent exact replay, changed-command rejection, and one audit row', async () => {
    const { invoiceId } = await createInvoice();
    const pendingRows = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_refunds
         (patient_uid, invoice_id, amount, reason, mode, raised_by, tenant_id)
       VALUES ($1::uuid, $2::int, 25, 'reject deep', 'CHEQUE', $3::uuid, $4::uuid)
       RETURNING id`,
      PATIENT,
      invoiceId,
      PAYER,
      TENANT,
    );
    const refundId = Number(pendingRows[0].id);
    const key = `reject-refund-${randomUUID()}`;
    const app = appFor({ uid: APPROVER, role: 'ADMIN' });
    const body = { rejection_reason: 'Duplicate request' };
    const first = await request(app)
      .post(`/refunds/${refundId}/reject`)
      .set('Idempotency-Key', key)
      .send(body);
    const replay = await request(app)
      .post(`/refunds/${refundId}/reject`)
      .set('Idempotency-Key', key)
      .send(body);
    const mismatch = await request(app)
      .post(`/refunds/${refundId}/reject`)
      .set('Idempotency-Key', key)
      .send({ rejection_reason: 'Changed reason' });

    expect(first.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(mismatch.status).toBe(422);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT refund.approval_status,
              COUNT(audit.id)::int AS audit_count
         FROM billing_refunds refund
         LEFT JOIN audit_logs audit
           ON audit.tenant_id = refund.tenant_id
          AND audit.action = 'FRONT_OFFICE_BILLING_REFUND_REJECTED'
          AND audit.resource_id = refund.id::text
        WHERE refund.tenant_id = $1::uuid AND refund.id = $2::int
        GROUP BY refund.approval_status`,
      TENANT,
      refundId,
    );
    expect(rows[0]).toMatchObject({ approval_status: 'REJECTED', audit_count: 1 });
  });

  test('strict audit failure rolls back payout evidence and permanent idempotency finalization', async () => {
    const drawerId = await openDrawer({ shift: 'EVENING' });
    const { invoiceId } = await createInvoice({
      mode: 'CASH', reference: `CASH-ROLLBACK-${randomUUID()}`, shift: 'EVENING',
    });
    const refundId = await createApprovedRefund({ invoiceId, mode: 'CASH', amount: 50 });
    const reference = `CASH-ROLLBACK-VOUCHER-${randomUUID()}`;
    const commandBody = billing.refundManualPayoutIdempotencyBody(refundId, {
      cash_drawer_session_id: drawerId,
      reference,
    });
    const requestFingerprint = hashRequestBody(commandBody);
    const commandKey = `refund-audit-rollback-${randomUUID()}`;
    const claim = await claimIdempotencyKey({
      tenantId: TENANT,
      userUid: PAYER,
      requestKey: commandKey,
      requestMethod: 'POST',
      requestPath: billing.REFUND_MANUAL_PAYOUT_IDEMPOTENCY_PATH,
      requestBodyHash: requestFingerprint,
    });
    const functionName = 'codex_fail_refund_payout_audit_747';
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${functionName}()
       RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
       BEGIN
         IF NEW.action = 'FRONT_OFFICE_BILLING_REFUND_PAID'
            AND NEW.resource_id = '${refundId}' THEN
           RAISE EXCEPTION 'forced refund audit failure';
         END IF;
         RETURN NEW;
       END
       $fn$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${functionName}
       BEFORE INSERT ON audit_logs
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    try {
      await expect(billing.markRefundPaid(refundId, {
        tenantId: TENANT,
        paid_by: PAYER,
        reference,
        cash_drawer_session_id: drawerId,
        commandKey,
        requestFingerprint,
        httpIdempotencyClaimId: claim.id,
        requestId: 'req-refund-audit-rollback',
        auditContext: {
          actorUid: PAYER,
          subjectUid: PAYER,
          actorRole: 'FINANCE_INCHARGE',
          actingAsDependent: false,
          requestId: 'req-refund-audit-rollback',
          deviceType: 'desktop',
          ipAddress: '127.0.0.1',
          userAgent: 'refund payout deep test',
        },
      })).rejects.toThrow(/forced refund audit failure/i);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${functionName} ON audit_logs`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`);
    }
    expect(await refundRow(refundId)).toMatchObject({
      approval_status: 'APPROVED',
      reference: null,
      payout_rail: null,
      cash_drawer_session_id: null,
    });
    const claims = await prisma.$queryRawUnsafe(
      `SELECT status, response_status, response_body
         FROM idempotency_keys WHERE id = $1::int`,
      claim.id,
    );
    expect(claims[0]).toMatchObject({
      status: 'in_flight', response_status: null, response_body: null,
    });
    await releaseIdempotencyKey(claim.id);
  });

  test('two concurrent exact payout commands converge to one paid refund and one audit', async () => {
    const drawerId = await openDrawer({ shift: 'AFTERNOON' });
    const { invoiceId } = await createInvoice({
      mode: 'CASH', reference: `CASH-RACE-${randomUUID()}`, shift: 'AFTERNOON',
    });
    const refundId = await createApprovedRefund({ invoiceId, mode: 'CASH', amount: 75 });
    const key = `cash-race-${randomUUID()}`;
    const body = { cash_drawer_session_id: drawerId, reference: `CASH-RACE-V-${randomUUID()}` };
    const app = appFor();
    const results = await Promise.all([
      request(app).post(`/refunds/${refundId}/pay`).set('Idempotency-Key', key).send(body),
      request(app).post(`/refunds/${refundId}/pay`).set('Idempotency-Key', key).send(body),
    ]);
    expect(results.every(({ status }) => [200, 409].includes(status))).toBe(true);
    expect(results.some(({ status }) => status === 200)).toBe(true);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT refund.approval_status,
              COUNT(audit.id)::int AS audit_count
         FROM billing_refunds refund
         LEFT JOIN audit_logs audit
           ON audit.tenant_id = refund.tenant_id
          AND audit.action = 'FRONT_OFFICE_BILLING_REFUND_PAID'
          AND audit.resource_id = refund.id::text
        WHERE refund.tenant_id = $1::uuid AND refund.id = $2::int
        GROUP BY refund.approval_status`,
      TENANT,
      refundId,
    );
    expect(rows[0]).toMatchObject({ approval_status: 'PAID', audit_count: 1 });
  });
});
