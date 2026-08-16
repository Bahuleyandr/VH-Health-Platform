// Deep tests for kitchen management on top of diet orders (migrations 685 +
// 687): menu master CRUD + live-name uniqueness, meal-ticket generation
// correctness (admitted-only, npo/discharged/inactive exclusion,
// unified-allergy-store screening with fail-closed degradation + persisted
// screen evidence, idempotency + live uniqueness), same-day re-sync on
// diet-order change (stale kitchen-side tickets cancelled, out-of-kitchen
// trays recall-flagged with the canonical recall event), the discharge
// recall hook, stale/recalled transition refusal, lifecycle transition
// validation with wrong-role rejection, the canonical timeline/audit pair on
// delivery, and the production summary.
import prisma from '../lib/prisma.js';
import {
  createMenuItem, updateMenuItem, listMenuItems,
  generateMealTickets, syncTicketsForOrder, recallTicketsForPatient,
  listMealTickets, getProductionSummary, transitionTicket,
  buildAllergenTerms, menuItemAllergenConflict, screenMenuItems,
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
const P_UNIFIED = 'd1e76666-6666-4666-8666-666666666666'; // allergy only in patient_allergies
const P_RECALL = 'd1e77777-7777-4777-8777-777777777777'; // NPO-change recall flow
const P_STALE = 'd1e78888-8888-4888-8888-888888888888'; // stale transition refusal
const P_DISCHG = 'd1e79999-9999-4999-8999-999999999999'; // discharge recall hook

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
            allergies, menu_selections, diet_spec, allergy_screen, cancel_reason,
            recalled_at, recalled_by, recall_reason, recall_ack_at, recall_ack_by,
            service_date::text AS service_date
       FROM dietary_meal_tickets
      WHERE diet_order_id = $1::int
      ORDER BY array_position(ARRAY['breakfast','lunch','dinner','snack']::text[], meal_type), id`,
    orderId,
  );
}

const ALL_PATIENTS = [
  P_ADMITTED, P_DISCHARGED, P_NPO, P_ONHOLD, P_FOREIGN,
  P_UNIFIED, P_RECALL, P_STALE, P_DISCHG,
];

async function cleanup() {
  const patients = ALL_PATIENTS;
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
    `DELETE FROM patient_allergies WHERE patient_uid = ANY($1::uuid[])`, patients,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE uid = $1::uuid
        OR (resource = 'admission' AND (metadata->>'patient_uid') = ANY($2::text[]))`,
    DIETITIAN_ACTOR.uid, patients,
  ).catch(() => {});
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
  // Admissions + diet orders for these four are created inside their own
  // describes so the earlier generation-count assertions stay exact.
  await seedPatient(P_UNIFIED, 'Kitchen Unified Allergy', '9821000006', TENANT);
  await seedPatient(P_RECALL, 'Kitchen Recall', '9821000007', TENANT);
  await seedPatient(P_STALE, 'Kitchen Stale', '9821000008', TENANT);
  await seedPatient(P_DISCHG, 'Kitchen Discharge Hook', '9821000009', TENANT);

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

    // Screen evidence persisted on the ticket (radiology idiom): a clean
    // (non-degraded) screen recording exactly which item was withheld.
    expect(breakfast.allergy_screen.degraded).toBe(false);
    expect(breakfast.allergy_screen.sources_failed).toEqual([]);
    expect(breakfast.allergy_screen.patient_allergies).toEqual(['Peanut']);
    const withheld = breakfast.allergy_screen.excluded;
    expect(withheld.length).toBe(1);
    expect(withheld[0].name).toBe('Peanut Chikki Oats');
    expect(withheld[0].tag).toBe('peanut');
    expect(withheld[0].matched).toBe('peanut');

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

  test('same-day re-sync on order change cancels ALL stale kitchen-side tickets (preparing included) and re-cuts', async () => {
    // Kitchen starts breakfast before the diet change lands — the stale
    // preparing tray must NOT keep cooking the old diet (it would be served
    // with the stale spec through delivered).
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
    expect(sync.cancelled).toBe(4); // preparing breakfast + 3 pending, all stale
    expect(sync.recalled).toBe(0); // nothing was out of the kitchen
    expect(sync.created).toBe(4); // full re-cut with the new diet type

    const after = await ticketsFor(orderAdmitted);
    const live = after.filter((t) => t.status !== 'cancelled');
    expect(live.length).toBe(4);
    for (const meal of MEAL_TYPES) {
      const ticket = live.find((t) => t.meal_type === meal);
      expect(ticket.status).toBe('pending');
      expect(ticket.diet_type).toBe('renal');
    }
    const stale = after.find((t) => t.id === breakfastId);
    expect(stale.status).toBe('cancelled');
    const cancelled = after.filter((t) => t.status === 'cancelled');
    expect(cancelled.length).toBe(4);

    // Re-syncing with no order change is a no-op: nothing is stale.
    const rerun = await syncTicketsForOrder({
      tenantId: TENANT, dietOrderId: orderAdmitted, actorUid: DIETITIAN_ACTOR.uid,
    });
    expect(rerun.cancelled).toBe(0);
    expect(rerun.recalled).toBe(0);
    expect(rerun.created).toBe(0);
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
    // The stale diabetic breakfast was cancelled by the re-sync; every live
    // ticket cooks the re-cut renal spec.
    expect(summary.byMeal.breakfast.by_diet_type).toEqual({ renal: 1 });
    expect(summary.byMeal.lunch.by_diet_type).toEqual({ renal: 1 });
    expect(summary.byMeal.dinner.by_diet_type).toEqual({ renal: 1 });
    expect(summary.byMeal.snack.by_diet_type).toEqual({ renal: 1 });
    // Status rollup includes cancelled history for the day.
    expect(summary.byMeal.lunch.by_status.collected).toBe(1);
    expect(summary.byMeal.lunch.by_status.cancelled).toBe(1);
    expect(summary.byMeal.breakfast.by_status.pending).toBe(1);
    expect(summary.byMeal.breakfast.by_status.cancelled).toBe(1);
  });

  test('cross-tenant isolation: the other tenant sees nothing', async () => {
    const board = await listMealTickets({ tenantId: OTHER, date: TODAY });
    expect(board.tickets).toEqual([]);
    const summary = await getProductionSummary({ tenantId: OTHER, date: TODAY });
    expect(summary.totalLive).toBe(0);
  });
});

