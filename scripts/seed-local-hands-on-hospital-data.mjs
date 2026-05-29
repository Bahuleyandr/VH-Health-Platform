#!/usr/bin/env node
// Local hands-on hospital fixtures for the Staff app.
//
// This is intentionally additive and idempotent. It is for the local
// vhhealth_test database only, after migrations and baseline seeds have
// already run. It fills the workflows clinicians actually tap through:
// bed board, doctor-scoped appointments, admission case sheet, progress
// notes, nursing notes, vitals, discharge hub, and hospital numbers.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromBackend = createRequire(
  path.join(__dirname, '..', 'apps', 'backend', 'package.json')
);
const pg = requireFromBackend('pg');
const {
  LEGACY_DEMO_BED_NUMBERS,
  seedCurrentBedStructure,
} = await import(pathToFileURL(
  path.join(__dirname, '..', 'apps', 'backend', 'scripts', 'seed-current-bed-structure.mjs')
).href);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SEED_TAG = 'vh_hands_on_seed';
const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

function guard() {
  if (!connectionString) {
    throw new Error('DATABASE_URL or TEST_DATABASE_URL is required.');
  }
  const url = new URL(connectionString);
  const host = url.hostname.toLowerCase();
  const db = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || db !== 'vhhealth_test') {
    throw new Error(
      `Refusing to seed non-local test DB (${host}/${db}). ` +
        'Use the local vhhealth_test database.'
    );
  }
}

const patients = [
  {
    key: 'fatima',
    uid: '10000000-0000-4000-8000-000000000101',
    name: 'Demo Patient Fatima Rahman',
    phone: '+919810000101',
    gender: 'Female',
    birthday: '1974-08-14',
    hospitalNumber: 'VH-2026-0101',
    bloodGroup: 'B+',
    allergies: 'Penicillin rash',
    history: 'Type 2 diabetes mellitus and hypertension.',
  },
  {
    key: 'aarav',
    uid: '10000000-0000-4000-8000-000000000102',
    name: 'Demo Patient Aarav Menon',
    phone: '+919810000102',
    gender: 'Male',
    birthday: '1988-02-03',
    hospitalNumber: 'VH-2026-0102',
    bloodGroup: 'O+',
    allergies: 'No known drug allergies',
    history: 'Bronchial asthma, intermittent inhaler use.',
  },
  {
    key: 'shanthi',
    uid: '10000000-0000-4000-8000-000000000103',
    name: 'Demo Flow Patient Shanthi Rao',
    phone: '+919810000103',
    gender: 'Female',
    birthday: '1969-11-21',
    hospitalNumber: 'VH-2026-0103',
    bloodGroup: 'A+',
    allergies: 'Sulfa intolerance',
    history: 'Laparoscopic cholecystectomy done during this admission.',
  },
  {
    key: 'ravi',
    uid: '10000000-0000-4000-8000-000000000104',
    name: 'Demo Patient Ravi Iyer',
    phone: '+919810000104',
    gender: 'Male',
    birthday: '1958-05-30',
    hospitalNumber: 'VH-2026-0104',
    bloodGroup: 'AB+',
    allergies: 'No known drug allergies',
    history: 'Coronary artery disease with prior angioplasty.',
  },
  {
    key: 'leela',
    uid: '10000000-0000-4000-8000-000000000105',
    name: 'Demo Patient Leela Krishnan',
    phone: '+919810000105',
    gender: 'Female',
    birthday: '1994-04-18',
    hospitalNumber: 'VH-2026-0105',
    bloodGroup: 'O-',
    allergies: 'Shellfish allergy',
    history: 'Hypothyroidism on regular medication.',
  },
  {
    key: 'nikhil',
    uid: '10000000-0000-4000-8000-000000000106',
    name: 'Demo Patient Nikhil Das',
    phone: '+919810000106',
    gender: 'Male',
    birthday: '2007-12-09',
    hospitalNumber: 'VH-2026-0106',
    bloodGroup: 'B-',
    allergies: 'No known drug allergies',
    history: 'Recent dengue fever, admitted for warning-sign monitoring.',
  },
  {
    key: 'meera',
    uid: '10000000-0000-4000-8000-000000000107',
    name: 'Demo Patient Meera Joseph',
    phone: '+919810000107',
    gender: 'Female',
    birthday: '1991-09-12',
    hospitalNumber: 'VH-2026-0107',
    bloodGroup: 'A-',
    allergies: 'Latex sensitivity',
    history: 'G2P1, booked for antenatal review.',
  },
  {
    key: 'karthik',
    uid: '10000000-0000-4000-8000-000000000108',
    name: 'Demo Patient Karthik Nair',
    phone: '+919810000108',
    gender: 'Male',
    birthday: '2016-07-01',
    hospitalNumber: 'VH-2026-0108',
    bloodGroup: 'O+',
    allergies: 'No known drug allergies',
    history: 'Recurrent wheeze, paediatric follow-up.',
  },
];

