import request from 'supertest';
import { jest } from '@jest/globals';

import app from '../../app.js';
import { generateToken } from '../../utils/jwtUtils.js';
import {
  API_KEY,
  DEFAULT_TENANT,
  describeJourney,
  hospitalDateOffset,
  hospitalToday,
  prisma,
  runSuffix,
  seedUser
} from './_journeyHarness.js';

const RUN = runSuffix();
const TENANT_B = `c7b00000-0000-4000-8000-${RUN.padStart(12, '0')}`;
const MOTHER_UID = `c7000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const TWIN_ONE_UID = `c7000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const TWIN_TWO_UID = `c7000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DOCTOR_UID = `c7000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const TENANT_B_DOCTOR_UID = `c7000005-0000-4000-8000-${RUN.padStart(12, '0')}`;

const MOTHER_PHONE = `96801${RUN}`;
const TWIN_ONE_PHONE = `96802${RUN}`;
const TWIN_TWO_PHONE = `96803${RUN}`;
const DOCTOR_PHONE = `96804${RUN}`;
const TENANT_B_DOCTOR_PHONE = `96805${RUN}`;
const VACCINE_CODE = `JRNBCG${RUN}`;

const PRIVATE_IMAGING = `JOURNEY_PRIVATE_IMAGING_${RUN}`;
const PRIVATE_LABOUR = `JOURNEY_PRIVATE_LABOUR_${RUN}`;
const PRIVATE_PARTOGRAPH = `JOURNEY_PRIVATE_PARTOGRAPH_${RUN}`;
const PRIVATE_DELIVERY = `JOURNEY_PRIVATE_DELIVERY_${RUN}`;
const PRIVATE_IMMUNISATION = `JOURNEY_PRIVATE_IMMUNISATION_${RUN}`;
const PRIVATE_MARKERS = [PRIVATE_IMAGING, PRIVATE_LABOUR, PRIVATE_PARTOGRAPH, PRIVATE_DELIVERY];
const TEST_TIMEOUT_MS = 60_000;

jest.setTimeout(TEST_TIMEOUT_MS);

// expectedRevisions reflects the #589 canonical revision regime for the six
// fixed families: exact retries no-op (no canonical pair), every genuine
// mutation owns one `<state-fingerprint>:tx:<xid8>`-keyed pair. The ANC visit
// carries 3 revisions because the revision-semantics step below drives one
// A -> B -> A cycle through the staff API (initial + B + back-to-A); the
// remaining events are written exactly once in this journey.
const LANDED_CANONICAL_EVENTS = [
  {
    eventType: 'maternity.pregnancy_created',
    sourceTable: 'maternity_pregnancies',
    expectedRevisions: 1
  },
  {
    eventType: 'maternity.anc_visit_recorded',
    sourceTable: 'maternity_anc_visits',
    expectedRevisions: 3
  },
  {
    eventType: 'maternity.labor_admission_recorded',
    sourceTable: 'maternity_labor_admissions',
    expectedRevisions: 1
  },
  {
    eventType: 'maternity.partograph_entry_recorded',
    sourceTable: 'maternity_partograph_entries',
    expectedRevisions: 1
  },
  {
    eventType: 'maternity.delivery_recorded',
    sourceTable: 'maternity_deliveries',
    expectedRevisions: 1
  }
];

function clientForTenant(role, { uid, id, phone, tenantId }) {
  const token = generateToken({
    uid,
    id,
    phone,
    role,
    tenant_id: tenantId,
    deviceType: role === 'PATIENT' ? 'mobile' : 'desktop'
  });
  const auth = req => req.set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
  return {
    get: path => auth(request(app).get(path)),
    post: path => auth(request(app).post(path))
  };
}

