#!/usr/bin/env node
// Seeds the current VH inpatient bed structure from the photographed A/B block
// room lists plus requested specialty units. Idempotent and safe to re-run
// against the local QA database.

import pg from 'pg';
import { fileURLToPath } from 'node:url';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export const CURRENT_BED_STRUCTURE = [
  {
    name: 'ER',
    floor: 0,
    building: 'Emergency',
    beds: [
      ['ER-1', 'er', 'Emergency Bed', null],
      ['ER-2', 'er', 'Emergency Bed', null],
      ['ER-3', 'er', 'Emergency Bed', null],
      ['ER-4', 'er', 'Emergency Bed', null],
      ['ER-5', 'er', 'Emergency Bed', null],
      ['ER-6', 'er', 'Emergency Bed', null],
      ['ER-7', 'er', 'Emergency Bed', null],
      ['ER-8', 'er', 'Emergency Bed', null],
      ['ER-9', 'er', 'Emergency Bed', null],
      ['ER-10', 'er', 'Emergency Bed', null],
    ],
  },
  {
    name: 'Day Care',
    floor: 0,
    building: 'Day Care',
    beds: [
      ['DC-1', 'day_care', 'Day Care Bed', null],
      ['DC-2', 'day_care', 'Day Care Bed', null],
      ['DC-3', 'day_care', 'Day Care Bed', null],
      ['DC-4', 'day_care', 'Day Care Bed', null],
      ['DC-5', 'day_care', 'Day Care Bed', null],
      ['DC-6', 'day_care', 'Day Care Bed', null],
      ['DC-7', 'day_care', 'Day Care Bed', null],
      ['DC-8', 'day_care', 'Day Care Bed', null],
      ['DC-9', 'day_care', 'Day Care Bed', null],
      ['DC-10', 'day_care', 'Day Care Bed', null],
    ],
  },
  {
    name: 'Dialysis',
    floor: 0,
    building: 'Dialysis Unit',
    beds: [
      ['DIAL-1', 'dialysis', 'Dialysis Bed', null],
      ['DIAL-2', 'dialysis', 'Dialysis Bed', null],
      ['DIAL-3', 'dialysis', 'Dialysis Bed', null],
      ['DIAL-4', 'dialysis', 'Dialysis Bed', null],
    ],
  },
  {
    name: 'A Block - Floor III',
    floor: 3,
    building: 'A Block',
    beds: [
      ['A-301', 'single_non_ac', 'Single Non A/C', 4500],
      ['A-302', 'unclassified', 'Handwritten floor list - tariff pending', null],
      ['A-303', 'general_ward', 'General Ward', 2500],
      ['A-304A', 'general_ward', 'General Ward', 2500],
      ['A-304B', 'general_ward', 'General Ward', 2500],
      ['A-305', 'general_ward', 'General Ward', 2500],
      ['A-306', 'general_ward', 'General Ward', 2500],
      ['A-307', 'general_ward', 'General Ward', 2500],
      ['A-308', 'general_ward', 'General Ward', 2500],
      ['A-309', 'single_non_ac', 'Single Non A/C', 4500],
      ['A-310A', 'twin_sharing_ac', 'Twin Sharing A/C', 4500],
      ['A-310B', 'twin_sharing_ac', 'Twin Sharing A/C', 4500],
      ['A-311A', 'neonatal', 'Neonatal', 7500],
      ['A-311B', 'neonatal', 'Neonatal', 7500],
      ['A-311C', 'neonatal', 'Neonatal', 7500],
    ],
  },
  {
    name: 'A Block - Floor IV',
    floor: 4,
    building: 'A Block',
    beds: [
      ['A-401', 'single_ac', 'Single A/C', 6500],
      ['A-402', 'single_non_ac', 'Single Non A/C', 4500],
      ['A-403', 'single_non_ac', 'Single Non A/C', 4500],
      ['A-404', 'single_ac', 'Single A/C', 6500],
      ['A-405', 'single_non_ac', 'Single Non A/C', 4500],
      ['A-406A', 'twin_sharing_non_ac', 'Twin Sharing Non A/C', 3500],
      ['A-406B', 'twin_sharing_non_ac', 'Twin Sharing Non A/C', 3500],
      ['A-407', 'single_ac', 'Single A/C', 6500],
      ['A-408', 'single_ac', 'Single A/C', 6500],
      ['A-409', 'single_ac', 'Single A/C', 6500],
      ['A-410', 'deluxe_ac', 'Deluxe A/C', 7500],
    ],
  },
  {
    name: 'A Block - Floor V',
    floor: 5,
    building: 'A Block',
    beds: [
      ['A-501', 'single_ac', 'Single A/C', 6500],
      ['A-502', 'single_ac', 'Single A/C', 6500],
      ['A-503', 'single_ac', 'Single A/C', 6500],
      ['A-504', 'deluxe_ac', 'Deluxe A/C', 7500],
      ['A-505', 'single_ac', 'Single A/C', 6500],
      ['A-506A', 'twin_sharing_ac', 'Twin Sharing A/C', 4500],
      ['A-506B', 'twin_sharing_ac', 'Twin Sharing A/C', 4500],
      ['A-507', 'single_ac', 'Single A/C', 6500],
      ['A-508', 'single_ac', 'Single A/C', 6500],
      ['A-509', 'single_ac', 'Single A/C', 6500],
      ['A-510', 'deluxe_ac', 'Deluxe A/C', 7500],
    ],
  },
  {
    name: 'B Block - ICU',
    floor: 1,
    building: 'B Block',
    beds: [
      ['B-101', 'icu_secluded', 'ICU / Secluded', 20000],
      ['B-102', 'icu_secluded', 'ICU / Secluded', 20000],
      ['B-103', 'icu', 'ICU', 15000],
      ['B-104', 'icu', 'ICU', 15000],
      ['B-105', 'icu', 'ICU', 15000],
      ['B-106', 'icu', 'ICU', 15000],
      ['B-107', 'icu', 'ICU', 15000],
      ['B-108', 'icu', 'ICU', 15000],
      ['B-109', 'icu', 'ICU', 15000],
      ['B-110', 'icu', 'ICU', 15000],
      ['B-111', 'icu', 'ICU', 15000],
      ['B-112', 'icu', 'ICU', 15000],
      ['B-113', 'icu', 'ICU', 15000],
      ['B-114', 'icu', 'ICU', 15000],
    ],
  },
  {
    name: 'B Block - Floor II',
    floor: 2,
    building: 'B Block',
    beds: [
      ['B-202', 'deluxe', 'Deluxe', 7500],
      ['B-203', 'deluxe', 'Deluxe', 7500],
      ['B-204', 'suite', 'Suite Room', 14500],
      ['B-205', 'single_ac', 'Single A/C', 6500],
      ['B-206', 'single_ac', 'Single A/C', 6500],
      ['B-207', 'deluxe', 'Deluxe', 7500],
      ['B-208', 'deluxe', 'Deluxe', 7500],
      ['B-209', 'deluxe', 'Deluxe', 7500],
      ['B-211', 'super_deluxe', 'Super Deluxe', 8500],
      ['B-212', 'deluxe', 'Deluxe', 7500],
    ],
  },
  {
    name: 'B Block - Floor III',
    floor: 3,
    building: 'B Block',
    beds: [
      ['B-301', 'suite', 'Suite Room', 14500],
      ['B-302', 'deluxe', 'Deluxe', 7500],
      ['B-303', 'deluxe', 'Deluxe', 7500],
      ['B-304', 'unclassified', 'Handwritten floor list - tariff pending', null],
      ['B-305', 'unclassified', 'Handwritten floor list - tariff pending', null],
      ['B-306', 'unclassified', 'Handwritten floor list - tariff pending', null],
      ['B-307', 'deluxe', 'Deluxe', 7500],
      ['B-308', 'deluxe', 'Deluxe', 7500],
      ['B-309', 'deluxe', 'Deluxe', 7500],
      ['B-310', 'unclassified', 'Handwritten floor list - tariff pending', null],
      ['B-311', 'suite', 'Suite Room', 14500],
      ['B-312', 'deluxe', 'Deluxe', 7500],
    ],
  },
];

