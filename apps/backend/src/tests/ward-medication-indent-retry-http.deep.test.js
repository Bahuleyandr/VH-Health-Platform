import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { jest } from '@jest/globals';
import request from 'supertest';

const actualPrisma = await import('../lib/prisma.js');
const prisma = actualPrisma.default;
let transactionFault = null;
const assertRuntimeRole = process.env.WARD_MEDICATION_ASSERT_RUNTIME_ROLE === '1';
const runtimeRoleEvidence = [];

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrisma,
  setTenantTx: (tenantId, fn, options) => {
    const observed = async (tx) => {
      if (assertRuntimeRole) {
        const evidence = await tx.$queryRawUnsafe(
          `SELECT current_user::text AS database_role,
                  current_setting('app.current_tenant_id', true) AS tenant_id,
                  rolsuper, rolbypassrls,
                  pg_catalog.row_security_active('ward_indents'::regclass) AS indent_rls,
                  pg_catalog.row_security_active('medication_administrations'::regclass) AS mar_rls
             FROM pg_roles WHERE rolname = current_user`,
        );
        expect(evidence).toEqual([{
          database_role: 'vhhealth_app', tenant_id: tenantId,
          rolsuper: false, rolbypassrls: false, indent_rls: true, mar_rls: true,
        }]);
        runtimeRoleEvidence.push(evidence[0]);
      }
      return fn(tx);
    };
    return transactionFault?.tenantId === tenantId
      ? transactionFault.run(observed, options)
      : actualPrisma.setTenantTx(tenantId, observed, options);
  },
}));

const { default: app } = await import('../app.js');
const { API_KEY, generateTestToken } = await import('./testClient.js');
const { seedMedicationFacilityAuthority } = await import('./helpers/medicationEvidenceFixture.js');
const { teardownTenantFixture } = await import('./helpers/tenantTeardown.js');
const { waitForAuditLogDrain } = await import('../middleware/auditLog.js');
const { bindMedicationOrderCatalogAuthority } = await import('../services/ipd/wardIndentWorkflowService.js');

jest.setTimeout(60_000);
const wardBase = '/api/v1/pharmacy-orders/ward-indents';
const orderBase = '/api/v1/emr/orders';
const tenants = [];
const stateTables = [
  'clinical_orders', 'pharmacy_catalog', 'pharmacy_inventory_batches',
  'pharmacy_stock_movements', 'ward_indents', 'ward_indent_items',
  'ward_indent_events', 'ward_indent_inventory_allocations',
  'ward_indent_inventory_movement_links', 'ward_indent_inventory_receipt_events',
  'ward_indent_financial_events', 'billing_invoices', 'billing_invoice_items',
  'medication_administrations', 'mar_supply_consumptions',
  'mar_administration_command_receipts', 'clinical_timeline_events',
  'tasks', 'workflow_sla_instances', 'notification_outbox',
];

function http(owner, actor, method, path, body, key = randomUUID()) {
  const user = owner.actors[actor];
  const token = generateTestToken(user.role, {
    uid: user.uid, id: Number(user.id), tenant_id: owner.id, deviceType: 'desktop',
  });
  const call = request(app)[method](path)
    .set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
  if (method !== 'get') call.set('Idempotency-Key', key);
  return body === undefined ? call : call.send(body);
}

async function rows(owner, table, db = prisma) {
  const predicate = table === 'clinical_audit_events' ? " AND action_status = 'success'" : '';
  const result = await db.$queryRawUnsafe(
    `SELECT COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY entry.id), '[]'::jsonb) AS rows
       FROM ${table} entry WHERE tenant_id = $1::uuid${predicate}`, owner.id,
  );
  return result[0].rows;
}

async function snapshot(owner, db = prisma) {
  const state = {};
  for (const table of [...stateTables, 'clinical_audit_events']) state[table] = await rows(owner, table, db);
  expect(state.pharmacy_catalog.length).toBeGreaterThan(0);
  expect(state.pharmacy_inventory_batches.length).toBeGreaterThan(0);
  return state;
}

