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

// This journey walks the SIGNED D7 Shape-3 spine end-to-end (decision record
// obgyn-d7-decision-record.md, SHA-256 E82EEC9A054CA3708A31F48568818BB2
// 7F9986D8F5A02C37AF9407F4D5DB9562): pregnancy -> labour -> delivery ->
// recordNewborn (atomic infant identity minting, "B/O <mother>" naming,
// guardian=mother, consent evidence) -> immunisation seed+dose on the
// INFANT subject (M-D fail-closed, no mother fallback) -> Apgar (#589
// revision keys, service-computed total_score) -> postnatal visits under
// the B-i dual-pair rule with F-1 link-required rejection.
const RUN = runSuffix();
const TENANT_B = `c7b00000-0000-4000-8000-${RUN.padStart(12, '0')}`;
const MOTHER_UID = `c7000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DOCTOR_UID = `c7000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const TENANT_B_DOCTOR_UID = `c7000005-0000-4000-8000-${RUN.padStart(12, '0')}`;

const MOTHER_PHONE = `96801${RUN}`;
const DOCTOR_PHONE = `96804${RUN}`;
const TENANT_B_DOCTOR_PHONE = `96805${RUN}`;
const VACCINE_CODE = `JRNBCG${RUN}`;

const PRIVATE_IMAGING = `JOURNEY_PRIVATE_IMAGING_${RUN}`;
const PRIVATE_LABOUR = `JOURNEY_PRIVATE_LABOUR_${RUN}`;
const PRIVATE_PARTOGRAPH = `JOURNEY_PRIVATE_PARTOGRAPH_${RUN}`;
const PRIVATE_DELIVERY = `JOURNEY_PRIVATE_DELIVERY_${RUN}`;
const PRIVATE_IMMUNISATION = `JOURNEY_PRIVATE_IMMUNISATION_${RUN}`;
const PRIVATE_POSTNATAL = `JOURNEY_PRIVATE_POSTNATAL_${RUN}`;
const PRIVATE_RED_FLAG = `JOURNEY_PRIVATE_REDFLAG_${RUN}`;
const PRIVATE_MARKERS = [
  PRIVATE_IMAGING,
  PRIVATE_LABOUR,
  PRIVATE_PARTOGRAPH,
  PRIVATE_DELIVERY,
  PRIVATE_POSTNATAL,
  PRIVATE_RED_FLAG
];
const TEST_TIMEOUT_MS = 60_000;

// #589 revision-key regimes for the amendable infant-scope families landed by
// R1/R2 (PR #595/#596): `<table>:<id>:<fingerprint>:tx:<xid8>`. Apgar
// fingerprints are 32 hex chars (canonicalStateFingerprint), dose fingerprints
// 64 (full sha256) — both carry the transaction-unique xid8 suffix.
const APGAR_TIMELINE_KEY_RE = /^maternity_apgar_scores:\d+:[0-9a-f]{32}:tx:\d+$/;
const APGAR_AUDIT_KEY_RE = /^maternity_apgar_scores:\d+:audit:[0-9a-f]{32}:tx:\d+$/;

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
    post: path => auth(request(app).post(path)),
    patch: path => auth(request(app).patch(path))
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

// All canonical rows for one subject + event family, ordered. Used for the
// signed D7 subject-attribution assertions (infant-vs-mother separation).
async function subjectEvents(patientUid, eventType) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT source_id, idempotency_key, payload, visible_to_patient,
            actor_uid, actor_role
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND event_type = $3
      ORDER BY created_at, id`,
    DEFAULT_TENANT,
    patientUid,
    eventType
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT resource_id, idempotency_key, after_state, action_status,
            actor_uid, actor_role
       FROM clinical_audit_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND action = $3
      ORDER BY created_at, id`,
    DEFAULT_TENANT,
    patientUid,
    eventType
  );
  return { timeline, audit };
}