describe('allergen matching (pure, fail-closed)', () => {
  test('bidirectional substring and food-allergen class synonyms both exclude', () => {
    const item = { id: '1', name: 'Kheer', allergen_tags: ['milk'] };
    // Free-text "dairy" never contains "milk" — only the class map catches it.
    expect(menuItemAllergenConflict(item, ['dairy'])).toMatchObject({
      tag: 'milk', matched: 'dairy', via: 'class:milk',
    });
    // Substring both directions: "peanuts" ⊃ "peanut" tag…
    const chikki = { id: '2', name: 'Chikki', allergen_tags: ['peanut'] };
    expect(menuItemAllergenConflict(chikki, ['peanuts'])).toMatchObject({ via: 'substring' });
    // …and "nut" tag ⊂ "peanut allergy (anaphylaxis)".
    const laddu = { id: '3', name: 'Laddu', allergen_tags: ['nut'] };
    expect(menuItemAllergenConflict(laddu, ['peanut allergy (anaphylaxis)'])).toMatchObject({ via: 'substring' });
    // Indian-formulary synonym: groundnut is the peanut class.
    const poha = { id: '4', name: 'Poha', allergen_tags: ['groundnut'] };
    expect(menuItemAllergenConflict(poha, ['peanuts'])).toMatchObject({ via: 'class:peanut' });
    // No conflict → null.
    expect(menuItemAllergenConflict(item, ['penicillin'])).toBeNull();
  });

  test('degraded screen fails CLOSED: every allergen-tagged item excluded, untagged items pass', () => {
    const tagged = { id: '1', name: 'Kheer', allergen_tags: ['milk'] };
    const untagged = { id: '2', name: 'Plain Rice', allergen_tags: [] };
    expect(menuItemAllergenConflict(tagged, [], { degraded: true }))
      .toMatchObject({ via: 'screen_degraded', matched: null });
    expect(menuItemAllergenConflict(untagged, [], { degraded: true })).toBeNull();

    const { selections, excluded } = screenMenuItems(
      [
        { id: '1', name: 'Kheer', meal_type: 'dinner', diet_types: ['regular'], is_veg: true, allergen_tags: ['milk'] },
        { id: '2', name: 'Plain Rice', meal_type: 'dinner', diet_types: ['regular'], is_veg: true, allergen_tags: [] },
      ],
      { mealType: 'dinner', dietType: 'regular', terms: [], degraded: true },
    );
    expect(selections.map((s) => s.name)).toEqual(['Plain Rice']);
    expect(excluded.map((e) => e.name)).toEqual(['Kheer']);
  });

  test('terms union includes unified allergies, order free text, AND restrictions; degenerate terms dropped', () => {
    const terms = buildAllergenTerms({
      unifiedAllergies: [{ allergen: 'Peanuts', severity: 'ANAPHYLAXIS' }],
      orderAllergies: ['Shellfish'],
      orderRestrictions: ['no nuts', 'ab'], // 'ab' is too short to match anything
    });
    expect(terms).toContain('peanuts');
    expect(terms).toContain('shellfish');
    expect(terms).toContain('no nuts');
    expect(terms).not.toContain('ab');
    // A "no nuts" restriction excludes nut-tagged items.
    expect(menuItemAllergenConflict(
      { id: '1', name: 'Badam Halwa', allergen_tags: ['nut'] }, terms,
    )).toMatchObject({ via: 'substring' });
  });
});

