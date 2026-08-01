// Roadmap D2 — scheduling optimization deep round-trip.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199918${String(Date.now() % 10000).padStart(4, '0')}`;
let patientUid;
let doctorUserId;
let templateId;
// Future Wednesdays (predictable weekday=3, no collisions), computed
// relative to today: the slot grid only honours templates whose
// effective_from (CURRENT_DATE at creation time) is on/before the queried
// date, so a fixed calendar date would flip the whole grid to capacity 0
// once real time passed it.
function futureWednesday(minDaysAhead) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DATE = futureWednesday(90);
const LEAVE_DATE = futureWednesday(97); // following Wednesday
const EXCEPTION_DATE = futureWednesday(104);

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM scheduling_overbook_audit_events WHERE doctor_id IN (SELECT id FROM users WHERE name = 'D2TEST Doctor')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM scheduling_overbook_policies WHERE doctor_id IN (SELECT id FROM users WHERE name = 'D2TEST Doctor')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM appointment_slot_holds WHERE doctor_id IN (SELECT id FROM users WHERE name = 'D2TEST Doctor')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM provider_availability_template_exceptions WHERE doctor_id IN (SELECT id FROM users WHERE name = 'D2TEST Doctor')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM provider_availability_template_audit WHERE template_id IN (SELECT id FROM provider_availability_templates WHERE doctor_id IN (SELECT id FROM users WHERE name = 'D2TEST Doctor'))`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM appointment_waitlist WHERE notes LIKE 'D2TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM scheduling_resource_compatibility WHERE resource_id IN (SELECT id FROM bookable_resources WHERE name LIKE 'D2TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM resource_bookings WHERE resource_id IN (SELECT id FROM bookable_resources WHERE name LIKE 'D2TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM bookable_resources WHERE name LIKE 'D2TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM provider_availability_templates WHERE doctor_id IN (SELECT id FROM users WHERE name = 'D2TEST Doctor')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM provider_leaves WHERE doctor_id IN (SELECT id FROM users WHERE name = 'D2TEST Doctor')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE reason LIKE 'D2TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name LIKE 'D2TEST%'`).catch(() => {});
}