const admissions = [
  {
    key: 'fatima',
    encounterId: '20000000-0000-4000-8000-000000000101',
    bedNumber: 'B-103',
    ward: 'B Block - ICU',
    roomCategory: 'icu',
    department: 'General Medicine',
    chiefComplaint: 'Fever with breathlessness for 3 days',
    diagnosis: 'Community-acquired pneumonia with sepsis risk',
    priority: 'urgent',
    status: 'admitted',
    admittedHoursAgo: 36,
    dischargeInitiated: false,
    nextReviewHours: 4,
  },
  {
    key: 'aarav',
    encounterId: '20000000-0000-4000-8000-000000000102',
    bedNumber: 'B-202',
    ward: 'B Block - Floor II',
    roomCategory: 'deluxe',
    department: 'General Medicine',
    chiefComplaint: 'Wheeze and chest tightness',
    diagnosis: 'Acute exacerbation of bronchial asthma',
    priority: 'routine',
    status: 'admitted',
    admittedHoursAgo: 18,
    dischargeInitiated: false,
    nextReviewHours: 8,
  },
  {
    key: 'shanthi',
    encounterId: '20000000-0000-4000-8000-000000000103',
    bedNumber: 'B-205',
    ward: 'B Block - Floor II',
    roomCategory: 'private',
    department: 'General Surgery',
    chiefComplaint: 'Post-operative monitoring after laparoscopic cholecystectomy',
    diagnosis: 'Post-op day 1 after laparoscopic cholecystectomy',
    priority: 'routine',
    status: 'admitted',
    admittedHoursAgo: 30,
    dischargeInitiated: true,
    summarySigned: true,
    nextReviewHours: 6,
  },
  {
    key: 'ravi',
    encounterId: '20000000-0000-4000-8000-000000000104',
    bedNumber: 'B-101',
    ward: 'B Block - ICU',
    roomCategory: 'icu',
    department: 'Cardiology',
    chiefComplaint: 'Chest discomfort with elevated blood pressure',
    diagnosis: 'ACS rule-out with hypertensive urgency',
    priority: 'urgent',
    status: 'admitted',
    admittedHoursAgo: 10,
    dischargeInitiated: false,
    nextReviewHours: 2,
  },
  {
    key: 'leela',
    encounterId: '20000000-0000-4000-8000-000000000105',
    bedNumber: 'A-406A',
    ward: 'A Block - Floor IV',
    roomCategory: 'semi_private',
    department: 'General Medicine',
    chiefComplaint: 'Persistent vomiting and dehydration',
    diagnosis: 'Acute gastroenteritis with dehydration',
    priority: 'routine',
    status: 'admitted',
    admittedHoursAgo: 14,
    dischargeInitiated: false,
    nextReviewHours: 6,
  },
  {
    key: 'nikhil',
    encounterId: '20000000-0000-4000-8000-000000000106',
    bedNumber: 'A-307',
    ward: 'A Block - Floor III',
    roomCategory: 'general',
    department: 'Paediatrics',
    chiefComplaint: 'Dengue warning signs observation',
    diagnosis: 'Dengue fever with thrombocytopenia, improving',
    priority: 'routine',
    status: 'admitted',
    admittedHoursAgo: 8,
    dischargeInitiated: false,
    nextReviewHours: 4,
  },
];

const appointments = [
  { key: 'fatima', doctorEmployeeId: 'EMP-1004', time: '09:30', status: 'CONFIRMED', reason: 'Post-discharge pneumonia review' },
  { key: 'aarav', doctorEmployeeId: 'EMP-1004', time: '10:00', status: 'SCHEDULED', reason: 'Asthma follow-up' },
  { key: 'ravi', doctorEmployeeId: 'EMP-1004', time: '10:30', status: 'SCHEDULED', reason: 'Cardiac risk review before transfer' },
  { key: 'leela', doctorEmployeeId: 'EMP-1004', time: '11:00', status: 'CONFIRMED', reason: 'Dehydration reassessment' },
  { key: 'meera', doctorEmployeeId: 'EMP-1010', time: '09:45', status: 'CONFIRMED', reason: 'Antenatal review' },
  { key: 'shanthi', doctorEmployeeId: 'EMP-1010', time: '12:00', status: 'SCHEDULED', reason: 'Post-op wound check' },
  { key: 'karthik', doctorEmployeeId: 'EMP-1012', time: '16:30', status: 'SCHEDULED', reason: 'Paediatric wheeze follow-up' },
];

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0] || null;
}

async function all(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows;
}

async function staffUser(client, employeeId) {
  const row = await one(
    client,
    `SELECT u.id, u.uid, u.name, u.role, s.employee_id
       FROM staff s
       JOIN users u ON u.uid = s.user_id
      WHERE s.employee_id = $1
      LIMIT 1`,
    [employeeId]
  );
  if (!row) throw new Error(`Required staff account not found: ${employeeId}`);
  return row;
}