async function assertIndentEvidence(c, action, status, version, actor) {
  const tables = ['ward_indent_events', 'clinical_timeline_events', 'clinical_audit_events',
    'tasks', 'workflow_sla_instances', 'notification_outbox'];
  const [events, timeline, audit, tasks, clocks, outbox] = await Promise.all(
    tables.map((table) => rows(c.owner, table)),
  );
  const subject = {
    tenant_id: c.owner.id, patient_uid: c.body.patient_uid ?? null,
    encounter_id: c.body.encounter_id ?? null,
  };
  const actorUid = c.owner.actors[actor].uid;
  expect(events.filter((event) => event.ward_indent_id === c.indentId && event.state_version === version))
    .toEqual([expect.objectContaining({
      tenant_id: c.owner.id, action, to_status: status, actor_uid: actorUid,
    })]);
  const canonicalTimeline = timeline.filter((event) => event.source_table === 'ward_indents'
    && event.source_id === String(c.indentId) && event.payload?.state_version === version);
  const canonicalAudit = audit.filter((event) => event.resource_table === 'ward_indents'
    && event.resource_id === String(c.indentId) && event.after_state?.state_version === version);
  if (subject.patient_uid) {
    expect(canonicalTimeline).toEqual([expect.objectContaining({
      ...subject, event_type: `ward_indent.${action}`, event_status: status,
      actor_uid: actorUid, visible_to_patient: false, resource_type: 'ward_indent',
      resource_id: String(c.indentId),
      idempotency_key: `ward_indents:${c.indentId}:transition:${version}`,
      payload: expect.objectContaining({
        ward_indent_id: c.indentId, admission_id: c.admissionId, ward_id: c.owner.wardId,
        state_version: version, item_count: 1,
      }),
    })]);
    expect(canonicalAudit).toEqual([expect.objectContaining({
      ...subject, action: `ward_indent.${action}`, action_status: 'success',
      actor_uid: actorUid, resource_type: 'ward_indent',
      idempotency_key: `ward_indents:${c.indentId}:audit:transition:${version}`,
      after_state: expect.objectContaining({ status, state_version: version }),
    })]);
  } else {
    expect(canonicalTimeline).toEqual([]);
    expect(canonicalAudit).toEqual([]);
  }

  const [rule, kind, recipients] = {
    requested: ['ward_indent_pharmacy_response', 'ward_indent_request', ['pharmacist']],
    reserved: ['ward_indent_pharmacy_response', 'ward_indent_reserved', ['pharmacist']],
    approved: ['ward_indent_pharmacy_issue', 'ward_indent_approved', ['pharmacist']],
    issued: ['ward_indent_ward_receipt', 'ward_indent_issued', ['nurse']],
    partially_received: ['ward_indent_ward_receipt', 'ward_indent_partial_receipt', ['nurse']],
    received: ['ward_indent_reconciliation', 'ward_indent_received', ['pharmacist', 'nurse']],
  }[status];
  const currentTasks = tasks.filter((task) => task.metadata?.ward_indent_id === c.indentId
    && task.metadata?.obligation_kind === 'ward_indent_state' && task.metadata?.state_version === version);
  expect(currentTasks).toEqual([expect.objectContaining({
    ...subject, encounter_id: null, status: 'open', sla_completion_semantics: 'domain_evidence',
    related_resource_type: 'ward_indents',
    metadata: expect.objectContaining({
      task_contract: 'ward_medication_obligation_v1', current_state: status, state_version: version,
      ...(subject.encounter_id ? { canonical_encounter_id: subject.encounter_id } : {}),
    }),
  })]);
  const task = currentTasks[0];
  expect(clocks.filter((clock) => clock.id === task.workflow_sla_instance_id))
    .toEqual([expect.objectContaining({
      ...subject, rule_code: rule, status: 'active', source_table: 'ward_indents',
      source_id: task.related_resource_id,
    })]);
  const notifications = outbox.filter((entry) => entry.payload?.ward_indent_id === c.indentId
    && entry.payload?.state_version === version);
  expect(notifications).toHaveLength(recipients.length);
  expect(notifications.map((entry) => entry.recipient_id).sort())
    .toEqual(recipients.map((name) => String(c.owner.actors[name].id)).sort());
  for (const notification of notifications) {
    expect(notification).toMatchObject({
      tenant_id: c.owner.id, type: kind, channel: 'inapp', status: 'PENDING',
      source_event_key: `ward-indent:${c.indentId}:v${version}:${kind}`,
      payload: { ward_indent_id: c.indentId, state: status, state_version: version, task_id: task.id },
    });
  }
}

