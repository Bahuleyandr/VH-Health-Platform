// src/routes/fhir/fhirRoutes.js
// HL7 FHIR R4 interoperability routes
// Exposes VH Health data as FHIR-compliant JSON resources

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  toFhirPatient,
  toFhirAppointment,
  toFhirObservation,
  toFhirMedicationRequest,
  toFhirCondition,
  toFhirConditionFromProblem,
  toFhirProcedure,
  toFhirDiagnosticReport,
  toFhirAllergyIntolerance,
  toFhirEncounter,
  toFhirDocumentReference,
  toFhirServiceRequest,
} from '../../services/fhir/fhirAdapter.js';
import { validatedFhirJson, validateResource } from '../../services/fhir/fhirValidator.js';
import { fhirObservationToVitals } from '../../services/fhir/observationVitalsMapper.js';
import { recordVitals } from '../../services/emr/vitalsChartService.js';
import { createProblem } from '../../services/clinical/problemListService.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

// Roadmap C3 — write interactions are tighter than the read mount: doctors,
// admins and the integration service account may create resources.
function requireFhirWriteRole(req) {
  const role = req.user?.role;
  if (isDoctor(role) || isAdmin(role) || role === 'SUPER_ADMIN' || role === ROLES.INTEGRATION_ADMIN) {
    return;
  }
  throw AppError.forbidden('FHIR write interactions require a doctor, admin or integration role', 'FHIR_WRITE_FORBIDDEN');
}

function patientUidFromReference(reference) {
  const match = /^Patient\/([0-9a-f-]{36})$/i.exec(String(reference || '').trim());
  if (!match) {
    throw AppError.badRequest("subject.reference must be 'Patient/<uuid>'", 'FHIR_BAD_SUBJECT');
  }
  return match[1];
}

function assertValidInbound(resource, expectedType) {
  if (!resource || resource.resourceType !== expectedType) {
    throw AppError.badRequest(`Body must be a FHIR ${expectedType} resource`, 'FHIR_WRONG_RESOURCE_TYPE');
  }
  // Create payloads carry no id (the server assigns one); the validator's
  // required-field list was written for outbound resources, so validate a
  // copy with a placeholder id.
  const verdict = validateResource({ id: 'pending-create', ...resource }, { expectedType });
  if (verdict && verdict.valid === false) {
    throw AppError.badRequest(
      `${expectedType} failed validation: ${(verdict.issues || verdict.errors || []).map((i) => i.message || i).join('; ')}`,
      'FHIR_VALIDATION_FAILED',
    );
  }
}

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