async function upsertPatient(client, patient) {
  return one(
    client,
    `INSERT INTO users
       (uid, tenant_id, phone, name, gender, birthday, role, is_active, status,
        registered_at, updated_at, preferred_language, preferred_channel,
        blood_group, allergies, medical_history, profile_completed_at,
        chronic_medications)
     VALUES
       ($1::uuid, $2::uuid, $3, $4, $5, $6::date, 'PATIENT', TRUE, 'active',
        NOW(), NOW(), 'en', 'app', $7, $8, $9, NOW(), '[]'::jsonb)
     ON CONFLICT (phone) DO UPDATE
       SET name = EXCLUDED.name,
           gender = EXCLUDED.gender,
           birthday = EXCLUDED.birthday,
           role = 'PATIENT',
           is_active = TRUE,
           status = 'active',
           updated_at = NOW(),
           blood_group = EXCLUDED.blood_group,
           allergies = EXCLUDED.allergies,
           medical_history = EXCLUDED.medical_history,
           profile_completed_at = NOW()
     RETURNING id, uid, name, phone`,
    [
      patient.uid,
      TENANT_ID,
      patient.phone,
      patient.name,
      patient.gender,
      patient.birthday,
      patient.bloodGroup,
      patient.allergies,
      patient.history,
    ]
  );
}

async function ensureHospitalNumber(client, patientRow, hospitalNumber) {
  await client.query(
    `INSERT INTO patient_identifiers
       (tenant_id, patient_uid, identifier_type, identifier_value, issuer,
        assigned_at, is_primary, status, metadata, created_at, updated_at)
     VALUES
       ($1::uuid, $2::uuid, 'mrn', $3, 'VH Health Local Demo', NOW(),
        TRUE, 'active', $4::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, identifier_type, identifier_value)
       WHERE status = 'active'
     DO UPDATE
       SET patient_uid = EXCLUDED.patient_uid,
           is_primary = TRUE,
           issuer = EXCLUDED.issuer,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()`,
    [
      TENANT_ID,
      patientRow.uid,
      hospitalNumber,
      JSON.stringify({ source: SEED_TAG }),
    ]
  );
}

async function ensureExistingPatientsHaveHospitalNumbers(client) {
  await client.query(
    `WITH patient_rows AS (
       SELECT u.uid,
              'VH-2026-' || LPAD(ROW_NUMBER() OVER (ORDER BY u.id)::text, 4, '0') AS generated_mrn
         FROM users u
        WHERE u.role = 'PATIENT'
          AND NOT EXISTS (
            SELECT 1
              FROM patient_identifiers pi
             WHERE pi.tenant_id = u.tenant_id
               AND pi.patient_uid = u.uid
               AND pi.identifier_type IN ('mrn', 'uhid')
               AND pi.status = 'active'
          )
     )
     INSERT INTO patient_identifiers
       (tenant_id, patient_uid, identifier_type, identifier_value, issuer,
        assigned_at, is_primary, status, metadata, created_at, updated_at)
     SELECT $1::uuid, uid, 'mrn', generated_mrn, 'VH Health Local Demo',
            NOW(), TRUE, 'active', $2::jsonb, NOW(), NOW()
       FROM patient_rows
     ON CONFLICT (tenant_id, identifier_type, identifier_value)
       WHERE status = 'active'
     DO NOTHING`,
    [TENANT_ID, JSON.stringify({ source: `${SEED_TAG}:backfill` })]
  );
}

async function bedByNumber(client, bedNumber) {
  const row = await one(
    client,
    `SELECT b.id, b.bed_number, b.ward_id, COALESCE(b.ward_name, w.name) AS ward_name
       FROM beds b
       LEFT JOIN wards w ON w.id = b.ward_id
      WHERE b.bed_number = $1
      LIMIT 1`,
    [bedNumber]
  );
  if (!row) throw new Error(`Bed not found: ${bedNumber}`);
  return row;
}

async function clearOrphanBaselineAdmission(client) {
  await client.query(
    `UPDATE admissions
        SET status = 'discharged',
            discharged_at = COALESCE(discharged_at, NOW() - INTERVAL '1 day'),
            discharge_type = COALESCE(discharge_type, 'home'),
            updated_at = NOW()
      WHERE discharged_at IS NULL
        AND COALESCE(reason_for_admission, '') = ''
        AND bed_number = 'GW-201'
        AND chief_complaint = 'Seed admission'`
  );
}

async function resetDemoBeds(client, demoUids) {
  const targetBeds = [
    ...admissions.map((admission) => admission.bedNumber),
    'A-410',
    ...LEGACY_DEMO_BED_NUMBERS,
  ];
  await client.query(
    `UPDATE beds
        SET status = 'available',
            patient_id = NULL,
            patient_name = NULL,
            patient_uid = NULL,
            admission_id = NULL,
            admitted_at = NULL,
            assigned_at = NULL,
            expected_discharge = NULL,
            notes = NULL,
            updated_at = NOW()
      WHERE bed_number = ANY($1::text[])
        AND (patient_uid IS NULL OR patient_uid = ANY($2::uuid[]))`,
    [targetBeds, demoUids]
  );

  await client.query(
    `UPDATE beds
        SET status = 'available',
            patient_id = NULL,
            patient_name = NULL,
            patient_uid = NULL,
            admission_id = NULL,
            admitted_at = NULL,
            assigned_at = NULL,
            expected_discharge = NULL,
            notes = NULL,
            updated_at = NOW()
      WHERE patient_uid = ANY($1::uuid[])
        AND NOT (bed_number = ANY($2::text[]))`,
    [demoUids, targetBeds]
  );
}