describe('unified allergy stores gate menu selection (migration 687)', () => {
  let orderUnified;

  beforeAll(async () => {
    // The allergy lives ONLY in patient_allergies — the diet order carries
    // no free text. Pre-687 this patient's peanut anaphylaxis never reached
    // the kitchen.
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (tenant_id, patient_uid, allergy_name, severity, is_active)
       VALUES ($1::uuid, $2::uuid, 'Peanuts', 'ANAPHYLAXIS', TRUE)`,
      TENANT, P_UNIFIED,
    );
    await createMenuItem({
      tenant_id: TENANT, name: 'Groundnut Poha', meal_type: 'breakfast',
      diet_types: ['regular'], allergen_tags: ['groundnut'],
    });
    await insertAdmission(TENANT, P_UNIFIED, { ward: 'Ward C', bed: 'C-301' });
    orderUnified = await insertDietOrder(TENANT, P_UNIFIED, { dietType: 'regular' });
  });

  test('a patient_allergies-only allergy excludes matching menu items and lands on the ticket snapshot', async () => {
    const result = await generateMealTickets({
      tenantId: TENANT, source: 'manual', generatedBy: DIETITIAN_ACTOR.uid,
      dietOrderId: orderUnified,
    });
    expect(result.created).toBe(MEAL_TYPES.length);

    const tickets = await ticketsFor(orderUnified);
    const breakfast = tickets.find((t) => t.meal_type === 'breakfast');
    // Kitchen staff see the unified allergy on the tray ticket…
    expect(breakfast.allergies).toEqual(['Peanuts']);
    // …the groundnut (peanut-class) item is withheld…
    const names = breakfast.menu_selections.map((s) => s.name);
    expect(names).not.toContain('Groundnut Poha');
    // ('Ragi Porridge' suits regular and only carries a milk tag — kept.)
    expect(names).toContain('Ragi Porridge');
    // …and the evidence names the store-sourced match.
    expect(breakfast.allergy_screen.degraded).toBe(false);
    expect(breakfast.allergy_screen.patient_allergies).toEqual(['Peanuts']);
    const hit = breakfast.allergy_screen.excluded.find((e) => e.name === 'Groundnut Poha');
    expect(hit).toMatchObject({ tag: 'groundnut', matched: 'peanuts', via: 'class:peanut' });
  });
});

describe('NPO change recalls trays past pending (migration 687)', () => {
  let orderRecall;
  let byMeal;

  beforeAll(async () => {
    await insertAdmission(TENANT, P_RECALL, { ward: 'Ward D', bed: 'D-401' });
    orderRecall = await insertDietOrder(TENANT, P_RECALL, { dietType: 'regular' });
    await generateMealTickets({
      tenantId: TENANT, source: 'manual', generatedBy: DIETITIAN_ACTOR.uid,
      dietOrderId: orderRecall,
    });
    const tickets = await ticketsFor(orderRecall);
    byMeal = Object.fromEntries(tickets.map((t) => [t.meal_type, t.id]));
    // Kitchen state before the NPO order lands: breakfast cooking, lunch out
    // on the ward, dinner already at the bedside, snack untouched.
    const go = (id, statuses, actor) => statuses.reduce(
      (p, toStatus) => p.then(() => transitionTicket({
        tenantId: TENANT, ticketId: id, toStatus, actor,
      })),
      Promise.resolve(),
    );
    await go(byMeal.breakfast, ['preparing'], KITCHEN_ACTOR);
    await go(byMeal.lunch, ['preparing', 'ready', 'dispatched'], KITCHEN_ACTOR);
    await go(byMeal.dinner, ['preparing', 'ready', 'dispatched'], KITCHEN_ACTOR);
    await go(byMeal.dinner, ['delivered'], NURSE_ACTOR);
  });

  test('re-sync cancels kitchen-side tickets and recall-flags out-of-kitchen trays with the canonical event', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE diet_orders SET diet_type = 'npo', updated_at = NOW() WHERE id = $1::int`,
      orderRecall,
    );
    const sync = await syncTicketsForOrder({
      tenantId: TENANT, dietOrderId: orderRecall, actorUid: DIETITIAN_ACTOR.uid,
      reason: 'patient made nil by mouth',
    });
    expect(sync.cancelled).toBe(2); // preparing breakfast + pending snack
    expect(sync.recalled).toBe(2); // dispatched lunch + delivered dinner
    expect(sync.created).toBe(0); // npo cuts nothing

    const tickets = await ticketsFor(orderRecall);
    const lunch = tickets.find((t) => t.id === byMeal.lunch);
    // The out-of-kitchen tray is NOT silently cancelled — it keeps its
    // status with the do-not-serve flag until the ward accounts for it.
    expect(lunch.status).toBe('dispatched');
    expect(lunch.recalled_at).toBeTruthy();
    expect(lunch.recall_reason).toBe('patient made nil by mouth');
    expect(lunch.recall_ack_at).toBeNull();
    const dinner = tickets.find((t) => t.id === byMeal.dinner);
    expect(dinner.status).toBe('delivered');
    expect(dinner.recalled_at).toBeTruthy();
    expect(tickets.find((t) => t.id === byMeal.breakfast).status).toBe('cancelled');
    expect(tickets.find((t) => t.id === byMeal.snack).status).toBe('cancelled');

    // Canonical recall pair per out-of-kitchen tray, in the recall tx.
    for (const id of [byMeal.lunch, byMeal.dinner]) {
      const timeline = await prisma.$queryRawUnsafe(
        `SELECT event_type, patient_uid FROM clinical_timeline_events WHERE idempotency_key = $1`,
        `dietary_meal_tickets:${id}:recalled`,
      );
      expect(timeline.length).toBe(1);
      expect(timeline[0].event_type).toBe('dietary.meal_recalled');
      expect(timeline[0].patient_uid).toBe(P_RECALL);
      const audit = await prisma.$queryRawUnsafe(
        `SELECT id FROM clinical_audit_events WHERE idempotency_key = $1`,
        `dietary_meal_tickets:${id}:audit:recalled`,
      );
      expect(audit.length).toBe(1);
    }
  });

  test('a recalled tray refuses delivery (409) and the ward acknowledges by cancelling / collecting', async () => {
    // Do-not-serve: the recalled dispatched tray cannot be delivered.
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: byMeal.lunch, toStatus: 'delivered', actor: NURSE_ACTOR,
    })).rejects.toMatchObject({ statusCode: 409, code: 'DIETARY_TICKET_RECALLED' });

    // Ward acknowledges the dispatched tray by cancelling it (the leg that
    // is already open to ward roles) — the ack is stamped.
    const cancelledTicket = await transitionTicket({
      tenantId: TENANT, ticketId: byMeal.lunch, toStatus: 'cancelled', actor: NURSE_ACTOR,
      reason: 'recall acknowledged — tray returned to kitchen',
    });
    expect(cancelledTicket.status).toBe('cancelled');
    expect(cancelledTicket.recall_ack_at).toBeTruthy();
    expect(cancelledTicket.recall_ack_by).toBe(NURSE_ACTOR.uid);

    // A recalled delivered tray is acknowledged by collecting it back.
    const collectedTicket = await transitionTicket({
      tenantId: TENANT, ticketId: byMeal.dinner, toStatus: 'collected', actor: NURSE_ACTOR,
    });
    expect(collectedTicket.status).toBe('collected');
    expect(collectedTicket.recall_ack_at).toBeTruthy();
    expect(collectedTicket.recall_ack_by).toBe(NURSE_ACTOR.uid);
  });
});