async function settledClaim(owner, actor, key, expectedStatus) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const claims = await prisma.$queryRawUnsafe(
      `SELECT status, response_status FROM idempotency_keys
        WHERE tenant_id = $1::uuid AND user_uid = $2::uuid AND request_key = $3::text`,
      owner.id, owner.actors[actor].uid, key,
    );
    if (expectedStatus === null && claims.length === 0) return;
    if (claims.length === 1 && claims[0].status !== 'in_flight') {
      expect(claims[0].response_status).toBe(expectedStatus);
      return;
    }
    await delay(20);
  }
  throw new Error(`Idempotency claim did not settle: ${key}`);
}

async function seedTenant() {
  const owner = { id: randomUUID(), actors: {} };
  tenants.push(owner);
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
     VALUES ($1::uuid, $2::text, 'Synthetic ward regression', 'IN', 'active', NOW(), NOW())`,
    owner.id, `ward-regression-${owner.id}`,
  );
  for (const [name, role] of Object.entries({
    doctor: 'DOCTOR', pharmacist: 'PHARMACY_INCHARGE', nurse: 'NURSING_INCHARGE', admin: 'ADMIN',
  })) {
    const [actor] = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, uid, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, TRUE, 'active', NOW()) RETURNING id, uid, role`,
      owner.id, randomUUID(), `Synthetic ${name}`, role,
    );
    owner.actors[name] = actor;
  }
  Object.assign(owner, await seedMedicationFacilityAuthority({
    prisma, tenantId: owner.id, pharmacistUid: owner.actors.pharmacist.uid,
    grantAdminUid: owner.actors.admin.uid, run: owner.id,
  }));
  const [ward] = await prisma.$queryRawUnsafe(
    `INSERT INTO wards (tenant_id, name, facility_id, total_beds, created_at, updated_at)
     VALUES ($1::uuid, $2::text, $3::int, 12, NOW(), NOW()) RETURNING id`,
    owner.id, `Synthetic ward ${owner.id}`, owner.facilityId,
  );
  owner.wardId = Number(ward.id);
  const [composition] = await prisma.$queryRawUnsafe(
    `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
     VALUES ($1::text, 'Synthetic paracetamol', ARRAY['paracetamol']::text[], 'curated') RETURNING id`,
    `ward-regression-${owner.id}`,
  );
  owner.compositionId = Number(composition.id);
  return owner;
}