function intervalHours(hours) {
  return `${Number(hours || 0)} hours`;
}

async function upsertAdmission(client, admission, patientRow, doctor) {
  const bed = await bedByNumber(client, admission.bedNumber);
  const tag = `${SEED_TAG}::${admission.key}`;
  const dischargeInitiatedAt = admission.dischargeInitiated
    ? `NOW() - INTERVAL '2 hours'`
    : 'NULL';
  const billingClosedAt = admission.dischargeInitiated
    ? `NOW() - INTERVAL '2 hours'`
    : 'NULL';
  const summarySignedAt = admission.summarySigned
    ? `NOW() - INTERVAL '90 minutes'`
    : 'NULL';

  const existing = await one(
    client,
    `SELECT id
       FROM admissions
      WHERE patient_uid = $1::uuid
        AND reason_for_admission = $2
      ORDER BY id
      LIMIT 1`,
    [patientRow.uid, tag]
  );

  if (existing) {
    return one(
      client,
      `UPDATE admissions
          SET tenant_id = $1::uuid,
              encounter_id = $2::uuid,
              status = $3,
              admitting_doctor = $4::uuid,
              attending_doctor = $4::uuid,
              department = $5,
              ward = $6,
              bed_id = $7::int,
              bed_number = $8,
              chief_complaint = $9,
              admitting_diagnosis = $10,
              reason_for_admission = $11,
              admission_type = 'elective',
              priority = $12,
              room_category = $13,
              admitted_at = NOW() - $14::interval,
              discharged_at = NULL,
              discharge_type = NULL,
              discharge_initiated_at = ${dischargeInitiatedAt},
              billing_closed_at = ${billingClosedAt},
              summary_signed_at = ${summarySignedAt},
              discharge_drugs_dispensed_at = NULL,
              expected_los_days = 3,
              next_review_at = NOW() + $15::interval,
              allergies = $16::text[],
              updated_at = NOW()
        WHERE id = $17::int
        RETURNING id, encounter_id, patient_uid`,
      [
        TENANT_ID,
        admission.encounterId,
        admission.status,
        doctor.uid,
        admission.department,
        admission.ward,
        bed.id,
        admission.bedNumber,
        admission.chiefComplaint,
        admission.diagnosis,
        tag,
        admission.priority,
        admission.roomCategory,
        intervalHours(admission.admittedHoursAgo),
        intervalHours(admission.nextReviewHours),
        patients.find((p) => p.key === admission.key)?.allergies?.includes('No known') ? [] : [patients.find((p) => p.key === admission.key)?.allergies || ''],
        existing.id,
      ]
    );
  }

  return one(
    client,
    `INSERT INTO admissions
       (tenant_id, patient_uid, encounter_id, status, admitting_doctor,
        attending_doctor, department, ward, bed_id, bed_number,
        chief_complaint, admitting_diagnosis, reason_for_admission,
        admission_type, priority, room_category, admitted_at, created_by,
        discharge_initiated_at, billing_closed_at, summary_signed_at,
        expected_los_days, next_review_at, allergies, created_at, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $5::uuid, $6, $7,
        $8::int, $9, $10, $11, $12, 'elective', $13, $14,
        NOW() - $15::interval, $5::uuid, ${dischargeInitiatedAt},
        ${billingClosedAt}, ${summarySignedAt}, 3, NOW() + $16::interval,
        $17::text[], NOW(), NOW())
     RETURNING id, encounter_id, patient_uid`,
    [
      TENANT_ID,
      patientRow.uid,
      admission.encounterId,
      admission.status,
      doctor.uid,
      admission.department,
      admission.ward,
      bed.id,
      admission.bedNumber,
      admission.chiefComplaint,
      admission.diagnosis,
      tag,
      admission.priority,
      admission.roomCategory,
      intervalHours(admission.admittedHoursAgo),
      intervalHours(admission.nextReviewHours),
      patients.find((p) => p.key === admission.key)?.allergies?.includes('No known') ? [] : [patients.find((p) => p.key === admission.key)?.allergies || ''],
    ]
  );
}

async function assignBed(client, admission, admissionRow, patientRow) {
  const result = await client.query(
    `UPDATE beds
        SET status = 'occupied',
            patient_id = $1::int,
            patient_name = $2,
            patient_uid = $3::uuid,
            admission_id = $4::int,
            admitted_at = NOW() - $5::interval,
            assigned_at = NOW() - $5::interval,
            expected_discharge = CASE
              WHEN $6::boolean THEN NOW() + INTERVAL '6 hours'
              ELSE NOW() + INTERVAL '2 days'
            END,
            notes = $7,
            updated_at = NOW()
      WHERE bed_number = $8
        AND (patient_uid IS NULL OR patient_uid = $3::uuid)
      RETURNING id`,
    [
      patientRow.id,
      patientRow.name,
      patientRow.uid,
      admissionRow.id,
      intervalHours(admission.admittedHoursAgo),
      admission.dischargeInitiated === true,
      admission.dischargeInitiated
        ? 'Discharge cascade initiated; bed remains occupied until checklist completion.'
        : 'Hands-on demo active admission.',
      admission.bedNumber,
    ]
  );
  if (!result.rowCount) {
    throw new Error(`Bed ${admission.bedNumber} is occupied by a non-demo patient; not overwritten.`);
  }
}

