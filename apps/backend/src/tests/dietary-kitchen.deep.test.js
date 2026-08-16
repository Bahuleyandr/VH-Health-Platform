// Deep tests for kitchen management on top of diet orders (migration 685):
// menu master CRUD + live-name uniqueness, meal-ticket generation correctness
// (admitted-only, npo/discharged/inactive exclusion, allergen-aware menu
// matching, idempotency + live uniqueness), same-day re-sync on diet-order
// change, lifecycle transition validation with wrong-role rejection, the
// canonical timeline/audit pair on delivery, and the production summary.
import prisma from '../lib/prisma.js';
import {
  createMenuItem, updateMenuItem, listMenuItems,
  generateMealTickets, syncTicketsForOrder,
  listMealTickets, getProductionSummary, transitionTicket,
  MEAL_TYPES,
} from '../services/dietary/kitchenService.js';
import { istDateString } from '../utils/dateUtils.js';

const TENANT = '00000000-0000-4000-8000-0000d1e70001';
const OTHER = '00000000-0000-4000-8000-0000d1e70099';

const P_ADMITTED = 'd1e71111-1111-4111-8111-111111111111'; // active diabetic order, peanut allergy
const P_DISCHARGED = 'd1e72222-2222-4222-8222-222222222222'; // active order, but discharged
const P_NPO = 'd1e73333-3333-4333-8333-333333333333'; // admitted, npo order
const P_ONHOLD = 'd1e74444-4444-4444-8444-444444444444'; // admitted, on_hold order
const P_FOREIGN = 'd1e75555-5555-4555-8555-555555555555'; // other tenant, admitted + active

const DIETITIAN_ACTOR = { uid: 'd1e7aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'DIETITIAN' };
const KITCHEN_ACTOR = { uid: 'd1e7bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'DIETARY_STAFF' };
const NURSE_ACTOR = { uid: 'd1e7cccc-cccc-4ccc-8ccc-cccccccccccc', role: 'NURSING_STAFF' };

let orderAdmitted; let orderNpo;
const TODAY = istDateString();

async function insertDietOrder(tenant, patientUid, {
  dietType = 'regular', status = 'active', allergies = [], restrictions = [],
  special = null,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO diet_orders
       (tenant_id, patient_uid, diet_type, restrictions, allergies, special_instructions,
        status, ordered_by)
     VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5::text[], $6, $7, $8::uuid)
     RETURNING id`,
    tenant, patientUid, dietType, restrictions, allergies, special, status, DIETITIAN_ACTOR.uid,
  );
  return Number(rows[0].id);
}

async function insertAdmission(tenant, patientUid, {
  status = 'admitted', ward = 'Ward A', bed = 'A-101', dischargedAt = null,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, status, ward, bed_number, allergies,
                             admitted_at, discharged_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, '{}'::text[], NOW() - interval '1 day',
             ${dischargedAt ? 'NOW()' : 'NULL'})
     RETURNING id`,
    tenant, patientUid, status, ward, bed,
  );
  return Number(rows[0].id);
}

async function ticketsFor(orderId) {
  return prisma.$queryRawUnsafe(
    `SELECT id::text AS id, meal_type, status, diet_type, ward, bed_number, patient_name,
            allergies, menu_selections, diet_spec, service_date::text AS service_date
       FROM dietary_meal_tickets
      WHERE diet_order_id = $1::int
      ORDER BY array_position(ARRAY['breakfast','lunch','dinner','snack']::text[], meal_type), id`,
    orderId,
  );
}

async function cleanup() {
  const patients = [P_ADMITTED, P_DISCHARGED, P_NPO, P_ONHOLD, P_FOREIGN];
  for (const tid of [TENANT, OTHER]) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM dietary_meal_tickets WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM dietary_menu_items WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM diet_orders WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE tenant_id = $1::uuid AND patient_uid = ANY($2::uuid[])`,
      tid, patients,
    ).catch(() => {});
  }
  for (const uid of patients) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, uid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, uid,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`, patients,
  ).catch(() => {});
}

