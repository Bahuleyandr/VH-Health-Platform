#!/usr/bin/env node
// scripts/dsar-export.mjs
//
// DSAR (Data Subject Access Request) export — §13 portability / §12 access.
// Produces a FHIR R4 Bundle JSON file for a given patient, covering the data
// categories in dataExportRoutes.js (profile, appointments, health records,
// investigations, prescriptions, pharmacy orders, feedback, notifications).
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/dsar-export.mjs \
//     --uid <patient-uid>                    # or
//     --phone <e164-phone>                   # either identifier works
//     [--out <path>]                         # default: ./dsar-<uid>-<timestamp>.json
//     [--pretty]                             # pretty-print output
//
// Notes
// - Output format is FHIR R4 Bundle of type "collection" — interoperable
//   with any FHIR-aware processor. Resource IDs are prefixed (Patient/xxx,
//   Appointment/xxx, Observation/xxx, ...) and cross-linked via `subject`.
// - Read-only. Never mutates. Safe to run against prod.
// - Mapping is minimal but spec-compliant. Extend per-resource in the
//   mapping functions below when new fields need to flow through.
// - Run inside Operator documentation: docs/DATA_SUBJECT_RIGHTS.md.

import { argv, exit } from 'node:process';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import pg from 'pg';

function parseArgs(a) {
  const out = { pretty: false };
  for (let i = 2; i < a.length; i++) {
    const k = a[i];
    if (k === '--uid') out.uid = a[++i];
    else if (k === '--phone') out.phone = a[++i];
    else if (k === '--out') out.out = a[++i];
    else if (k === '--pretty') out.pretty = true;
    else if (k === '-h' || k === '--help') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage: node scripts/dsar-export.mjs --uid <uid> | --phone <phone> [--out <path>] [--pretty]

Produces a FHIR R4 Bundle JSON export of a patient's data for DSAR (§13
portability / §12 access) response.

Requires DATABASE_URL in the environment.`);
}

const args = parseArgs(argv);
if (args.help || (!args.uid && !args.phone)) {
  usage();
  exit(args.help ? 0 : 1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

// --- Resolve patient --------------------------------------------------------
// uid is uuid + phone is varchar; cast uid to text so a single $1 bind works.
// SELECT * to be resilient to schema drift (allergies/emergency_contact/blood_group
// exist in prod but not always in dev DBs seeded from older migrations).
const userRes = await client.query(
  `SELECT * FROM users WHERE uid::text = $1 OR phone = $1 LIMIT 1`,
  [args.uid || args.phone],
);
if (userRes.rows.length === 0) {
  console.error(`No user found for ${args.uid ? `uid=${args.uid}` : `phone=${args.phone}`}`);
  await client.end();
  exit(2);
}
const user = userRes.rows[0];
const uid = user.uid;
const phone = user.phone;

// --- FHIR mapping helpers ---------------------------------------------------
const now = new Date().toISOString();

function patientResource(u) {
  const r = {
    resourceType: 'Patient',
    id: u.uid,
    active: !!u.is_active,
    name: u.name ? [{ text: u.name }] : undefined,
    telecom: [
      u.phone ? { system: 'phone', value: u.phone, use: 'mobile' } : null,
      u.email ? { system: 'email', value: u.email } : null,
    ].filter(Boolean),
    gender: u.gender ? String(u.gender).toLowerCase() : undefined,
    birthDate: u.birthday ? new Date(u.birthday).toISOString().slice(0, 10) : undefined,
    address: u.address ? [{ text: u.address }] : undefined,
    extension: [
      u.blood_group && {
        url: 'https://vhhealth.app/fhir/StructureDefinition/bloodGroup',
        valueString: u.blood_group,
      },
      u.allergies && {
        url: 'https://vhhealth.app/fhir/StructureDefinition/allergiesFreeText',
        valueString: typeof u.allergies === 'string' ? u.allergies : JSON.stringify(u.allergies),
      },
      u.emergency_contact && {
        url: 'https://vhhealth.app/fhir/StructureDefinition/emergencyContact',
        valueString: typeof u.emergency_contact === 'string' ? u.emergency_contact : JSON.stringify(u.emergency_contact),
      },
    ].filter(Boolean),
  };
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)));
}

function appointmentResource(row) {
  return {
    resourceType: 'Appointment',
    id: `appt-${row.id}`,
    status: mapApptStatus(row.status),
    description: row.reason || undefined,
    comment: row.notes || undefined,
    start: combineDateTime(row.appointment_date, row.appointment_time),
    serviceType: row.department ? [{ text: row.department }] : undefined,
    participant: [
      { actor: { reference: `Patient/${uid}` }, status: 'accepted' },
      row.doctor_id ? { actor: { reference: `Practitioner/${row.doctor_id}` }, status: 'accepted' } : null,
    ].filter(Boolean),
    identifier: row.token_number ? [{ system: 'https://vhhealth.app/fhir/token', value: String(row.token_number) }] : undefined,
    created: row.created_at ? new Date(row.created_at).toISOString() : undefined,
  };
}

function observationResource(row) {
  return {
    resourceType: 'Observation',
    id: `obs-${row.id}`,
    status: 'final',
    code: { text: row.record_type || 'unknown' },
    subject: { reference: `Patient/${uid}` },
    effectiveDateTime: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    valueString: typeof row.record_data === 'string' ? row.record_data : JSON.stringify(row.record_data),
    note: row.notes ? [{ text: row.notes }] : undefined,
    performer: row.doctor_name ? [{ display: row.doctor_name }] : undefined,
  };
}

function documentReferenceResource(row) {
  return {
    resourceType: 'DocumentReference',
    id: `doc-${row.id}`,
    status: 'current',
    subject: { reference: `Patient/${uid}` },
    type: { text: row.record_type || 'document' },
    date: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    content: [
      {
        attachment: {
          title: row.file_name || undefined,
          url: row.file_key ? `https://vhhealth.app/upload/by-key/${row.file_key}` : undefined,
        },
      },
    ],
    description: row.notes || undefined,
  };
}