async function setCleaningBed(client) {
  await client.query(
    `UPDATE beds
        SET status = 'cleaning',
            patient_id = NULL,
            patient_name = NULL,
            patient_uid = NULL,
            admission_id = NULL,
            admitted_at = NULL,
            assigned_at = NULL,
            expected_discharge = NULL,
            notes = 'Housekeeping turnover demo bed',
            updated_at = NOW()
      WHERE bed_number = 'A-410'
        AND patient_uid IS NULL`
  );
}

async function upsertClinicalNote(client, note) {
  const existing = await one(
    client,
    `SELECT id
       FROM clinical_notes
      WHERE encounter_id = $1::uuid
        AND patient_uid = $2::uuid
        AND note_type = $3
        AND title = $4
        AND is_addendum = FALSE
      ORDER BY id
      LIMIT 1`,
    [note.encounterId, note.patientUid, note.noteType, note.title]
  );

  const values = [
    note.encounterId,
    note.patientUid,
    note.authorUid,
    note.authorRole,
    note.noteType,
    note.title,
    JSON.stringify(note.content),
    note.isSigned === true,
    note.signedBy || null,
  ];

  if (existing) {
    await client.query(
      `UPDATE clinical_notes
          SET author_uid = $1::uuid,
              author_role = $2,
              content = $3::jsonb,
              version = GREATEST(version, 1),
              is_signed = $4::boolean,
              signed_by = $5::uuid,
              signed_at = CASE WHEN $4::boolean THEN COALESCE(signed_at, NOW() - INTERVAL '90 minutes') ELSE NULL END,
              updated_at = NOW()
        WHERE id = $6::int`,
      [
        note.authorUid,
        note.authorRole,
        JSON.stringify(note.content),
        note.isSigned === true,
        note.signedBy || null,
        existing.id,
      ]
    );
    return existing.id;
  }

  const row = await one(
    client,
    `INSERT INTO clinical_notes
       (encounter_id, patient_uid, author_uid, author_role, note_type, title,
        content, version, is_addendum, is_signed, signed_by, signed_at,
        created_at, updated_at, tenant_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, 1,
        FALSE, $8::boolean, $9::uuid,
        CASE WHEN $8::boolean THEN NOW() - INTERVAL '90 minutes' ELSE NULL END,
        NOW() - INTERVAL '1 hour', NOW(), $10::uuid)
     RETURNING id`,
    [...values, TENANT_ID]
  );
  return row.id;
}

function vitalsFor(key) {
  const byKey = {
    fatima: { pulse_rate: '104 /min', bp: '136/84 mm Hg', spo2: '93 %', cbg: '198 mg/dl', weight: '72 kg', temperature: '100.4 deg F' },
    aarav: { pulse_rate: '92 /min', bp: '122/78 mm Hg', spo2: '96 %', cbg: '118 mg/dl', weight: '68 kg', temperature: '98.6 deg F' },
    shanthi: { pulse_rate: '84 /min', bp: '126/80 mm Hg', spo2: '98 %', cbg: '142 mg/dl', weight: '64 kg', temperature: '98.4 deg F' },
    ravi: { pulse_rate: '88 /min', bp: '168/96 mm Hg', spo2: '97 %', cbg: '154 mg/dl', weight: '76 kg', temperature: '98.7 deg F' },
    leela: { pulse_rate: '98 /min', bp: '108/70 mm Hg', spo2: '99 %', cbg: '96 mg/dl', weight: '59 kg', temperature: '99.1 deg F' },
    nikhil: { pulse_rate: '102 /min', bp: '104/68 mm Hg', spo2: '99 %', cbg: '92 mg/dl', weight: '38 kg', temperature: '99.4 deg F' },
  };
  return byKey[key] || {};
}