describe('stale-ticket transition refusal (live re-check at dispatch/deliver)', () => {
  let orderStale;
  let breakfastId;

  beforeAll(async () => {
    await insertAdmission(TENANT, P_STALE, { ward: 'Ward E', bed: 'E-501' });
    orderStale = await insertDietOrder(TENANT, P_STALE, { dietType: 'regular' });
    await generateMealTickets({
      tenantId: TENANT, source: 'manual', generatedBy: DIETITIAN_ACTOR.uid,
      dietOrderId: orderStale,
    });
    const tickets = await ticketsFor(orderStale);
    breakfastId = tickets.find((t) => t.meal_type === 'breakfast').id;
    await transitionTicket({
      tenantId: TENANT, ticketId: breakfastId, toStatus: 'preparing', actor: KITCHEN_ACTOR,
    });
    await transitionTicket({
      tenantId: TENANT, ticketId: breakfastId, toStatus: 'ready', actor: KITCHEN_ACTOR,
    });
  });

  test('diet changed under the ticket → dispatch refused 409 with the reason', async () => {
    // Direct SQL change — no re-sync ran (e.g. another node changed the
    // order between board refreshes). transitionTicket must still notice.
    await prisma.$executeRawUnsafe(
      `UPDATE diet_orders SET diet_type = 'diabetic', updated_at = NOW() WHERE id = $1::int`,
      orderStale,
    );
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: breakfastId, toStatus: 'dispatched', actor: KITCHEN_ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DIETARY_TICKET_STALE',
      details: { reason: 'diet_changed' },
    });
  });

  test('NPO under the ticket → refused with patient_npo', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE diet_orders SET diet_type = 'npo', updated_at = NOW() WHERE id = $1::int`,
      orderStale,
    );
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: breakfastId, toStatus: 'dispatched', actor: KITCHEN_ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DIETARY_TICKET_STALE',
      details: { reason: 'patient_npo' },
    });
  });

  test('admission ended under the ticket → refused with admission_ended', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE diet_orders SET diet_type = 'regular', updated_at = NOW() WHERE id = $1::int`,
      orderStale,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE admissions SET status = 'discharged', discharged_at = NOW()
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, P_STALE,
    );
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: breakfastId, toStatus: 'dispatched', actor: KITCHEN_ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DIETARY_TICKET_STALE',
      details: { reason: 'admission_ended' },
    });
  });
});