const LEGACY_SEED_WARDS = [
  'General Ward',
  'ICU',
  'CCU',
  'Semi-Private',
  'Private',
  'Deluxe',
  'Day Care',
];

export const LEGACY_DEMO_BED_NUMBERS = [
  'GW-201',
  'GW-202',
  'ICU-001',
  'CCU-001',
  'SP-001',
  'PR-002',
  'DLX-001',
  'DLX-004',
  'DC-001',
];

function isLocalTestDatabase(urlText) {
  try {
    const url = new URL(urlText);
    const host = url.hostname.toLowerCase();
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    return ['127.0.0.1', 'localhost', '::1'].includes(host) && database === 'vhhealth_test';
  } catch {
    return false;
  }
}

function tariffNote({ ward, roomType, rate }) {
  const base = `${ward.building}; floor ${ward.floor}; room type: ${roomType}`;
  return rate ? `${base}; tariff: Rs.${rate}/day` : `${base}; tariff pending confirmation`;
}

function isStrictScreeningWard(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'er' || normalized.includes('emergency') || normalized.includes('icu');
}

function attendantPassColor(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (normalized === 'er' || normalized.includes('emergency')) return 'orange';
  if (normalized.includes('icu')) return 'red';
  return 'blue';
}

async function upsertWard(client, ward) {
  const existing = await client.query(
    `SELECT id FROM wards WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [ward.name]
  );
  const totalBeds = ward.beds.length;
  const strictScreening = isStrictScreeningWard(ward.name);
  const passColor = attendantPassColor(ward.name);
  if (existing.rowCount) {
    await client.query(
      `UPDATE wards
          SET floor = $1,
              total_beds = $2,
              attendant_pass_color = COALESCE(attendant_pass_color, $4::text),
              attendant_pass_screening_level = CASE
                WHEN $5::boolean THEN 'strict'
                ELSE COALESCE(attendant_pass_screening_level, 'standard')
              END,
              updated_at = NOW()
        WHERE id = $3`,
      [ward.floor, totalBeds, existing.rows[0].id, passColor, strictScreening]
    );
    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `INSERT INTO wards
       (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id`,
    [
      ward.name,
      ward.floor,
      totalBeds,
      passColor,
      strictScreening ? 'strict' : 'standard',
    ]
  );
  return inserted.rows[0].id;
}

async function upsertBed(client, ward, wardId, bed) {
  const [bedNumber, bedType, roomType, rate] = bed;
  const note = tariffNote({ ward, roomType, rate });
  const existing = await client.query(
    `SELECT id, patient_id, patient_uid, admission_id
       FROM beds
      WHERE LOWER(bed_number) = LOWER($1)
      LIMIT 1`,
    [bedNumber]
  );

  if (existing.rowCount) {
    await client.query(
      `UPDATE beds
          SET ward_id = $2,
              ward_name = $3,
              floor = $4,
              bed_type = $5,
              notes = CASE
                WHEN patient_id IS NULL AND patient_uid IS NULL AND admission_id IS NULL
                  THEN $6
                ELSE COALESCE(notes, $6)
              END,
              tenant_id = COALESCE(tenant_id, $7::uuid),
              updated_at = NOW()
        WHERE id = $1`,
      [existing.rows[0].id, wardId, ward.name, ward.floor, bedType, note, DEFAULT_TENANT_ID]
    );
    return 'updated';
  }

  await client.query(
    `INSERT INTO beds
       (ward_id, ward_name, bed_number, status, bed_type, floor, notes, tenant_id, created_at, updated_at)
     VALUES
       ($1, $2, $3, 'available', $4, $5, $6, $7::uuid, NOW(), NOW())`,
    [wardId, ward.name, bedNumber, bedType, ward.floor, note, DEFAULT_TENANT_ID]
  );
  return 'inserted';
}

async function upsertHousekeepingZone(client, ward) {
  const zoneName = ward.name;
  const existing = await client.query(
    `SELECT id
       FROM housekeeping_zones
      WHERE LOWER(name) = LOWER($1)
        AND LOWER(zone_type) = 'floor'
      LIMIT 1`,
    [zoneName]
  );
  if (existing.rowCount) {
    await client.query(
      `UPDATE housekeeping_zones
          SET floor = $2,
              building = $3,
              is_active = TRUE,
              updated_at = NOW()
        WHERE id = $1`,
      [existing.rows[0].id, String(ward.floor), ward.building]
    );
    return;
  }

  await client.query(
    `INSERT INTO housekeeping_zones
       (name, zone_type, floor, building, is_active, created_at, updated_at)
     VALUES ($1, 'floor', $2, $3, TRUE, NOW(), NOW())`,
    [zoneName, String(ward.floor), ward.building]
  );
}

async function cleanupLegacySeedBeds(client) {
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
            updated_at = NOW()
      WHERE bed_number = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1
            FROM admissions a
           WHERE a.bed_id = beds.id
             AND a.discharged_at IS NULL
        )
        AND patient_uid IS NULL`,
    [LEGACY_DEMO_BED_NUMBERS]
  );

  await client.query(
    `DELETE FROM beds b
      USING wards w
      WHERE b.ward_id = w.id
        AND LOWER(w.name) = ANY($1::text[])
        AND b.patient_id IS NULL
        AND b.patient_uid IS NULL
        AND b.admission_id IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM admissions a
           WHERE a.bed_id = b.id
             AND a.discharged_at IS NULL
        )`,
    [LEGACY_SEED_WARDS.map((name) => name.toLowerCase())]
  );

  await client.query(
    `DELETE FROM wards w
      WHERE LOWER(w.name) = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM beds b WHERE b.ward_id = w.id)
        AND NOT EXISTS (
          SELECT 1
            FROM admissions a
           WHERE LOWER(COALESCE(a.ward, '')) = LOWER(w.name)
             AND a.discharged_at IS NULL
        )`,
    [LEGACY_SEED_WARDS.map((name) => name.toLowerCase())]
  );
}

export async function seedCurrentBedStructure(client, { cleanupLegacy = true } = {}) {
  const summary = { wards: 0, bedsInserted: 0, bedsUpdated: 0, zones: 0 };
  for (const ward of CURRENT_BED_STRUCTURE) {
    const wardId = await upsertWard(client, ward);
    summary.wards += 1;
    await upsertHousekeepingZone(client, ward);
    summary.zones += 1;
    for (const bed of ward.beds) {
      const action = await upsertBed(client, ward, wardId, bed);
      if (action === 'inserted') summary.bedsInserted += 1;
      else summary.bedsUpdated += 1;
    }
  }
  if (cleanupLegacy) await cleanupLegacySeedBeds(client);
  return summary;
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL or TEST_DATABASE_URL is required.');
  }
  if (!isLocalTestDatabase(connectionString) && process.env.VH_ALLOW_NON_TEST_DATA_SEED !== 'true') {
    throw new Error(
      'Refusing to seed a non-local test database. Use local vhhealth_test or set VH_ALLOW_NON_TEST_DATA_SEED=true.'
    );
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const summary = await seedCurrentBedStructure(client);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[seed-current-bed-structure] failed:', err);
    process.exit(1);
  });
}