function diagnosticReportResource(row) {
  return {
    resourceType: 'DiagnosticReport',
    id: `diag-${row.id}`,
    status: mapInvestigationStatus(row.status),
    code: { text: row.investigation_type || 'investigation' },
    subject: { reference: `Patient/${uid}` },
    effectiveDateTime: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    conclusion: typeof row.results === 'string' ? row.results : row.results ? JSON.stringify(row.results) : undefined,
    note: row.notes ? [{ text: row.notes }] : undefined,
  };
}

function medicationDispenseResource(row) {
  return {
    resourceType: 'MedicationDispense',
    id: `med-${row.id}`,
    status: mapPharmacyStatus(row.status),
    subject: { reference: `Patient/${uid}` },
    whenHandedOver: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    note: [row.order_note, row.notes].filter(Boolean).map((t) => ({ text: t })),
    extension: row.urgent
      ? [{ url: 'https://vhhealth.app/fhir/StructureDefinition/urgent', valueBoolean: true }]
      : undefined,
  };
}

function feedbackCommunicationResource(row) {
  return {
    resourceType: 'Communication',
    id: `feedback-${row.id}`,
    status: 'completed',
    subject: { reference: `Patient/${uid}` },
    sent: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    payload: [
      row.comment ? { contentString: row.comment } : null,
      row.rating != null ? { contentString: `rating=${row.rating}` } : null,
    ].filter(Boolean),
    about: row.appointment_id ? [{ reference: `Appointment/appt-${row.appointment_id}` }] : undefined,
  };
}

function notificationCommunicationResource(row) {
  return {
    resourceType: 'Communication',
    id: `notif-${row.id}`,
    status: 'completed',
    subject: { reference: `Patient/${uid}` },
    received: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    category: [{ text: row.type || 'notification' }],
    payload: [{ contentString: `${row.title || ''}\n${row.body || ''}`.trim() }],
    note: row.read === false ? [{ text: 'unread at export time' }] : undefined,
  };
}

function mapApptStatus(s) {
  const m = {
    SCHEDULED: 'booked',
    CONFIRMED: 'booked',
    IN_PROGRESS: 'arrived',
    COMPLETED: 'fulfilled',
    CANCELLED: 'cancelled',
    NO_SHOW: 'noshow',
  };
  return m[String(s).toUpperCase()] || 'booked';
}

function mapInvestigationStatus(s) {
  const m = {
    PENDING: 'registered',
    CONFIRMED: 'partial',
    SAMPLE_COLLECTED: 'partial',
    PROCESSING: 'partial',
    COMPLETED: 'final',
    REPORT_READY: 'final',
    CANCELLED: 'cancelled',
  };
  return m[String(s).toUpperCase()] || 'registered';
}

function mapPharmacyStatus(s) {
  const m = {
    PENDING: 'preparation',
    CONFIRMED: 'preparation',
    PREPARING: 'in-progress',
    READY: 'preparation',
    DISPATCHED: 'in-progress',
    DELIVERED: 'completed',
    CANCELLED: 'cancelled',
  };
  return m[String(s).toUpperCase()] || 'unknown';
}