function buildEverythingBundle(resources) {
  const entries = resources.filter(Boolean);
  return {
    resourceType: 'Bundle',
    type: 'collection',
    total: entries.length,
    entry: entries.map((resource) => ({
      fullUrl: `${resource.resourceType}/${resource.id}`,
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

function isMissingSchemaError(err) {
  const message = String(err?.message || '');
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(message);
}

async function optionalFhirQuery(sql, ...params) {
  try {
    return await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      logger.warn('Optional FHIR source skipped', { error: err.message });
      return [];
    }
    throw err;
  }
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
                { code: 'create' },
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
                { code: 'create' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: 'category', type: 'token' },
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
                { code: 'create' },
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
  '/Patient/:id/$everything',
  wrapAsync(async (req, res) => {
    const { id } = req.params;
    const { _count } = parsePagination(req.query);

    const [
      patientRows,
      observations,
      meds,
      conditions,
      procedures,
      reports,
      allergies,
      encounters,
      documents,
      serviceRequests,
    ] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
         FROM users WHERE uid = $1::uuid LIMIT 1`,
        id
      ),
      optionalFhirQuery(
        `SELECT CONCAT(v.id, '-', obs.type) AS id, v.patient_uid, obs.type,
                obs.value, obs.unit, v.recorded_at AS recorded_date, v.recorded_by
         FROM vitals_chart v
         CROSS JOIN LATERAL (VALUES
           ('heart_rate', v.heart_rate::text, 'beats/min'),
           ('systolic', v.systolic_bp::text, 'mmHg'),
           ('diastolic', v.diastolic_bp::text, 'mmHg'),
           ('temperature', v.temperature::text, 'Cel'),
           ('spo2', v.spo2::text, '%'),
           ('respiratory_rate', v.respiratory_rate::text, 'breaths/min'),
           ('blood_glucose', v.blood_glucose::text, 'mg/dL')
        ) AS obs(type, value, unit)
         WHERE v.patient_uid = $1::uuid AND obs.value IS NOT NULL
         ORDER BY v.recorded_at DESC LIMIT $2`,
        id, _count
      ),
      optionalFhirQuery(
        `SELECT id, uid, phone, status, medication, order_note, prescribed_by,
                priority, urgent, ordered_at, created_at
         FROM pharmacy_orders WHERE uid = $1::uuid
         ORDER BY created_at DESC LIMIT $2`,
        id, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, status, icd10_code, icd10_description, description,
                onset_date, resolved_date, diagnosed_by, notes, created_at
         FROM diagnoses WHERE patient_uid = $1::uuid
         ORDER BY created_at DESC LIMIT $2`,
        id, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, note_type, title, content, status, procedure_name,
                performed_at, performed_by, author_id, outcome, complications, notes, created_at
         FROM clinical_notes
         WHERE patient_uid = $1::uuid AND LOWER(note_type) = 'procedure'
         ORDER BY created_at DESC LIMIT $2`,
        id, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, uid, status, test_name, investigation_type, results,
                conclusion, interpretation, ordered_at, completed_at, created_at
         FROM investigations WHERE patient_uid = $1::uuid OR uid = $1::uuid
         ORDER BY created_at DESC LIMIT $2`,
        id, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, allergen, description, name, severity, reaction, recorded_at
         FROM allergies WHERE patient_uid = $1::uuid
         ORDER BY recorded_at DESC LIMIT $2`,
        id, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, status, priority, admission_type, reason, reason_for_admission,
                admitting_doctor, attending_doctor, admitted_at, discharged_at,
                discharge_disposition, discharge_type, ward, bed_number
         FROM admissions WHERE patient_uid = $1::uuid
         ORDER BY admitted_at DESC LIMIT $2`,
        id, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, note_type, type, title, content, author_id, created_by, created_at
         FROM clinical_notes WHERE patient_uid = $1::uuid
         ORDER BY created_at DESC LIMIT $2`,
        id, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, status, priority, referring_doctor, requester_id,
                referred_to_doctor, performer_id, referred_to_department,
                reason, clinical_notes, notes, created_at
         FROM referrals WHERE patient_uid = $1::uuid
         ORDER BY created_at DESC LIMIT $2`,
        id, _count
      ),
    ]);

    if (!patientRows.length) throw AppError.notFound('Patient not found');

    // Longitudinal problem list (roadmap B7) rides along as
    // problem-list-item Conditions.
    const problems = await optionalFhirQuery(
      `SELECT id, patient_uid, title, icd10_code, snomed_code, status, onset_date,
              resolved_date, notes, created_at
       FROM patient_problems WHERE patient_uid = $1::uuid
       ORDER BY created_at DESC LIMIT $2`,
      id, _count
    );

    const resources = [
      toFhirPatient(patientRows[0]),
      ...observations.map(toFhirObservation),
      ...meds.map(toFhirMedicationRequest),
      ...conditions.map(toFhirCondition),
      ...problems.map(toFhirConditionFromProblem),
      ...procedures.map(toFhirProcedure),
      ...reports.map(toFhirDiagnosticReport),
      ...allergies.map(toFhirAllergyIntolerance),
      ...encounters.map(toFhirEncounter),
      ...documents.map(toFhirDocumentReference),
      ...serviceRequests.map(toFhirServiceRequest),
    ];

    return res.json(buildEverythingBundle(resources));
  })
);

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
      conditions.push(`v.patient_uid = $${idx}::uuid`);
      params.push(patient);
      idx++;
    }

    if (code) {
      conditions.push(`obs.type ILIKE $${idx}`);
      params.push(`%${code}%`);
      idx++;
    }

    if (date) {
      conditions.push(`v.recorded_at::date = $${idx}::date`);
      params.push(date);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT CONCAT(v.id, '-', obs.type) AS id, v.patient_uid, obs.type,
              obs.value, obs.unit, v.recorded_at AS recorded_date, v.recorded_by
       FROM vitals_chart v
       CROSS JOIN LATERAL (VALUES
         ('heart_rate', v.heart_rate::text, 'beats/min'),
         ('systolic', v.systolic_bp::text, 'mmHg'),
         ('diastolic', v.diastolic_bp::text, 'mmHg'),
         ('temperature', v.temperature::text, 'Cel'),
         ('spo2', v.spo2::text, '%'),
         ('respiratory_rate', v.respiratory_rate::text, 'breaths/min'),
         ('blood_glucose', v.blood_glucose::text, 'mg/dL')
       ) AS obs(type, value, unit)
       ${where ? `${where} AND obs.value IS NOT NULL` : 'WHERE obs.value IS NOT NULL'}
       ORDER BY v.recorded_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
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
// GET /Condition — Search conditions by patient. Returns BOTH per-encounter
// diagnoses (category encounter-diagnosis) and the longitudinal problem
// list (roadmap B7, category problem-list-item); filter with ?category=.
// ---------------------------------------------------------------------------
router.get(
  '/Condition',
  wrapAsync(async (req, res) => {
    const { patient, category } = req.query;
    const { _count, _offset } = parsePagination(req.query);
    const wantDiagnoses = !category || category === 'encounter-diagnosis';
    const wantProblems = !category || category === 'problem-list-item';

    const resources = [];
    if (wantDiagnoses) {
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
      resources.push(...rows.map(toFhirCondition));
    }
    if (wantProblems) {
      const rows = await optionalFhirQuery(
        `SELECT id, patient_uid, title, icd10_code, snomed_code, status, onset_date,
                resolved_date, notes, created_at
         FROM patient_problems
         ${patient ? 'WHERE patient_uid = $1::uuid' : ''}
         ORDER BY created_at DESC LIMIT $${patient ? 2 : 1} OFFSET $${patient ? 3 : 2}`,
        ...(patient ? [patient] : []), _count, _offset
      );
      resources.push(...rows.map(toFhirConditionFromProblem));
    }
    res.json(buildBundle('Condition', resources));
  })
);

// ---------------------------------------------------------------------------
// POST /Condition — create a longitudinal problem-list entry (roadmap C3).
// Routes through the B7 problem-list service so dedupe, terminology
// verdicts and canonical timeline/audit events all apply.
// ---------------------------------------------------------------------------
router.post(
  '/Condition',
  wrapAsync(async (req, res) => {
    requireFhirWriteRole(req);
    const resource = req.body;
    assertValidInbound(resource, 'Condition');
    const patientUid = patientUidFromReference(resource.subject?.reference);

    const codings = Array.isArray(resource.code?.coding) ? resource.code.coding : [];
    const icd10 = codings.find((c) => String(c.system || '').includes('icd-10'))?.code || null;
    const snomed = codings.find((c) => String(c.system || '').includes('snomed'))?.code || null;
    const title = resource.code?.text
      || codings.find((c) => c.display)?.display
      || icd10 || snomed;
    if (!title) {
      throw AppError.badRequest('Condition.code needs text or a coded display', 'FHIR_CONDITION_NO_CODE');
    }
    const clinical = resource.clinicalStatus?.coding?.[0]?.code || 'active';
    if (!['active', 'recurrence', 'relapse'].includes(clinical)) {
      throw AppError.badRequest(
        'Only active conditions can be created via FHIR; resolve/inactivate through the problem-list API',
        'FHIR_CONDITION_NOT_ACTIVE',
      );
    }

    const result = await createProblem({
      patientUid,
      title,
      icd10Code: icd10,
      snomedCode: snomed,
      onsetDate: resource.onsetDateTime ? String(resource.onsetDateTime).slice(0, 10) : null,
      notes: resource.note?.[0]?.text || null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });

    res.status(201);
    res.setHeader('Location', `Condition/p-${result.problem.id}`);
    return res.json(toFhirConditionFromProblem(result.problem));
  })
);

// ---------------------------------------------------------------------------
// POST /Observation — create vital-sign observations (roadmap C3). LOINC
// codes map onto one vitals_chart row; NEWS2 + anomaly checks + canonical
// timeline events fire through the standard vitals write path.
// ---------------------------------------------------------------------------
router.post(
  '/Observation',
  wrapAsync(async (req, res) => {
    requireFhirWriteRole(req);
    const resource = req.body;
    assertValidInbound(resource, 'Observation');
    const patientUid = patientUidFromReference(resource.subject?.reference);

    const mappedResult = fhirObservationToVitals(resource);
    if (mappedResult.mapped.length === 0) {
      throw AppError.badRequest(
        `No supported vital-sign LOINC codes found (unsupported: ${mappedResult.unmapped.join(', ') || 'none'})`,
        'FHIR_OBSERVATION_UNSUPPORTED_CODES',
      );
    }

    const result = await recordVitals({
      patient_uid: patientUid,
      ...mappedResult.vitals,
      temperature_unit: mappedResult.temperatureUnit || undefined,
      recorded_at: mappedResult.effective || undefined,
      notes: `FHIR Observation create (${mappedResult.mapped.join(', ')})`,
      recorded_by: req.user?.uid,
    });
    const row = result?.vitals || result;

    res.status(201);
    res.setHeader('Location', `Observation/vitals-${row.id}`);
    return res.json({
      resourceType: 'Observation',
      id: `vitals-${row.id}`,
      status: 'final',
      category: [{
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          code: 'vital-signs',
        }],
      }],
      code: resource.code,
      subject: { reference: `Patient/${patientUid}` },
      effectiveDateTime: row.recorded_at,
      component: mappedResult.mapped.map((loinc) => ({
        code: { coding: [{ system: 'http://loinc.org', code: loinc }] },
      })),
    });
  })
);

