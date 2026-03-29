// src/services/documents/ccdaGenerator.js
// Generates a Continuity of Care Document (CCD) in XML format following C-CDA R2.1 structure.

import crypto from 'crypto';
import db from '../../config/database.js';
import logger from '../../logging/logger.js';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Generate a complete CCD XML document for a patient.
 * @param {string} patientUid - Patient UID
 * @returns {string} C-CDA R2.1 XML string
 */
export async function generateCCD(patientUid) {
  logger.info(`Generating CCD for patient ${patientUid}`);

  const patient = await getPatientData(patientUid);
  const diagnoses = await getActiveDiagnoses(patientUid);
  const medications = await getActiveMedications(patientUid);
  const allergies = await getAllergies(patientUid);
  const vitals = await getRecentVitals(patientUid);
  const procedures = await getProcedures(patientUid);
  const investigations = await getInvestigations(patientUid);

  const xml = buildCCDXml(patient, { diagnoses, medications, allergies, vitals, procedures, investigations });

  logger.info(`CCD generated for patient ${patientUid} — ${xml.length} bytes`);
  return xml;
}

// =============================================================================
// XML BUILDER
// =============================================================================

function buildCCDXml(patient, data) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="IN"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.2"/>
  <id root="${generateUUID()}"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <title>Continuity of Care Document — ${escapeXml(patient.name || 'Patient')}</title>
  <effectiveTime value="${formatCDADate(new Date())}"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <recordTarget>
    <patientRole>
      <id root="${escapeXml(patient.uid)}"/>
      <addr>${escapeXml(patient.address || '')}</addr>
      <telecom value="tel:${escapeXml(patient.phone || '')}"/>
      <patient>
        <name><given>${escapeXml(patient.name || '')}</given></name>
        <administrativeGenderCode code="${mapCDAGender(patient.gender)}" codeSystem="2.16.840.1.113883.5.1"/>
        ${patient.birthday ? `<birthTime value="${formatCDADate(new Date(patient.birthday))}"/>` : ''}
      </patient>
    </patientRole>
  </recordTarget>
  <author>
    <time value="${formatCDADate(new Date())}"/>
    <assignedAuthor>
      <id root="2.16.840.1.113883.4.6"/>
      <assignedAuthoringDevice>
        <softwareName>VH Health EMR</softwareName>
      </assignedAuthoringDevice>
    </assignedAuthor>
  </author>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <name>Venkataeswara Hospitals</name>
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>
  <component>
    <structuredBody>
      ${buildProblemsSection(data.diagnoses)}
      ${buildMedicationsSection(data.medications)}
      ${buildAllergiesSection(data.allergies)}
      ${buildVitalsSection(data.vitals)}
      ${buildProceduresSection(data.procedures)}
      ${buildResultsSection(data.investigations)}
    </structuredBody>
  </component>