describe('discharge recalls the patient\'s live tickets', () => {
  let orderDischg;
  let byMeal;
  let admissionId;

  beforeAll(async () => {
    admissionId = await insertAdmission(TENANT, P_DISCHG, { ward: 'Ward F', bed: 'F-601' });
    orderDischg = await insertDietOrder(TENANT, P_DISCHG, { dietType: 'regular' });
    await generateMealTickets({
      tenantId: TENANT, source: 'manual', generatedBy: DIETITIAN_ACTOR.uid,
      dietOrderId: orderDischg,
    });
    const tickets = await ticketsFor(orderDischg);
    byMeal = Object.fromEntries(tickets.map((t) => [t.meal_type, t.id]));
    // One tray out of the kitchen when the discharge lands.
    for (const toStatus of ['preparing', 'ready', 'dispatched']) {
      await transitionTicket({
        tenantId: TENANT, ticketId: byMeal.lunch, toStatus, actor: KITCHEN_ACTOR,
      });
    }
  });

  test('dischargePatient (Phase 1.5 hook) cancels kitchen-side tickets and recall-flags the dispatched tray', async () => {
    const { default: admissionService } = await import('../services/emr/admissionService.js');
    // LAMA bypasses the discharge readiness gate — this test is about the
    // dietary hook, not the gate.
    await admissionService.dischargePatient(
      admissionId,
      { discharge_type: 'lama' },
      DIETITIAN_ACTOR.uid,
      { tenantId: TENANT },
    );

    const tickets = await ticketsFor(orderDischg);
    for (const meal of ['breakfast', 'dinner', 'snack']) {
      const ticket = tickets.find((t) => t.id === byMeal[meal]);
      expect(ticket.status).toBe('cancelled');
      expect(ticket.cancel_reason).toBe('admission ended (lama)');
    }
    const lunch = tickets.find((t) => t.id === byMeal.lunch);
    expect(lunch.status).toBe('dispatched');
    expect(lunch.recalled_at).toBeTruthy();
    expect(lunch.recall_reason).toBe('admission ended (lama)');

    // And the stale re-check backstops the hook: even if the recall had been
    // missed, the discharged patient's tray cannot be delivered.
    await expect(transitionTicket({
      tenantId: TENANT, ticketId: byMeal.lunch, toStatus: 'delivered', actor: NURSE_ACTOR,
    })).rejects.toMatchObject({ statusCode: 409, code: 'DIETARY_TICKET_RECALLED' });
  });

  test('recallTicketsForPatient is idempotent — a second run finds nothing live', async () => {
    const rerun = await recallTicketsForPatient({
      tenantId: TENANT, patientUid: P_DISCHG,
      actorUid: DIETITIAN_ACTOR.uid, reason: 'admission ended (lama)',
    });
    expect(rerun).toEqual({ cancelled: 0, recalled: 0 });
  });
});