function combineDateTime(date, time) {
  if (!date) return undefined;
  const d = new Date(date).toISOString().slice(0, 10);
  if (!time) return d;
  const t = typeof time === 'string' ? time : new Date(time).toISOString().slice(11, 19);
  return `${d}T${t}`;
}

// --- Collect data ----------------------------------------------------------
// Per-table query with graceful degradation: if a table or column is absent
// (dev DB drift vs prod schema), note it and continue. DSAR exports must
// succeed with whatever data exists — partial is better than failed.
const skipped = [];
async function safeSelectAll(sql, params, label) {
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } catch (e) {
    skipped.push({ label, reason: e.message.split('\n')[0] });
    return [];
  }
}

const appts = await safeSelectAll(
  `SELECT * FROM appointments WHERE uid::text = $1 OR phone = $2 LIMIT 10000`,
  [uid, phone],
  'appointments',
);
const hrecs = await safeSelectAll(
  `SELECT * FROM health_records WHERE phone = $1 LIMIT 10000`,
  [phone],
  'health_records',
);
const docs = await safeSelectAll(
  `SELECT * FROM records WHERE phone = $1 LIMIT 10000`,
  [phone],
  'records',
);
const invs = await safeSelectAll(
  `SELECT * FROM investigations WHERE phone = $1 LIMIT 10000`,
  [phone],
  'investigations',
);
const pharmas = await safeSelectAll(
  `SELECT * FROM pharmacy_orders WHERE phone = $1 LIMIT 10000`,
  [phone],
  'pharmacy_orders',
);
const feedback = await safeSelectAll(
  `SELECT * FROM feedback WHERE phone = $1 LIMIT 10000`,
  [phone],
  'feedback',
);
const notifs = await safeSelectAll(
  `SELECT * FROM notifications WHERE phone = $1 LIMIT 10000`,
  [phone],
  'notifications',
);

// --- Build Bundle ----------------------------------------------------------
const entries = [
  { fullUrl: `Patient/${uid}`, resource: patientResource(user) },
  ...appts.map((r) => ({ fullUrl: `Appointment/appt-${r.id}`, resource: appointmentResource(r) })),
  ...hrecs.map((r) => ({ fullUrl: `Observation/obs-${r.id}`, resource: observationResource(r) })),
  ...docs.map((r) => ({ fullUrl: `DocumentReference/doc-${r.id}`, resource: documentReferenceResource(r) })),
  ...invs.map((r) => ({ fullUrl: `DiagnosticReport/diag-${r.id}`, resource: diagnosticReportResource(r) })),
  ...pharmas.map((r) => ({ fullUrl: `MedicationDispense/med-${r.id}`, resource: medicationDispenseResource(r) })),
  ...feedback.map((r) => ({ fullUrl: `Communication/feedback-${r.id}`, resource: feedbackCommunicationResource(r) })),
  ...notifs.map((r) => ({ fullUrl: `Communication/notif-${r.id}`, resource: notificationCommunicationResource(r) })),
];

const bundle = {
  resourceType: 'Bundle',
  id: `dsar-${uid}-${Date.now()}`,
  type: 'collection',
  timestamp: now,
  total: entries.length,
  meta: {
    tag: [
      { system: 'https://vhhealth.app/fhir/tag', code: 'dsar-export' },
      { system: 'https://vhhealth.app/fhir/tag', code: 'dpdpa-section-13' },
    ],
  },
  entry: entries,
};

// --- Write output -----------------------------------------------------------
const outPath = resolvePath(args.out || `./dsar-${uid}-${Date.now()}.json`);
const payload = args.pretty ? JSON.stringify(bundle, null, 2) : JSON.stringify(bundle);
writeFileSync(outPath, payload, 'utf8');

console.log(`✓ DSAR export complete`);
console.log(`  patient: ${uid} (${phone})`);
console.log(`  resources: ${entries.length}`);
console.log(`    - 1 Patient`);
console.log(`    - ${appts.length} Appointment(s)`);
console.log(`    - ${hrecs.length} Observation(s)`);
console.log(`    - ${docs.length} DocumentReference(s)`);
console.log(`    - ${invs.length} DiagnosticReport(s)`);
console.log(`    - ${pharmas.length} MedicationDispense(s)`);
console.log(`    - ${feedback.length + notifs.length} Communication(s)`);
if (skipped.length > 0) {
  console.log(`  skipped tables (schema drift):`);
  for (const s of skipped) console.log(`    - ${s.label}: ${s.reason}`);
}
console.log(`  written to: ${outPath}`);
console.log(`  size: ${payload.length} bytes`);

await client.end();