async function seedCase(owner, { governed = false, consumable = false } = {}) {
  const c = { owner, barcode: `WR-${randomUUID()}`, patientUid: randomUUID() };
  const [patient] = await prisma.$queryRawUnsafe(
    `INSERT INTO users (tenant_id, uid, name, role, is_active, status, updated_at)
     VALUES ($1::uuid, $2::uuid, 'Synthetic patient', 'PATIENT', TRUE, 'active', NOW()) RETURNING id`,
    owner.id, c.patientUid,
  );
  expect(Number(patient.id)).toBeGreaterThan(0);
  const bedNumber = randomUUID().slice(0, 20);
  const [bed] = await prisma.$queryRawUnsafe(
    `INSERT INTO beds (tenant_id, ward_id, ward_name, bed_number, status, patient_uid, created_at, updated_at)
     VALUES ($1::uuid, $2::int, $3::text, $4::text, 'occupied', $5::uuid, NOW(), NOW()) RETURNING id`,
    owner.id, owner.wardId, `Synthetic ward ${owner.id}`, bedNumber, c.patientUid,
  );
  const [admission] = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, bed_id, status, admitted_at, ward, bed_number,
                            created_by, attending_doctor, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::int, 'admitted', NOW(), $4::text, $5::text,
             $6::uuid, $7::uuid, NOW(), NOW()) RETURNING id, encounter_id`,
    owner.id, c.patientUid, Number(bed.id), `Synthetic ward ${owner.id}`, bedNumber,
    owner.actors.nurse.uid, owner.actors.doctor.uid,
  );
  c.admissionId = Number(admission.id);
  c.encounterId = String(admission.encounter_id);
  const [catalog] = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_catalog
       (tenant_id, name, generic_name, category, requires_prescription, is_active, stock_quantity,
        unit_price, price, composition_id, composition_confidence, composition_source, strength,
        strength_key, strength_components, form, form_key, release_key, route, updated_at)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, FALSE, TRUE, 20, 12.50, 12.50,
             $5::int, 'high', 'test_fixture', $6::text, $7::text, $8::jsonb,
             $9::text, $9::text, $10::text, $11::text, NOW()) RETURNING *`,
    owner.id, `Synthetic product ${c.barcode}`, consumable ? null : 'Paracetamol',
    consumable ? 'ward_supply' : 'medicine', consumable ? null : owner.compositionId,
    consumable ? null : '500 mg', consumable ? null : '500mg',
    JSON.stringify(consumable ? [] : [{ ingredient: 'paracetamol', value: '500', unit: 'mg' }]),
    consumable ? null : 'tablet', consumable ? null : 'ir', consumable ? null : 'oral',
  );
  c.catalogId = Number(catalog.id);
  const [item] = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, sku_code, display_name, catalog_id, strength, form, unit_label,
        schedule_class, is_narcotic, status, facility_id)
     VALUES ($1::uuid, $2::text, $2::text, $3::int, $4::text, $5::text, $6::text,
             $8::text, FALSE, 'active', $7::int) RETURNING id`,
    owner.id, c.barcode, c.catalogId, consumable ? null : '500 mg',
    consumable ? null : 'tablet', consumable ? 'each' : 'tablet', owner.facilityId,
    consumable ? null : 'OTC',
  );
  const [batch] = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_batches
       (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity,
        remaining_quantity, status, facility_id, storage_location_id)
     VALUES ($1::uuid, $2::int, $3::text, (NOW() + INTERVAL '365 days')::date,
             20, 20, 'in_stock', $4::int, $5::int) RETURNING id`,
    owner.id, Number(item.id), c.barcode, owner.facilityId, owner.storageLocationId,
  );
  c.batchId = Number(batch.id);
  const details = {
    catalog_id: c.catalogId, dose: '500 mg', route: 'oral', frequency: 'BD', duration_days: 1,
    quantity_requested: 2, unit: 'tablet', supply_quantity_per_dose: 1,
  };
  if (!consumable && governed) {
    const response = await http(owner, 'doctor', 'post', orderBase, {
      patient_uid: c.patientUid, encounter_id: c.encounterId, order_type: 'medication',
      priority: 'routine', start_date: new Date().toISOString(), details,
    });
    expect(response.status).toBe(201);
    c.orderId = Number(response.body.data.order.id);
    const linked = await prisma.$queryRawUnsafe(
      `SELECT ward_indent_id, id FROM ward_indent_items
        WHERE tenant_id = $1::uuid AND clinical_order_id = $2::int`, owner.id, c.orderId,
    );
    expect(linked).toHaveLength(1);
    c.indentId = Number(linked[0].ward_indent_id);
    c.indentItemId = Number(linked[0].id);
    const doses = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM medication_administrations
        WHERE tenant_id = $1::uuid AND clinical_order_id = $2::int ORDER BY scheduled_time, id`,
      owner.id, c.orderId,
    );
    expect(doses).toHaveLength(2);
    expect(doses.map((dose) => dose.status)).toEqual(['scheduled', 'scheduled']);
    c.doseIds = doses.map((dose) => Number(dose.id));
  } else if (!consumable) {
    const [order] = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, encounter_id, patient_uid, order_type, status, ordered_by, details, route, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'medication', 'ordered', $5::uuid, $6::jsonb, 'oral', NOW()) RETURNING id`,
      owner.id, c.barcode, c.encounterId, c.patientUid, owner.actors.doctor.uid,
      JSON.stringify(bindMedicationOrderCatalogAuthority(details, catalog, { phase: 'create' })),
    );
    c.orderId = Number(order.id);
  }
  c.body = {
    ward_id: owner.wardId, indent_type: consumable ? 'consumables' : 'pharmacy',
    ...(consumable ? {} : { patient_uid: c.patientUid, admission_id: c.admissionId, encounter_id: c.encounterId }),
    items: [{ pharmacy_catalog_id: c.catalogId, quantity_requested: 2, unit: consumable ? 'each' : 'tablet',
      ...(consumable ? {} : { clinical_order_id: c.orderId }) }],
  };
  if (governed && !consumable) await assertIndentEvidence(c, 'requested', 'requested', 1, 'doctor');
  return c;
}

