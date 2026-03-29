// src/routes/fhir/fhirRoutes.js
// HL7 FHIR R4 interoperability routes
// Exposes VH Health data as FHIR-compliant JSON resources

import express from 'express';
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  toFhirPatient,
  toFhirAppointment,
  toFhirObservation,
  toFhirMedicationRequest,
} from '../../services/fhir/fhirAdapter.js';

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

    const { rows } = await db.query(
      `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
       FROM users WHERE uid = $1 LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      throw AppError.notFound('Patient not found');
    }

    res.json(toFhirPatient(rows[0]));
  })
);

// ---------------------------------------------------------------------------
// GET /Patient — Search patients by name or phone
// ---------------------------------------------------------------------------
router.get(
  '/Patient',
  wrapAsync(async (req, res) => {
    const { name, phone } = req.query;
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

    const { rows } = await db.query(
      `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
       FROM users ${where} ORDER BY name LIMIT 100`,
      params
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

    const { rows } = await db.query(
      `SELECT a.id, a.uid, a.phone, a.patient_name, a.doctor_id, a.doctor_name,
              a.appointment_date, a.appointment_time, a.status, a.reason, a.notes, a.created_at
       FROM appointments a WHERE a.id = $1 LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      throw AppError.notFound('Appointment not found');
    }

    res.json(toFhirAppointment(rows[0]));
  })
);

// ---------------------------------------------------------------------------
// GET /Observation — Search observations (vital signs) by patient, type, date
// ---------------------------------------------------------------------------
router.get(
  '/Observation',
  wrapAsync(async (req, res) => {
    const { patient, code, date } = req.query;
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

    const { rows } = await db.query(
      `SELECT id, patient_uid, type, value, unit, recorded_date, recorded_by
       FROM vital_signs ${where} ORDER BY recorded_date DESC LIMIT 200`,
      params
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

    const { rows } = await db.query(
      `SELECT id, uid, phone, status, medication, order_note, prescribed_by,
              priority, urgent, ordered_at, created_at
       FROM pharmacy_orders ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    );

    const resources = rows.map(toFhirMedicationRequest);
    res.json(buildBundle('MedicationRequest', resources));
  })
);

export default router;