// ---------------------------------------------------------------------------
// POST /AllergyIntolerance — create a structured allergy (roadmap C3).
// Lands in patient_allergies, the store every CDS consumer reads (A10).
// ---------------------------------------------------------------------------
router.post(
  '/AllergyIntolerance',
  wrapAsync(async (req, res) => {
    requireFhirWriteRole(req);
    const resource = req.body;
    assertValidInbound(resource, 'AllergyIntolerance');
    const patientUid = patientUidFromReference(resource.patient?.reference || resource.subject?.reference);

    const allergen = resource.code?.text
      || resource.code?.coding?.find((c) => c.display)?.display
      || resource.code?.coding?.[0]?.code;
    if (!allergen) {
      throw AppError.badRequest('AllergyIntolerance.code needs text or a coded display', 'FHIR_ALLERGY_NO_CODE');
    }
    const criticality = String(resource.criticality || '').toLowerCase();
    const reactionSeverity = String(resource.reaction?.[0]?.severity || '').toLowerCase();
    const severity = criticality === 'high' || reactionSeverity === 'severe' ? 'SEVERE'
      : reactionSeverity === 'moderate' ? 'MODERATE'
        : 'MILD';
    const reactionText = resource.reaction?.[0]?.manifestation?.[0]?.text
      || resource.reaction?.[0]?.description || null;

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_allergies (patient_uid, allergy_name, severity, reaction, is_active, created_at)
       SELECT u.uid, $2, $3, $4, true, NOW()
         FROM users u WHERE u.uid = $1::uuid
       RETURNING id, patient_uid, allergy_name, severity, reaction, created_at`,
      patientUid, String(allergen).trim(), severity, reactionText,
    );
    if (!rows.length) throw AppError.notFound('Patient not found');
    const created = rows[0];

    res.status(201);
    res.setHeader('Location', `AllergyIntolerance/pa-${created.id}`);
    return res.json({
      resourceType: 'AllergyIntolerance',
      id: `pa-${created.id}`,
      clinicalStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }],
      },
      code: { text: created.allergy_name },
      patient: { reference: `Patient/${created.patient_uid}` },
      criticality: severity === 'SEVERE' ? 'high' : 'low',
      reaction: created.reaction ? [{ manifestation: [{ text: created.reaction }] }] : [],
      recordedDate: created.created_at,
    });
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

    conditions.push(`LOWER(note_type) = 'procedure'`);
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, note_type, title, content, status, procedure_name,
              performed_at, performed_by, author_id, outcome, complications, notes, created_at
       FROM clinical_notes ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
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

    const rows = await optionalFhirQuery(
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

// ---------------------------------------------------------------------------
// FHIR error contract (roadmap C3): failures leave this router as
// OperationOutcome, not the platform envelope.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 500) logger.error('FHIR endpoint error:', err);
  res.status(status).json({
    resourceType: 'OperationOutcome',
    issue: [{
      severity: 'error',
      code: status === 404 ? 'not-found'
        : status === 403 ? 'forbidden'
          : status === 409 ? 'conflict'
            : status === 400 ? 'invalid'
              : 'exception',
      diagnostics: status >= 500 ? 'Internal server error' : String(err?.message || 'Request failed'),
      details: err?.code ? { text: err.code } : undefined,
    }],
  });
});

export default router;