async function createIndent(c, key = randomUUID()) {
  const response = await http(c.owner, 'nurse', 'post', wardBase, c.body, key);
  expect(response.status).toBe(201);
  expect(response.body.data).toMatchObject({ status: 'requested', state_version: 1 });
  expect(response.body.data.items).toHaveLength(1);
  c.indentId = Number(response.body.data.id);
  c.indentItemId = Number(response.body.data.items[0].id);
  await assertIndentEvidence(c, 'requested', 'requested', 1, 'nurse');
  return response;
}

async function transition(c, action, version, status, extra = {}, actor = 'pharmacist') {
  const response = await http(c.owner, actor, 'post', `${wardBase}/${c.indentId}/${action}`,
    { expected_version: version, ...extra });
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ id: c.indentId, status, state_version: version + 1 });
  const eventAction = { reserve: 'reserved', approve: 'approved', issue: 'issued', receive: 'receipt_recorded' }[action];
  await assertIndentEvidence(c, eventAction, status, version + 1, actor);
  return response;
}

beforeAll(() => {
  // The coordinator supplies the existing database slot; never silently use Jest's localhost fallback.
  expect(process.env.TEST_DATABASE_URL).toBeTruthy();
  expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
});

afterAll(async () => {
  transactionFault = null;
  await waitForAuditLogDrain();
  for (const owner of tenants) {
    await teardownTenantFixture(prisma, {
      tenantIds: [owner.id],
      evidence: async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of [
          ...stateTables, 'clinical_audit_events', 'idempotency_keys',
          'mar_transition_command_receipts', 'mar_supply_reconciliation_links',
          'medication_safety_reviews', 'task_comments', 'pharmacy_schedule_register',
          'pharmacy_staff_facility_grant_events', 'pharmacy_staff_facility_grants',
          'pharmacy_inventory_items', 'care_team_member_status_history', 'care_team_members',
          'care_team_status_history', 'care_teams', 'admissions', 'beds', 'wards',
          'staff', 'facility_locations', 'facilities', 'audit_logs',
        ]) {
          await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, owner.id);
        }
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'origin'`);
        await tx.$executeRawUnsafe(`DELETE FROM hipaa_access_log WHERE tenant_id = $1::uuid`, owner.id);
        await tx.$executeRawUnsafe(`DELETE FROM audit_log WHERE tenant_id = $1::uuid`, owner.id);
        await tx.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key = $1::text`,
          `ward-regression-${owner.id}`);
      },
    });
  }
  await prisma.$disconnect();
  if (assertRuntimeRole) {
    for (const owner of tenants) {
      const observations = runtimeRoleEvidence.filter((entry) => entry.tenant_id === owner.id);
      expect(observations.length).toBeGreaterThan(0);
      process.stdout.write(`Ward medication runtime role evidence: ${JSON.stringify({
        ...observations[0], observed_transactions: observations.length,
      })}\n`);
    }
  }
}, 120_000);