d('Scheduling optimization — deep round-trip (roadmap D2)', () => {
  beforeAll(async () => {
    await cleanup();
    const doc = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'D2TEST Doctor', 'DOCTOR', true, NOW()) RETURNING id`,
      `+9199919${String(Date.now() % 10000).padStart(4, '0')}`,
    );
    doctorUserId = Number(doc[0].id);
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'D2TEST Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      PHONE,
    );
    patientUid = p[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('template + booked appointment + no-show score → slot grid with overbook basis', async () => {
    const template = await authClient('ADMIN')
      .post('/api/v1/scheduling/templates')
      .send({
        doctor_id: doctorUserId,
        weekday: 3,
        start_time: '09:00',
        end_time: '10:00',
        slot_minutes: 15,
        appointment_type: 'consult',
        service_code: 'opd',
      });
    expect(template.status).toBe(201);
    templateId = template.body.data.template.id;

    // One booked appointment at 09:15 with a high no-show score.
    const appt = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments (phone, patient_name, doctor_id, doctor_name, appointment_date, appointment_time, status, reason, updated_at)
       VALUES ($1, 'D2TEST Patient', $2, 'D2TEST Doctor', $3::date, '09:15', 'SCHEDULED', 'D2TEST follow-up', NOW())
       RETURNING id`,
      PHONE, doctorUserId, DATE,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_ai_no_show_predictions (appointment_id, patient_uid, risk_score, band, scored_at)
       VALUES ($1, $2::uuid, 1.0, 'high', NOW())`,
      Number(appt[0].id), patientUid,
    ).catch(() => {}); // prediction table contents are best-effort for the grid

    const grid = await authClient('RECEPTIONIST')
      .get('/api/v1/scheduling/slots')
      .query({ doctor_id: doctorUserId, date: DATE });
    expect(grid.status).toBe(200);
    expect(grid.body.data.capacity).toBe(4); // 09:00 09:15 09:30 09:45
    expect(grid.body.data.booked_count).toBe(1);
    const bookedSlot = grid.body.data.slots.find((s) => s.start === '09:15');
    expect(bookedSlot.available).toBe(false);
    expect(grid.body.data.overbook_basis).toBeDefined();
    expect(grid.body.data.overbook_allowance).toBe(0);
    expect(grid.body.data.overbook_policy.enabled).toBe(false);

    const policy = await authClient('ADMIN')
      .post('/api/v1/scheduling/overbook-policies')
      .send({
        policy_scope: 'doctor',
        doctor_id: doctorUserId,
        appointment_type: 'consult',
        max_overbook_fraction: 0.5,
        max_overbook_slots: 1,
        authority_role: 'ADMIN',
        enabled: true,
      });
    expect(policy.status).toBe(201);

    const policyGrid = await authClient('RECEPTIONIST')
      .get('/api/v1/scheduling/slots')
      .query({ doctor_id: doctorUserId, date: DATE, appointment_type: 'consult' });
    expect(policyGrid.status).toBe(200);
    expect(policyGrid.body.data.overbook_allowance).toBe(1);

    const decision = await authClient('ADMIN')
      .post('/api/v1/scheduling/overbook/evaluate')
      .send({ doctor_id: doctorUserId, date: DATE, appointment_type: 'consult', requested_slots: 1 });
    expect(decision.status).toBe(200);
    expect(decision.body.data.allowed).toBe(true);
    expect(decision.body.data.decision).toBe('allowed');
  });

  test('leave auto-blocks the grid', async () => {
    const leave = await authClient('ADMIN')
      .post('/api/v1/scheduling/leaves')
      .send({ doctor_id: doctorUserId, starts_on: LEAVE_DATE, ends_on: LEAVE_DATE, reason: 'D2TEST CME day' });
    expect(leave.status).toBe(201);

    const grid = await authClient('RECEPTIONIST')
      .get('/api/v1/scheduling/slots')
      .query({ doctor_id: doctorUserId, date: LEAVE_DATE });
    expect(grid.status).toBe(200);
    expect(grid.body.data.on_leave).toBe(true);
    expect(grid.body.data.capacity).toBe(0);
  });

  test('template exceptions close a provider day', async () => {
    const exception = await authClient('ADMIN')
      .post(`/api/v1/scheduling/templates/${templateId}/exceptions`)
      .send({
        doctor_id: doctorUserId,
        exception_date: EXCEPTION_DATE,
        exception_type: 'closed',
        all_day: true,
        reason: 'D2TEST holiday',
      });
    expect(exception.status).toBe(201);

    const grid = await authClient('RECEPTIONIST')
      .get('/api/v1/scheduling/slots')
      .query({ doctor_id: doctorUserId, date: EXCEPTION_DATE });
    expect(grid.status).toBe(200);
    expect(grid.body.data.schedule_closed).toBe(true);
    expect(grid.body.data.capacity).toBe(0);
  });

  test('slot holds are idempotent and block displayed availability until release', async () => {
    const first = await authClient('RECEPTIONIST')
      .post('/api/v1/scheduling/slot-holds')
      .send({
        doctor_id: doctorUserId,
        date: DATE,
        slot_start: '09:30',
        slot_end: '09:45',
        source_channel: 'staff',
        idempotency_key: 'D2TEST-hold-0930',
      });
    expect(first.status).toBe(201);
    const holdId = first.body.data.hold.id;

    const repeat = await authClient('RECEPTIONIST')
      .post('/api/v1/scheduling/slot-holds')
      .send({
        doctor_id: doctorUserId,
        date: DATE,
        slot_start: '09:30',
        slot_end: '09:45',
        source_channel: 'staff',
        idempotency_key: 'D2TEST-hold-0930',
      });
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.hold.id).toBe(holdId);

    const grid = await authClient('RECEPTIONIST')
      .get('/api/v1/scheduling/slots')
      .query({ doctor_id: doctorUserId, date: DATE });
    expect(grid.status).toBe(200);
    const heldSlot = grid.body.data.slots.find((s) => s.start === '09:30');
    expect(heldSlot.available).toBe(false);
    expect(heldSlot.active_hold_id).toBe(holdId);

    const release = await authClient('RECEPTIONIST')
      .post(`/api/v1/scheduling/slot-holds/${holdId}/release`)
      .send({});
    expect(release.status).toBe(200);
    expect(release.body.data.hold.status).toBe('cancelled');
  });

  test('waitlist add + auto-fill offers a free slot (am window honoured)', async () => {
    const add = await authClient('RECEPTIONIST')
      .post('/api/v1/scheduling/waitlist')
      .send({
        patient_uid: patientUid, doctor_id: doctorUserId,
        preferred_date: DATE, preferred_window: 'am', priority: 1, notes: 'D2TEST urgent review',
      });
    expect(add.status).toBe(201);
    const waitlistId = add.body.data.entry.id;

    const fill = await authClient('RECEPTIONIST')
      .post('/api/v1/scheduling/waitlist/fill')
      .send({ doctor_id: doctorUserId, date: DATE });
    expect(fill.status).toBe(200);
    const offer = fill.body.data.offers.find((o) => o.waitlist_id === waitlistId);
    expect(offer).toBeDefined();
    expect(offer.slot.start < '12:00').toBe(true);

    const resolved = await authClient('RECEPTIONIST')
      .patch(`/api/v1/scheduling/waitlist/${waitlistId}`)
      .send({ status: 'booked' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.entry.status).toBe('booked');
    expect(resolved.body.data.entry.notification_state).toBe('queued');
  });

  test('resource booking enforces compatibility and blocks overlaps', async () => {
    const resource = await authClient('ADMIN')
      .post('/api/v1/scheduling/resources')
      .send({ kind: 'room', name: 'D2TEST Minor OT', location: 'Block A', service_code: 'minor_ot' });
    expect(resource.status).toBe(201);
    const resourceId = resource.body.data.resource.id;

    const compatibility = await authClient('ADMIN')
      .post(`/api/v1/scheduling/resources/${resourceId}/compatibility`)
      .send({ doctor_id: doctorUserId, service_code: 'minor_ot', requirement: 'required' });
    expect(compatibility.status).toBe(201);

    const incompatible = await authClient('RECEPTIONIST')
      .post(`/api/v1/scheduling/resources/${resourceId}/book`)
      .send({
        starts_at: `${DATE}T08:00:00+05:30`,
        ends_at: `${DATE}T08:30:00+05:30`,
        booked_for_type: 'other',
        doctor_id: doctorUserId,
        service_code: 'imaging',
      });
    expect(incompatible.status).toBe(409);

    const first = await authClient('RECEPTIONIST')
      .post(`/api/v1/scheduling/resources/${resourceId}/book`)
      .send({
        starts_at: `${DATE}T10:00:00+05:30`,
        ends_at: `${DATE}T11:00:00+05:30`,
        booked_for_type: 'other',
        doctor_id: doctorUserId,
        service_code: 'minor_ot',
      });
    expect(first.status).toBe(201);

    const overlap = await authClient('RECEPTIONIST')
      .post(`/api/v1/scheduling/resources/${resourceId}/book`)
      .send({
        starts_at: `${DATE}T10:30:00+05:30`,
        ends_at: `${DATE}T11:30:00+05:30`,
        doctor_id: doctorUserId,
        service_code: 'minor_ot',
      });
    expect(overlap.status).toBe(409);

    const schedule = await authClient('RECEPTIONIST')
      .get(`/api/v1/scheduling/resources/${resourceId}/schedule`)
      .query({ date: DATE });
    expect(schedule.status).toBe(200);
    expect(schedule.body.data.count).toBe(1);
  });

  test('template writes are role-gated', async () => {
    const res = await authClient('RECEPTIONIST')
      .post('/api/v1/scheduling/templates')
      .send({ doctor_id: doctorUserId, weekday: 1, start_time: '09:00', end_time: '10:00' });
    expect(res.status).toBe(403);
  });
});
