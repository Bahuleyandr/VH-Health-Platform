// src/routes/fhir/fhirRoutes.js
// HL7 FHIR R4 interoperability routes
// Exposes VH Health data as FHIR-compliant JSON resources

import express from 'express';
import prisma from '../../lib/prisma.js';
import {
  toFhirPatient,
  toFhirAppointment,
  toFhirObservation,
  toFhirMedicationRequest,
  toFhirCondition,
  toFhirProcedure,
  toFhirDiagnosticReport,
  toFhirAllergyIntolerance,
  toFhirEncounter,
  toFhirDocumentReference,
  toFhirServiceRequest,
} from '../../services/fhir/fhirAdapter.js';
import { validatedFhirJson } from '../../services/fhir/fhirValidator.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Middleware: set FHIR content type on all responses from this router
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/fhir+json; charset=utf-8');
  next();
});

// ---------------------------------------------------------------------------
// Helper: wrap a FHIR resource array in a Bundle (searchset)
// ---------------------------------------------------------------------------
function buildBundle(resourceType, entries) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: entries.length,
    entry: entries.map((resource) => ({
      fullUrl: `${resourceType}/${resource.id}`,
      resource,
    })),
  };
}

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Helper: parse _count and _offset query parameters
// ---------------------------------------------------------------------------
function parsePagination(query) {
  const _count = Math.min(Math.max(parseInt(query._count, 10) || 200, 1), 1000);
  const _offset = Math.max(parseInt(query._offset, 10) || 0, 0);
  return { _count, _offset };
}

