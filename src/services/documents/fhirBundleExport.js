// src/services/documents/fhirBundleExport.js
// Generates a complete FHIR R4 Bundle (type: document) for a patient,
// aggregating all clinical data into interoperable FHIR resources.

import * as fhirAdapter from '../fhir/fhirAdapter.js';
import db from '../../config/database.js';
import logger from '../../logging/logger.js';

/**
 * Generate a complete FHIR Bundle containing all patient data.
 * @param {string} patientUid - Patient UID
 * @returns {Object} FHIR Bundle resource
 */
export async function generatePatientBundle(patientUid) {
  logger.info(`Generating FHIR Bundle for patient ${patientUid}`);

  // Collect all patient data in parallel
  const [
    patientResult,
    appointmentResult,
    conditionResult,
    observationResult,
    medicationResult,
    investigationResult,
    admissionResult,
    allergyResult,
    procedureResult,
  ] = await Promise.all([
    db.readQuery(
      `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
       FROM users WHERE uid = $1 LIMIT 1`,
      [patientUid]
    ),
    db.readQuery(
      `SELECT id, uid, phone, patient_name, doctor_id, doctor_name,
              appointment_date, appointment_time, status, reason, notes, created_at
       FROM appointments WHERE uid = $1
       ORDER BY appointment_date DESC LIMIT 200`,
      [patientUid]
    ),
    db.readQuery(
      `SELECT id, patient_uid, status, icd10_code, icd10_description, description,
              onset_date, resolved_date, diagnosed_by, notes, created_at
       FROM diagnoses WHERE patient_uid = $1
       ORDER BY created_at DESC`,
      [patientUid]
    ),
    db.readQuery(
      `SELECT id, patient_uid, encounter_id, heart_rate, systolic_bp, diastolic_bp,
              temperature, spo2, respiratory_rate, blood_glucose, recorded_at
       FROM vitals_chart WHERE patient_uid = $1
       ORDER BY recorded_at DESC LIMIT 200`,
      [patientUid]
    ),
    db.readQuery(
      `SELECT id, uid, phone, status, medication, order_note, prescribed_by,
              priority, urgent, ordered_at, created_at
       FROM pharmacy_orders WHERE uid = $1
       ORDER BY created_at DESC LIMIT 200`,
      [patientUid]
    ),
    db.readQuery(
      `SELECT id, patient_uid, uid, status, test_name, investigation_type, results,
              conclusion, interpretation, ordered_at, completed_at, created_at
       FROM investigations WHERE patient_uid = $1
       ORDER BY created_at DESC LIMIT 200`,
      [patientUid]
    ),
    db.readQuery(
      `SELECT id, patient_uid, status, priority, admission_type, reason, reason_for_admission,
              admitting_doctor, attending_doctor, admitted_at, discharged_at,
              discharge_disposition, discharge_type, ward, bed_number
       FROM admissions WHERE patient_uid = $1
       ORDER BY admitted_at DESC LIMIT 100`,
      [patientUid]
    ),
    db.readQuery(
      `SELECT id, patient_uid, allergen, description, name, severity, reaction, recorded_at
       FROM allergies WHERE patient_uid = $1
       ORDER BY recorded_at DESC`,
      [patientUid]
    ),
    db.readQuery(
      `SELECT id, patient_uid, note_type, title, content, status, procedure_name,
              performed_at, performed_by, author_id, outcome, complications, notes, created_at
       FROM clinical_notes WHERE patient_uid = $1 AND note_type = 'procedure'
       ORDER BY created_at DESC LIMIT 100`,
      [patientUid]
    ),
  ]);

  const patient = patientResult.rows[0];
  if (!patient) {
    throw new Error(`Patient not found: ${patientUid}`);
  }

  // Build bundle entries
  const entries = [];

  // Patient resource
  const patientResource = fhirAdapter.toFhirPatient(patient);
  entries.push({
    fullUrl: `Patient/${patient.uid}`,
    resource: patientResource,
    request: { method: 'PUT', url: `Patient/${patient.uid}` },
  });

  // Appointments
  for (const apt of appointmentResult.rows) {
    const resource = fhirAdapter.toFhirAppointment(apt);
    if (resource) {
      entries.push({
        fullUrl: `Appointment/${apt.id}`,
        resource,
        request: { method: 'PUT', url: `Appointment/${apt.id}` },
      });
    }
  }

  // Conditions (diagnoses)
  for (const dx of conditionResult.rows) {
    const resource = fhirAdapter.toFhirCondition(dx);
    if (resource) {
      entries.push({
        fullUrl: `Condition/${dx.id}`,
        resource,
        request: { method: 'PUT', url: `Condition/${dx.id}` },
      });
    }
  }

  // Observations (vitals) — map each vital reading to individual observations
  for (const v of observationResult.rows) {
    const vitalTypes = [
      { type: 'heart_rate', value: v.heart_rate, unit: '/min' },
      { type: 'systolic', value: v.systolic_bp, unit: 'mmHg' },
      { type: 'diastolic', value: v.diastolic_bp, unit: 'mmHg' },
      { type: 'temperature', value: v.temperature, unit: 'degF' },
      { type: 'spo2', value: v.spo2, unit: '%' },
      { type: 'respiratory_rate', value: v.respiratory_rate, unit: '/min' },
      { type: 'blood_glucose', value: v.blood_glucose, unit: 'mg/dL' },
    ];

    for (const vt of vitalTypes) {
      if (vt.value != null) {
        const obs = fhirAdapter.toFhirObservation({
          id: `${v.id}-${vt.type}`,
          patient_uid: patientUid,
          type: vt.type,
          value: vt.value,
          unit: vt.unit,
          recorded_date: v.recorded_at,
        });
        if (obs) {
          entries.push({
            fullUrl: `Observation/${v.id}-${vt.type}`,
            resource: obs,
            request: { method: 'PUT', url: `Observation/${v.id}-${vt.type}` },
          });
        }
      }
    }
  }

  // MedicationRequests
  for (const med of medicationResult.rows) {
    const resource = fhirAdapter.toFhirMedicationRequest(med);
    if (resource) {
      entries.push({
        fullUrl: `MedicationRequest/${med.id}`,
        resource,
        request: { method: 'PUT', url: `MedicationRequest/${med.id}` },
      });
    }
  }

  // DiagnosticReports (investigations)
  for (const inv of investigationResult.rows) {
    const resource = fhirAdapter.toFhirDiagnosticReport(inv);
    if (resource) {
      entries.push({
        fullUrl: `DiagnosticReport/${inv.id}`,
        resource,
        request: { method: 'PUT', url: `DiagnosticReport/${inv.id}` },
      });
    }
  }

  // Encounters (admissions)
  for (const adm of admissionResult.rows) {
    const resource = fhirAdapter.toFhirEncounter(adm);
    if (resource) {
      entries.push({
        fullUrl: `Encounter/${adm.id}`,
        resource,
        request: { method: 'PUT', url: `Encounter/${adm.id}` },
      });
    }
  }

  // AllergyIntolerances
  for (const allergy of allergyResult.rows) {
    const resource = fhirAdapter.toFhirAllergyIntolerance(allergy);
    if (resource) {
      entries.push({
        fullUrl: `AllergyIntolerance/${allergy.id}`,
        resource,
        request: { method: 'PUT', url: `AllergyIntolerance/${allergy.id}` },
      });
    }
  }

  // Procedures
  for (const proc of procedureResult.rows) {
    const resource = fhirAdapter.toFhirProcedure(proc);
    if (resource) {
      entries.push({
        fullUrl: `Procedure/${proc.id}`,
        resource,
        request: { method: 'PUT', url: `Procedure/${proc.id}` },
      });
    }
  }

  const bundle = {
    resourceType: 'Bundle',
    type: 'document',
    timestamp: new Date().toISOString(),
    total: entries.length,
    entry: entries,
  };

  logger.info(`FHIR Bundle generated for patient ${patientUid} — ${entries.length} entries`);
  return bundle;
}

export default { generatePatientBundle };