describe('ward medication indent HTTP isolation and command recovery', () => {
  let owner;
  let neighbour;
  beforeAll(async () => {
    owner = await seedTenant();
    neighbour = await seedTenant();
  });

  test('keeps populated tenants isolated and rejects a live prescriber at the pharmacy custody boundary', async () => {
    const c = await seedCase(owner);
    const other = await seedCase(neighbour);
    await createIndent(c);
    await createIndent(other);
    for (const candidate of [c, other]) {
      const own = await http(candidate.owner, 'nurse', 'get', `${wardBase}/${candidate.indentId}`);
      expect(own.status).toBe(200);
      expect(own.body.data.id).toBe(candidate.indentId);
    }
    const before = await snapshot(owner);
    const otherBefore = await snapshot(neighbour);
    expect(before.ward_indents).toHaveLength(1);
    expect(otherBefore.ward_indents).toHaveLength(1);
    expect((await http(neighbour, 'nurse', 'get', `${wardBase}/${c.indentId}`)).status).toBe(404);
    expect((await http(neighbour, 'pharmacist', 'post', `${wardBase}/${c.indentId}/reserve`, { expected_version: 1 })).status).toBe(404);
    expect((await http(owner, 'doctor', 'post', `${wardBase}/${c.indentId}/reserve`, { expected_version: 1 })).status).toBe(403);
    expect(await snapshot(owner)).toEqual(before);
    expect(await snapshot(neighbour)).toEqual(otherBefore);
    await transition(c, 'reserve', 1, 'reserved');
    await transition(other, 'reserve', 1, 'reserved');
  });

  test('replays creation across aliases and refuses changed payloads or a second clinical-order link', async () => {
    const c = await seedCase(owner);
    const key = randomUUID();
    const created = await createIndent(c, key);
    await settledClaim(owner, 'nurse', key, 201);
    const before = await snapshot(owner);
    for (const alias of ['/api/v1/pharmacy/ward-indents', '/api/v1/ipd/ward-indents']) {
      const replay = await http(owner, 'nurse', 'post', alias, c.body, key);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(created.body);
    }
    const changed = await http(owner, 'nurse', 'post', wardBase,
      { ...c.body, items: [{ ...c.body.items[0], quantity_requested: 3 }] }, key);
    expect(changed.status).toBe(422);
    const duplicate = await http(owner, 'nurse', 'post', wardBase, c.body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED');
    expect(await snapshot(owner)).toEqual(before);
    expect(before.ward_indent_items.filter((item) => item.clinical_order_id === c.orderId)).toHaveLength(1);
    expect(before.ward_indent_events.filter((event) => event.ward_indent_id === c.indentId)).toHaveLength(1);
  });

  test('retains a stale command outcome and recovers using authoritative state and a new key', async () => {
    const c = await seedCase(owner);
    await createIndent(c);
    await transition(c, 'reserve', 1, 'reserved');
    const before = await snapshot(owner);
    const key = randomUUID();
    const stale = await http(owner, 'pharmacist', 'post', `${wardBase}/${c.indentId}/approve`, { expected_version: 1 }, key);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('WARD_INDENT_VERSION_CONFLICT');
    await settledClaim(owner, 'pharmacist', key, 409);
    expect(await snapshot(owner)).toEqual(before);
    const readback = await http(owner, 'pharmacist', 'get', `${wardBase}/${c.indentId}`);
    expect(readback.status).toBe(200);
    expect(readback.body.data).toMatchObject({ status: 'reserved', state_version: 2 });
    await transition(c, 'approve', readback.body.data.state_version, 'approved');
    const after = await snapshot(owner);
    const replay = await http(owner, 'pharmacist', 'post', `${wardBase}/${c.indentId}/approve`, { expected_version: 1 }, key);
    expect(replay.status).toBe(409);
    expect(replay.body).toEqual(stale.body);
    expect(await snapshot(owner)).toEqual(after);
  });

  test('retains a post-commit 500 without reissuing stock or charging twice, then permits receipt after readback', async () => {
    const c = await seedCase(owner);
    await createIndent(c);
    expect((await http(owner, 'pharmacist', 'put', `${orderBase}/${c.orderId}/verify`, {})).status).toBe(200);
    await transition(c, 'reserve', 1, 'reserved');
    await transition(c, 'approve', 2, 'approved');
    const key = randomUUID();
    let injected = 0;
    transactionFault = { tenantId: owner.id, run: async (fn, options) => {
      const result = await actualPrisma.setTenantTx(owner.id, fn, options);
      if (!injected && Number(result?.id) === c.indentId && result?.status === 'issued') {
        injected += 1;
        throw new Error('Synthetic response failure after committed ward issue');
      }
      return result;
    } };
    let failed;
    try {
      failed = await http(owner, 'pharmacist', 'post', `${wardBase}/${c.indentId}/issue`, { expected_version: 3 }, key);
    } finally {
      transactionFault = null;
    }
    expect(injected).toBe(1);
    expect(failed.status).toBe(500);
    await settledClaim(owner, 'pharmacist', key, 500);
    await assertIndentEvidence(c, 'issued', 'issued', 4, 'pharmacist');
    const after = await snapshot(owner);
    expect(after.ward_indent_financial_events.filter((event) => event.ward_indent_id === c.indentId))
      .toEqual([expect.objectContaining({
        clinical_order_id: c.orderId, event_kind: 'charge', quantity: 2,
        unit_price_minor: 1250, amount_minor: 2500,
      })]);
    expect(after.ward_indent_inventory_movement_links.filter((link) => link.ward_indent_id === c.indentId))
      .toEqual([expect.objectContaining({ movement_purpose: 'issue', quantity: 2 })]);
    expect(after.ward_indent_inventory_allocations.filter((allocation) => allocation.ward_indent_id === c.indentId))
      .toEqual([expect.objectContaining({ issued_quantity: 2, received_quantity: 0 })]);
    expect(after.pharmacy_inventory_batches.find((batch) => batch.id === c.batchId).remaining_quantity).toBe(18);
    const replay = await http(owner, 'pharmacist', 'post', `/api/v1/pharmacy/ward-indents/${c.indentId}/issue`, { expected_version: 3 }, key);
    expect(replay.status).toBe(500);
    expect(replay.body).toEqual(failed.body);
    expect(await snapshot(owner)).toEqual(after);
    const readback = await http(owner, 'nurse', 'get', `${wardBase}/${c.indentId}`);
    expect(readback.status).toBe(200);
    expect(readback.body.data).toMatchObject({ status: 'issued', state_version: 4 });
    await transition(c, 'receive', 4, 'received', {
      item_quantities_received: [{ item_id: c.indentItemId, quantity_received: 2 }],
    }, 'nurse');
    const received = await snapshot(owner);
    for (const table of ['pharmacy_catalog', 'pharmacy_inventory_batches', 'pharmacy_stock_movements',
      'ward_indent_inventory_movement_links', 'ward_indent_financial_events', 'billing_invoices',
      'billing_invoice_items', 'medication_administrations', 'mar_supply_consumptions']) {
      expect(received[table]).toEqual(after[table]);
    }
    expect(received.pharmacy_inventory_batches.find((batch) => batch.id === c.batchId).remaining_quantity).toBe(18);
    expect(received.pharmacy_catalog.find((catalog) => catalog.id === c.catalogId).stock_quantity).toBe(18);
    expect(received.ward_indent_inventory_allocations.filter((allocation) => allocation.ward_indent_id === c.indentId))
      .toEqual([expect.objectContaining({
        status: 'issued', reserved_quantity: 2, issued_quantity: 2, received_quantity: 2,
        consumed_quantity: 0, returned_quantity: 0,
      })]);
    expect(received.ward_indent_inventory_receipt_events.filter((event) => event.ward_indent_id === c.indentId))
      .toEqual([expect.objectContaining({
        tenant_id: owner.id, ward_indent_item_id: c.indentItemId, inventory_batch_id: c.batchId,
        ward_indent_state_version: 5, quantity_delta: 2, received_by: owner.actors.nurse.uid,
      })]);
    const charges = received.ward_indent_financial_events.filter((event) => event.ward_indent_id === c.indentId);
    expect(charges).toEqual([expect.objectContaining({ event_kind: 'charge', quantity: 2, amount_minor: 2500 })]);
    expect(received.billing_invoices.filter((invoice) => invoice.id === charges[0].invoice_id)).toHaveLength(1);
    expect(received.billing_invoice_items.filter((line) => line.id === charges[0].invoice_item_id))
      .toEqual([expect.objectContaining({ source_ref_type: 'ward_indent_item' })]);
    const history = received.ward_indent_events.filter((event) => event.ward_indent_id === c.indentId)
      .sort((a, b) => a.state_version - b.state_version);
    expect(history.map((event) => [event.state_version, event.action, event.to_status])).toEqual([
      [1, 'requested', 'requested'], [2, 'reserved', 'reserved'], [3, 'approved', 'approved'],
      [4, 'issued', 'issued'], [5, 'receipt_recorded', 'received'],
    ]);
    expect(received.clinical_timeline_events.filter((event) => event.source_table === 'ward_indents'
      && event.source_id === String(c.indentId))).toHaveLength(5);
    expect(received.clinical_audit_events.filter((event) => event.resource_table === 'ward_indents'
      && event.resource_id === String(c.indentId))).toHaveLength(5);
    const tasks = received.tasks.filter((task) => task.metadata?.ward_indent_id === c.indentId
      && task.metadata?.obligation_kind === 'ward_indent_state');
    expect(tasks).toHaveLength(4);
    const clocks = received.workflow_sla_instances.filter((clock) => clock.source_table === 'ward_indents'
      && clock.metadata?.ward_indent_id === c.indentId).sort((a, b) => a.source_id.localeCompare(b.source_id));
    expect(clocks.map((clock) => {
      const task = tasks.find((entry) => entry.workflow_sla_instance_id === clock.id);
      expect(task).toBeDefined();
      return [clock.source_id, clock.rule_code, clock.status, task.status, task.metadata.current_state];
    })).toEqual([
      [`ward-indent:${c.indentId}:v1`, 'ward_indent_pharmacy_response', 'completed', 'completed', 'reserved'],
      [`ward-indent:${c.indentId}:v3`, 'ward_indent_pharmacy_issue', 'completed', 'completed', 'approved'],
      [`ward-indent:${c.indentId}:v4`, 'ward_indent_ward_receipt', 'completed', 'completed', 'issued'],
      [`ward-indent:${c.indentId}:v5`, 'ward_indent_reconciliation', 'active', 'open', 'received'],
    ]);
    const notifications = received.notification_outbox.filter((entry) => entry.payload?.ward_indent_id === c.indentId);
    expect(notifications.map((entry) => `${entry.source_event_key}:${entry.recipient_id}`).sort()).toEqual([
      `ward-indent:${c.indentId}:v1:ward_indent_request:${owner.actors.pharmacist.id}`,
      `ward-indent:${c.indentId}:v2:ward_indent_reserved:${owner.actors.pharmacist.id}`,
      `ward-indent:${c.indentId}:v3:ward_indent_approved:${owner.actors.pharmacist.id}`,
      `ward-indent:${c.indentId}:v4:ward_indent_issued:${owner.actors.nurse.id}`,
      `ward-indent:${c.indentId}:v5:ward_indent_received:${owner.actors.pharmacist.id}`,
      `ward-indent:${c.indentId}:v5:ward_indent_received:${owner.actors.nurse.id}`,
    ].sort());
  });

  test('keeps patientless consumables separate from the clinical-order and MAR workflow', async () => {
    const medication = await seedCase(owner, { governed: true });
    const c = await seedCase(owner, { consumable: true });
    const before = await snapshot(owner);
    expect(before.medication_administrations.filter((dose) => dose.clinical_order_id === medication.orderId)).toHaveLength(2);
    await createIndent(c);
    await transition(c, 'reserve', 1, 'reserved');
    await transition(c, 'approve', 2, 'approved');
    const after = await snapshot(owner);
    expect(after.ward_indents.find((indent) => indent.id === c.indentId))
      .toMatchObject({ patient_uid: null, admission_id: null, encounter_id: null, indent_type: 'consumables' });
    expect(after.ward_indent_items.filter((item) => item.ward_indent_id === c.indentId))
      .toEqual([expect.objectContaining({ clinical_order_id: null })]);
    expect(after.clinical_orders).toEqual(before.clinical_orders);
    expect(after.medication_administrations).toEqual(before.medication_administrations);
    expect(after.mar_supply_consumptions).toEqual(before.mar_supply_consumptions);
    expect(after.ward_indent_financial_events).toEqual(before.ward_indent_financial_events);
  });
});