async function outboundCounts() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT (SELECT COUNT(*)::int FROM notification_outbox) AS outbox,
            (SELECT COUNT(*)::int FROM engagement_campaign_recipients) AS recipients`
  );
  return {
    outbox: Number(rows[0].outbox),
    recipients: Number(rows[0].recipients)
  };
}

async function canonicalPair({ patientUid, eventType, sourceTable, sourceId }) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT event_type, event_status, source_table, source_id, actor_uid,
            actor_role, visible_to_patient, payload, idempotency_key
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND event_type = $3
        AND source_table = $4
        AND source_id = $5
      ORDER BY created_at`,
    DEFAULT_TENANT,
    patientUid,
    eventType,
    sourceTable,
    String(sourceId)
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT action, action_status, resource_table, resource_id, actor_uid,
            actor_role, after_state, idempotency_key
       FROM clinical_audit_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND action = $3
        AND resource_table = $4
        AND resource_id = $5
      ORDER BY created_at`,
    DEFAULT_TENANT,
    patientUid,
    eventType,
    sourceTable,
    String(sourceId)
  );
  return { timeline, audit };
}

// Split `<state-fingerprint-base>:tx:<xid8>` revision keys (#589 regime for
// the six fixed canonical families). Genuine mutations carry a
// transaction-unique numeric xid8 suffix; the base keeps the persisted-state
// fingerprint, so A -> B -> A revisions 1 and 3 share a base while still
// owning distinct revision pairs. Mirrors the authoritative helper in
// maternity-anc-atomicity.deep.test.js / immunisation-canonical-atomicity.deep.test.js.
function splitRevisionKey(key) {
  const marker = String(key).lastIndexOf(':tx:');
  if (marker === -1) return { base: String(key), tx: null };
  return { base: String(key).slice(0, marker), tx: String(key).slice(marker + 4) };
}

// Tuple-identity probe: maternity_anc_visits has NO updated_at column (see the
// service comment in recordAncVisit), so exact-retry stability is asserted via
// xmin plus the full row image. `- 'alerts'` mirrors the deep-test helper.
async function ancVisitTupleVersion(visitId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT xmin::text AS xmin, to_jsonb(v) - 'alerts' AS row_state
       FROM maternity_anc_visits v
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(visitId),
    DEFAULT_TENANT
  );
  return { xmin: rows[0].xmin, row_state: JSON.stringify(rows[0].row_state) };
}

async function newbornDoseTupleVersion(newbornImmunisationId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT xmin::text AS xmin, updated_at, to_jsonb(n) AS row_state
       FROM newborn_immunisations n
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(newbornImmunisationId),
    DEFAULT_TENANT
  );
  return {
    xmin: rows[0].xmin,
    updated_at: new Date(rows[0].updated_at).toISOString(),
    row_state: JSON.stringify(rows[0].row_state)
  };
}

async function userProjectionVersion(uid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT xmin::text AS xmin, updated_at, is_pregnant
       FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
    DEFAULT_TENANT,
    uid
  );
  return {
    xmin: rows[0].xmin,
    updated_at: new Date(rows[0].updated_at).toISOString(),
    is_pregnant: rows[0].is_pregnant
  };
}

async function ancCanonicalRevisions(patientUid) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT source_id, idempotency_key
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND event_type = 'maternity.anc_visit_recorded'
      ORDER BY created_at`,
    DEFAULT_TENANT,
    patientUid
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT resource_id, idempotency_key
       FROM clinical_audit_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND action = 'maternity.anc_visit_recorded'
      ORDER BY created_at`,
    DEFAULT_TENANT,
    patientUid
  );
  return { timeline, audit };
}

async function cleanupFixture() {
  const patientUids = [MOTHER_UID, TWIN_ONE_UID, TWIN_TWO_UID];
  const newbornPatientUids = [TWIN_ONE_UID, TWIN_TWO_UID];
  const allUids = [...patientUids, DOCTOR_UID, TENANT_B_DOCTOR_UID];
  const phones = [
    MOTHER_PHONE,
    TWIN_ONE_PHONE,
    TWIN_TWO_PHONE,
    DOCTOR_PHONE,
    TENANT_B_DOCTOR_PHONE
  ];
  const swallow = promise => promise.catch(() => {});

  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM engagement_campaign_recipients
      WHERE patient_uid = ANY($1::uuid[])`,
      patientUids
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM notification_outbox
      WHERE recipient_id = ANY($1::text[])
         OR recipient_phone = ANY($2::text[])`,
      patientUids,
      phones
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM patient_immunisations
      WHERE patient_uid = ANY($1::uuid[])`,
      newbornPatientUids
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM newborn_immunisations
      WHERE newborn_id IN (
        SELECT n.id
          FROM maternity_newborns n
          JOIN maternity_deliveries d ON d.id = n.delivery_id
          JOIN maternity_pregnancies p ON p.id = d.pregnancy_id
         WHERE p.patient_uid = $1::uuid
      )`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM maternity_postnatal_visits
      WHERE delivery_id IN (
        SELECT d.id
          FROM maternity_deliveries d
          JOIN maternity_pregnancies p ON p.id = d.pregnancy_id
         WHERE p.patient_uid = $1::uuid
      )`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM maternity_apgar_scores
      WHERE newborn_id IN (
        SELECT n.id
          FROM maternity_newborns n
          JOIN maternity_deliveries d ON d.id = n.delivery_id
          JOIN maternity_pregnancies p ON p.id = d.pregnancy_id
         WHERE p.patient_uid = $1::uuid
      )`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM maternity_newborns
      WHERE delivery_id IN (
        SELECT d.id
          FROM maternity_deliveries d
          JOIN maternity_pregnancies p ON p.id = d.pregnancy_id
         WHERE p.patient_uid = $1::uuid
      )`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM maternity_deliveries
      WHERE pregnancy_id IN (
        SELECT id FROM maternity_pregnancies WHERE patient_uid = $1::uuid
      )`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM maternity_partograph_entries
      WHERE labor_admission_id IN (
        SELECT la.id
          FROM maternity_labor_admissions la
          JOIN maternity_pregnancies p ON p.id = la.pregnancy_id
         WHERE p.patient_uid = $1::uuid
      )`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM maternity_labor_admissions
      WHERE pregnancy_id IN (
        SELECT id FROM maternity_pregnancies WHERE patient_uid = $1::uuid
      )`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM maternity_anc_visits
      WHERE pregnancy_id IN (
        SELECT id FROM maternity_pregnancies WHERE patient_uid = $1::uuid
      )`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events
      WHERE patient_uid = ANY($1::uuid[])`,
      patientUids
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events
      WHERE patient_uid = ANY($1::uuid[])`,
      patientUids
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM investigations
      WHERE patient_uid = $1::uuid AND test_name = $2`,
      MOTHER_UID,
      `Journey anomaly ultrasound ${RUN}`
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE patient_uid = $1::uuid`,
      MOTHER_UID
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid AND code = $2`,
      DEFAULT_TENANT,
      VACCINE_CODE
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM patient_access_audit_log
      WHERE patient_uid = ANY($1::uuid[])`,
      patientUids
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM care_team_members
      WHERE patient_uid = ANY($1::uuid[])`,
      patientUids
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM care_teams
      WHERE patient_uid = ANY($1::uuid[])`,
      patientUids
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM hipaa_access_log
      WHERE tenant_id = $1::uuid
         OR accessed_by = ANY($2::uuid[])
         OR patient_id = ANY($3::text[])`,
      TENANT_B,
      allUids,
      patientUids
    )
  );
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs
      WHERE uid = ANY($1::uuid[])
         OR metadata->>'patient_uid' = ANY($2::text[])`,
      allUids,
      patientUids
    )
  );
  await swallow(prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids));
  await swallow(prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B));
}

