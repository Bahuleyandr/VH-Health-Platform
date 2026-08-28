// OpenAPI Phase 5 — V2 billing money-movement contract coverage.
// Drives payments / advances / refunds / reports over HTTP and validates every
// response against the canonical spec via assertResponse.
import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';
import { assertResponse } from './helpers/assertSchema.js';

describe('V2 billing money-movement contract', () => {
  const admin = authClient('ADMIN');
  const TENANT = '00000000-0000-4000-8000-000000000001';
  const ADMIN_UID = '550e8400-e29b-41d4-a716-446655440000';
  const PAYER_UID = '550e8400-e29b-41d4-a716-446655440111';
  const payer = authClient('FINANCE_INCHARGE', {
    uid: PAYER_UID,
    id: 111,
    tenant_id: TENANT,
  });
  const patientUid = '44444444-4444-4444-8444-444444444444';
  const RUN = Date.now();
  const idem = (s) => `p5mm-${s}-${RUN}`;

  let advanceId;

  async function makeIssuedInvoice() {
    const draft = await admin.post('/api/v1/billing/v2/invoices').send({
      patient_uid: patientUid, invoice_type: 'OP', patient_name: 'MM Test',
    });
    const id = draft.body.data.id;
    await admin.post(`/api/v1/billing/v2/invoices/${id}/items`).send({
      description: 'Item', quantity: 1, unit_price: 1000, gst_rate: 0,
    });
    await admin.post(`/api/v1/billing/v2/invoices/${id}/issue`).send({});
    return id;
  }

  async function refundApprovalAuditRows(refundId) {
    return prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text, uid::text, role, resource, resource_id,
              actor_uid::text, subject_uid::text, acting_as_dependent, metadata
         FROM audit_logs
        WHERE tenant_id = $1::uuid
          AND action = 'FRONT_OFFICE_BILLING_REFUND_APPROVED'
          AND resource = 'billing_refund'
          AND resource_id = $2::text
        ORDER BY id`,
      TENANT,
      String(refundId),
    );
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM billing_advance_settlements WHERE invoice_id IN (SELECT id FROM billing_invoices WHERE patient_uid = $1::uuid)`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_refunds WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_advances WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id IN (SELECT id FROM billing_invoices WHERE patient_uid = $1::uuid)`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PAYER_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
       VALUES
         ($1::uuid, '9001112233', 'MM Test', 'PATIENT', $3::uuid, NOW()),
         ($2::uuid, '9001112244', 'MM Payer', 'FINANCE_INCHARGE', $3::uuid, NOW())`,
      patientUid, PAYER_UID, TENANT,
    ).catch(() => {});
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('collects then reverses a payment', async () => {
    const invId = await makeIssuedInvoice();
    const pay = await admin.post('/api/v1/billing/v2/payments')
      .set('Idempotency-Key', idem('pay'))
      .send({ invoice_id: invId, amount: 600, mode: 'CASH', shift: 'MORNING' });
    expect([200, 201]).toContain(pay.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/payments', pay.body);
    const paymentId = pay.body.data.id;

    const rev = await admin.post(`/api/v1/billing/v2/payments/${paymentId}/reverse`).send({ reason: 'test reversal' });
    expect(rev.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/payments/{id}/reverse', rev.body);
  });

  it('collects + lists an advance', async () => {
    const adv = await admin.post('/api/v1/billing/v2/advances')
      .set('Idempotency-Key', idem('adv'))
      .send({ patient_uid: patientUid, amount: 2000, mode: 'CASH' });
    expect([200, 201]).toContain(adv.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/advances', adv.body);
    advanceId = adv.body.data.id;

    const list = await admin.get(`/api/v1/billing/v2/advances?patient_uid=${patientUid}`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/advances', list.body);
  });

  it('settles an advance against an invoice', async () => {
    const invId = await makeIssuedInvoice();
    const res = await admin.post(`/api/v1/billing/v2/advances/${advanceId}/settle`)
      .set('Idempotency-Key', idem('settle'))
      .send({ invoice_id: invId, amount: 500 });
    expect(res.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/advances/{id}/settle', res.body);
  });

  it('raises, lists, approves + pays a refund', async () => {
    const raise = await admin.post('/api/v1/billing/v2/refunds')
      .set('Idempotency-Key', idem('refundraise'))
      .send({
        patient_uid: patientUid, advance_id: advanceId, amount: 300, reason: 'overpayment', mode: 'CHEQUE',
      });
    expect([200, 201]).toContain(raise.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/refunds', raise.body);
    const refundId = raise.body.data.id;

    const list = await admin.get(`/api/v1/billing/v2/refunds?patient_uid=${patientUid}`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/refunds', list.body);

    const approvalKey = idem('refundapprove');
    const approvalRequestId = `p5mm-refundapprove-request-${RUN}`;
    const approvals = await Promise.all([
      admin.post(`/api/v1/billing/v2/refunds/${refundId}/approve`)
        .set('Idempotency-Key', approvalKey)
        .set('X-Request-Id', approvalRequestId)
        .send({}),
      admin.post(`/api/v1/billing/v2/refunds/${refundId}/approve`)
        .set('Idempotency-Key', approvalKey)
        .set('X-Request-Id', approvalRequestId)
        .send({}),
    ]);
    const approve = approvals.find((response) => response.statusCode === 200);
    expect(approve).toBeDefined();
    expect(approvals.map((response) => response.statusCode).sort())
      .toEqual(expect.arrayContaining([200]));
    expect(approvals.every((response) => [200, 409].includes(response.statusCode))).toBe(true);
    assertResponse('POST', '/api/v1/billing/v2/refunds/{id}/approve', approve.body);
    const auditAfterApproval = await refundApprovalAuditRows(refundId);
    expect(auditAfterApproval).toHaveLength(1);
    expect(auditAfterApproval[0]).toMatchObject({
      tenant_id: TENANT,
      uid: ADMIN_UID,
      role: 'ADMIN',
      resource: 'billing_refund',
      resource_id: String(refundId),
      actor_uid: ADMIN_UID,
      subject_uid: ADMIN_UID,
      acting_as_dependent: false,
      metadata: expect.objectContaining({
        request_id: approvalRequestId,
        device_type: 'desktop',
        tenant_id: TENANT,
        actor_role: 'ADMIN',
        refund_id: refundId,
        approval_status: 'APPROVED',
        source: 'billing_v2',
      }),
    });

    const replay = await admin.post(`/api/v1/billing/v2/refunds/${refundId}/approve`)
      .set('Idempotency-Key', approvalKey)
      .set('X-Request-Id', `p5mm-refundapprove-replay-${RUN}`)
      .send({});
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(approve.body);
    expect((await refundApprovalAuditRows(refundId)).map(({ id }) => id))
      .toEqual(auditAfterApproval.map(({ id }) => id));
    const durableClaim = (await prisma.$queryRawUnsafe(
      `SELECT status, response_status, response_body, expires_at::text
         FROM idempotency_keys
        WHERE tenant_id = $1::uuid
          AND request_key = $2::text
          AND request_path = '/api/v1/billing/v2/refunds/approve'
        LIMIT 1`,
      TENANT,
      approvalKey,
    ))[0];
    expect(durableClaim).toMatchObject({
      status: 'complete',
      response_status: 200,
      response_body: approve.body,
      expires_at: 'infinity',
    });

    const changed = await admin.post('/api/v1/billing/v2/refunds')
      .set('Idempotency-Key', idem('refundraise-mismatch'))
      .send({
        patient_uid: patientUid,
        advance_id: advanceId,
        amount: 50,
        reason: 'idempotency mismatch probe',
        mode: 'CHEQUE',
      });
    expect(changed.statusCode).toBe(200);
    const changedRefundId = changed.body.data.id;
    const mismatch = await admin.post(`/api/v1/billing/v2/refunds/${changedRefundId}/approve`)
      .set('Idempotency-Key', approvalKey)
      .send({});
    expect(mismatch.statusCode).toBe(422);
    const rejectChanged = await admin.post(
      `/api/v1/billing/v2/refunds/${changedRefundId}/reject`,
    )
      .set('Idempotency-Key', idem('refundreject-mismatch'))
      .send({ rejection_reason: 'idempotency mismatch test cleanup' });
    expect(rejectChanged.statusCode).toBe(200);

    const pay = await payer.post(`/api/v1/billing/v2/refunds/${refundId}/pay`)
      .set('Idempotency-Key', idem('refundpay'))
      .send({ reference: 'REF-PAY-1' });
    expect(pay.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/refunds/{id}/pay', pay.body);
  });

  it('rolls refund approval and permanent finalization back when audit persistence fails', async () => {
    const raise = await admin.post('/api/v1/billing/v2/refunds')
      .set('Idempotency-Key', idem('refundraise-audit-failure'))
      .send({
        patient_uid: patientUid,
        advance_id: advanceId,
        amount: 100,
        reason: 'strict audit rollback probe',
        mode: 'CHEQUE',
      });
    expect(raise.statusCode).toBe(200);
    const refundId = Number(raise.body.data.id);
    const approvalKey = idem('refundapprove-audit-failure');
    const functionName = `test_refund_audit_fail_${process.pid}_${RUN}`;
    const triggerName = `test_refund_audit_fail_${process.pid}_${RUN}`;
    let response;

    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $fn$
       BEGIN
         IF NEW.action = 'FRONT_OFFICE_BILLING_REFUND_APPROVED'
            AND NEW.resource = 'billing_refund'
            AND NEW.resource_id = '${refundId}' THEN
           RAISE EXCEPTION 'forced refund approval audit failure';
         END IF;
         RETURN NEW;
       END
       $fn$`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER ${triggerName}
         BEFORE INSERT ON audit_logs
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
      response = await admin.post(`/api/v1/billing/v2/refunds/${refundId}/approve`)
        .set('Idempotency-Key', approvalKey)
        .set('X-Request-Id', `p5mm-refundapprove-audit-failure-${RUN}`)
        .send({});
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    expect(response.statusCode).toBe(500);
    expect((await prisma.$queryRawUnsafe(
      `SELECT approval_status, approved_by::text, approved_at
         FROM billing_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      refundId,
    ))[0]).toMatchObject({
      approval_status: 'PENDING',
      approved_by: null,
      approved_at: null,
    });
    expect(await refundApprovalAuditRows(refundId)).toHaveLength(0);
    const claim = (await prisma.$queryRawUnsafe(
      `SELECT status, response_status
         FROM idempotency_keys
        WHERE tenant_id = $1::uuid
          AND request_key = $2::text
          AND request_path = '/api/v1/billing/v2/refunds/approve'
        LIMIT 1`,
      TENANT,
      approvalKey,
    ))[0];
    expect(claim).toBeDefined();
    expect(claim).not.toMatchObject({ status: 'complete', response_status: 200 });

    const reject = await admin.post(`/api/v1/billing/v2/refunds/${refundId}/reject`)
      .set('Idempotency-Key', idem('refundreject-audit-failure'))
      .send({ rejection_reason: 'audit rollback test cleanup' });
    expect(reject.statusCode).toBe(200);
  });

  it('raises + rejects a refund', async () => {
    const raise = await admin.post('/api/v1/billing/v2/refunds')
      .set('Idempotency-Key', idem('refundraise-reject'))
      .send({
        patient_uid: patientUid, advance_id: advanceId, amount: 200, reason: 'overpayment', mode: 'CHEQUE',
      });
    expect([200, 201]).toContain(raise.statusCode);
    const refundId = raise.body.data.id;

    const reject = await admin.post(`/api/v1/billing/v2/refunds/${refundId}/reject`)
      .set('Idempotency-Key', idem('refundreject'))
      .send({ rejection_reason: 'not eligible' });
    expect(reject.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/refunds/{id}/reject', reject.body);
  });

  it('returns the daily-collection + outstanding reports', async () => {
    const daily = await admin.get('/api/v1/billing/v2/reports/daily-collection');
    expect(daily.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/reports/daily-collection', daily.body);

    const out = await admin.get('/api/v1/billing/v2/reports/outstanding?limit=50');
    expect(out.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/reports/outstanding', out.body);
  });
});
