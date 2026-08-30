import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { bindMedicationOrderCatalogAuthority } from '../services/ipd/wardIndentWorkflowService.js';
import { seedMedicationFacilityAuthority } from './helpers/medicationEvidenceFixture.js';
import { API_KEY, generateTestToken } from './testClient.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('MED-03 ward medication registered-route journey', () => {
  const tenantId = randomUUID();
  const patientUid = randomUUID();
  const requesterUid = randomUUID();
  const pharmacyQueueUid = randomUUID();
  const pharmacistUid = randomUUID();
  const receiverUid = randomUUID();
  const doctorUid = randomUUID();
  const billingOwnerUid = randomUUID();
  const financeOwnerUid = randomUUID();
  const adminUid = randomUUID();
  const run = `${process.pid}-${Date.now()}`;
  const compositionKey = `med03-route-paracetamol-${tenantId}`;
  const wardBase = '/api/v1/pharmacy-orders/ward-indents';
  const billingBase = '/api/v1/billing/v2';
  const actorIds = {};
  let wardId;
  let facilityId;
  let storageLocationId;
  let admissionId;
  let encounterId;
  let catalogId;
  let inventoryItemId;
  let batchId;
  let clinicalOrderId;

  function client(role, uid, id) {
    const token = generateTestToken(role, {
      uid,
      id,
      tenant_id: tenantId,
      deviceType: 'desktop',
    });
    return {
      get: (path) => request(app)
        .get(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`),
      post: (path, idempotencyKey) => request(app)
        .post(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey),
      put: (path, idempotencyKey) => request(app)
        .put(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey),
    };
  }

  function expectState(response, status, stateVersion) {
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status,
      state_version: stateVersion,
    });
    return response.body.data;
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'MED-03 route journey', 'IN',
               'active', NOW(), NOW())`,
      tenantId,
      `med03-route-journey-${run}`,
    );
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (tenant_id, uid, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $11::text, 'MED03 route patient',
          'PATIENT', TRUE, 'active', NOW()),
         ($1::uuid, $3::uuid, $12::text, 'MED03 requesting nurse',
          'IP_STAFF_NURSE', TRUE, 'active', NOW()),
         ($1::uuid, $4::uuid, $13::text, 'MED03 pharmacy queue',
          'PHARMACY_STAFF', TRUE, 'active', NOW()),
         ($1::uuid, $5::uuid, $14::text, 'MED03 pharmacy incharge',
          'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $6::uuid, $15::text, 'MED03 nursing incharge',
          'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $7::uuid, $16::text, 'MED03 prescriber',
          'DOCTOR', TRUE, 'active', NOW()),
         ($1::uuid, $8::uuid, $17::text, 'MED03 billing owner',
          'BILLING_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $9::uuid, $18::text, 'MED03 finance owner',
          'FINANCE_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $10::uuid, $19::text, 'MED03 refund approver',
          'ADMIN', TRUE, 'active', NOW())
       RETURNING id, uid::text, role`,
      tenantId,
      patientUid,
      requesterUid,
      pharmacyQueueUid,
      pharmacistUid,
      receiverUid,
      doctorUid,
      billingOwnerUid,
      financeOwnerUid,
      adminUid,
      `+91901${String(Date.now()).slice(-7)}`,
      `+91902${String(Date.now()).slice(-7)}`,
      `+91903${String(Date.now()).slice(-7)}`,
      `+91904${String(Date.now()).slice(-7)}`,
      `+91905${String(Date.now()).slice(-7)}`,
      `+91906${String(Date.now()).slice(-7)}`,
      `+91907${String(Date.now()).slice(-7)}`,
      `+91908${String(Date.now()).slice(-7)}`,
      `+91909${String(Date.now()).slice(-7)}`,
    );
    for (const user of users) actorIds[user.role] = Number(user.id);

    const authority = await seedMedicationFacilityAuthority({
      prisma,
      tenantId,
      pharmacistUid,
      grantAdminUid: adminUid,
      run: `route-${run}`,
    });
    facilityId = authority.facilityId;
    storageLocationId = authority.storageLocationId;
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards
         (tenant_id, name, facility_id, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, $3::int, 12, NOW(), NOW())
       RETURNING id`,
      tenantId,
      `MED03 Route Ward ${run}`,
      facilityId,
    ))[0].id);

    const bedNumber = `M3R-${run.slice(-16)}`;
    const bedId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3::text, $4::text, 'occupied', $5::uuid,
               NOW(), NOW())
       RETURNING id`,
      tenantId,
      wardId,
      `MED03 Route Ward ${run}`,
      bedNumber,
      patientUid,
    ))[0].id);
    const admissions = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, bed_id, status, admitted_at, ward, bed_number,
          created_by, attending_doctor, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::int, 'admitted', NOW(), $4::text, $5::text,
               $6::uuid, $7::uuid, NOW(), NOW())
       RETURNING id, encounter_id`,
      tenantId,
      patientUid,
      bedId,
      `MED03 Route Ward ${run}`,
      bedNumber,
      requesterUid,
      doctorUid,
    );
    admissionId = Number(admissions[0].id);
    encounterId = String(admissions[0].encounter_id);

    const compositionId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1::text, 'MED-03 route fixture paracetamol',
               ARRAY['paracetamol']::text[], 'curated')
       RETURNING id`,
      compositionKey,
    ))[0].id);
    const catalog = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, generic_name, is_active, stock_quantity,
          unit_price, price, composition_id, composition_confidence,
          composition_source, strength, strength_key, strength_components,
          form, form_key, release_key, route, updated_at)
       VALUES ($1::uuid, $2::text, 'Paracetamol', TRUE, 20,
               12.50, 12.50, $3::int, 'high', 'test_fixture',
               '500 mg', '500mg', $4::jsonb,
               'tablet', 'tablet', 'ir', 'oral', NOW())
       RETURNING id, name, generic_name, composition_id,
                 composition_confidence, composition_source,
                 strength, strength_key, strength_components,
                 form, form_key, release_key, route`,
      tenantId,
      `MED03 Route Paracetamol ${run}`,
      compositionId,
      JSON.stringify([{ ingredient: 'paracetamol', value: '500', unit: 'mg' }]),
    ))[0];
    catalogId = Number(catalog.id);
    inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, strength, form,
          unit_label, schedule_class, is_narcotic, status, facility_id)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, '500 mg', 'tablet',
               'unit', 'OTC', FALSE, 'active', $5::int)
       RETURNING id`,
      tenantId,
      `MED03-ROUTE-${run}`,
      `MED03 Route Paracetamol ${run}`,
      catalogId,
      facilityId,
    ))[0].id);
    batchId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status, facility_id,
          storage_location_id)
       VALUES ($1::uuid, $2::int, $3::text,
               (NOW() + INTERVAL '365 days')::date, 20, 20, 'in_stock',
               $4::int, $5::int)
       RETURNING id`,
      tenantId,
      inventoryItemId,
      `MED03-ROUTE-BATCH-${run}`,
      facilityId,
      storageLocationId,
    ))[0].id);
    const clinicalOrderDetails = bindMedicationOrderCatalogAuthority({
      catalog_id: catalogId,
      medication_name: catalog.name,
      dose: '500 mg',
      route: catalog.route,
      strength: catalog.strength,
      strength_key: catalog.strength_key,
      form: catalog.form,
      form_key: catalog.form_key,
      release_key: catalog.release_key,
      supply_quantity_per_dose: 1,
      quantity_requested: 2,
      unit: 'unit',
    }, catalog, { phase: 'create' });
    clinicalOrderId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, encounter_id, patient_uid, order_type,
          status, ordered_by, details, route, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'medication',
               'ordered', $5::uuid, $6::jsonb, $7::text, NOW())
       RETURNING id`,
      tenantId,
      `MED03-ROUTE-ORDER-${run}`,
      encounterId,
      patientUid,
      doctorUid,
      JSON.stringify(clinicalOrderDetails),
      catalog.route,
    ))[0].id);
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, TRUE),
                set_config('app.current_user_role', 'SUPER_ADMIN', TRUE),
                set_config('app.current_user_uid', $2::text, TRUE)`,
        tenantId,
        adminUid,
      );
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `DO $cleanup$
         DECLARE
           relation_record RECORD;
         BEGIN
           FOR relation_record IN
             SELECT table_info.table_name
               FROM information_schema.tables table_info
               JOIN information_schema.columns column_info
                 ON column_info.table_schema = table_info.table_schema
                AND column_info.table_name = table_info.table_name
              WHERE table_info.table_schema = 'public'
                AND table_info.table_type = 'BASE TABLE'
                AND column_info.column_name = 'tenant_id'
              ORDER BY table_info.table_name
           LOOP
             EXECUTE format(
               'DELETE FROM public.%I WHERE tenant_id::text = $1',
               relation_record.table_name
             ) USING current_setting('app.current_tenant_id');
           END LOOP;
         END
         $cleanup$`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM drug_compositions WHERE composition_key = $1::text`,
        compositionKey,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
    }, { timeout: 30_000 });
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  test('closes stock, clinical, inbox, billing, credit, and refund obligations through HTTP', async () => {
    const requester = client('IP_STAFF_NURSE', requesterUid, actorIds.IP_STAFF_NURSE);
    const pharmacyQueue = client('PHARMACY_STAFF', pharmacyQueueUid, actorIds.PHARMACY_STAFF);
    const pharmacist = client('PHARMACY_INCHARGE', pharmacistUid, actorIds.PHARMACY_INCHARGE);
    const receiver = client('NURSING_INCHARGE', receiverUid, actorIds.NURSING_INCHARGE);
    const doctor = client('DOCTOR', doctorUid, actorIds.DOCTOR);
    const billingOwner = client('BILLING_INCHARGE', billingOwnerUid, actorIds.BILLING_INCHARGE);
    const financeOwner = client('FINANCE_INCHARGE', financeOwnerUid, actorIds.FINANCE_INCHARGE);
    const admin = client('ADMIN', adminUid, actorIds.ADMIN);
    const createKey = `med03-route-create-${run}`;
    const createBody = {
      ward_id: wardId,
      admission_id: admissionId,
      encounter_id: encounterId,
      patient_uid: patientUid,
      indent_type: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        clinical_order_id: clinicalOrderId,
        item_name: 'Caller-controlled medication name',
        quantity_requested: 2,
        unit_price: 9999,
      }],
    };
    const created = await requester.post(wardBase, createKey).send(createBody);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: 'requested',
      state_version: 1,
      ward_id: wardId,
      admission_id: admissionId,
      encounter_id: encounterId,
      patient_uid: patientUid,
    });
    expect(created.body.data.items).toHaveLength(1);
    expect(created.body.data.items[0]).toMatchObject({
      pharmacy_catalog_id: catalogId,
      original_pharmacy_catalog_id: catalogId,
      clinical_order_id: clinicalOrderId,
      item_name: `MED03 Route Paracetamol ${run}`,
    });
    expect(Number(created.body.data.items[0].unit_price)).toBe(12.5);
    const indentId = Number(created.body.data.id);
    const indentItemId = Number(created.body.data.items[0].id);

    const createReplay = await requester.post(wardBase, createKey).send(createBody);
    expect(createReplay.status).toBe(201);
    expect(createReplay.body).toEqual(created.body);
    const createdEffects = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM ward_indents
           WHERE tenant_id = $1::uuid AND id = $2::int) AS indent_count,
         (SELECT COUNT(*)::int
            FROM ward_indent_items
           WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int) AS item_count,
         (SELECT COUNT(*)::int
            FROM ward_indent_events
           WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int) AS event_count`,
      tenantId,
      indentId,
    );
    expect(createdEffects[0]).toEqual({
      indent_count: 1,
      item_count: 1,
      event_count: 1,
    });

    const verifyKey = `med03-route-order-verify-${run}`;
    const verifyBody = {};
    const verifiedOrder = await pharmacist
      .put(`/api/v1/emr/orders/${clinicalOrderId}/verify`, verifyKey)
      .send(verifyBody);
    expect(verifiedOrder.status).toBe(200);
    expect(verifiedOrder.body.data).toMatchObject({
      id: clinicalOrderId,
      tenant_id: tenantId,
      patient_uid: patientUid,
      encounter_id: encounterId,
      status: 'verified',
      verified_by: pharmacistUid,
    });
    expect(verifiedOrder.body.data.verified_at).not.toBeNull();
    const verifiedOrderReplay = await pharmacist
      .put(`/api/v1/emr/orders/${clinicalOrderId}/verify`, verifyKey)
      .send(verifyBody);
    expect(verifiedOrderReplay.status).toBe(200);
    expect(verifiedOrderReplay.body).toEqual(verifiedOrder.body);
    const marScheduling = await doctor
      .post(
        `/api/v1/emr/orders/${clinicalOrderId}/retry-mar-scheduling`,
        `med03-route-mar-schedule-${run}`,
      )
      .send({});
    expect(marScheduling.status).toBe(200);
    expect(marScheduling.body.data).toMatchObject({
      order_id: clinicalOrderId,
      status: 'scheduled',
      scheduled_dose_count: 1,
    });
    expect(marScheduling.body.data.scheduled_dose_ids).toHaveLength(1);
    const marId = Number(marScheduling.body.data.scheduled_dose_ids[0]);
    expect(Number.isSafeInteger(marId)).toBe(true);
    expect(marId).toBeGreaterThan(0);
    const verificationEvidence = await prisma.$queryRawUnsafe(
      `SELECT timeline.event_type, timeline.event_status,
              timeline.actor_uid::text, timeline.actor_role, timeline.payload,
              audit.action, audit.action_status, audit.actor_uid::text AS audit_actor_uid,
              audit.actor_role AS audit_actor_role, audit.before_state,
              audit.after_state, audit.metadata,
              clinical_order.status AS order_status,
              clinical_order.verified_by::text, clinical_order.verified_at
         FROM clinical_timeline_events timeline
         JOIN clinical_audit_events audit
           ON audit.tenant_id = timeline.tenant_id
          AND audit.resource_table = timeline.source_table
          AND audit.resource_id = timeline.source_id
          AND audit.action = timeline.event_type
         JOIN clinical_orders clinical_order
           ON clinical_order.tenant_id = timeline.tenant_id
          AND clinical_order.id::text = timeline.source_id
        WHERE timeline.tenant_id = $1::uuid
          AND timeline.source_table = 'clinical_orders'
          AND timeline.source_id = $2::text
          AND timeline.event_type = 'order.verified'`,
      tenantId,
      clinicalOrderId,
    );
    expect(verificationEvidence).toHaveLength(1);
    expect(verificationEvidence[0]).toMatchObject({
      event_type: 'order.verified',
      event_status: 'verified',
      actor_uid: pharmacistUid,
      actor_role: 'PHARMACY_INCHARGE',
      action: 'order.verified',
      action_status: 'success',
      audit_actor_uid: pharmacistUid,
      audit_actor_role: 'PHARMACY_INCHARGE',
      before_state: { status: 'ordered' },
      after_state: { status: 'verified' },
      order_status: 'verified',
      verified_by: pharmacistUid,
    });
    expect(verificationEvidence[0].verified_at).not.toBeNull();
    expect(verificationEvidence[0].payload.verification_command_fingerprint)
      .toMatch(/^[0-9a-f]{64}$/);
    expect(verificationEvidence[0].metadata.verification_command_fingerprint)
      .toBe(verificationEvidence[0].payload.verification_command_fingerprint);
    expect(verificationEvidence[0].payload.verification_response)
      .toEqual(verifiedOrder.body.data);
    expect(verificationEvidence[0].metadata.verification_response)
      .toEqual(verifiedOrder.body.data);
    const verificationCardinality = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND source_table = 'clinical_orders'
             AND source_id = $2::text
             AND event_type = 'order.verified') AS timeline_count,
         (SELECT COUNT(*)::int
            FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND resource_table = 'clinical_orders'
             AND resource_id = $2::text
             AND action = 'order.verified') AS audit_count`,
      tenantId,
      clinicalOrderId,
    );
    expect(verificationCardinality[0]).toEqual({
      timeline_count: 1,
      audit_count: 1,
    });

    const inbox = await pharmacyQueue.get('/api/v1/clinical-inbox/tasks/inbox');
    expect(inbox.status).toBe(200);
    const requestedTask = inbox.body.data.tasks.find(
      (task) => Number(task.metadata?.ward_indent_id) === indentId,
    );
    expect(requestedTask).toMatchObject({
      status: 'open',
      assigned_to_role: 'PHARMACY_STAFF',
      sla_completion_semantics: 'domain_evidence',
      metadata: {
        task_contract: 'ward_medication_obligation_v1',
        obligation_kind: 'ward_indent_state',
        current_state: 'requested',
        state_version: 1,
        ward_indent_id: indentId,
      },
    });
    const requestedOwnership = await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status AS task_status, task.assigned_to_role,
              task.sla_completion_semantics, task.related_resource_id,
              task.metadata, sla.rule_code, sla.status AS sla_status,
              ROUND(EXTRACT(EPOCH FROM (sla.due_at - sla.started_at)) / 60)::int
                AS target_minutes
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      tenantId,
      Number(requestedTask.id),
    );
    expect(requestedOwnership[0]).toMatchObject({
      task_status: 'open',
      assigned_to_role: 'PHARMACY_STAFF',
      sla_completion_semantics: 'domain_evidence',
      related_resource_id: `ward-indent:${indentId}:v1`,
      rule_code: 'ward_indent_pharmacy_response',
      sla_status: 'active',
      target_minutes: 30,
    });
    expect(requestedOwnership[0].metadata.owner_role_codes).toEqual([
      'PHARMACY_STAFF',
      'PHARMACY_INCHARGE',
      'PHARMACIST',
    ]);
    const requestedNotifications = await prisma.$queryRawUnsafe(
      `SELECT outbox.recipient_id, recipient.role, outbox.type,
              outbox.channel, outbox.status, outbox.source_event_key,
              outbox.payload
         FROM notification_outbox outbox
         JOIN users recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.payload->>'ward_indent_id' = $2::text
          AND outbox.payload->>'state' = 'requested'
        ORDER BY recipient.role`,
      tenantId,
      String(indentId),
    );
    expect(requestedNotifications.map((row) => row.role)).toEqual([
      'PHARMACY_INCHARGE',
      'PHARMACY_STAFF',
    ]);
    expect(requestedNotifications.every((row) => (
      row.type === 'ward_indent_request'
      && row.channel === 'inapp'
      && row.source_event_key === `ward-indent:${indentId}:v1:ward_indent_request`
      && Number(row.payload.task_id) === Number(requestedTask.id)
      && Number(row.payload.state_version) === 1
    ))).toBe(true);

    const reserveBody = { expected_version: 1 };
    const reservedResponse = await pharmacist
      .post(`${wardBase}/${indentId}/reserve`, `med03-route-reserve-${run}`)
      .send(reserveBody);
    const reserved = expectState(reservedResponse, 'reserved', 2);
    const approved = expectState(
      await pharmacist
        .post(`${wardBase}/${indentId}/approve`, `med03-route-approve-${run}`)
        .send({ expected_version: reserved.state_version }),
      'approved',
      3,
    );
    const issueKey = `med03-route-issue-${run}`;
    const issueBody = { expected_version: approved.state_version };
    const issuedResponse = await pharmacist
      .post(`${wardBase}/${indentId}/issue`, issueKey)
      .send(issueBody);
    const issued = expectState(issuedResponse, 'issued', 4);
    const issueReplay = await pharmacist
      .post(`${wardBase}/${indentId}/issue`, issueKey)
      .send(issueBody);
    expect(issueReplay.status).toBe(200);
    expect(issueReplay.body).toEqual(issuedResponse.body);

    const stockAfterIssue = await prisma.$queryRawUnsafe(
      `SELECT batch.remaining_quantity, catalog.stock_quantity,
              allocation.id AS allocation_id, allocation.inventory_batch_id,
              allocation.status, allocation.reserved_quantity,
              allocation.issued_quantity, allocation.received_quantity,
              allocation.returned_quantity
         FROM pharmacy_inventory_batches batch
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id = batch.tenant_id
          AND catalog.id = $3::int
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = batch.tenant_id
          AND allocation.inventory_batch_id = batch.id
        WHERE batch.tenant_id = $1::uuid
          AND batch.id = $2::int
          AND allocation.ward_indent_id = $4::int`,
      tenantId,
      batchId,
      catalogId,
      indentId,
    );
    expect(stockAfterIssue).toHaveLength(1);
    expect(Number(stockAfterIssue[0].remaining_quantity)).toBe(18);
    expect(Number(stockAfterIssue[0].stock_quantity)).toBe(18);
    expect(stockAfterIssue[0].status).toBe('issued');
    expect(Number(stockAfterIssue[0].reserved_quantity)).toBe(2);
    expect(Number(stockAfterIssue[0].issued_quantity)).toBe(2);
    expect(Number(stockAfterIssue[0].received_quantity)).toBe(0);
    expect(Number(stockAfterIssue[0].returned_quantity)).toBe(0);
    const allocationId = String(stockAfterIssue[0].allocation_id);

    const issueMovements = await prisma.$queryRawUnsafe(
      `SELECT link.movement_purpose, link.quantity,
              link.ward_indent_state_version,
              movement.quantity_delta, movement.inventory_item_id,
              movement.inventory_batch_id AS movement_batch_id
         FROM ward_indent_inventory_movement_links link
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = link.tenant_id
          AND movement.id = link.stock_movement_id
        WHERE link.tenant_id = $1::uuid
          AND link.allocation_id = $2::bigint
        ORDER BY link.ward_indent_state_version`,
      tenantId,
      BigInt(allocationId),
    );
    expect(issueMovements).toHaveLength(1);
    expect(issueMovements[0]).toMatchObject({
      movement_purpose: 'issue',
      ward_indent_state_version: 4,
      inventory_item_id: inventoryItemId,
      movement_batch_id: batchId,
    });
    expect(Number(issueMovements[0].quantity)).toBe(2);
    expect(Number(issueMovements[0].quantity_delta)).toBe(-2);

    const chargeRows = await prisma.$queryRawUnsafe(
      `SELECT event.id, event.ward_indent_item_id, event.clinical_order_id,
              event.ward_indent_state_version, event.event_kind, event.quantity,
              event.unit_price_minor, event.amount_minor, event.original_event_id,
              event.invoice_id, event.invoice_item_id, line.source_ref_type,
              line.source_ref_id
         FROM ward_indent_financial_events event
         JOIN billing_invoice_items line
           ON line.tenant_id = event.tenant_id
          AND line.id = event.invoice_item_id
        WHERE event.tenant_id = $1::uuid
          AND event.ward_indent_id = $2::int
        ORDER BY event.id`,
      tenantId,
      indentId,
    );
    expect(chargeRows).toHaveLength(1);
    expect(chargeRows[0]).toMatchObject({
      ward_indent_item_id: indentItemId,
      clinical_order_id: clinicalOrderId,
      ward_indent_state_version: 4,
      event_kind: 'charge',
      original_event_id: null,
      source_ref_type: 'ward_indent_item',
    });
    expect(Number(chargeRows[0].quantity)).toBe(2);
    expect(Number(chargeRows[0].unit_price_minor)).toBe(1250);
    expect(Number(chargeRows[0].amount_minor)).toBe(2500);
    expect(Number(chargeRows[0].source_ref_id)).toBe(indentItemId);
    const chargeEventId = String(chargeRows[0].id);
    const invoiceId = Number(chargeRows[0].invoice_id);
    const invoiceItemId = Number(chargeRows[0].invoice_item_id);

    const issuedInvoice = await billingOwner
      .post(`${billingBase}/invoices/${invoiceId}/issue`, `med03-route-invoice-issue-${run}`)
      .send({});
    expect(issuedInvoice.status).toBe(200);
    expect(issuedInvoice.body.data).toMatchObject({ id: invoiceId, status: 'ISSUED' });
    expect(Number(issuedInvoice.body.data.total_amount)).toBe(25);
    expect(Number(issuedInvoice.body.data.amount_due)).toBe(25);

    const paymentKey = `med03-route-payment-${run}`;
    const paymentBody = {
      invoice_id: invoiceId,
      amount: 25,
      mode: 'CHEQUE',
      reference: `MED03-ROUTE-CHEQUE-${run}`,
      shift: 'GENERAL',
    };
    const payment = await billingOwner
      .post(`${billingBase}/payments`, paymentKey)
      .send(paymentBody);
    expect(payment.status).toBe(200);
    expect(payment.body.data).toMatchObject({
      invoice_id: invoiceId,
      mode: 'CHEQUE',
      reference: paymentBody.reference,
    });
    expect(Number(payment.body.data.amount)).toBe(25);
    const paymentReplay = await billingOwner
      .post(`${billingBase}/payments`, paymentKey)
      .send(paymentBody);
    expect(paymentReplay.status).toBe(200);
    expect(paymentReplay.body).toEqual(payment.body);
    const persistedPayments = await prisma.$queryRawUnsafe(
      `SELECT id, invoice_id, amount, mode, reference, reversed
         FROM billing_payments
        WHERE tenant_id = $1::uuid
          AND invoice_id = $2::int
        ORDER BY id`,
      tenantId,
      invoiceId,
    );
    expect(persistedPayments).toHaveLength(1);
    expect(persistedPayments[0]).toMatchObject({
      invoice_id: invoiceId,
      mode: 'CHEQUE',
      reference: paymentBody.reference,
      reversed: false,
    });
    expect(Number(persistedPayments[0].amount)).toBe(25);

    const received = expectState(
      await receiver
        .post(`${wardBase}/${indentId}/receive`, `med03-route-receive-${run}`)
        .send({
          expected_version: issued.state_version,
          item_quantities_received: [{
            item_id: indentItemId,
            quantity_received: 2,
          }],
        }),
      'received',
      5,
    );
    const administered = await receiver
      .post(
        `/api/v1/clinical/mar/${marId}/administer-with-scan`,
        `med03-route-mar-administer-${run}`,
      )
      .send({
        scanned_patient_uid: patientUid,
        scanned_barcode: `MED03-ROUTE-BATCH-${run}`,
      });
    expect(administered.status).toBe(200);
    expect(administered.body.data).toMatchObject({
      id: marId,
      status: 'administered',
      all_rights_passed: true,
      supply_state: {
        status: 'matched',
        quantity: 1,
      },
    });
    const supplyConsumptions = await prisma.$queryRawUnsafe(
      `SELECT medication_administration_id, clinical_order_id,
              ward_indent_item_id, inventory_allocation_id,
              inventory_batch_id, quantity, evidence_status,
              administration_mode, recorded_by::text
         FROM mar_supply_consumptions
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::int
        ORDER BY id`,
      tenantId,
      marId,
    );
    expect(supplyConsumptions).toHaveLength(1);
    expect(supplyConsumptions[0]).toMatchObject({
      medication_administration_id: marId,
      clinical_order_id: clinicalOrderId,
      ward_indent_item_id: indentItemId,
      inventory_batch_id: batchId,
      evidence_status: 'matched',
      administration_mode: 'online_barcode_scan',
      recorded_by: receiverUid,
    });
    expect(String(supplyConsumptions[0].inventory_allocation_id)).toBe(allocationId);
    expect(Number(supplyConsumptions[0].quantity)).toBe(1);
    const returnPending = expectState(
      await receiver
        .post(`${wardBase}/${indentId}/returns`, `med03-route-return-${run}`)
        .send({
          expected_version: received.state_version,
          item_quantities_returned: [{
            item_id: indentItemId,
            quantity_returned: 1,
          }],
          reason: 'One paid unit was unused',
        }),
      'return_pending',
      6,
    );
    const reconciledResponse = await pharmacist
      .post(`${wardBase}/${indentId}/reconcile`, `med03-route-reconcile-${run}`)
      .send({
        expected_version: returnPending.state_version,
        reason: 'Exact paid unused stock returned to the source batch',
      });
    const reconciled = expectState(reconciledResponse, 'reconciled', 7);

    const closureRows = await prisma.$queryRawUnsafe(
      `SELECT batch.remaining_quantity, catalog.stock_quantity,
              allocation.status, allocation.reserved_quantity,
              allocation.issued_quantity, allocation.received_quantity,
              allocation.consumed_quantity, allocation.returned_quantity
         FROM pharmacy_inventory_batches batch
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id = batch.tenant_id
          AND catalog.id = $3::int
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = batch.tenant_id
          AND allocation.inventory_batch_id = batch.id
        WHERE batch.tenant_id = $1::uuid
          AND batch.id = $2::int
          AND allocation.id = $4::bigint`,
      tenantId,
      batchId,
      catalogId,
      BigInt(allocationId),
    );
    expect(closureRows).toHaveLength(1);
    expect(closureRows[0].status).toBe('reconciled');
    expect(Number(closureRows[0].remaining_quantity)).toBe(19);
    expect(Number(closureRows[0].stock_quantity)).toBe(19);
    expect(Number(closureRows[0].reserved_quantity)).toBe(2);
    expect(Number(closureRows[0].issued_quantity)).toBe(2);
    expect(Number(closureRows[0].received_quantity)).toBe(2);
    expect(Number(closureRows[0].consumed_quantity)).toBe(1);
    expect(Number(closureRows[0].returned_quantity)).toBe(1);

    const movements = await prisma.$queryRawUnsafe(
      `SELECT link.movement_purpose, link.quantity,
              link.ward_indent_state_version, movement.quantity_delta,
              movement.inventory_item_id, movement.inventory_batch_id
         FROM ward_indent_inventory_movement_links link
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = link.tenant_id
          AND movement.id = link.stock_movement_id
        WHERE link.tenant_id = $1::uuid
          AND link.allocation_id = $2::bigint
        ORDER BY link.ward_indent_state_version`,
      tenantId,
      BigInt(allocationId),
    );
    expect(movements.map((row) => ({
      purpose: row.movement_purpose,
      quantity: Number(row.quantity),
      version: row.ward_indent_state_version,
      delta: Number(row.quantity_delta),
      inventoryItemId: Number(row.inventory_item_id),
      batchId: Number(row.inventory_batch_id),
    }))).toEqual([
      {
        purpose: 'issue',
        quantity: 2,
        version: 4,
        delta: -2,
        inventoryItemId,
        batchId,
      },
      {
        purpose: 'return',
        quantity: 1,
        version: 7,
        delta: 1,
        inventoryItemId,
        batchId,
      },
    ]);
    const receiptEvents = await prisma.$queryRawUnsafe(
      `SELECT ward_indent_state_version, quantity_delta,
              inventory_allocation_id, inventory_batch_id, received_by::text
         FROM ward_indent_inventory_receipt_events
        WHERE tenant_id = $1::uuid
          AND inventory_allocation_id = $2::bigint`,
      tenantId,
      BigInt(allocationId),
    );
    expect(receiptEvents).toHaveLength(1);
    expect(receiptEvents[0]).toMatchObject({
      ward_indent_state_version: 5,
      inventory_batch_id: batchId,
      received_by: receiverUid,
    });
    expect(Number(receiptEvents[0].quantity_delta)).toBe(2);

    const financialEvents = await prisma.$queryRawUnsafe(
      `SELECT id, event_kind, ward_indent_state_version, quantity,
              unit_price_minor, amount_minor, original_event_id,
              invoice_id, invoice_item_id
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
        ORDER BY id`,
      tenantId,
      indentId,
    );
    expect(financialEvents).toHaveLength(2);
    expect(financialEvents.map((row) => ({
      kind: row.event_kind,
      version: row.ward_indent_state_version,
      quantity: Number(row.quantity),
      unitPriceMinor: Number(row.unit_price_minor),
      amountMinor: Number(row.amount_minor),
      originalEventId: row.original_event_id == null ? null : String(row.original_event_id),
      invoiceId: Number(row.invoice_id),
      invoiceItemId: Number(row.invoice_item_id),
    }))).toEqual([
      {
        kind: 'charge',
        version: 4,
        quantity: 2,
        unitPriceMinor: 1250,
        amountMinor: 2500,
        originalEventId: null,
        invoiceId,
        invoiceItemId,
      },
      {
        kind: 'credit',
        version: 7,
        quantity: 1,
        unitPriceMinor: 1250,
        amountMinor: -1250,
        originalEventId: chargeEventId,
        invoiceId,
        invoiceItemId,
      },
    ]);

    const wardNotifications = await prisma.$queryRawUnsafe(
      `SELECT source_event_key, recipient_id, payload
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND payload->>'ward_indent_id' = $2::text
          AND payload ? 'state'
        ORDER BY source_event_key, recipient_id`,
      tenantId,
      String(indentId),
    );
    expect(wardNotifications).toHaveLength(14);
    expect(new Set(wardNotifications.map((row) => row.source_event_key))).toEqual(new Set([
      `ward-indent:${indentId}:v1:ward_indent_request`,
      `ward-indent:${indentId}:v2:ward_indent_reserved`,
      `ward-indent:${indentId}:v3:ward_indent_approved`,
      `ward-indent:${indentId}:v4:ward_indent_issued`,
      `ward-indent:${indentId}:v5:ward_indent_received`,
      `ward-indent:${indentId}:v6:ward_indent_return_pending`,
      `ward-indent:${indentId}:v7:ward_indent_reconciled`,
    ]));
    expect(wardNotifications.every((row) => Number(row.payload.ward_indent_id) === indentId))
      .toBe(true);

    const expectedStages = [
      [`ward-indent:${indentId}:v1`, 'ward_indent_pharmacy_response', 'reserved', 2, 'completed', 'completed'],
      [`ward-indent:${indentId}:v3`, 'ward_indent_pharmacy_issue', 'approved', 3, 'completed', 'completed'],
      [`ward-indent:${indentId}:v4`, 'ward_indent_ward_receipt', 'issued', 4, 'completed', 'completed'],
      [`ward-indent:${indentId}:v5`, 'ward_indent_reconciliation', 'reconciled', 7, 'active', 'open'],
    ];
    const stageRows = await prisma.$queryRawUnsafe(
      `SELECT sla.source_id, sla.rule_code, sla.status AS sla_status,
              task.status AS task_status, task.assigned_to_role,
              task.sla_completion_semantics, task.metadata
         FROM workflow_sla_instances sla
         JOIN tasks task
           ON task.tenant_id = sla.tenant_id
          AND task.workflow_sla_instance_id = sla.id
        WHERE sla.tenant_id = $1::uuid
          AND sla.source_table = 'ward_indents'
          AND sla.source_id = ANY($2::text[])
        ORDER BY sla.source_id`,
      tenantId,
      expectedStages.map((stage) => stage[0]),
    );
    expect(stageRows).toHaveLength(4);
    for (const [sourceId, rule, state, version, slaStatus, taskStatus] of expectedStages) {
      const row = stageRows.find((stage) => stage.source_id === sourceId);
      expect(row).toMatchObject({
        source_id: sourceId,
        rule_code: rule,
        sla_status: slaStatus,
        task_status: taskStatus,
        sla_completion_semantics: 'domain_evidence',
        metadata: {
          task_contract: 'ward_medication_obligation_v1',
          obligation_kind: 'ward_indent_state',
          current_state: state,
          state_version: version,
          ward_indent_id: indentId,
        },
      });
    }

    const pendingNotes = await billingOwner
      .get(`${billingBase}/credit-notes?status=pending&invoice_id=${invoiceId}`);
    expect(pendingNotes.status).toBe(200);
    expect(pendingNotes.body.data).toHaveLength(1);
    expect(pendingNotes.body.data[0]).toMatchObject({
      ward_indent_id: indentId,
      invoice_id: invoiceId,
      status: 'pending',
      amount_minor: 1250,
    });
    const creditNoteId = String(pendingNotes.body.data[0].id);
    const pendingCreditOwnership = await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status, task.title, task.assigned_to_role,
              task.sla_completion_semantics, task.metadata AS task_metadata,
              note.task_id AS credit_note_task_id,
              sla.id::text AS sla_id, sla.status AS sla_status, sla.rule_code,
              sla.completed_at
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
         LEFT JOIN billing_credit_notes note
           ON note.tenant_id = task.tenant_id
          AND note.id = $2::bigint
        WHERE task.tenant_id = $1::uuid
          AND task.metadata->>'obligation_kind' = 'credit_note_review'
          AND task.metadata->>'credit_note_id' = $2::text`,
      tenantId,
      creditNoteId,
    );
    expect(pendingCreditOwnership).toHaveLength(1);
    expect(pendingCreditOwnership[0]).toMatchObject({
      status: 'open',
      title: 'Review ward medication credit note',
      assigned_to_role: 'BILLING_INCHARGE',
      sla_completion_semantics: 'domain_evidence',
      sla_status: 'active',
      rule_code: 'ward_indent_credit_note_review',
      completed_at: null,
      task_metadata: {
        task_contract: 'ward_medication_obligation_v1',
        obligation_kind: 'credit_note_review',
        evidence_kind: 'billing_credit_note_decision',
        credit_note_id: creditNoteId,
        ward_indent_id: indentId,
        invoice_id: invoiceId,
      },
    });
    const creditTaskId = Number(pendingCreditOwnership[0].id);
    expect(pendingCreditOwnership[0].credit_note_task_id).not.toBeNull();
    expect(Number(pendingCreditOwnership[0].credit_note_task_id)).toBe(creditTaskId);
    const creditNotifications = await prisma.$queryRawUnsafe(
      `SELECT recipient.id, recipient.role, outbox.payload
         FROM notification_outbox outbox
         JOIN users recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.payload->>'credit_note_id' = $2::text
          AND outbox.type = 'ward_indent_credit_note_review'
        ORDER BY recipient.role`,
      tenantId,
      creditNoteId,
    );
    expect(creditNotifications.map((row) => row.role)).toEqual([
      'BILLING_INCHARGE',
      'FINANCE_INCHARGE',
    ]);
    expect(creditNotifications.every((row) => Number(row.payload.task_id) === creditTaskId))
      .toBe(true);

    const blockedCloseBody = {
      expected_version: reconciled.state_version,
      reason: 'Clinical stock is reconciled but patient money is still owed',
    };
    const blockedClose = await pharmacist
      .post(`${wardBase}/${indentId}/close`, `med03-route-close-blocked-${run}`)
      .send(blockedCloseBody);
    expect(blockedClose.status).toBe(409);
    expect(blockedClose.body.code).toBe('WARD_INDENT_FINANCIAL_RECONCILIATION_REQUIRED');
    const blockedState = await prisma.$queryRawUnsafe(
      `SELECT indent.status, indent.state_version, task.status AS task_status,
              sla.status AS sla_status, sla.completed_at
         FROM ward_indents indent
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = indent.tenant_id
          AND sla.source_id = indent.active_sla_source_id
         JOIN tasks task
           ON task.tenant_id = sla.tenant_id
          AND task.workflow_sla_instance_id = sla.id
          AND task.metadata->>'obligation_kind' = 'ward_indent_state'
        WHERE indent.tenant_id = $1::uuid
          AND indent.id = $2::int`,
      tenantId,
      indentId,
    );
    expect(blockedState).toHaveLength(1);
    expect(blockedState[0]).toMatchObject({
      status: 'reconciled',
      state_version: 7,
      task_status: 'open',
      sla_status: 'active',
      completed_at: null,
    });
    const preSettlementEvidence = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM ward_indent_events
           WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int) AS events,
         (SELECT COUNT(*)::int
            FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND source_table = 'ward_indents'
             AND source_id = $2::text) AS timeline,
         (SELECT COUNT(*)::int
            FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND resource_table = 'ward_indents'
             AND resource_id = $2::text) AS clinical_audit`,
      tenantId,
      indentId,
    );
    expect(preSettlementEvidence[0]).toEqual({ events: 7, timeline: 7, clinical_audit: 7 });

    const creditApproveKey = `med03-route-credit-approve-${run}`;
    const approvedCredit = await billingOwner
      .post(`${billingBase}/credit-notes/${creditNoteId}/approve`, creditApproveKey)
      .send({});
    expect(approvedCredit.status).toBe(200);
    expect(approvedCredit.body.data).toMatchObject({
      id: pendingNotes.body.data[0].id,
      status: 'approved',
    });
    const approvedCreditReplay = await billingOwner
      .post(`${billingBase}/credit-notes/${creditNoteId}/approve`, creditApproveKey)
      .send({});
    expect(approvedCreditReplay.status).toBe(200);
    expect(approvedCreditReplay.body).toEqual(approvedCredit.body);

    const creditApplyKey = `med03-route-credit-apply-${run}`;
    const creditApplyBody = { refund_mode: 'CHEQUE' };
    const appliedCredit = await billingOwner
      .post(`${billingBase}/credit-notes/${creditNoteId}/apply`, creditApplyKey)
      .send(creditApplyBody);
    expect(appliedCredit.status).toBe(200);
    expect(appliedCredit.body.data).toMatchObject({
      id: pendingNotes.body.data[0].id,
      status: 'applied',
      receivable_credit_minor: 0,
      refund_obligation_minor: 1250,
    });
    const refundId = Number(appliedCredit.body.data.refund_id);
    expect(refundId).toBeGreaterThan(0);
    const appliedCreditReplay = await billingOwner
      .post(`${billingBase}/credit-notes/${creditNoteId}/apply`, creditApplyKey)
      .send(creditApplyBody);
    expect(appliedCreditReplay.status).toBe(200);
    expect(appliedCreditReplay.body).toEqual(appliedCredit.body);

    const refundBeforeApproval = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid::text, invoice_id, amount, reason, mode,
              approval_status, raised_by::text, approved_by::text,
              paid_by::text, reference, payout_rail
         FROM billing_refunds
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      tenantId,
      refundId,
    );
    expect(refundBeforeApproval).toHaveLength(1);
    expect(refundBeforeApproval[0]).toMatchObject({
      id: refundId,
      patient_uid: patientUid,
      invoice_id: invoiceId,
      mode: 'CHEQUE',
      approval_status: 'PENDING',
      raised_by: billingOwnerUid,
      approved_by: null,
      paid_by: null,
      reference: null,
      payout_rail: null,
    });
    expect(Number(refundBeforeApproval[0].amount)).toBe(12.5);

    const refundApprovalOwnership = await prisma.$queryRawUnsafe(
      `SELECT task.status, task.title, task.assigned_to_role,
              task.metadata AS task_metadata, sla.id::text AS sla_id,
              sla.status AS sla_status, sla.completed_at
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      tenantId,
      creditTaskId,
    );
    expect(refundApprovalOwnership[0]).toMatchObject({
      status: 'open',
      title: 'Authorize ward medication credit refund',
      assigned_to_role: 'ADMIN',
      sla_status: 'active',
      completed_at: null,
      task_metadata: {
        evidence_kind: 'billing_credit_note_refund_paid',
        credit_note_stage: 'refund_approval',
        refund_id: refundId,
      },
    });
    const refundApprovalNotifications = await prisma.$queryRawUnsafe(
      `SELECT recipient.id, recipient.role, outbox.payload
         FROM notification_outbox outbox
         JOIN users recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.payload->>'refund_id' = $2::text
          AND outbox.type = 'ward_indent_credit_note_refund_approval'
        ORDER BY recipient.id`,
      tenantId,
      String(refundId),
    );
    expect(refundApprovalNotifications).toHaveLength(1);
    expect(refundApprovalNotifications[0]).toMatchObject({
      id: actorIds.ADMIN,
      role: 'ADMIN',
    });

    const refundApproveKey = `med03-route-refund-approve-${run}`;
    const approvedRefund = await admin
      .post(`${billingBase}/refunds/${refundId}/approve`, refundApproveKey)
      .send({});
    expect(approvedRefund.status).toBe(200);
    expect(approvedRefund.body.data).toMatchObject({
      id: refundId,
      approval_status: 'APPROVED',
      approved_by: adminUid,
    });
    const approvedRefundReplay = await admin
      .post(`${billingBase}/refunds/${refundId}/approve`, refundApproveKey)
      .send({});
    expect(approvedRefundReplay.status).toBe(200);
    expect(approvedRefundReplay.body).toEqual(approvedRefund.body);

    const refundPayOwnership = await prisma.$queryRawUnsafe(
      `SELECT task.status, task.title, task.assigned_to_role,
              task.metadata AS task_metadata, sla.status AS sla_status,
              sla.completed_at
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      tenantId,
      creditTaskId,
    );
    expect(refundPayOwnership[0]).toMatchObject({
      status: 'open',
      title: 'Settle approved ward medication credit refund',
      assigned_to_role: 'FINANCE_INCHARGE',
      sla_status: 'active',
      completed_at: null,
      task_metadata: {
        evidence_kind: 'billing_credit_note_refund_paid',
        credit_note_stage: 'refund_payout',
        refund_id: refundId,
      },
    });
    const refundPayoutNotifications = await prisma.$queryRawUnsafe(
      `SELECT recipient.id, recipient.role, outbox.payload
         FROM notification_outbox outbox
         JOIN users recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.payload->>'refund_id' = $2::text
          AND outbox.type = 'ward_indent_credit_note_refund_payout'
        ORDER BY recipient.role`,
      tenantId,
      String(refundId),
    );
    expect(refundPayoutNotifications.map((row) => row.role)).toEqual([
      'BILLING_INCHARGE',
      'FINANCE_INCHARGE',
    ]);

    const refundPayKey = `med03-route-refund-pay-${run}`;
    const refundPayBody = { reference: `MED03-ROUTE-PAYOUT-${run}` };
    const paidRefund = await financeOwner
      .post(`${billingBase}/refunds/${refundId}/pay`, refundPayKey)
      .send(refundPayBody);
    expect(paidRefund.status).toBe(200);
    expect(paidRefund.body.data).toMatchObject({
      id: refundId,
      approval_status: 'PAID',
      paid_by: financeOwnerUid,
      reference: refundPayBody.reference,
      payout_rail: 'manual',
    });
    const paidRefundReplay = await financeOwner
      .post(`${billingBase}/refunds/${refundId}/pay`, refundPayKey)
      .send(refundPayBody);
    expect(paidRefundReplay.status).toBe(200);
    expect(paidRefundReplay.body).toEqual(paidRefund.body);

    const settledFinance = await prisma.$queryRawUnsafe(
      `SELECT note.status AS credit_status, note.receivable_credit_minor,
              note.refund_obligation_minor, note.refund_id, note.task_id,
              refund.approval_status, refund.mode, refund.reference,
              refund.payout_rail, refund.approved_by::text, refund.paid_by::text,
              invoice.total_amount, invoice.credit_note_amount,
              invoice.amount_paid, invoice.amount_due,
              task.status AS task_status, task.assigned_to_role,
              sla.status AS sla_status, sla.completed_at, sla.metadata AS sla_metadata
         FROM billing_credit_notes note
         JOIN billing_refunds refund
           ON refund.tenant_id = note.tenant_id
          AND refund.id = note.refund_id
         JOIN billing_invoices invoice
           ON invoice.tenant_id = note.tenant_id
          AND invoice.id = note.invoice_id
         JOIN tasks task
           ON task.tenant_id = note.tenant_id
          AND task.metadata->>'obligation_kind' = 'credit_note_review'
          AND task.metadata->>'credit_note_id' = note.id::text
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE note.tenant_id = $1::uuid
          AND note.id = $2::bigint`,
      tenantId,
      BigInt(creditNoteId),
    );
    expect(settledFinance).toHaveLength(1);
    expect(settledFinance[0]).toMatchObject({
      credit_status: 'applied',
      refund_id: refundId,
      task_id: creditTaskId,
      approval_status: 'PAID',
      mode: 'CHEQUE',
      reference: refundPayBody.reference,
      payout_rail: 'manual',
      approved_by: adminUid,
      paid_by: financeOwnerUid,
      task_status: 'completed',
      assigned_to_role: 'FINANCE_INCHARGE',
      sla_status: 'completed',
    });
    expect(Number(settledFinance[0].receivable_credit_minor)).toBe(0);
    expect(Number(settledFinance[0].refund_obligation_minor)).toBe(1250);
    expect(Number(settledFinance[0].total_amount)).toBe(25);
    expect(Number(settledFinance[0].credit_note_amount)).toBe(12.5);
    expect(Number(settledFinance[0].amount_paid)).toBe(12.5);
    expect(Number(settledFinance[0].amount_due)).toBe(0);
    expect(settledFinance[0].completed_at).not.toBeNull();
    expect(settledFinance[0].sla_metadata).toMatchObject({
      completed_via: 'domain_evidence',
      completed_by: financeOwnerUid,
      completion_evidence: {
        kind: 'billing_credit_note_refund_paid',
        resource_type: 'billing_refund',
        resource_id: String(refundId),
      },
    });

    const creditEvents = await prisma.$queryRawUnsafe(
      `SELECT event_type, actor_uid::text
         FROM billing_credit_note_events
        WHERE tenant_id = $1::uuid
          AND credit_note_id = $2::bigint
        ORDER BY id`,
      tenantId,
      BigInt(creditNoteId),
    );
    expect(creditEvents).toEqual([
      { event_type: 'raised', actor_uid: pharmacistUid },
      { event_type: 'approved', actor_uid: billingOwnerUid },
      { event_type: 'applied', actor_uid: billingOwnerUid },
    ]);
    const refundAudits = await prisma.$queryRawUnsafe(
      `SELECT action, resource, resource_id, actor_uid::text, subject_uid::text,
              role
         FROM audit_logs
        WHERE tenant_id = $1::uuid
          AND resource = 'billing_refund'
          AND resource_id = $2::text
          AND action = ANY($3::text[])
        ORDER BY action`,
      tenantId,
      String(refundId),
      [
        'FRONT_OFFICE_BILLING_REFUND_APPROVED',
        'FRONT_OFFICE_BILLING_REFUND_PAID',
      ],
    );
    expect(refundAudits).toHaveLength(2);
    expect(refundAudits.map((row) => ({
      action: row.action,
      actor: row.actor_uid,
      subject: row.subject_uid,
      role: row.role,
    }))).toEqual([
      {
        action: 'FRONT_OFFICE_BILLING_REFUND_APPROVED',
        actor: adminUid,
        subject: adminUid,
        role: 'ADMIN',
      },
      {
        action: 'FRONT_OFFICE_BILLING_REFUND_PAID',
        actor: financeOwnerUid,
        subject: financeOwnerUid,
        role: 'FINANCE_INCHARGE',
      },
    ]);

    const closeKey = `med03-route-close-final-${run}`;
    const closeBody = {
      expected_version: reconciled.state_version,
      reason: 'Stock and patient refund are both reconciled',
    };
    const closedResponse = await pharmacist
      .post(`${wardBase}/${indentId}/close`, closeKey)
      .send(closeBody);
    const closed = expectState(closedResponse, 'closed', 8);
    expect(closed).toMatchObject({ active_sla_source_id: null });
    const closeReplay = await pharmacist
      .post(`${wardBase}/${indentId}/close`, closeKey)
      .send(closeBody);
    expect(closeReplay.status).toBe(200);
    expect(closeReplay.body).toEqual(closedResponse.body);

    const transitionEvidence = await prisma.$queryRawUnsafe(
      `SELECT event.state_version, event.action, event.from_status,
              event.to_status, event.actor_uid::text, actor.role
         FROM ward_indent_events event
         JOIN users actor
           ON actor.tenant_id = event.tenant_id
          AND actor.uid = event.actor_uid
        WHERE event.tenant_id = $1::uuid
          AND event.ward_indent_id = $2::int
        ORDER BY event.state_version`,
      tenantId,
      indentId,
    );
    expect(transitionEvidence).toEqual([
      { state_version: 1, action: 'requested', from_status: null, to_status: 'requested', actor_uid: requesterUid, role: 'IP_STAFF_NURSE' },
      { state_version: 2, action: 'reserved', from_status: 'requested', to_status: 'reserved', actor_uid: pharmacistUid, role: 'PHARMACY_INCHARGE' },
      { state_version: 3, action: 'approved', from_status: 'reserved', to_status: 'approved', actor_uid: pharmacistUid, role: 'PHARMACY_INCHARGE' },
      { state_version: 4, action: 'issued', from_status: 'approved', to_status: 'issued', actor_uid: pharmacistUid, role: 'PHARMACY_INCHARGE' },
      { state_version: 5, action: 'receipt_recorded', from_status: 'issued', to_status: 'received', actor_uid: receiverUid, role: 'NURSING_INCHARGE' },
      { state_version: 6, action: 'return_requested', from_status: 'received', to_status: 'return_pending', actor_uid: receiverUid, role: 'NURSING_INCHARGE' },
      { state_version: 7, action: 'reconciled', from_status: 'return_pending', to_status: 'reconciled', actor_uid: pharmacistUid, role: 'PHARMACY_INCHARGE' },
      { state_version: 8, action: 'closed', from_status: 'reconciled', to_status: 'closed', actor_uid: pharmacistUid, role: 'PHARMACY_INCHARGE' },
    ]);
    const canonicalTransitions = await prisma.$queryRawUnsafe(
      `SELECT timeline.event_type, timeline.event_status,
              (timeline.payload->>'state_version')::int AS state_version,
              audit.action AS audit_action,
              audit.before_state, audit.after_state
         FROM clinical_timeline_events timeline
         JOIN clinical_audit_events audit
           ON audit.tenant_id = timeline.tenant_id
          AND audit.resource_table = timeline.source_table
          AND audit.resource_id = timeline.source_id
          AND audit.idempotency_key = REPLACE(
                timeline.idempotency_key,
                ':transition:',
                ':audit:transition:'
              )
        WHERE timeline.tenant_id = $1::uuid
          AND timeline.source_table = 'ward_indents'
          AND timeline.source_id = $2::text
        ORDER BY (timeline.payload->>'state_version')::int`,
      tenantId,
      indentId,
    );
    expect(canonicalTransitions.map((row) => ({
      eventType: row.event_type,
      eventStatus: row.event_status,
      stateVersion: row.state_version,
      auditAction: row.audit_action,
      before: row.before_state,
      after: row.after_state,
    }))).toEqual([
      { eventType: 'ward_indent.requested', eventStatus: 'requested', stateVersion: 1, auditAction: 'ward_indent.requested', before: null, after: expect.objectContaining({ status: 'requested', state_version: 1 }) },
      { eventType: 'ward_indent.reserved', eventStatus: 'reserved', stateVersion: 2, auditAction: 'ward_indent.reserved', before: { status: 'requested', state_version: 1 }, after: expect.objectContaining({ status: 'reserved', state_version: 2 }) },
      { eventType: 'ward_indent.approved', eventStatus: 'approved', stateVersion: 3, auditAction: 'ward_indent.approved', before: { status: 'reserved', state_version: 2 }, after: expect.objectContaining({ status: 'approved', state_version: 3 }) },
      { eventType: 'ward_indent.issued', eventStatus: 'issued', stateVersion: 4, auditAction: 'ward_indent.issued', before: { status: 'approved', state_version: 3 }, after: expect.objectContaining({ status: 'issued', state_version: 4 }) },
      { eventType: 'ward_indent.receipt_recorded', eventStatus: 'received', stateVersion: 5, auditAction: 'ward_indent.receipt_recorded', before: { status: 'issued', state_version: 4 }, after: expect.objectContaining({ status: 'received', state_version: 5 }) },
      { eventType: 'ward_indent.return_requested', eventStatus: 'return_pending', stateVersion: 6, auditAction: 'ward_indent.return_requested', before: { status: 'received', state_version: 5 }, after: expect.objectContaining({ status: 'return_pending', state_version: 6 }) },
      { eventType: 'ward_indent.reconciled', eventStatus: 'reconciled', stateVersion: 7, auditAction: 'ward_indent.reconciled', before: { status: 'return_pending', state_version: 6 }, after: expect.objectContaining({ status: 'reconciled', state_version: 7 }) },
      { eventType: 'ward_indent.closed', eventStatus: 'closed', stateVersion: 8, auditAction: 'ward_indent.closed', before: { status: 'reconciled', state_version: 7 }, after: expect.objectContaining({ status: 'closed', state_version: 8 }) },
    ]);
    const canonicalEvidence = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND source_table = 'ward_indents'
             AND source_id = $2::text) AS timeline_count,
         (SELECT COUNT(*)::int
            FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND resource_table = 'ward_indents'
             AND resource_id = $2::text) AS audit_count,
         (SELECT COUNT(*)::int
            FROM ward_indent_events
           WHERE tenant_id = $1::uuid
             AND ward_indent_id = $2::int
             AND action = 'closed') AS closed_count`,
      tenantId,
      indentId,
    );
    expect(canonicalEvidence[0]).toEqual({
      timeline_count: 8,
      audit_count: 8,
      closed_count: 1,
    });
    const finalStateOwnership = await prisma.$queryRawUnsafe(
      `SELECT indent.status, indent.state_version, indent.active_sla_source_id,
              task.status AS task_status, sla.status AS sla_status,
              task.completed_at AS task_completed_at,
              sla.completed_at AS sla_completed_at,
              sla.metadata AS sla_metadata
         FROM ward_indents indent
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = indent.tenant_id
          AND sla.source_id = $3::text
         JOIN tasks task
           ON task.tenant_id = sla.tenant_id
          AND task.workflow_sla_instance_id = sla.id
          AND task.metadata->>'obligation_kind' = 'ward_indent_state'
        WHERE indent.tenant_id = $1::uuid
          AND indent.id = $2::int`,
      tenantId,
      indentId,
      `ward-indent:${indentId}:v5`,
    );
    expect(finalStateOwnership).toHaveLength(1);
    expect(finalStateOwnership[0]).toMatchObject({
      status: 'closed',
      state_version: 8,
      active_sla_source_id: null,
      task_status: 'completed',
      sla_status: 'completed',
    });
    expect(finalStateOwnership[0].task_completed_at).not.toBeNull();
    expect(finalStateOwnership[0].sla_completed_at).not.toBeNull();
    expect(finalStateOwnership[0].sla_metadata).toMatchObject({
      completed_via: 'domain_evidence',
      completion_evidence: {
        kind: 'ward_indent_transition',
        resource_type: 'ward_indent_event',
      },
    });
  }, 60_000);
});