</ClinicalDocument>`;
}

// =============================================================================
// CDA SECTION BUILDERS
// =============================================================================

/**
 * Problems / Diagnoses section.
 * templateId 2.16.840.1.113883.10.20.22.2.5.1, LOINC 11450-4
 */
function buildProblemsSection(diagnoses) {
  const rows = (diagnoses || []).map(d =>
    `<tr><td>${escapeXml(d.icd10_code || 'N/A')}</td><td>${escapeXml(d.description || '')}</td><td>${escapeXml(d.status || 'active')}</td><td>${escapeXml(d.onset_date || '')}</td></tr>`
  ).join('\n              ');

  const entries = (diagnoses || []).map(d => `
          <entry typeCode="DRIV">
            <act classCode="ACT" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
              <id root="${generateUUID()}"/>
              <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
              <statusCode code="active"/>
              <entryRelationship typeCode="SUBJ">
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
                  <id root="${generateUUID()}"/>
                  <code code="55607006" codeSystem="2.16.840.1.113883.6.96" displayName="Problem"/>
                  <statusCode code="completed"/>
                  ${d.onset_date ? `<effectiveTime><low value="${formatCDADate(new Date(d.onset_date))}"/></effectiveTime>` : ''}
                  <value xsi:type="CD" ${d.icd10_code ? `code="${escapeXml(d.icd10_code)}" codeSystem="2.16.840.1.113883.6.90"` : ''} displayName="${escapeXml(d.description || '')}"/>
                </observation>
              </entryRelationship>
            </act>
          </entry>`
  ).join('');

  return `<component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
          <code code="11450-4" codeSystem="2.16.840.1.113883.6.1" displayName="Problem List"/>
          <title>Problems</title>
          <text>
            <table border="1">
              <thead><tr><th>ICD-10</th><th>Description</th><th>Status</th><th>Onset</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="4">No active problems</td></tr>'}</tbody>
            </table>
          </text>
          ${entries}
        </section>
      </component>`;
}

/**
 * Medications section.
 * templateId 2.16.840.1.113883.10.20.22.2.1.1, LOINC 10160-0
 */
function buildMedicationsSection(meds) {
  const rows = (meds || []).map(m =>
    `<tr><td>${escapeXml(m.medication_name || m.medication || '')}</td><td>${escapeXml(m.dose || '')}</td><td>${escapeXml(m.route || '')}</td><td>${escapeXml(m.status || '')}</td></tr>`
  ).join('\n              ');

  const entries = (meds || []).map(m => `
          <entry typeCode="DRIV">
            <substanceAdministration classCode="SBADM" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
              <id root="${generateUUID()}"/>
              <statusCode code="${m.status === 'COMPLETED' || m.status === 'DISPENSED' ? 'completed' : 'active'}"/>
              ${m.dose ? `<doseQuantity value="${escapeXml(m.dose)}"/>` : ''}
              ${m.route ? `<routeCode displayName="${escapeXml(m.route)}"/>` : ''}
              <consumable>
                <manufacturedProduct classCode="MANU">
                  <templateId root="2.16.840.1.113883.10.20.22.4.23"/>
                  <manufacturedMaterial>
                    <code>
                      <originalText>${escapeXml(m.medication_name || m.medication || '')}</originalText>
                    </code>
                  </manufacturedMaterial>
                </manufacturedProduct>
              </consumable>
            </substanceAdministration>
          </entry>`
  ).join('');

  return `<component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
          <code code="10160-0" codeSystem="2.16.840.1.113883.6.1" displayName="Medications"/>
          <title>Medications</title>
          <text>
            <table border="1">
              <thead><tr><th>Medication</th><th>Dose</th><th>Route</th><th>Status</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="4">No active medications</td></tr>'}</tbody>
            </table>
          </text>
          ${entries}
        </section>
      </component>`;
}

/**
 * Allergies section.
 * templateId 2.16.840.1.113883.10.20.22.2.6.1, LOINC 48765-2
 */
function buildAllergiesSection(allergies) {
  const rows = (allergies || []).map(a =>
    `<tr><td>${escapeXml(a.allergen || a.name || a.description || '')}</td><td>${escapeXml(a.severity || 'unknown')}</td><td>${escapeXml(a.reaction || '')}</td></tr>`
  ).join('\n              ');

  const entries = (allergies || []).map(a => `
          <entry typeCode="DRIV">
            <act classCode="ACT" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.30"/>
              <id root="${generateUUID()}"/>
              <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/>
              <statusCode code="active"/>
              <entryRelationship typeCode="SUBJ">
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.7"/>
                  <id root="${generateUUID()}"/>
                  <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/>
                  <statusCode code="completed"/>
                  <value xsi:type="CD" displayName="${escapeXml(a.allergen || a.name || a.description || '')}"/>
                </observation>
              </entryRelationship>
            </act>
          </entry>`
  ).join('');

  return `<component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
          <code code="48765-2" codeSystem="2.16.840.1.113883.6.1" displayName="Allergies"/>
          <title>Allergies and Adverse Reactions</title>
          <text>
            <table border="1">
              <thead><tr><th>Allergen</th><th>Severity</th><th>Reaction</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="3">No known allergies</td></tr>'}</tbody>
            </table>
          </text>
          ${entries}
        </section>
      </component>`;
}

/**
 * Vital Signs section.
 * templateId 2.16.840.1.113883.10.20.22.2.4.1, LOINC 8716-3
 */
function buildVitalsSection(vitals) {
  const rows = (vitals || []).map(v =>
    `<tr><td>${escapeXml(v.recorded_at || '')}</td><td>${v.heart_rate || '-'}</td><td>${v.systolic_bp || '-'}/${v.diastolic_bp || '-'}</td><td>${v.temperature || '-'}</td><td>${v.spo2 || '-'}</td><td>${v.respiratory_rate || '-'}</td></tr>`
  ).join('\n              ');

  const entries = (vitals || []).map(v => `
          <entry typeCode="DRIV">
            <organizer classCode="CLUSTER" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.26"/>
              <id root="${generateUUID()}"/>
              <code code="46680005" codeSystem="2.16.840.1.113883.6.96" displayName="Vital signs"/>
              <statusCode code="completed"/>
              ${v.recorded_at ? `<effectiveTime value="${formatCDADate(new Date(v.recorded_at))}"/>` : ''}
              ${v.heart_rate ? buildVitalComponent('8867-4', 'Heart rate', v.heart_rate, '/min') : ''}
              ${v.systolic_bp ? buildVitalComponent('8480-6', 'Systolic BP', v.systolic_bp, 'mm[Hg]') : ''}
              ${v.diastolic_bp ? buildVitalComponent('8462-4', 'Diastolic BP', v.diastolic_bp, 'mm[Hg]') : ''}
              ${v.temperature ? buildVitalComponent('8310-5', 'Body temperature', v.temperature, '[degF]') : ''}
              ${v.spo2 ? buildVitalComponent('2708-6', 'Oxygen saturation', v.spo2, '%') : ''}
              ${v.respiratory_rate ? buildVitalComponent('9279-1', 'Respiratory rate', v.respiratory_rate, '/min') : ''}
            </organizer>
          </entry>`
  ).join('');

  return `<component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
          <code code="8716-3" codeSystem="2.16.840.1.113883.6.1" displayName="Vital Signs"/>
          <title>Vital Signs</title>
          <text>
            <table border="1">
              <thead><tr><th>Date</th><th>HR</th><th>BP</th><th>Temp</th><th>SpO2</th><th>RR</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="6">No vital signs recorded</td></tr>'}</tbody>
            </table>
          </text>
          ${entries}
        </section>
      </component>`;
}

/**
 * Procedures section.
 * templateId 2.16.840.1.113883.10.20.22.2.7.1, LOINC 47519-4
 */
function buildProceduresSection(procs) {
  const rows = (procs || []).map(p =>
    `<tr><td>${escapeXml(p.procedure_name || p.title || '')}</td><td>${escapeXml(p.performed_at || p.created_at || '')}</td><td>${escapeXml(p.outcome || '')}</td></tr>`
  ).join('\n              ');

  const entries = (procs || []).map(p => `
          <entry typeCode="DRIV">
            <procedure classCode="PROC" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.14"/>
              <id root="${generateUUID()}"/>
              <code displayName="${escapeXml(p.procedure_name || p.title || '')}"/>
              <statusCode code="completed"/>
              ${(p.performed_at || p.created_at) ? `<effectiveTime value="${formatCDADate(new Date(p.performed_at || p.created_at))}"/>` : ''}
            </procedure>
          </entry>`
  ).join('');

  return `<component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.7.1"/>
          <code code="47519-4" codeSystem="2.16.840.1.113883.6.1" displayName="Procedures"/>
          <title>Procedures</title>
          <text>
            <table border="1">
              <thead><tr><th>Procedure</th><th>Date</th><th>Outcome</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="3">No procedures recorded</td></tr>'}</tbody>
            </table>
          </text>
          ${entries}
        </section>
      </component>`;
}

/**
 * Results / Investigations section.
 * templateId 2.16.840.1.113883.10.20.22.2.3.1, LOINC 30954-2
 */
function buildResultsSection(results) {
  const rows = (results || []).map(r =>
    `<tr><td>${escapeXml(r.test_name || r.investigation_type || '')}</td><td>${escapeXml(r.status || '')}</td><td>${escapeXml(r.result_summary || r.conclusion || '')}</td><td>${escapeXml(r.completed_at || r.created_at || '')}</td></tr>`
  ).join('\n              ');

  const entries = (results || []).map(r => `
          <entry typeCode="DRIV">
            <organizer classCode="BATTERY" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.1"/>
              <id root="${generateUUID()}"/>
              <code displayName="${escapeXml(r.test_name || r.investigation_type || '')}"/>
              <statusCode code="${r.status === 'COMPLETED' ? 'completed' : 'active'}"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
                  <id root="${generateUUID()}"/>
                  <code displayName="${escapeXml(r.test_name || r.investigation_type || '')}"/>
                  <statusCode code="completed"/>
                  ${r.result_summary ? `<value xsi:type="ST">${escapeXml(r.result_summary)}</value>` : ''}
                  ${r.completed_at ? `<effectiveTime value="${formatCDADate(new Date(r.completed_at))}"/>` : ''}
                </observation>
              </component>
            </organizer>
          </entry>`
  ).join('');

  return `<component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
          <code code="30954-2" codeSystem="2.16.840.1.113883.6.1" displayName="Results"/>
          <title>Results</title>
          <text>
            <table border="1">
              <thead><tr><th>Test</th><th>Status</th><th>Result</th><th>Date</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="4">No results available</td></tr>'}</tbody>
            </table>
          </text>
          ${entries}
        </section>
      </component>`;
}

// =============================================================================
// VITAL SIGN COMPONENT HELPER
// =============================================================================

function buildVitalComponent(loincCode, displayName, value, unit) {
  return `
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="${generateUUID()}"/>
                  <code code="${loincCode}" codeSystem="2.16.840.1.113883.6.1" displayName="${displayName}"/>
                  <statusCode code="completed"/>
                  <value xsi:type="PQ" value="${escapeXml(String(value))}" unit="${unit}"/>
                </observation>
              </component>`;
}

// =============================================================================
// DATA FETCHERS
// =============================================================================

async function getPatientData(uid) {
  const { rows } = await db.readQuery(
    `SELECT uid, phone, name, gender, email, birthday, address
     FROM users WHERE uid = $1 LIMIT 1`,
    [uid]
  );
  if (!rows.length) {
    throw new Error(`Patient not found: ${uid}`);
  }
  return rows[0];
}

async function getActiveDiagnoses(uid) {
  const { rows } = await db.readQuery(
    `SELECT icd10_code, description, status, severity, diagnosis_type, onset_date, resolved_date
     FROM diagnoses
     WHERE patient_uid = $1 AND status IN ('active', 'chronic', 'recurrent')
     ORDER BY created_at DESC`,
    [uid]
  );
  return rows;
}

async function getActiveMedications(uid) {
  const { rows } = await db.readQuery(
    `SELECT medication_name, dose, route, status, administered_at
     FROM medication_administrations
     WHERE patient_uid = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [uid]
  );
  return rows;
}