beforeAll(async () => {
  await cleanup();
  for (const [tid, slug] of [[TENANT, 'kitchen-test'], [OTHER, 'kitchen-other']]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2, 'Kitchen Test', 'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      tid, slug,
    );
  }
  const seedPatient = async (uid, name, phone, tenant) => prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, name, phone, role, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, 'PATIENT', $4::uuid, NOW())
     ON CONFLICT (uid) DO NOTHING`,
    uid, name, phone, tenant,
  );
  await seedPatient(P_ADMITTED, 'Kitchen Admitted', '9821000001', TENANT);
  await seedPatient(P_DISCHARGED, 'Kitchen Discharged', '9821000002', TENANT);
  await seedPatient(P_NPO, 'Kitchen NPO', '9821000003', TENANT);
  await seedPatient(P_ONHOLD, 'Kitchen OnHold', '9821000004', TENANT);
  await seedPatient(P_FOREIGN, 'Kitchen Foreign', '9821000005', OTHER);

  await insertAdmission(TENANT, P_ADMITTED, { ward: 'Ward A', bed: 'A-101' });
  await insertAdmission(TENANT, P_DISCHARGED, { status: 'discharged', dischargedAt: true });
  await insertAdmission(TENANT, P_NPO, { ward: 'Ward B', bed: 'B-201' });
  await insertAdmission(TENANT, P_ONHOLD, { ward: 'Ward B', bed: 'B-202' });
  await insertAdmission(OTHER, P_FOREIGN, { ward: 'Ward X', bed: 'X-1' });

  orderAdmitted = await insertDietOrder(TENANT, P_ADMITTED, {
    dietType: 'diabetic', allergies: ['Peanut'], restrictions: ['low sugar'],
    special: 'small portions',
  });
  await insertDietOrder(TENANT, P_DISCHARGED, { dietType: 'regular' });
  orderNpo = await insertDietOrder(TENANT, P_NPO, { dietType: 'npo' });
  await insertDietOrder(TENANT, P_ONHOLD, { dietType: 'regular', status: 'on_hold' });
  await insertDietOrder(OTHER, P_FOREIGN, { dietType: 'regular' });
});

afterAll(async () => {
  await cleanup();
  if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
});

describe('menu master', () => {
  test('creates, lists, and validates menu items', async () => {
    const safe = await createMenuItem({
      tenant_id: TENANT, name: 'Ragi Porridge', meal_type: 'breakfast',
      diet_types: ['diabetic', 'regular'], is_veg: true,
      allergen_tags: ['Milk'], created_by: DIETITIAN_ACTOR.uid,
    });
    expect(safe.meal_type).toBe('breakfast');
    expect(safe.allergen_tags).toEqual(['milk']); // normalized lower-case
    expect(safe.active).toBe(true);

    await createMenuItem({
      tenant_id: TENANT, name: 'Peanut Chikki Oats', meal_type: 'breakfast',
      diet_types: ['diabetic'], allergen_tags: ['peanut'],
    });
    await createMenuItem({
      tenant_id: TENANT, name: 'Plain Rice Meal', meal_type: 'lunch',
      diet_types: ['regular'],
    });

    const all = await listMenuItems({ tenantId: TENANT });
    expect(all.length).toBe(3);
    const breakfastOnly = await listMenuItems({ tenantId: TENANT, meal_type: 'breakfast' });
    expect(breakfastOnly.length).toBe(2);

    await expect(createMenuItem({
      tenant_id: TENANT, name: 'Astronaut Paste', meal_type: 'breakfast', diet_types: ['npo'],
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('live-name uniqueness holds per meal window and frees on deactivate', async () => {
    await expect(createMenuItem({
      tenant_id: TENANT, name: 'ragi porridge', meal_type: 'breakfast', diet_types: ['diabetic'],
    })).rejects.toMatchObject({ statusCode: 409, code: 'DIETARY_MENU_ITEM_DUPLICATE' });

    // Same name in a different meal window is fine.
    const dinner = await createMenuItem({
      tenant_id: TENANT, name: 'Ragi Porridge', meal_type: 'dinner', diet_types: ['diabetic'],
    });
    // Deactivate → the name frees up for a replacement.
    const off = await updateMenuItem(dinner.id, { tenant_id: TENANT, active: false });
    expect(off.active).toBe(false);
    const replacement = await createMenuItem({
      tenant_id: TENANT, name: 'Ragi Porridge', meal_type: 'dinner', diet_types: ['regular'],
    });
    await updateMenuItem(replacement.id, { tenant_id: TENANT, active: false });
  });
});

describe('meal ticket generation', () => {
  test('cuts tickets only for active orders of currently admitted patients, excluding npo', async () => {
    const result = await generateMealTickets({
      tenantId: TENANT, source: 'manual', generatedBy: DIETITIAN_ACTOR.uid,
    });
    expect(result.serviceDate).toBe(TODAY);
    expect(result.considered).toBe(1); // only the admitted diabetic order
    expect(result.created).toBe(MEAL_TYPES.length);

    const all = await prisma.$queryRawUnsafe(
      `SELECT diet_order_id, patient_uid FROM dietary_meal_tickets WHERE tenant_id = $1::uuid`,
      TENANT,
    );
    expect(all.length).toBe(MEAL_TYPES.length);
    expect(new Set(all.map((r) => r.patient_uid))).toEqual(new Set([P_ADMITTED]));

    const tickets = await ticketsFor(orderAdmitted);
    const breakfast = tickets.find((t) => t.meal_type === 'breakfast');
    expect(breakfast.ward).toBe('Ward A');
    expect(breakfast.bed_number).toBe('A-101');
    expect(breakfast.patient_name).toBe('Kitchen Admitted');
    expect(breakfast.diet_type).toBe('diabetic');
    expect(breakfast.allergies).toEqual(['Peanut']);

    // Menu matching: the diabetic breakfast item without a conflicting
    // allergen is selected; the peanut item is excluded (patient allergy).
    const names = breakfast.menu_selections.map((s) => s.name);
    expect(names).toContain('Ragi Porridge');
    expect(names).not.toContain('Peanut Chikki Oats');
    expect(breakfast.diet_spec).toBeNull();

    // No diabetic lunch item exists → empty selections + free-text spec.
    const lunch = tickets.find((t) => t.meal_type === 'lunch');
    expect(lunch.menu_selections).toEqual([]);
    expect(lunch.diet_spec).toMatch(/diabetic diet/);

    // The npo order got nothing.
    expect(await ticketsFor(orderNpo)).toEqual([]);
  });

  test('re-running generation is idempotent and the live unique index rejects duplicates', async () => {
    const rerun = await generateMealTickets({ tenantId: TENANT, source: 'manual' });
    expect(rerun.created).toBe(0);
    expect(rerun.considered).toBe(1);

    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO dietary_meal_tickets
         (tenant_id, diet_order_id, patient_uid, service_date, meal_type, diet_type)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::date, 'breakfast', 'diabetic')`,
      TENANT, orderAdmitted, P_ADMITTED, TODAY,
    )).rejects.toThrow(/23505|duplicate key/i);
  });

  test('same-day re-sync on order change cancels pending tickets and re-cuts, leaving in-flight trays alone', async () => {
    // Kitchen starts breakfast before the diet change lands.
    const before = await ticketsFor(orderAdmitted);
    const breakfastId = before.find((t) => t.meal_type === 'breakfast').id;
    await transitionTicket({
      tenantId: TENANT, ticketId: breakfastId, toStatus: 'preparing', actor: KITCHEN_ACTOR,
    });

    await prisma.$executeRawUnsafe(
      `UPDATE diet_orders SET diet_type = 'renal', updated_at = NOW() WHERE id = $1::int`,
      orderAdmitted,
    );
    const sync = await syncTicketsForOrder({
      tenantId: TENANT, dietOrderId: orderAdmitted, actorUid: DIETITIAN_ACTOR.uid,
    });
    expect(sync.cancelled).toBe(3); // lunch/dinner/snack were pending
    expect(sync.created).toBe(3); // re-cut with the new diet type

    const after = await ticketsFor(orderAdmitted);
    const live = after.filter((t) => t.status !== 'cancelled');
    expect(live.length).toBe(4);
    // The in-flight breakfast keeps cooking under the old spec…
    expect(live.find((t) => t.id === breakfastId).status).toBe('preparing');
    expect(live.find((t) => t.id === breakfastId).diet_type).toBe('diabetic');
    // …while the re-cut meals carry the new diet type.
    for (const meal of ['lunch', 'dinner', 'snack']) {
      expect(live.find((t) => t.meal_type === meal).diet_type).toBe('renal');
    }
    const cancelled = after.filter((t) => t.status === 'cancelled');
    expect(cancelled.length).toBe(3);
  });

  test('discharge ends generation for the patient', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE admissions SET status = 'discharged', discharged_at = NOW()
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, P_NPO,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE diet_orders SET diet_type = 'regular' WHERE id = $1::int`, orderNpo,
    );
    // Even though the order is now a regular (non-npo) ACTIVE order, the
    // patient is discharged — no tickets.
    const result = await generateMealTickets({ tenantId: TENANT, source: 'manual' });
    expect(await ticketsFor(orderNpo)).toEqual([]);
    expect(result.considered).toBe(1);
  });
});

describe('ticket lifecycle + tray tracking', () => {
  let lunchId;

  beforeAll(async () => {
    const tickets = await ticketsFor(orderAdmitted);
    lunchId = tickets.find((t) => t.meal_type === 'lunch' && t.status !== 'cancelled').id;
  });

  test('rejects invalid jumps and wrong-role kitchen actions', async () => {
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'delivered', actor: KITCHEN_ACTOR,
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });

    // A ward nurse cannot run the kitchen line…
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'preparing', actor: NURSE_ACTOR,
    })).rejects.toMatchObject({ statusCode: 403 });
    // …nor cancel a ticket still in the kitchen.
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'cancelled', actor: NURSE_ACTOR, reason: 'nope',
    })).rejects.toMatchObject({ statusCode: 403 });

    await expect(transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'cancelled', actor: KITCHEN_ACTOR,
    })).rejects.toMatchObject({ statusCode: 400 }); // cancel requires a reason

    // Cross-tenant: the ticket does not exist under the other tenant.
    await expect(transitionTicket({
      tenantId: OTHER, ticketId: lunchId, toStatus: 'preparing', actor: KITCHEN_ACTOR,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('kitchen leg progresses with per-step stamps; ward leg delivers and collects', async () => {
    const preparing = await transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'preparing', actor: KITCHEN_ACTOR,
    });
    expect(preparing.status).toBe('preparing');
    expect(preparing.preparing_at).toBeTruthy();

    const ready = await transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'ready', actor: KITCHEN_ACTOR,
    });
    expect(ready.ready_at).toBeTruthy();

    const dispatched = await transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'dispatched', actor: KITCHEN_ACTOR,
    });
    expect(dispatched.dispatched_at).toBeTruthy();

    // Ward nurse takes over the tray from here.
    const delivered = await transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'delivered', actor: NURSE_ACTOR,
    });
    expect(delivered.status).toBe('delivered');
    expect(delivered.delivered_at).toBeTruthy();

    const collected = await transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'collected', actor: NURSE_ACTOR,
    });
    expect(collected.status).toBe('collected');
    expect(collected.collected_at).toBeTruthy();

    // Terminal: nothing moves out of collected.
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: lunchId, toStatus: 'delivered', actor: NURSE_ACTOR,
    })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  test('delivery wrote exactly one canonical timeline + audit pair in the transaction', async () => {
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, patient_uid FROM clinical_timeline_events
        WHERE idempotency_key = $1`,
      `dietary_meal_tickets:${lunchId}:delivered`,
    );
    expect(timeline.length).toBe(1);
    expect(timeline[0].event_type).toBe('dietary.meal_delivered');
    expect(timeline[0].patient_uid).toBe(P_ADMITTED);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_audit_events WHERE idempotency_key = $1`,
      `dietary_meal_tickets:${lunchId}:audit:delivered`,
    );
    expect(audit.length).toBe(1);
  });
});

describe('kitchen board + production summary', () => {
  test('board lists the day filtered by meal and status', async () => {
    const board = await listMealTickets({ tenantId: TENANT, date: TODAY });
    expect(board.serviceDate).toBe(TODAY);
    expect(board.tickets.length).toBeGreaterThanOrEqual(7); // 4 live + 3 cancelled

    const collectedOnly = await listMealTickets({ tenantId: TENANT, status: 'collected' });
    expect(collectedOnly.tickets.length).toBe(1);
    expect(collectedOnly.tickets[0].meal_type).toBe('lunch');

    await expect(listMealTickets({ tenantId: TENANT, status: 'plated' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('production summary counts live tickets by meal x diet type', async () => {
    const summary = await getProductionSummary({ tenantId: TENANT, date: TODAY });
    expect(summary.totalLive).toBe(4);
    // In-flight breakfast kept its original diabetic spec; the re-cut meals
    // cook renal.
    expect(summary.byMeal.breakfast.by_diet_type).toEqual({ diabetic: 1 });
    expect(summary.byMeal.lunch.by_diet_type).toEqual({ renal: 1 });
    expect(summary.byMeal.dinner.by_diet_type).toEqual({ renal: 1 });
    expect(summary.byMeal.snack.by_diet_type).toEqual({ renal: 1 });
    // Status rollup includes cancelled history for the day.
    expect(summary.byMeal.lunch.by_status.collected).toBe(1);
    expect(summary.byMeal.lunch.by_status.cancelled).toBe(1);
    expect(summary.byMeal.breakfast.by_status.preparing).toBe(1);
  });

  test('cross-tenant isolation: the other tenant sees nothing', async () => {
    const board = await listMealTickets({ tenantId: OTHER, date: TODAY });
    expect(board.tickets).toEqual([]);
    const summary = await getProductionSummary({ tenantId: OTHER, date: TODAY });
    expect(summary.totalLive).toBe(0);
  });
});