// Shape 3 mints the infant identities at recordNewborn time, so their uids
// are only known at runtime. Resolve them through the mother's maternity
// chain — works in beforeAll (empty on a fresh run) and afterAll alike, and
// MUST run before the maternity_newborns rows are deleted.
async function resolveMintedInfantUids() {
  const rows = await prisma
    .$queryRawUnsafe(
      `SELECT DISTINCT n.newborn_patient_uid AS uid
         FROM maternity_newborns n
         JOIN maternity_deliveries d ON d.id = n.delivery_id
         JOIN maternity_pregnancies p ON p.id = d.pregnancy_id
        WHERE p.patient_uid = $1::uuid
          AND n.newborn_patient_uid IS NOT NULL`,
      MOTHER_UID
    )
    .catch(() => []);
  return rows.map(row => String(row.uid));
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
  // Resolve the Shape-3 minted infant identities BEFORE deleting the
  // maternity rows that link to them.
  const infantUids = await resolveMintedInfantUids();
  const patientUids = [MOTHER_UID, ...infantUids];
  const allUids = [...patientUids, DOCTOR_UID, TENANT_B_DOCTOR_UID];
  const phones = [MOTHER_PHONE, DOCTOR_PHONE, TENANT_B_DOCTOR_PHONE];
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
      patientUids
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
  // Shape-3 residue: minted guardian consents, then the self-FK guardian
  // link (users.guardian_user_id -> mother) before the users delete.
  await swallow(
    prisma.$executeRawUnsafe(
      `DELETE FROM patient_consents
      WHERE patient_uid = ANY($1::uuid[])`,
      patientUids
    )
  );
  if (infantUids.length) {
    await swallow(
      prisma.$executeRawUnsafe(
        `UPDATE users SET guardian_user_id = NULL WHERE uid = ANY($1::uuid[])`,
        infantUids
      )
    );
  }
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
  let twinOneUid; // minted by Shape-3 at recordNewborn — runtime-only
  let twinTwoUid; // minted by Shape-3 at recordNewborn — runtime-only
  let bothVisitId;
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

    // Shape 3 (signed D7): NO pre-registered twin identities. The birth
    // workflow mints the infants' patient records atomically at
    // recordNewborn; the journey asserts the minted identities below.
    const mother = await seedUser({
      uid: MOTHER_UID,
      phone: MOTHER_PHONE,
      name: `OBGyn Mother ${RUN}`,
      role: 'PATIENT',
      gender: 'Female'
    });
    motherId = Number(mother.id);
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
    expect(vaccineCatalogueId).toBeGreaterThan(0);
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

  it('mints Shape-3 infant identities at birth with guardian links, consent evidence and canonical pairs', async () => {
    // Signed D7 S-1 Shape 3: recordNewborn atomically creates the infant's
    // OWN patient identity (no newborn_patient_uid supplied), the mother as
    // automatic initial guardian (G-1), guardian(mother) consent evidence
    // through patient_consents (G-3) and one insert-once canonical pair
    // whose subject is the INFANT.
    const twinInputs = [
      {
        birth_order: 1,
        birth_datetime: `${birthDate}T05:01:00.000Z`,
        sex: 'female',
        birth_weight_g: 2480,
        expectedName: `B/O OBGyn Mother ${RUN}`
      },
      {
        birth_order: 2,
        birth_datetime: `${birthDate}T05:04:00.000Z`,
        sex: 'male',
        birth_weight_g: 2360,
        expectedName: `Twin-2 B/O OBGyn Mother ${RUN}`
      }
    ];
    const minted = [];
    for (const input of twinInputs) {
      const response = await doctor.post('/api/v1/maternity/newborns').send({
        delivery_id: deliveryId,
        birth_order: input.birth_order,
        birth_datetime: input.birth_datetime,
        sex: input.sex,
        birth_weight_g: input.birth_weight_g,
        outcome: 'live'
      });
      expect(response.statusCode).toBe(200);
      const newborn = response.body.data;
      const infantUid = String(newborn.newborn_patient_uid);
      expect(newborn.minted_identity).toMatchObject({
        patient_uid: infantUid,
        guardian_user_id: motherId,
        guardian_relationship: 'mother',
        provisional_name: input.expectedName
      });
      expect(newborn.minted_identity.guardian_consent_id).toEqual(expect.any(Number));

      // Minted users row: PATIENT minor, active, provisional B/O name,
      // synthetic NB- phone, guardian link to the mother (mig-202 substrate).
      const infantRows = await prisma.$queryRawUnsafe(
        `SELECT role, is_minor, is_active, is_deleted, name, gender, phone,
                birthday::text AS birthday, guardian_user_id, guardian_name,
                guardian_relationship, tenant_id
           FROM users
          WHERE uid = $1::uuid`,
        infantUid
      );
      expect(infantRows).toHaveLength(1);
      expect(infantRows[0]).toMatchObject({
        role: 'PATIENT',
        is_minor: true,
        is_active: true,
        is_deleted: false,
        name: input.expectedName,
        gender: input.sex,
        guardian_user_id: motherId,
        guardian_name: `OBGyn Mother ${RUN}`,
        guardian_relationship: 'mother',
        birthday: birthDate
      });
      expect(String(infantRows[0].tenant_id)).toBe(DEFAULT_TENANT);
      expect(infantRows[0].phone).toMatch(/^NB-[0-9A-F]{12}$/);

      // G-3 consent evidence through the EXISTING patient_consents substrate.
      const consents = await prisma.$queryRawUnsafe(
        `SELECT id, consent_type, granted, status, granted_by, source,
                consent_method, witness_uid, witness_name
           FROM patient_consents
          WHERE patient_uid = $1::uuid`,
        infantUid
      );
      expect(consents).toHaveLength(1);
      expect(consents[0]).toMatchObject({
        consent_type: 'treatment',
        granted: true,
        status: 'active',
        granted_by: 'guardian_mother',
        source: 'birth_registration',
        consent_method: 'verbal',
        witness_uid: DOCTOR_UID,
        witness_name: `OBGyn Doctor ${RUN}`
      });
      expect(Number(consents[0].id)).toBe(newborn.minted_identity.guardian_consent_id);

      // Exactly one staff-only canonical pair, subject = the INFANT, on the
      // insert-once fixed lifecycle keys (Idempotency-Key Discipline).
      const pair = await canonicalPair({
        patientUid: infantUid,
        eventType: 'maternity.newborn_recorded',
        sourceTable: 'maternity_newborns',
        sourceId: newborn.id
      });
      expect(pair.timeline).toHaveLength(1);
      expect(pair.audit).toHaveLength(1);
      expect(pair.timeline[0]).toMatchObject({
        event_status: 'recorded',
        actor_uid: DOCTOR_UID,
        actor_role: 'DOCTOR',
        visible_to_patient: false,
        idempotency_key: `maternity_newborns:${Number(newborn.id)}:recorded`,
        payload: expect.objectContaining({
          newborn_id: Number(newborn.id),
          delivery_id: deliveryId,
          pregnancy_id: pregnancyId,
          birth_order: input.birth_order,
          outcome: 'live',
          newborn_patient_uid: infantUid,
          mother_patient_uid: MOTHER_UID,
          identity_minted: true,
          guardian_user_id: motherId,
          guardian_consent_id: newborn.minted_identity.guardian_consent_id
        })
      });
      expect(pair.audit[0]).toMatchObject({
        action_status: 'success',
        actor_uid: DOCTOR_UID,
        actor_role: 'DOCTOR',
        idempotency_key: `maternity_newborns:${Number(newborn.id)}:audit:recorded`
      });
      // Minimal structured payload — no provisional-name / mother-name leak.
      expect(JSON.stringify(pair.timeline[0].payload)).not.toContain(`OBGyn Mother ${RUN}`);

      minted.push({ id: Number(newborn.id), uid: infantUid, phone: infantRows[0].phone });
    }

    [twinOneId, twinTwoId] = [minted[0].id, minted[1].id];
    [twinOneUid, twinTwoUid] = [minted[0].uid, minted[1].uid];
    expect(twinOneUid).not.toBe(twinTwoUid);
    expect(minted[0].phone).not.toBe(minted[1].phone);

    // A live-minted birth never lands the event on the mother's episode
    // (mother-subject newborn events exist only for stillbirths, by design).
    const motherNewbornEvents = await subjectEvents(MOTHER_UID, 'maternity.newborn_recorded');
    expect(motherNewbornEvents.timeline).toHaveLength(0);
    expect(motherNewbornEvents.audit).toHaveLength(0);
  });

  it('records Apgar and postnatal visits on the infant identities with B-i dual pairs and F-1', async () => {
    // Apgar: infant-scope write on the minted identity; total_score is
    // service-computed; keys follow the #589 fingerprint+tx revision regime.
    for (const [newbornId, infantUid] of [
      [twinOneId, twinOneUid],
      [twinTwoId, twinTwoUid]
    ]) {
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
            respiration: 2,
            total_score: timeMinute === 1 ? 9 : 10
          })
        );
      }

      const apgarEvents = await subjectEvents(infantUid, 'maternity.apgar_recorded');
      expect(apgarEvents.timeline).toHaveLength(2);
      expect(apgarEvents.audit).toHaveLength(2);
      expect(apgarEvents.timeline.map(row => row.payload.total_score)).toEqual([9, 10]);
      for (const [index, row] of apgarEvents.timeline.entries()) {
        expect(row.visible_to_patient).toBe(false);
        expect(row).toMatchObject({ actor_uid: DOCTOR_UID, actor_role: 'DOCTOR' });
        expect(row.idempotency_key).toMatch(APGAR_TIMELINE_KEY_RE);
        expect(apgarEvents.audit[index].idempotency_key).toMatch(APGAR_AUDIT_KEY_RE);
        // The timeline and audit halves of each mutation share one transaction.
        expect(splitRevisionKey(apgarEvents.audit[index].idempotency_key).tx).toBe(
          splitRevisionKey(row.idempotency_key).tx
        );
      }
    }
    const motherApgarEvents = await subjectEvents(MOTHER_UID, 'maternity.apgar_recorded');
    expect(motherApgarEvents.timeline).toHaveLength(0);
    expect(motherApgarEvents.audit).toHaveLength(0);

    // Postnatal composition under the signed B-i rule: 'mother' -> one
    // maternal pair; 'both' -> ONE detail row, TWO canonical pairs with
    // strict per-subject payload separation (F-n1 keeps shared notes /
    // red-flags detail-row-only); 'baby' -> one infant pair.
    const motherVisit = await doctor.post('/api/v1/maternity/postnatal-visits').send({
      delivery_id: deliveryId,
      visit_at: `${birthDate}T11:00:00.000Z`,
      visit_kind: 'mother',
      mother_temp_c: 36.8,
      mother_pulse_bpm: 82,
      breastfeeding_status: 'initiated'
    });
    expect(motherVisit.statusCode).toBe(200);
    const motherVisitId = Number(motherVisit.body.data.id);

    const bothVisit = await doctor.post('/api/v1/maternity/postnatal-visits').send({
      delivery_id: deliveryId,
      newborn_id: twinOneId,
      visit_at: `${birthDate}T11:15:00.000Z`,
      visit_kind: 'both',
      mother_temp_c: 36.9,
      mother_pulse_bpm: 84,
      mother_bp_systolic: 121,
      mother_bp_diastolic: 79,
      breastfeeding_status: 'established',
      baby_weight_g: 2460,
      baby_temperature_c: 36.7,
      baby_feeding: 'breastfeeding',
      baby_jaundice: 'none',
      baby_passed_meconium: true,
      baby_passed_urine: true,
      baby_cord_status: 'healthy',
      red_flags: [PRIVATE_RED_FLAG],
      notes: PRIVATE_POSTNATAL
    });
    expect(bothVisit.statusCode).toBe(200);
    bothVisitId = Number(bothVisit.body.data.id);
    // Shared free text persists on the DETAIL row only (F-n1).
    expect(bothVisit.body.data.notes).toBe(PRIVATE_POSTNATAL);
    expect(bothVisit.body.data.red_flags).toEqual([PRIVATE_RED_FLAG]);

    const babyVisit = await doctor.post('/api/v1/maternity/postnatal-visits').send({
      delivery_id: deliveryId,
      newborn_id: twinTwoId,
      visit_at: `${birthDate}T11:30:00.000Z`,
      visit_kind: 'baby',
      baby_weight_g: 2340,
      baby_temperature_c: 36.7,
      baby_feeding: 'breastfeeding'
    });
    expect(babyVisit.statusCode).toBe(200);
    const babyVisitId = Number(babyVisit.body.data.id);

    // Per-subject composition: mother = 2 maternal pairs (mother visit +
    // the maternal half of 'both'); twin one = the infant half of 'both';
    // twin two = the 'baby' visit pair. Fixed per-subject lifecycle keys.
    const motherPostnatal = await subjectEvents(MOTHER_UID, 'maternity.postnatal_visit_recorded');
    expect(motherPostnatal.timeline).toHaveLength(2);
    expect(motherPostnatal.audit).toHaveLength(2);
    expect(motherPostnatal.timeline.map(row => row.idempotency_key)).toEqual([
      `maternity_postnatal_visits:${motherVisitId}:mother:recorded`,
      `maternity_postnatal_visits:${bothVisitId}:mother:recorded`
    ]);

    const twinOnePostnatal = await subjectEvents(twinOneUid, 'maternity.postnatal_visit_recorded');
    expect(twinOnePostnatal.timeline).toHaveLength(1);
    expect(twinOnePostnatal.audit).toHaveLength(1);
    expect(twinOnePostnatal.timeline[0].idempotency_key).toBe(
      `maternity_postnatal_visits:${bothVisitId}:infant:recorded`
    );
    expect(twinOnePostnatal.audit[0].idempotency_key).toBe(
      `maternity_postnatal_visits:${bothVisitId}:infant:audit:recorded`
    );

    const twinTwoPostnatal = await subjectEvents(twinTwoUid, 'maternity.postnatal_visit_recorded');
    expect(twinTwoPostnatal.timeline).toHaveLength(1);
    expect(twinTwoPostnatal.timeline[0].idempotency_key).toBe(
      `maternity_postnatal_visits:${babyVisitId}:infant:recorded`
    );

    // B-i dual pairs over ONE detail row, with strict per-subject payload
    // separation and F-n1 exclusion of shared narrative from BOTH pairs.
    const maternalHalf = motherPostnatal.timeline.find(
      row => row.source_id === String(bothVisitId)
    );
    const maternalAuditHalf = motherPostnatal.audit.find(
      row => row.resource_id === String(bothVisitId)
    );
    expect(maternalHalf.payload).toMatchObject({
      postnatal_visit_id: bothVisitId,
      visit_kind: 'both',
      subject_scope: 'mother',
      mother_temp_c: 36.9,
      mother_pulse_bpm: 84,
      breastfeeding_status: 'established'
    });
    const infantHalf = twinOnePostnatal.timeline[0];
    expect(infantHalf.payload).toMatchObject({
      postnatal_visit_id: bothVisitId,
      visit_kind: 'both',
      subject_scope: 'infant',
      newborn_id: twinOneId,
      baby_weight_g: 2460,
      baby_temperature_c: 36.7,
      baby_feeding: 'breastfeeding'
    });
    const maternalText = JSON.stringify([maternalHalf.payload, maternalAuditHalf.after_state]);
    const infantText = JSON.stringify([infantHalf.payload, twinOnePostnatal.audit[0].after_state]);
    const sharedSecrets = [PRIVATE_POSTNATAL, PRIVATE_RED_FLAG, 'notes', 'red_flags'];
    for (const excluded of [...sharedSecrets, 'baby_weight_g', 'baby_temperature_c', 'baby_feeding']) {
      expect(maternalText).not.toContain(excluded);
    }
    for (const excluded of [...sharedSecrets, 'mother_temp_c', 'mother_pulse_bpm', 'breastfeeding_status']) {
      expect(infantText).not.toContain(excluded);
    }

    // F-1 (signed): a 'both' visit with NO newborn link is rejected — the
    // baby record always exists under Shape 3; staff link it first.
    const linkless = await doctor.post('/api/v1/maternity/postnatal-visits').send({
      delivery_id: deliveryId,
      visit_at: `${birthDate}T11:45:00.000Z`,
      visit_kind: 'both',
      mother_temp_c: 36.8,
      baby_weight_g: 2400
    });
    expect(linkless.statusCode).toBe(409);
    expect(linkless.body.code).toBe('MATERNITY_POSTNATAL_NEWBORN_LINK_REQUIRED');

    const newborns = await doctor.get(`/api/v1/maternity/newborns/delivery/${deliveryId}`);
    expect(newborns.statusCode).toBe(200);
    expect(newborns.body.data.map(row => Number(row.birth_order))).toEqual([1, 2]);
    expect(newborns.body.data.every(row => row.apgar.length === 2)).toBe(true);

    const postnatal = await doctor.get(`/api/v1/maternity/postnatal-visits/delivery/${deliveryId}`);
    expect(postnatal.statusCode).toBe(200);
    expect(postnatal.body.data).toHaveLength(3);
  });

  it('explicitly seeds, reads and records exact O1 links with signed fail-closed infant subjects', async () => {
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

    for (const patientUid of [twinOneUid, twinTwoUid]) {
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
      twinOneUid,
      vaccineCatalogueId
    );
    expect(twinOneDose).toHaveLength(1);
    expect(Number(twinOneDose[0].newborn_id)).toBe(twinOneId);

    // SIGNED D7 subject rule (S-2 FULL scope + M-D remediation, PR #595):
    // the canonical subject of every newborn-linked immunisation event is
    // the infant's OWN minted identity — the pre-D7 mother-fallback CASE is
    // REMOVED. Absent, invalid or ambiguous identity REJECTS fail-closed
    // (asserted further down); it never attributes to the mother.
    const newbornSeedCanonical = await canonicalPair({
      patientUid: twinOneUid,
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
      patientUid: twinOneUid,
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

    // SIGNED D7 subject rule: the dose event's canonical subject is the
    // infant's OWN minted identity via the exact tenant-scoped newborn
    // linkage — fail-closed, never the mother (M-D remediation, PR #595).
    const doseCanonical = await canonicalPair({
      patientUid: twinOneUid,
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

    const deduped = await doctor.get(`/api/v1/paediatric/immunisations/patient/${twinOneUid}`);
    expect(deduped.statusCode).toBe(200);
    const visibleDose = deduped.body.data.filter(row => row.code === VACCINE_CODE);
    expect(visibleDose).toHaveLength(1);
    expect(visibleDose[0].status).toBe('given');

    // ── Signed fail-closed identity rules (replaces the pre-D7 ambiguity
    // pin: the two-newborns-one-uid fixture that step corrupted into place
    // is STRUCTURALLY UNSEEDABLE post-mig-577) ────────────────────────────

    // (a) A-1 (mig 577): the partial unique index on
    // (tenant_id, newborn_patient_uid) rejects the old ambiguity fixture at
    // the DB layer, so "two newborns claiming one identity" can no longer
    // exist for the service paths to arbitrate.
    let uniqueViolation = null;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE maternity_newborns
            SET newborn_patient_uid = $1::uuid
          WHERE tenant_id = $2::uuid AND id = $3::int`,
        twinOneUid,
        DEFAULT_TENANT,
        twinTwoId
      );
    } catch (err) {
      uniqueViolation = err;
    }
    expect(uniqueViolation).not.toBeNull();
    expect(`${uniqueViolation.message} ${uniqueViolation.meta?.message || ''}`).toMatch(
      /uq_maternity_newborns_tenant_patient_uid|duplicate key/
    );
    const links = await prisma.$queryRawUnsafe(
      `SELECT id, newborn_patient_uid
         FROM maternity_newborns
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])
        ORDER BY id`,
      DEFAULT_TENANT,
      [twinOneId, twinTwoId]
    );
    expect(links.map(row => String(row.newborn_patient_uid))).toEqual([twinOneUid, twinTwoUid]);

    // (b) Link-less newborn (residual pre-577-style row, seeded via raw SQL
    // because the product path always mints under Shape 3): any immunisation
    // write REJECTS 409 NEWBORN_IDENTITY_REQUIRED with zero writes — no
    // proxy attribution to the mother.
    const linklessRows = await prisma.$queryRawUnsafe(
      `INSERT INTO maternity_newborns
         (delivery_id, birth_order, birth_datetime, outcome, recorded_by, tenant_id)
       VALUES ($1::int, 3, $2::timestamptz, 'live', $3::uuid, $4::uuid)
       RETURNING id`,
      deliveryId,
      `${birthDate}T05:07:00.000Z`,
      DOCTOR_UID,
      DEFAULT_TENANT
    );
    const linklessNewbornId = Number(linklessRows[0].id);
    const linklessSeed = await doctor
      .post(`/api/v1/maternity/newborns/${linklessNewbornId}/immunisations/seed`)
      .send({});
    expect(linklessSeed.statusCode).toBe(409);
    expect(linklessSeed.body.code).toBe('NEWBORN_IDENTITY_REQUIRED');
    const linklessDoses = await prisma.$queryRawUnsafe(
      `SELECT id FROM newborn_immunisations
        WHERE tenant_id = $1::uuid AND newborn_id = $2::int`,
      DEFAULT_TENANT,
      linklessNewbornId
    );
    expect(linklessDoses).toHaveLength(0);

    // (c) Invalidated identity (E-3): soft-delete twin two's minted record,
    // then attempt the newborn-keyed dose write — 409
    // NEWBORN_IDENTITY_INVALID(deleted), tuple untouched, zero canonical
    // rows. Restore the identity afterwards.
    const twinTwoDoseRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM newborn_immunisations
        WHERE tenant_id = $1::uuid
          AND newborn_id = $2::int
          AND vaccine_catalogue_id = $3::int`,
      DEFAULT_TENANT,
      twinTwoId,
      vaccineCatalogueId
    );
    expect(twinTwoDoseRows).toHaveLength(1);
    const twinTwoDoseId = Number(twinTwoDoseRows[0].id);
    const twinTwoTupleBefore = await newbornDoseTupleVersion(twinTwoDoseId);
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_deleted = true, deleted_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      DEFAULT_TENANT,
      twinTwoUid
    );
    const invalidatedDose = await doctor
      .patch(`/api/v1/maternity/immunisations/${twinTwoDoseId}/record`)
      .send({ status: 'given', given_by_name: `OBGyn Doctor ${RUN}` });
    expect(invalidatedDose.statusCode).toBe(409);
    expect(invalidatedDose.body.code).toBe('NEWBORN_IDENTITY_INVALID');
    expect(invalidatedDose.body.details).toMatchObject({ reason: 'deleted' });
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_deleted = false, deleted_at = NULL
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      DEFAULT_TENANT,
      twinTwoUid
    );
    const twinTwoTupleAfter = await newbornDoseTupleVersion(twinTwoDoseId);
    expect(twinTwoTupleAfter).toEqual(twinTwoTupleBefore);
    const twinTwoDoseEvents = await subjectEvents(twinTwoUid, 'immunisation.dose_recorded');
    expect(twinTwoDoseEvents.timeline).toHaveLength(0);
    expect(twinTwoDoseEvents.audit).toHaveLength(0);

    // No proxy attribution EVER: across every seed/dose above (including
    // the two rejections) the MOTHER carries zero immunisation events.
    for (const eventType of ['immunisation.schedule_seeded', 'immunisation.dose_recorded']) {
      const motherEvents = await subjectEvents(MOTHER_UID, eventType);
      expect(motherEvents.timeline).toHaveLength(0);
      expect(motherEvents.audit).toHaveLength(0);
    }

    const foreignRead = await tenantBDoctor.get(
      `/api/v1/paediatric/immunisations/patient/${twinOneUid}`
    );
    expect(foreignRead.statusCode).toBe(404);
    const foreignRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM patient_immunisations
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_B,
      twinOneUid
    );
    expect(foreignRows).toHaveLength(0);
  });

  it('keeps the completed journey staff-only, patient-safe and notification-free', async () => {
    const canonicalPatientRead = await patient.get(`/api/v1/emr/timeline/${MOTHER_UID}`);
    expect(canonicalPatientRead.statusCode).toBe(403);
    // X-1/G-4 (signed): the guardian mother's PORTAL proxy path is the only
    // patient-side view; the canonical EMR timeline stays staff-only even
    // for the infant's guardian until D3 broadens patient projections.
    const infantCanonicalPatientRead = await patient.get(`/api/v1/emr/timeline/${twinOneUid}`);
    expect(infantCanonicalPatientRead.statusCode).toBe(403);
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

    // Staff-only invariant across the WHOLE signed spine: every canonical
    // event this journey produced — mother-subject families plus the
    // infant-subject families landed by R1/R2 — stays visible_to_patient
    // = false for the mother AND both minted infants.
    const journeyEventTypes = [
      ...LANDED_CANONICAL_EVENTS.map(({ eventType }) => eventType),
      'maternity.newborn_recorded',
      'maternity.apgar_recorded',
      'maternity.postnatal_visit_recorded',
      'immunisation.schedule_seeded',
      'immunisation.dose_recorded'
    ];
    const visibleMaternityEvents = await prisma.$queryRawUnsafe(
      `SELECT event_type
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = ANY($2::uuid[])
          AND event_type = ANY($3::text[])
          AND visible_to_patient = true`,
      DEFAULT_TENANT,
      [MOTHER_UID, twinOneUid, twinTwoUid],
      journeyEventTypes
    );
    expect(visibleMaternityEvents).toHaveLength(0);

    const outbound = await outboundCounts();
    expect(outbound.outbox).toBe(baselineOutboxCount);
    expect(outbound.recipients).toBe(baselineRecipientCount);
  });
});