async function getAllergies(uid) {
  const { rows } = await db.readQuery(
    `SELECT id, allergen, description, name, severity, reaction, recorded_at
     FROM allergies
     WHERE patient_uid = $1
     ORDER BY recorded_at DESC`,
    [uid]
  );
  return rows;
}

async function getRecentVitals(uid) {
  const { rows } = await db.readQuery(
    `SELECT heart_rate, systolic_bp, diastolic_bp, temperature, spo2,
            respiratory_rate, blood_glucose, recorded_at
     FROM vitals_chart
     WHERE patient_uid = $1
     ORDER BY recorded_at DESC
     LIMIT 20`,
    [uid]
  );
  return rows;
}

async function getProcedures(uid) {
  const { rows } = await db.readQuery(
    `SELECT id, title, content, procedure_name, performed_at, outcome, complications, created_at
     FROM clinical_notes
     WHERE patient_uid = $1 AND note_type = 'procedure'
     ORDER BY created_at DESC`,
    [uid]
  );
  return rows;
}

async function getInvestigations(uid) {
  const { rows } = await db.readQuery(
    `SELECT id, test_name, investigation_type, status, result_summary, conclusion,
            ordered_at, completed_at, created_at
     FROM investigations
     WHERE patient_uid = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [uid]
  );
  return rows;
}

// =============================================================================
// HELPERS
// =============================================================================

function generateUUID() {
  return crypto.randomUUID();
}

function formatCDADate(date) {
  if (!date || isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function mapCDAGender(gender) {
  if (!gender) return 'UN';
  const g = gender.toLowerCase().trim();
  if (g === 'male' || g === 'm') return 'M';
  if (g === 'female' || g === 'f') return 'F';
  return 'UN';
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default { generateCCD };