async function seedNotes(client, admission, admissionRow, patientRow, doctor, nurse) {
  const vitals = vitalsFor(admission.key);
  await upsertClinicalNote(client, {
    encounterId: admissionRow.encounter_id,
    patientUid: patientRow.uid,
    authorUid: doctor.uid,
    authorRole: 'DOCTOR',
    noteType: 'case_sheet',
    title: 'In-hospital admission case sheet',
    content: {
      source: SEED_TAG,
      chief_complaints: admission.chiefComplaint,
      history_of_presenting_illness: `${admission.chiefComplaint}. Symptoms reviewed at admission and no red-flag deterioration after initial stabilization.`,
      past_history: patients.find((p) => p.key === admission.key)?.history || '',
      past_medical_surgical_history: patients.find((p) => p.key === admission.key)?.history || '',
      personal_history: 'Mixed diet, sleep adequate, no substance use disclosed in demo history.',
      menstrual_pregnancy_history: patientRow.name.includes('Meera') ? 'G2P1, antenatal follow-up ongoing.' : '',
      family_history: 'No major hereditary illness documented.',
      allergies: patients.find((p) => p.key === admission.key)?.allergies || '',
      vitals,
      cvs: 'S1 S2 heard, no new murmur.',
      rs: 'Bilateral air entry present; findings as per admitting diagnosis.',
      pa: 'Soft, non-tender unless post-operative site noted.',
      cns: 'Conscious, oriented, no focal deficit.',
      provisional_diagnosis: admission.diagnosis,
    },
  });

  await upsertClinicalNote(client, {
    encounterId: admissionRow.encounter_id,
    patientUid: patientRow.uid,
    authorUid: doctor.uid,
    authorRole: 'DOCTOR',
    noteType: 'progress',
    title: 'Hands-on progress note',
    content: {
      source: SEED_TAG,
      summary: `${admission.diagnosis}. Current ward review completed.`,
      current_status: admission.dischargeInitiated
        ? 'Clinically stable; discharge checklist is now the active blocker.'
        : 'Stable on current management with planned reassessment.',
      plan: admission.dischargeInitiated
        ? 'Complete discharge work items, confirm medications, and counsel family before final discharge.'
        : 'Continue treatment, monitor vitals, review investigations, and reassess on next round.',
      vitals,
    },
    isSigned: admission.dischargeInitiated === true,
    signedBy: admission.dischargeInitiated === true ? doctor.uid : null,
  });

  await upsertClinicalNote(client, {
    encounterId: admissionRow.encounter_id,
    patientUid: patientRow.uid,
    authorUid: nurse.uid,
    authorRole: 'NURSING_STAFF',
    noteType: 'nursing_assessment',
    title: 'Hands-on nursing note',
    content: {
      source: SEED_TAG,
      pain_level: admission.dischargeInitiated ? '2/10' : '3/10',
      mobility: admission.roomCategory === 'icu' ? 'Bed rest with assisted turns' : 'Ambulates with assistance',
      plan_of_care: 'Vitals charted, intake-output monitored, call bell within reach.',
      vitals,
    },
  });

  if (admission.key === 'shanthi') {
    await upsertClinicalNote(client, {
      encounterId: admissionRow.encounter_id,
      patientUid: patientRow.uid,
      authorUid: doctor.uid,
      authorRole: 'DOCTOR',
      noteType: 'procedure',
      title: 'Procedure note - laparoscopic cholecystectomy',
      content: {
        source: SEED_TAG,
        procedure_name: 'Laparoscopic cholecystectomy',
        pre_op_diagnosis: 'Symptomatic cholelithiasis',
        post_op_diagnosis: 'Chronic calculous cholecystitis',
        findings: 'Inflamed gall bladder with adhesions; no bile leak noted.',
        complications: 'None documented.',
        plan: 'Routine post-op monitoring and discharge when checklist complete.',
      },
      isSigned: true,
      signedBy: doctor.uid,
    });
  }
}

function parseBp(bp) {
  const match = String(bp || '').match(/(\d+)\s*\/\s*(\d+)/);
  return match ? { systolic: Number(match[1]), diastolic: Number(match[2]) } : null;
}