describeJourney('Journey: OBGyn maternity to newborn immunisation', () => {
  let doctor;
  let patient;
  let tenantBDoctor;
  let motherId;
  let pregnancyId;
  let ancVisitId;
  let ancVisitPayload;
  let laborId;
  let partographId;
  let deliveryId;
  let twinOneId;
  let twinTwoId;
  let vaccineCatalogueId;
  let birthDate;
  let baselineOutboxCount;
  let baselineRecipientCount;
  let originalGate;
  const canonicalSourceIds = new Map();

  beforeAll(async () => {
    originalGate = process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
    delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;

    await cleanupFixture();
    const baselineOutbound = await outboundCounts();
    baselineOutboxCount = baselineOutbound.outbox;
    baselineRecipientCount = baselineOutbound.recipients;
    birthDate = await hospitalToday();

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, $3)`,
      TENANT_B,
      `obgyn-journey-b-${RUN}`,
      `OBGyn Journey Tenant B ${RUN}`
    );

    const mother = await seedUser({
      uid: MOTHER_UID,
      phone: MOTHER_PHONE,
      name: `OBGyn Mother ${RUN}`,
      role: 'PATIENT',
      gender: 'Female'
    });
    motherId = Number(mother.id);
    const twinOne = await seedUser({
      uid: TWIN_ONE_UID,
      phone: TWIN_ONE_PHONE,
      name: `OBGyn Twin One ${RUN}`,
      role: 'PATIENT',
      gender: 'Female',
      extraCols: { birthday: birthDate }
    });
    await seedUser({
      uid: TWIN_TWO_UID,
      phone: TWIN_TWO_PHONE,
      name: `OBGyn Twin Two ${RUN}`,
      role: 'PATIENT',
      gender: 'Male',
      extraCols: { birthday: birthDate }
    });
    const doctorRow = await seedUser({
      uid: DOCTOR_UID,
      phone: DOCTOR_PHONE,
      name: `OBGyn Doctor ${RUN}`,
      role: 'DOCTOR'
    });
    const tenantBDoctorRow = await seedUser({
      uid: TENANT_B_DOCTOR_UID,
      phone: TENANT_B_DOCTOR_PHONE,
      name: `OBGyn Tenant B Doctor ${RUN}`,
      role: 'DOCTOR',
      extraCols: { tenant_id: TENANT_B }
    });

    doctor = clientForTenant('DOCTOR', {
      uid: DOCTOR_UID,
      id: Number(doctorRow.id),
      phone: DOCTOR_PHONE,
      tenantId: DEFAULT_TENANT
    });
    patient = clientForTenant('PATIENT', {
      uid: MOTHER_UID,
      id: motherId,
      phone: MOTHER_PHONE,
      tenantId: DEFAULT_TENANT
    });
    tenantBDoctor = clientForTenant('DOCTOR', {
      uid: TENANT_B_DOCTOR_UID,
      id: Number(tenantBDoctorRow.id),
      phone: TENANT_B_DOCTOR_PHONE,
      tenantId: TENANT_B
    });

    const careTeam = await prisma.$queryRawUnsafe(
      `INSERT INTO care_teams
         (tenant_id, patient_uid, team_kind, display_name, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'longitudinal', $3, 'active', $4::uuid, NOW())
       RETURNING id`,
      DEFAULT_TENANT,
      MOTHER_UID,
      `OBGyn Journey Care Team ${RUN}`,
      DOCTOR_UID
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO care_team_members
         (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
          relationship_kind, break_glass_allowed, created_by, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'DOCTOR', $5,
               'primary_consultant', false, $4::uuid, NOW())`,
      DEFAULT_TENANT,
      Number(careTeam[0].id),
      MOTHER_UID,
      DOCTOR_UID,
      `OBGyn Doctor ${RUN}`
    );

    const catalogue = await prisma.$queryRawUnsafe(
      `INSERT INTO vaccine_catalogue
         (code, display_name, dose_number, recommended_age_days, window_days,
          active, schedule_source, source_version, tenant_id)
       VALUES ($1, $2, NULL, 0, 28, true, 'uip', $3, $4::uuid)
       RETURNING id`,
      VACCINE_CODE,
      `Journey BCG ${RUN}`,
      `journey-${RUN}`,
      DEFAULT_TENANT
    );
    vaccineCatalogueId = Number(catalogue[0].id);
    expect(Number(twinOne.id)).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await cleanupFixture();
    if (originalGate === undefined) delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
    else process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = originalGate;
    await prisma.$disconnect().catch(() => {});
  }, TEST_TIMEOUT_MS);

  it('records pregnancy and factual ANC state through the staff API', async () => {
    const lmpDate = await hospitalDateOffset(-252);
    const pregnancy = await doctor.post('/api/v1/maternity/pregnancies').send({
      patient_uid: MOTHER_UID,
      lmp_date: lmpDate,
      gravida: 2,
      parity: 0,
      living_children: 0,
      booking_status: 'booked'
    });
    expect(pregnancy.statusCode).toBe(200);
    expect(pregnancy.body.success).toBe(true);
    pregnancyId = Number(pregnancy.body.data.id);
    canonicalSourceIds.set('maternity.pregnancy_created', pregnancyId);

    ancVisitPayload = {
      pregnancy_id: pregnancyId,
      visit_date: birthDate,
      gestational_age_weeks: 36,
      weight_kg: 66.2,
      bp_systolic: 118,
      bp_diastolic: 76,
      fetal_heart_rate_bpm: 146,
      fetal_movements_felt: true,
      presentation: 'cephalic'
    };
    const anc = await doctor.post('/api/v1/maternity/anc-visits').send(ancVisitPayload);
    expect(anc.statusCode).toBe(200);
    ancVisitId = Number(anc.body.data.id);
    expect(ancVisitId).toBeGreaterThan(0);
    canonicalSourceIds.set('maternity.anc_visit_recorded', ancVisitId);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.status, u.is_pregnant, u.pregnancy_lmp_date::text AS pregnancy_lmp_date
         FROM maternity_pregnancies p
         JOIN users u ON u.uid = p.patient_uid AND u.tenant_id = p.tenant_id
        WHERE p.id = $1::int AND p.tenant_id = $2::uuid`,
      pregnancyId,
      DEFAULT_TENANT
    );
    expect(rows[0]).toMatchObject({
      status: 'ongoing',
      is_pregnant: true,
      pregnancy_lmp_date: lmpDate
    });
  });

  it('replays exact ANC retries as no-ops and records A-B-A as three distinct revisions', async () => {
    // Approved #589 regime (canonical revision-sequence fix, merged 4c160af47)
    // exercised once end-to-end through the staff API; the exhaustive matrix
    // lives in maternity-anc-atomicity.deep.test.js. Exact retries return via
    // the effective-state guard: the visit tuple keeps its xmin (the table has
    // no updated_at), the users.is_pregnant projection is untouched, and no
    // canonical pair is emitted. Genuine mutations stamp
    // `<state-fingerprint>:tx:<xid8>` keys on BOTH canonical tables, so an
    // A -> B -> A cycle yields three distinct revision pairs whose first and
    // third keys share a fingerprint base.
    const tupleBefore = await ancVisitTupleVersion(ancVisitId);
    const userBefore = await userProjectionVersion(MOTHER_UID);
    const baseline = await ancCanonicalRevisions(MOTHER_UID);
    expect(baseline.timeline).toHaveLength(1);
    expect(baseline.audit).toHaveLength(1);

    const exactRetry = await doctor.post('/api/v1/maternity/anc-visits').send(ancVisitPayload);
    expect(exactRetry.statusCode).toBe(200);
    expect(Number(exactRetry.body.data.id)).toBe(ancVisitId);

    const tupleAfterRetry = await ancVisitTupleVersion(ancVisitId);
    expect(tupleAfterRetry.xmin).toBe(tupleBefore.xmin);
    expect(tupleAfterRetry.row_state).toBe(tupleBefore.row_state);
    const userAfterRetry = await userProjectionVersion(MOTHER_UID);
    expect(userAfterRetry.xmin).toBe(userBefore.xmin);
    expect(userAfterRetry.updated_at).toBe(userBefore.updated_at);
    expect(userAfterRetry.is_pregnant).toBe(true);
    const afterRetry = await ancCanonicalRevisions(MOTHER_UID);
    expect(afterRetry.timeline).toHaveLength(1);
    expect(afterRetry.audit).toHaveLength(1);

    // B keeps BP below the 140/90 pre-eclampsia alert threshold so the
    // journey's notification-free invariant is not disturbed.
    const stateB = await doctor
      .post('/api/v1/maternity/anc-visits')
      .send({ ...ancVisitPayload, bp_systolic: 122 });
    expect(stateB.statusCode).toBe(200);
    expect(Number(stateB.body.data.id)).toBe(ancVisitId);
    const backToA = await doctor.post('/api/v1/maternity/anc-visits').send(ancVisitPayload);
    expect(backToA.statusCode).toBe(200);
    expect(Number(backToA.body.data.id)).toBe(ancVisitId);

    // Still exactly one same-day visit row, restored byte-for-byte to state A
    // (the UPSERT merges on (pregnancy_id, visit_date)); the tuple was
    // genuinely rewritten along the way.
    const visits = await prisma.$queryRawUnsafe(
      `SELECT id, bp_systolic
         FROM maternity_anc_visits
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      DEFAULT_TENANT,
      pregnancyId
    );
    expect(visits).toHaveLength(1);
    expect(Number(visits[0].id)).toBe(ancVisitId);
    expect(visits[0].bp_systolic).toBe(118);
    const tupleFinal = await ancVisitTupleVersion(ancVisitId);
    expect(tupleFinal.row_state).toBe(tupleBefore.row_state);
    expect(tupleFinal.xmin).not.toBe(tupleBefore.xmin);

    const revisions = await ancCanonicalRevisions(MOTHER_UID);
    expect(revisions.timeline).toHaveLength(3);
    expect(revisions.audit).toHaveLength(3);
    expect(revisions.timeline.every(row => row.source_id === String(ancVisitId))).toBe(true);
    expect(revisions.audit.every(row => row.resource_id === String(ancVisitId))).toBe(true);
    expect(new Set(revisions.timeline.map(row => row.idempotency_key)).size).toBe(3);
    expect(new Set(revisions.audit.map(row => row.idempotency_key)).size).toBe(3);

    const timelineKeys = revisions.timeline.map(row => splitRevisionKey(row.idempotency_key));
    const auditKeys = revisions.audit.map(row => splitRevisionKey(row.idempotency_key));
    expect(timelineKeys.every(({ tx }) => tx && /^\d+$/.test(tx))).toBe(true);
    expect(auditKeys.every(({ tx }) => tx && /^\d+$/.test(tx))).toBe(true);
    expect(
      timelineKeys.every(({ base }) => base.startsWith(`maternity_anc_visits:${ancVisitId}:`))
    ).toBe(true);
    expect(
      auditKeys.every(({ base }) => base.startsWith(`maternity_anc_visits:${ancVisitId}:audit:`))
    ).toBe(true);
    // Revisions 1 and 3 share the persisted-state base but not the xid; the
    // timeline and audit halves of each mutation share one transaction.
    expect(timelineKeys[0].base).toBe(timelineKeys[2].base);
    expect(timelineKeys[1].base).not.toBe(timelineKeys[0].base);
    expect(timelineKeys[0].tx).not.toBe(timelineKeys[2].tx);
    expect(auditKeys[0].base).toBe(auditKeys[2].base);
    expect(auditKeys[0].tx).not.toBe(auditKeys[2].tx);
    expect(auditKeys.map(({ tx }) => tx)).toEqual(timelineKeys.map(({ tx }) => tx));
  });

  it('rejects cross-tenant pregnancy reads and ANC writes without side effects', async () => {
    const read = await tenantBDoctor.get(`/api/v1/maternity/pregnancies/${pregnancyId}`);
    expect(read.statusCode).toBe(404);

    const write = await tenantBDoctor.post('/api/v1/maternity/anc-visits').send({
      pregnancy_id: pregnancyId,
      visit_date: birthDate,
      bp_systolic: 160,
      bp_diastolic: 110
    });
    expect(write.statusCode).toBe(404);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, id
         FROM maternity_anc_visits
        WHERE pregnancy_id = $1::int`,
      pregnancyId
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].tenant_id)).toBe(DEFAULT_TENANT);
    expect(Number(rows[0].id)).toBe(ancVisitId);
  });

  it('keeps imaging narrative out of all patient ANC boundaries while preserving staff access', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO investigations
         (phone, patient_id, patient_uid, test_name, test_type, status,
          priority, requested_by, requested_at, completed_at, result_summary,
          created_at, updated_at)
       VALUES ($1, $2::int, $3::uuid, $4, 'RADIOLOGY', 'COMPLETED',
               'NORMAL', $5::uuid, NOW(), NOW(), $6, NOW(), NOW())`,
      MOTHER_PHONE,
      motherId,
      MOTHER_UID,
      `Journey anomaly ultrasound ${RUN}`,
      DOCTOR_UID,
      PRIVATE_IMAGING
    );

    const staff = await doctor.get(`/api/v1/maternity/pregnancies/${pregnancyId}/timeline`);
    expect(staff.statusCode).toBe(200);
    expect(staff.body.data.prior_imaging).toEqual(
      expect.arrayContaining([expect.objectContaining({ result_summary: PRIVATE_IMAGING })])
    );

    const patientResponses = await Promise.all([
      patient.get('/api/v1/portal/maternity/timeline'),
      patient.get(`/api/v1/maternity/timeline/patient/${MOTHER_UID}`),
      patient.get(`/api/v1/maternity/pregnancies/${pregnancyId}/timeline`)
    ]);
    for (const response of patientResponses) {
      expect(response.statusCode).toBe(200);
      expect(response.body.data).not.toHaveProperty('prior_imaging');
      expect(JSON.stringify(response.body.data)).not.toContain(PRIVATE_IMAGING);
    }
  });

  it('records labour, partograph and delivery with landed staff-only canonical pairs', async () => {
    const labor = await doctor.post('/api/v1/maternity/labor-admissions').send({
      pregnancy_id: pregnancyId,
      admission_reason: 'spontaneous_labour',
      gestational_age_weeks: 36,
      cervix_dilation_cm: 4,
      fetal_heart_rate_bpm: 142,
      labor_started_at: `${birthDate}T00:00:00.000Z`,
      attending_obstetrician: DOCTOR_UID,
      notes: PRIVATE_LABOUR
    });
    expect(labor.statusCode).toBe(200);
    laborId = Number(labor.body.data.id);
    canonicalSourceIds.set('maternity.labor_admission_recorded', laborId);

    const partograph = await doctor.post('/api/v1/maternity/partograph').send({
      labor_admission_id: laborId,
      recorded_at: `${birthDate}T03:00:00.000Z`,
      bp_systolic: 122,
      bp_diastolic: 78,
      cervix_dilation_cm: 6,
      contractions_per_10min: 3,
      fetal_heart_rate_bpm: 144,
      notes: PRIVATE_PARTOGRAPH
    });
    expect(partograph.statusCode).toBe(200);
    partographId = Number(partograph.body.data.id);
    canonicalSourceIds.set('maternity.partograph_entry_recorded', partographId);

    const delivery = await doctor.post('/api/v1/maternity/deliveries').send({
      pregnancy_id: pregnancyId,
      labor_admission_id: laborId,
      delivery_datetime: `${birthDate}T05:00:00.000Z`,
      delivery_mode: 'nvd',
      delivered_by: DOCTOR_UID,
      delivered_by_name: `OBGyn Doctor ${RUN}`,
      notes: PRIVATE_DELIVERY
    });
    expect(delivery.statusCode).toBe(200);
    deliveryId = Number(delivery.body.data.id);
    canonicalSourceIds.set('maternity.delivery_recorded', deliveryId);

    for (const expected of LANDED_CANONICAL_EVENTS) {
      const timeline = await prisma.$queryRawUnsafe(
        `SELECT event_type, source_table, source_id, actor_uid, actor_role,
                visible_to_patient, payload
           FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND event_type = $3
          ORDER BY created_at`,
        DEFAULT_TENANT,
        MOTHER_UID,
        expected.eventType
      );
      const audit = await prisma.$queryRawUnsafe(
        `SELECT action, resource_table, resource_id, actor_uid, actor_role,
                action_status, after_state, metadata
           FROM clinical_audit_events
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND action = $3
          ORDER BY created_at`,
        DEFAULT_TENANT,
        MOTHER_UID,
        expected.eventType
      );
      // Per-family revision counts under the #589 regime — every genuine
      // mutation owns exactly one timeline+audit pair, exact retries none.
      expect(timeline).toHaveLength(expected.expectedRevisions);
      expect(audit).toHaveLength(expected.expectedRevisions);
      for (const row of timeline) {
        expect(row).toMatchObject({
          event_type: expected.eventType,
          source_table: expected.sourceTable,
          source_id: String(canonicalSourceIds.get(expected.eventType)),
          actor_uid: DOCTOR_UID,
          actor_role: 'DOCTOR',
          visible_to_patient: false
        });
      }
      for (const row of audit) {
        expect(row).toMatchObject({
          action: expected.eventType,
          resource_table: expected.sourceTable,
          resource_id: String(canonicalSourceIds.get(expected.eventType)),
          actor_uid: DOCTOR_UID,
          actor_role: 'DOCTOR',
          action_status: 'success'
        });
      }
      const canonicalText = JSON.stringify({ timeline, audit });
      for (const privateMarker of PRIVATE_MARKERS) {
        expect(canonicalText).not.toContain(privateMarker);
      }
    }

    const state = await prisma.$queryRawUnsafe(
      `SELECT p.status AS pregnancy_status, la.status AS labor_status, u.is_pregnant
         FROM maternity_pregnancies p
         JOIN maternity_labor_admissions la ON la.pregnancy_id = p.id
         JOIN users u ON u.uid = p.patient_uid AND u.tenant_id = p.tenant_id
        WHERE p.id = $1::int AND la.id = $2::int`,
      pregnancyId,
      laborId
    );
    expect(state[0]).toMatchObject({
      pregnancy_status: 'delivered',
      labor_status: 'delivered',
      is_pregnant: false
    });
  });

  it('records twins, Apgar scores and mother/baby postnatal visits', async () => {
    const twinOne = await doctor.post('/api/v1/maternity/newborns').send({
      delivery_id: deliveryId,
      birth_order: 1,
      birth_datetime: `${birthDate}T05:01:00.000Z`,
      sex: 'female',
      birth_weight_g: 2480,
      outcome: 'live',
      newborn_patient_uid: TWIN_ONE_UID
    });
    expect(twinOne.statusCode).toBe(200);
    twinOneId = Number(twinOne.body.data.id);

    const twinTwo = await doctor.post('/api/v1/maternity/newborns').send({
      delivery_id: deliveryId,
      birth_order: 2,
      birth_datetime: `${birthDate}T05:04:00.000Z`,
      sex: 'male',
      birth_weight_g: 2360,
      outcome: 'live',
      newborn_patient_uid: TWIN_TWO_UID
    });
    expect(twinTwo.statusCode).toBe(200);
    twinTwoId = Number(twinTwo.body.data.id);

    for (const newbornId of [twinOneId, twinTwoId]) {
      for (const timeMinute of [1, 5]) {
        const apgar = await doctor.post(`/api/v1/maternity/newborns/${newbornId}/apgar`).send({
          time_minute: timeMinute,
          appearance: timeMinute === 1 ? 1 : 2,
          pulse: 2,
          grimace: 2,
          activity: 2,
          respiration: 2
        });
        expect(apgar.statusCode).toBe(200);
        expect(apgar.body.data).toEqual(
          expect.objectContaining({
            time_minute: timeMinute,
            appearance: timeMinute === 1 ? 1 : 2,
            pulse: 2,
            grimace: 2,
            activity: 2,
            respiration: 2
          })
        );
        const componentTotal = ['appearance', 'pulse', 'grimace', 'activity', 'respiration']
          .map(component => Number(apgar.body.data[component]))
          .reduce((sum, score) => sum + score, 0);
        expect(componentTotal).toBe(timeMinute === 1 ? 9 : 10);
      }
    }

    const motherVisit = await doctor.post('/api/v1/maternity/postnatal-visits').send({
      delivery_id: deliveryId,
      visit_at: `${birthDate}T11:00:00.000Z`,
      visit_kind: 'mother',
      mother_temp_c: 36.8,
      mother_pulse_bpm: 82,
      breastfeeding_status: 'initiated'
    });
    expect(motherVisit.statusCode).toBe(200);

    for (const [newbornId, weight] of [
      [twinOneId, 2460],
      [twinTwoId, 2340]
    ]) {
      const babyVisit = await doctor.post('/api/v1/maternity/postnatal-visits').send({
        delivery_id: deliveryId,
        newborn_id: newbornId,
        visit_at: `${birthDate}T11:15:00.000Z`,
        visit_kind: 'baby',
        baby_weight_g: weight,
        baby_temperature_c: 36.7,
        baby_feeding: 'breastfeeding'
      });
      expect(babyVisit.statusCode).toBe(200);
    }

    const newborns = await doctor.get(`/api/v1/maternity/newborns/delivery/${deliveryId}`);
    expect(newborns.statusCode).toBe(200);
    expect(newborns.body.data.map(row => Number(row.birth_order))).toEqual([1, 2]);
    expect(newborns.body.data.every(row => row.apgar.length === 2)).toBe(true);

    const postnatal = await doctor.get(`/api/v1/maternity/postnatal-visits/delivery/${deliveryId}`);
    expect(postnatal.statusCode).toBe(200);
    expect(postnatal.body.data).toHaveLength(3);
  });

  it('explicitly seeds, reads and records exact O1 links with M-D canonical coverage', async () => {
    for (const newbornId of [twinOneId, twinTwoId]) {
      const first = await doctor
        .post(`/api/v1/maternity/newborns/${newbornId}/immunisations/seed`)
        .send({});
      expect(first.statusCode).toBe(200);
      expect(Number(first.body.data.scheduled)).toBeGreaterThanOrEqual(1);
      const second = await doctor
        .post(`/api/v1/maternity/newborns/${newbornId}/immunisations/seed`)
        .send({});
      expect(second.statusCode).toBe(200);
      expect(Number(second.body.data.scheduled)).toBe(0);

      const beforeRead = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total
           FROM newborn_immunisations
          WHERE tenant_id = $1::uuid AND newborn_id = $2::int`,
        DEFAULT_TENANT,
        newbornId
      );
      const schedule = await doctor.get(`/api/v1/maternity/newborns/${newbornId}/immunisations`);
      expect(schedule.statusCode).toBe(200);
      expect(schedule.body.data.filter(row => row.code === VACCINE_CODE)).toHaveLength(1);
      const afterRead = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total
           FROM newborn_immunisations
          WHERE tenant_id = $1::uuid AND newborn_id = $2::int`,
        DEFAULT_TENANT,
        newbornId
      );
      expect(Number(afterRead[0].total)).toBe(Number(beforeRead[0].total));
    }

    for (const patientUid of [TWIN_ONE_UID, TWIN_TWO_UID]) {
      const first = await doctor.post('/api/v1/paediatric/immunisations/seed').send({
        patient_uid: patientUid,
        dob: birthDate
      });
      expect(first.statusCode).toBe(200);
      expect(Number(first.body.data.inserted)).toBeGreaterThanOrEqual(1);
      expect(Number(first.body.data.linked)).toBeGreaterThanOrEqual(1);
      const retry = await doctor.post('/api/v1/paediatric/immunisations/seed').send({
        patient_uid: patientUid,
        dob: birthDate
      });
      expect(retry.statusCode).toBe(200);
      expect(Number(retry.body.data.inserted)).toBe(0);
      expect(Number(retry.body.data.linked)).toBe(0);

      const beforeRead = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total
           FROM patient_immunisations
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
        DEFAULT_TENANT,
        patientUid
      );
      const list = await doctor.get(`/api/v1/paediatric/immunisations/patient/${patientUid}`);
      expect(list.statusCode).toBe(200);
      const matching = list.body.data.filter(row => row.code === VACCINE_CODE);
      expect(matching).toHaveLength(1);
      expect(matching[0].newborn_immunisation_id).toBeTruthy();

      const afterRead = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total
           FROM patient_immunisations
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
        DEFAULT_TENANT,
        patientUid
      );
      expect(Number(afterRead[0].total)).toBe(Number(beforeRead[0].total));
    }

    const twinOneDose = await prisma.$queryRawUnsafe(
      `SELECT pi.id AS patient_immunisation_id,
              pi.newborn_immunisation_id,
              ni.newborn_id
         FROM patient_immunisations pi
         JOIN newborn_immunisations ni ON ni.id = pi.newborn_immunisation_id
        WHERE pi.tenant_id = $1::uuid
          AND pi.patient_uid = $2::uuid
          AND pi.vaccine_catalogue_id = $3::int`,
      DEFAULT_TENANT,
      TWIN_ONE_UID,
      vaccineCatalogueId
    );
    expect(twinOneDose).toHaveLength(1);
    expect(Number(twinOneDose[0].newborn_id)).toBe(twinOneId);

    // Subject attribution (patientUid here): the seed's clinical_patient_uid
    // CASE resolves to the NEWBORN's own patient UID because the identity is
    // present and unambiguous in-tenant; absent/ambiguous identities fall back
    // to the MOTHER. This pins UNAPPROVED status-quo subject attribution
    // pending decision D7 — will change with the signed shape.
    const newbornSeedCanonical = await canonicalPair({
      patientUid: TWIN_ONE_UID,
      eventType: 'immunisation.schedule_seeded',
      sourceTable: 'newborn_immunisations',
      sourceId: twinOneDose[0].newborn_immunisation_id
    });
    expect(newbornSeedCanonical.timeline).toHaveLength(1);
    expect(newbornSeedCanonical.audit).toHaveLength(1);
    expect(newbornSeedCanonical.timeline[0]).toMatchObject({
      event_status: 'scheduled',
      actor_uid: DOCTOR_UID,
      actor_role: 'DOCTOR',
      visible_to_patient: false,
      payload: expect.objectContaining({
        newborn_id: twinOneId,
        vaccine_catalogue_id: vaccineCatalogueId,
        status: 'scheduled'
      })
    });

    const patientSeedCanonical = await canonicalPair({
      patientUid: TWIN_ONE_UID,
      eventType: 'immunisation.schedule_seeded',
      sourceTable: 'patient_immunisations',
      sourceId: twinOneDose[0].patient_immunisation_id
    });
    expect(patientSeedCanonical.timeline).toHaveLength(1);
    expect(patientSeedCanonical.audit).toHaveLength(1);
    expect(patientSeedCanonical.timeline[0]).toMatchObject({
      event_status: 'scheduled',
      actor_uid: DOCTOR_UID,
      actor_role: 'DOCTOR',
      visible_to_patient: false,
      payload: expect.objectContaining({
        vaccine_catalogue_id: vaccineCatalogueId,
        linked_to_newborn: true,
        status: 'scheduled'
      })
    });

    const doseInput = {
      status: 'given',
      given_at: `${birthDate}T12:00:00.000Z`,
      given_by_name: `OBGyn Doctor ${RUN}`,
      batch_number: `JRN-${RUN}`,
      manufacturer: `Journey Manufacturer ${RUN}`,
      site_of_injection: 'left_thigh',
      notes: PRIVATE_IMMUNISATION
    };

    const recorded = await doctor
      .post(`/api/v1/paediatric/immunisations/${twinOneDose[0].patient_immunisation_id}/given`)
      .send(doseInput);
    expect(recorded.statusCode).toBe(200);

    // #589 exact-retry semantics: a semantically identical retry succeeds as
    // a no-op — the linked newborn tuple keeps its xmin/updated_at/row image
    // and no new canonical pair is emitted (asserted below).
    const doseTupleBefore = await newbornDoseTupleVersion(
      twinOneDose[0].newborn_immunisation_id
    );
    const exactRetry = await doctor
      .post(`/api/v1/paediatric/immunisations/${twinOneDose[0].patient_immunisation_id}/given`)
      .send(doseInput);
    expect(exactRetry.statusCode).toBe(200);
    const doseTupleAfterRetry = await newbornDoseTupleVersion(
      twinOneDose[0].newborn_immunisation_id
    );
    expect(doseTupleAfterRetry.xmin).toBe(doseTupleBefore.xmin);
    expect(doseTupleAfterRetry.updated_at).toBe(doseTupleBefore.updated_at);
    expect(doseTupleAfterRetry.row_state).toBe(doseTupleBefore.row_state);

    const stored = await prisma.$queryRawUnsafe(
      `SELECT pi.status AS patient_status, pi.given_at AS patient_given_at,
              ni.status AS newborn_status, ni.given_at AS newborn_given_at,
              ni.batch_number, ni.manufacturer, ni.site_of_injection
         FROM patient_immunisations pi
         JOIN newborn_immunisations ni ON ni.id = pi.newborn_immunisation_id
        WHERE pi.id = $1::int`,
      Number(twinOneDose[0].patient_immunisation_id)
    );
    expect(stored[0].patient_status).toBe('scheduled');
    expect(stored[0].patient_given_at).toBeNull();
    expect(stored[0].newborn_status).toBe('given');
    // #590: given_at is a Date-typed instant end-to-end, so the stored value
    // equals the submitted instant exactly, including on non-UTC hosts.
    expect(new Date(stored[0].newborn_given_at).toISOString()).toBe(
      `${birthDate}T12:00:00.000Z`
    );
    expect(stored[0]).toMatchObject({
      batch_number: `JRN-${RUN}`,
      manufacturer: `Journey Manufacturer ${RUN}`,
      site_of_injection: 'left_thigh'
    });

    // Subject attribution (patientUid here) follows the exact tenant-scoped
    // newborn linkage; this pins UNAPPROVED status-quo subject attribution
    // pending decision D7 — will change with the signed shape.
    const doseCanonical = await canonicalPair({
      patientUid: TWIN_ONE_UID,
      eventType: 'immunisation.dose_recorded',
      sourceTable: 'newborn_immunisations',
      sourceId: twinOneDose[0].newborn_immunisation_id
    });
    expect(doseCanonical.timeline).toHaveLength(1);
    expect(doseCanonical.audit).toHaveLength(1);
    // #589 key regime: the genuine dose mutation owns one revision pair keyed
    // `<table>:<id>:recorded:<sha256-state-fingerprint>:tx:<xid8>` (audit adds
    // the `:audit:` segment); the exact retry above added none.
    expect(doseCanonical.timeline[0].idempotency_key).toMatch(
      new RegExp(
        `^newborn_immunisations:${Number(twinOneDose[0].newborn_immunisation_id)}` +
          ':recorded:[0-9a-f]{64}:tx:\\d+$'
      )
    );
    expect(doseCanonical.audit[0].idempotency_key).toMatch(
      new RegExp(
        `^newborn_immunisations:${Number(twinOneDose[0].newborn_immunisation_id)}` +
          ':audit:recorded:[0-9a-f]{64}:tx:\\d+$'
      )
    );
    expect(splitRevisionKey(doseCanonical.timeline[0].idempotency_key).tx).toBe(
      splitRevisionKey(doseCanonical.audit[0].idempotency_key).tx
    );
    expect(doseCanonical.timeline[0]).toMatchObject({
      event_status: 'given',
      actor_uid: DOCTOR_UID,
      actor_role: 'DOCTOR',
      visible_to_patient: false,
      payload: expect.objectContaining({
        patient_immunisation_id: Number(twinOneDose[0].patient_immunisation_id),
        newborn_immunisation_id: Number(twinOneDose[0].newborn_immunisation_id),
        batch_number: `JRN-${RUN}`,
        manufacturer: `Journey Manufacturer ${RUN}`,
        site_of_injection: 'left_thigh'
      })
    });
    expect(doseCanonical.audit[0]).toMatchObject({
      action_status: 'success',
      actor_uid: DOCTOR_UID,
      actor_role: 'DOCTOR',
      after_state: expect.objectContaining({
        status: 'given',
        batch_number: `JRN-${RUN}`,
        manufacturer: `Journey Manufacturer ${RUN}`,
        site_of_injection: 'left_thigh'
      })
    });
    expect(JSON.stringify(doseCanonical)).not.toContain(PRIVATE_IMMUNISATION);

    const deduped = await doctor.get(`/api/v1/paediatric/immunisations/patient/${TWIN_ONE_UID}`);
    expect(deduped.statusCode).toBe(200);
    const visibleDose = deduped.body.data.filter(row => row.code === VACCINE_CODE);
    expect(visibleDose).toHaveLength(1);
    expect(visibleDose[0].status).toBe('given');

    const newbornHistoryBeforeAmbiguity = await prisma.$queryRawUnsafe(
      `SELECT id, status, given_at, batch_number, manufacturer, site_of_injection
         FROM newborn_immunisations
        WHERE tenant_id = $1::uuid
          AND vaccine_catalogue_id = $2::int
          AND newborn_id = ANY($3::int[])
        ORDER BY id`,
      DEFAULT_TENANT,
      vaccineCatalogueId,
      [twinOneId, twinTwoId]
    );
    await prisma.$executeRawUnsafe(
      `UPDATE maternity_newborns
          SET newborn_patient_uid = $1::uuid
        WHERE tenant_id = $2::uuid AND id = $3::int`,
      TWIN_ONE_UID,
      DEFAULT_TENANT,
      twinTwoId
    );
    // Ambiguous infant identity (two newborns claiming one patient UID) makes
    // the linked write refuse with 409 instead of guessing a subject. This
    // pins UNAPPROVED status-quo subject attribution pending decision D7 —
    // will change with the signed shape.
    const ambiguousRetry = await doctor
      .post(`/api/v1/paediatric/immunisations/${twinOneDose[0].patient_immunisation_id}/given`)
      .send(doseInput);
    expect(ambiguousRetry.statusCode).toBe(409);
    expect(ambiguousRetry.body.message).toContain('no longer an exact tenant-scoped match');
    const newbornHistoryAfterAmbiguity = await prisma.$queryRawUnsafe(
      `SELECT id, status, given_at, batch_number, manufacturer, site_of_injection
         FROM newborn_immunisations
        WHERE tenant_id = $1::uuid
          AND vaccine_catalogue_id = $2::int
          AND newborn_id = ANY($3::int[])
        ORDER BY id`,
      DEFAULT_TENANT,
      vaccineCatalogueId,
      [twinOneId, twinTwoId]
    );
    expect(newbornHistoryAfterAmbiguity).toEqual(newbornHistoryBeforeAmbiguity);
    const canonicalAfterAmbiguity = await canonicalPair({
      patientUid: TWIN_ONE_UID,
      eventType: 'immunisation.dose_recorded',
      sourceTable: 'newborn_immunisations',
      sourceId: twinOneDose[0].newborn_immunisation_id
    });
    expect(canonicalAfterAmbiguity.timeline).toHaveLength(1);
    expect(canonicalAfterAmbiguity.audit).toHaveLength(1);

    const foreignRead = await tenantBDoctor.get(
      `/api/v1/paediatric/immunisations/patient/${TWIN_ONE_UID}`
    );
    expect(foreignRead.statusCode).toBe(404);
    const foreignRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM patient_immunisations
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_B,
      TWIN_ONE_UID
    );
    expect(foreignRows).toHaveLength(0);
  });

  it('keeps the completed journey staff-only, patient-safe and notification-free', async () => {
    const canonicalPatientRead = await patient.get(`/api/v1/emr/timeline/${MOTHER_UID}`);
    expect(canonicalPatientRead.statusCode).toBe(403);
    const canonicalStaffRead = await doctor.get(`/api/v1/emr/timeline/${MOTHER_UID}`);
    expect(canonicalStaffRead.statusCode).toBe(200);

    const patientResponses = await Promise.all([
      patient.get('/api/v1/portal/maternity/timeline'),
      patient.get(`/api/v1/maternity/timeline/patient/${MOTHER_UID}`),
      patient.get(`/api/v1/maternity/pregnancies/${pregnancyId}/timeline`)
    ]);
    for (const response of patientResponses) {
      expect(response.statusCode).toBe(200);
      const serialized = JSON.stringify(response.body.data);
      expect(response.body.data?.prior_imaging).toBeUndefined();
      for (const privateMarker of PRIVATE_MARKERS) {
        expect(serialized).not.toContain(privateMarker);
      }
    }

    const visibleMaternityEvents = await prisma.$queryRawUnsafe(
      `SELECT event_type
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND event_type = ANY($3::text[])
          AND visible_to_patient = true`,
      DEFAULT_TENANT,
      MOTHER_UID,
      LANDED_CANONICAL_EVENTS.map(({ eventType }) => eventType)
    );
    expect(visibleMaternityEvents).toHaveLength(0);

    const outbound = await outboundCounts();
    expect(outbound.outbox).toBe(baselineOutboxCount);
    expect(outbound.recipients).toBe(baselineRecipientCount);
  });
});