// ---------------------------------------------------------------------------
// GET /metadata — FHIR CapabilityStatement
// ---------------------------------------------------------------------------
router.get(
  '/metadata',
  wrapAsync(async (req, res) => {
    const capabilityStatement = {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: new Date().toISOString(),
      kind: 'instance',
      software: {
        name: 'VH Health FHIR Adapter',
        version: process.env.API_VERSION || '1.0.0',
      },
      fhirVersion: '4.0.1',
      format: ['json'],
      rest: [
        {
          mode: 'server',
          resource: [
            {
              type: 'Patient',
              interaction: [
                { code: 'read' },
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'name', type: 'string' },
                { name: 'phone', type: 'token' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'Appointment',
              interaction: [
                { code: 'read' },
              ],
            },
            {
              type: 'Observation',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: 'code', type: 'token' },
                { name: 'date', type: 'date' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'MedicationRequest',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: 'status', type: 'token' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'Condition',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'Procedure',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'DiagnosticReport',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'AllergyIntolerance',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'Encounter',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'DocumentReference',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: 'type', type: 'token' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'ServiceRequest',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
          ],
        },
      ],
    };

    res.json(capabilityStatement);
  })
);

// ---------------------------------------------------------------------------
// GET /Patient/:id — Read a single Patient resource
// ---------------------------------------------------------------------------
router.get(
  '/Patient/:id',
  wrapAsync(async (req, res) => {
    const { id } = req.params;

    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
       FROM users WHERE uid = $1 LIMIT 1`,
      id
    );

    if (!rows.length) {
      throw AppError.notFound('Patient not found');
    }

    // Validate before returning so any adapter drift surfaces as a 500 with an
    // OperationOutcome instead of reaching the peer as invalid FHIR.
    return validatedFhirJson(res, toFhirPatient(rows[0]), { expectedType: 'Patient' });
  })
);

// ---------------------------------------------------------------------------
// GET /Patient — Search patients by name or phone
// ---------------------------------------------------------------------------
router.get(
  '/Patient',
  wrapAsync(async (req, res) => {
    const { name, phone } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (name) {
      conditions.push(`name ILIKE $${idx}`);
      params.push(`%${name}%`);
      idx++;
    }

    if (phone) {
      conditions.push(`phone = $${idx}`);
      params.push(phone);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
       FROM users ${where} ORDER BY name LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirPatient);
    res.json(buildBundle('Patient', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /Appointment/:id — Read a single Appointment resource
// ---------------------------------------------------------------------------
router.get(
  '/Appointment/:id',
  wrapAsync(async (req, res) => {
    const { id } = req.params;

    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.uid, a.phone, a.patient_name, a.doctor_id, a.doctor_name,
              a.appointment_date, a.appointment_time, a.status, a.reason, a.notes, a.created_at
       FROM appointments a WHERE a.id = $1 LIMIT 1`,
      id
    );

    if (!rows.length) {
      throw AppError.notFound('Appointment not found');
    }

    return validatedFhirJson(res, toFhirAppointment(rows[0]), { expectedType: 'Appointment' });
  })
);

// ---------------------------------------------------------------------------
// GET /Observation — Search observations (vital signs) by patient, type, date
// ---------------------------------------------------------------------------
router.get(
  '/Observation',
  wrapAsync(async (req, res) => {
    const { patient, code, date } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`patient_uid = $${idx}`);
      params.push(patient);
      idx++;
    }

    if (code) {
      conditions.push(`type ILIKE $${idx}`);
      params.push(`%${code}%`);
      idx++;
    }

    if (date) {
      conditions.push(`recorded_date::date = $${idx}::date`);
      params.push(date);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, type, value, unit, recorded_date, recorded_by
       FROM vital_signs ${where} ORDER BY recorded_date DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirObservation);
    res.json(buildBundle('Observation', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /MedicationRequest — Search medication requests by patient, status
// ---------------------------------------------------------------------------
router.get(
  '/MedicationRequest',
  wrapAsync(async (req, res) => {
    const { patient, status } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`uid = $${idx}`);
      params.push(patient);
      idx++;
    }

    if (status) {
      // Map FHIR status back to VH Health status for filtering
      const reverseStatusMap = {
        active: ['PENDING', 'APPROVED'],
        completed: ['DISPENSED', 'DELIVERED'],
        cancelled: ['CANCELLED'],
        stopped: ['REJECTED'],
        'on-hold': ['ON_HOLD'],
      };
      const vhStatuses = reverseStatusMap[status];
      if (vhStatuses && vhStatuses.length > 0) {
        const placeholders = vhStatuses.map(() => `$${idx++}`).join(', ');
        conditions.push(`status IN (${placeholders})`);
        params.push(...vhStatuses);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, phone, status, medication, order_note, prescribed_by,
              priority, urgent, ordered_at, created_at
       FROM pharmacy_orders ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirMedicationRequest);
    res.json(buildBundle('MedicationRequest', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /Condition — Search conditions (diagnoses) by patient
// ---------------------------------------------------------------------------
router.get(
  '/Condition',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`patient_uid = $${idx}`);
      params.push(patient);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status, icd10_code, icd10_description, description,
              onset_date, resolved_date, diagnosed_by, notes, created_at
       FROM diagnoses ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirCondition);
    res.json(buildBundle('Condition', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /Procedure — Search procedures by patient
// ---------------------------------------------------------------------------
router.get(
  '/Procedure',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`patient_uid = $${idx}`);
      params.push(patient);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, note_type, title, content, status, procedure_name,
              performed_at, performed_by, author_id, outcome, complications, notes, created_at
       FROM clinical_notes ${where} AND note_type = 'PROCEDURE' ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirProcedure);
    res.json(buildBundle('Procedure', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /DiagnosticReport — Search diagnostic reports (investigations) by patient
// ---------------------------------------------------------------------------
router.get(
  '/DiagnosticReport',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`(patient_uid = $${idx} OR uid = $${idx})`);
      params.push(patient);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, uid, status, test_name, investigation_type, results,
              conclusion, interpretation, ordered_at, completed_at, created_at
       FROM investigations ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirDiagnosticReport);
    res.json(buildBundle('DiagnosticReport', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /AllergyIntolerance — Search patient allergies
// ---------------------------------------------------------------------------
router.get(
  '/AllergyIntolerance',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`patient_uid = $${idx}`);
      params.push(patient);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, allergen, description, name, severity, reaction, recorded_at
       FROM allergies ${where} ORDER BY recorded_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirAllergyIntolerance);
    res.json(buildBundle('AllergyIntolerance', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /Encounter — Search patient encounters (admissions)
// ---------------------------------------------------------------------------
router.get(
  '/Encounter',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`patient_uid = $${idx}`);
      params.push(patient);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status, priority, admission_type, reason, reason_for_admission,
              admitting_doctor, attending_doctor, admitted_at, discharged_at,
              discharge_disposition, discharge_type, ward, bed_number
       FROM admissions ${where} ORDER BY admitted_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirEncounter);
    res.json(buildBundle('Encounter', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /DocumentReference — Search clinical documents by patient and type
// ---------------------------------------------------------------------------
router.get(
  '/DocumentReference',
  wrapAsync(async (req, res) => {
    const { patient, type } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`patient_uid = $${idx}`);
      params.push(patient);
      idx++;
    }

    if (type) {
      conditions.push(`note_type ILIKE $${idx}`);
      params.push(`%${type}%`);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, note_type, type, title, content, author_id, created_by, created_at
       FROM clinical_notes ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirDocumentReference);
    res.json(buildBundle('DocumentReference', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /ServiceRequest — Search referrals by patient
// ---------------------------------------------------------------------------
router.get(
  '/ServiceRequest',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (patient) {
      conditions.push(`patient_uid = $${idx}`);
      params.push(patient);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status, priority, referring_doctor, requester_id,
              referred_to_doctor, performer_id, referred_to_department,
              reason, clinical_notes, notes, created_at
       FROM referrals ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params, _count, _offset
    );

    const resources = rows.map(toFhirServiceRequest);
    res.json(buildBundle('ServiceRequest', resources));
  })
);

export default router;