function numberFrom(value) {
  const match = String(value || '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

async function seedVitals(client, admission, admissionRow, patientRow) {
  const vitals = vitalsFor(admission.key);
  await client.query(
    `DELETE FROM patient_vitals
      WHERE admission_id = $1::int
        AND source = $2`,
    [admissionRow.id, SEED_TAG]
  );
  await client.query(
    `INSERT INTO patient_vitals
       (tenant_id, patient_uid, admission_id, encounter_id, blood_pressure,
        heart_rate, temperature, blood_sugar, weight, spo2, source,
        recorded_at, recorded_at_source, created_at, temperature_route)
     VALUES
       ($1::uuid, $2::uuid, $3::int, $4::uuid, $5::jsonb, $6::int, $7::numeric,
        $8::int, $9::numeric, $10::int, $11, NOW() - INTERVAL '45 minutes',
        NOW() - INTERVAL '45 minutes', NOW(), 'oral')`,
    [
      TENANT_ID,
      patientRow.uid,
      admissionRow.id,
      admissionRow.encounter_id,
      JSON.stringify(parseBp(vitals.bp)),
      numberFrom(vitals.pulse_rate),
      numberFrom(vitals.temperature),
      numberFrom(vitals.cbg),
      numberFrom(vitals.weight),
      numberFrom(vitals.spo2),
      SEED_TAG,
    ]
  );
}

async function seedDischarge(client, admission, admissionRow, patientRow, doctor) {
  if (!admission.dischargeInitiated) return;
  const consults = ['dietary', 'family_counselling', 'pharmacy', 'physiotherapy', 'billing'];
  for (const consultType of consults) {
    await client.query(
      `INSERT INTO discharge_consults
         (admission_id, patient_uid, consult_type, requested_at, requested_by,
          completed_at, completed_by, notes, created_at, updated_at, tenant_id)
       VALUES
         ($1::int, $2::uuid, $3, NOW() - INTERVAL '2 hours', $4::uuid,
          NULL, NULL, NULL, NOW(), NOW(), $5::uuid)
       ON CONFLICT (admission_id, consult_type) DO UPDATE
          SET patient_uid = EXCLUDED.patient_uid,
              requested_by = EXCLUDED.requested_by,
              updated_at = NOW()`,
      [admissionRow.id, patientRow.uid, consultType, doctor.uid, TENANT_ID]
    );
  }

  const formatted = [
    'DISCHARGE SUMMARY',
    '',
    `Name of the Patient : ${patientRow.name}`,
    `Hospital ID : ${patients.find((p) => p.key === admission.key)?.hospitalNumber}`,
    '',
    'DIAGNOSIS:',
    admission.diagnosis,
    '',
    'COURSE IN THE HOSPITAL:',
    `${patientRow.name} was admitted for ${admission.chiefComplaint}. Post-operative recovery has been stable with no fever spike or wound concern documented in the latest progress note.`,
    '',
    'CONDITION AT DISCHARGE:',
    'Stable, ambulant with assistance, tolerating oral diet.',
    '',
    'ADVISED TO CONTINUE:',
    'Tab Paracetamol 650 mg orally after food if pain, up to three times daily.',
    'Tab Pantoprazole 40 mg orally before breakfast for 5 days.',
    '',
    'FOLLOW UP:',
    'Review in surgery OPD after 5 days or earlier for fever, vomiting, jaundice, wound discharge, or worsening pain.',
  ].join('\n');

  await upsertClinicalNote(client, {
    encounterId: admissionRow.encounter_id,
    patientUid: patientRow.uid,
    authorUid: doctor.uid,
    authorRole: 'DOCTOR',
    noteType: 'discharge',
    title: 'Doctor-reviewed discharge summary',
    content: {
      source: SEED_TAG,
      formatted_summary: formatted,
      hospital_course: `${patientRow.name} was monitored after surgery. Pain settled, vitals stayed stable, and oral diet was tolerated.`,
      discharge_diagnosis: admission.diagnosis,
      discharge_condition: 'Stable at time of doctor review; final discharge still waits for checklist completion.',
      follow_up_instructions: 'Surgery OPD review in 5 days. Return earlier for fever, vomiting, jaundice, wound discharge, or worsening abdominal pain.',
      activity_restrictions: 'Avoid heavy lifting for 2 weeks. Walk as tolerated.',
      diet_instructions: 'Soft low-fat diet for 3 days, then normal diet as tolerated.',
      warning_signs: 'Fever, persistent vomiting, increasing abdominal pain, jaundice, or wound discharge.',
      medications_on_discharge: [
        { name: 'Paracetamol', dose: '650 mg', route: 'oral', frequency: 'TID PRN', duration: '3 days' },
        { name: 'Pantoprazole', dose: '40 mg', route: 'oral', frequency: 'OD', duration: '5 days' },
      ],
      procedures_performed: ['Laparoscopic cholecystectomy'],
      ai_metadata: {
        used_ai: false,
        fallback_reason: 'Local hands-on seed: AI provider not invoked',
        module_key: 'discharge_summary',
        model_tier: 'fallback',
      },
      source_citations: [
        { source: 'Admission case sheet', detail: 'Chief complaint and provisional diagnosis' },
        { source: 'Progress notes', detail: 'Course in hospital and current status' },
        { source: 'Procedure note', detail: 'Operation and intra-procedure findings' },
      ],
      safety_flags: [
        {
          code: 'CHECKLIST_PENDING',
          severity: 'review',
          message: 'Final discharge is blocked until role work items, pharmacy handover, and billing clearance are completed.',
        },
      ],
      is_signed: true,
      signed_by: doctor.uid,
      signed_by_name: doctor.name,
      signed_by_role: 'DOCTOR',
      signed_at: new Date().toISOString(),
    },
    isSigned: true,
    signedBy: doctor.uid,
  });
}

async function upsertAppointment(client, item, patientRow, doctor) {
  const visitNo = `${SEED_TAG.toUpperCase().replaceAll('_', '-')}-${item.doctorEmployeeId}-${item.key}`;
  await client.query(
    `INSERT INTO appointments
       (tenant_id, uid, phone, patient_id, doctor_id, doctor_name, patient_name,
        appointment_date, appointment_time, status, reason, notes, created_at,
        updated_at, admin_override, reminder_sent, reminder_1h_sent,
        reminder_24h_sent, token_number, department, visit_type, visit_no)
     VALUES
       ($1::uuid, gen_random_uuid(), $2, $3::int, $4::int, $5, $6,
        CURRENT_DATE, $7, $8, $9, $10, NOW(), NOW(), FALSE, FALSE, FALSE,
        FALSE, $11, $12, 'FOLLOW_UP', $13)
     ON CONFLICT (visit_no) WHERE visit_no IS NOT NULL DO UPDATE
       SET phone = EXCLUDED.phone,
           patient_id = EXCLUDED.patient_id,
           doctor_id = EXCLUDED.doctor_id,
           doctor_name = EXCLUDED.doctor_name,
           patient_name = EXCLUDED.patient_name,
           appointment_date = CURRENT_DATE,
           appointment_time = EXCLUDED.appointment_time,
           status = EXCLUDED.status,
           reason = EXCLUDED.reason,
           notes = EXCLUDED.notes,
           token_number = EXCLUDED.token_number,
           department = EXCLUDED.department,
           updated_at = NOW()`,
    [
      TENANT_ID,
      patientRow.phone,
      patientRow.id,
      doctor.id,
      doctor.name,
      patientRow.name,
      item.time,
      item.status,
      item.reason,
      `${SEED_TAG}: doctor-scoped appointment`,
      `${item.time.replace(':', '')}`,
      doctor.employee_id === 'EMP-1010'
        ? 'Obstetrics & Gynaecology'
        : doctor.employee_id === 'EMP-1012'
          ? 'Paediatrics'
          : 'General Medicine',
      visitNo,
    ]
  );
}

async function addAudit(client, actorUid, action, resource, resourceId, metadata = {}) {
  await client.query(
    `INSERT INTO audit_logs
       (uid, role, action, resource, resource_id, metadata, ip_address,
        actor_uid, subject_uid, created_at)
     VALUES
       ($1::uuid, 'SYSTEM', $2, $3, $4, $5::jsonb, NULL,
        $1::uuid, $6::uuid, NOW())`,
    [
      actorUid,
      action,
      resource,
      String(resourceId),
      JSON.stringify({ source: SEED_TAG, ...metadata }),
      metadata.subject_uid || null,
    ]
  );
}

async function main() {
  guard();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await seedCurrentBedStructure(client);

    const doctor = await staffUser(client, 'EMP-1004');
    const nurse = await staffUser(client, 'EMP-1001');
    const appointmentDoctors = new Map();
    for (const employeeId of ['EMP-1004', 'EMP-1010', 'EMP-1012']) {
      appointmentDoctors.set(employeeId, await staffUser(client, employeeId));
    }

    const patientRows = new Map();
    for (const patient of patients) {
      const row = await upsertPatient(client, patient);
      patientRows.set(patient.key, row);
      await ensureHospitalNumber(client, row, patient.hospitalNumber);
    }
    await ensureExistingPatientsHaveHospitalNumbers(client);

    await clearOrphanBaselineAdmission(client);
    await resetDemoBeds(client, [...patientRows.values()].map((row) => row.uid));
    await seedCurrentBedStructure(client);

    const admissionRows = [];
    for (const admission of admissions) {
      const patientRow = patientRows.get(admission.key);
      const row = await upsertAdmission(client, admission, patientRow, doctor);
      await assignBed(client, admission, row, patientRow);
      await seedNotes(client, admission, row, patientRow, doctor, nurse);
      await seedVitals(client, admission, row, patientRow);
      await seedDischarge(client, admission, row, patientRow, doctor);
      admissionRows.push({ admission, row, patientRow });
    }
    await setCleaningBed(client);

    for (const item of appointments) {
      const patientRow = patientRows.get(item.key);
      const apptDoctor = appointmentDoctors.get(item.doctorEmployeeId);
      await upsertAppointment(client, item, patientRow, apptDoctor);
    }

    await addAudit(client, doctor.uid, 'SEED_LOCAL_HANDS_ON_DATA', 'local_fixture', 'staff_app', {
      subject_uid: patientRows.get('fatima')?.uid,
      patients: patients.length,
      admissions: admissionRows.length,
      appointments: appointments.length,
    });

    await client.query('COMMIT');

    const counts = await all(
      client,
      `SELECT 'patients' AS name, COUNT(*)::int AS count FROM users WHERE role = 'PATIENT'
       UNION ALL SELECT 'appointments', COUNT(*)::int FROM appointments
       UNION ALL SELECT 'active_admissions', COUNT(*)::int FROM admissions WHERE discharged_at IS NULL
       UNION ALL SELECT 'occupied_beds', COUNT(*)::int FROM beds WHERE status = 'occupied'
       UNION ALL SELECT 'cleaning_beds', COUNT(*)::int FROM beds WHERE status = 'cleaning'
       UNION ALL SELECT 'clinical_notes', COUNT(*)::int FROM clinical_notes
       UNION ALL SELECT 'hospital_numbers', COUNT(*)::int FROM patient_identifiers WHERE status = 'active'`
    );

    console.log(
      JSON.stringify(
        {
          seed: SEED_TAG,
          restored: {
            patients: patients.map((p) => `${p.hospitalNumber} ${p.name}`),
            occupied_beds: admissions.map((a) => `${a.bedNumber} ${patientRows.get(a.key)?.name}`),
            discharge_hub_patient: patientRows.get('shanthi')?.name,
            appointment_doctors: [...appointmentDoctors.values()].map((d) => `${d.employee_id} ${d.name}`),
          },
          counts: Object.fromEntries(counts.map((row) => [row.name, row.count])),
        },
        null,
        2
      )
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[${SEED_TAG}] crashed:`, err);
  process.exit(1);
});
