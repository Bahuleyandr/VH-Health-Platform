import crypto from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { generateClinicalText, getClinicalAiConfig } from '../ai/localLlmClient.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { collectAdmissionClinicalContext } from './clinicalTimelineService.js';

const PROMPT_VERSION = 'clinical-discharge-v1';

// Fallback tenant when the request doesn't carry one. clinical_ai_generations.tenant_id
// is NOT NULL in the schema, so we always need a value. Matches the historical
// raw-SQL fallback ('00000000-0000-4000-8000-000000000001').
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

// Common Prisma `select` shapes — keep these in one place so every read returns
// the same projection the pre-ORM raw SQL did.
const ADMISSION_LOOKUP_SELECT = {
  encounter_id: true,
  patient_uid: true,
  status: true,
  discharge_summary: true,
};

const ADMISSION_FOR_SIGN_SELECT = {
  encounter_id: true,
  patient_uid: true,
};

const DISCHARGE_NOTE_SELECT = {
  id: true,
  is_signed: true,
};

const DISCHARGE_NOTE_FOR_SIGN_SELECT = {
  id: true,
  is_signed: true,
  ai_generation_id: true,
  content: true,
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function valueWithUnit(value, unit) {
  const valueText = text(value);
  if (!valueText) return '';
  if (valueText === '-') return valueText;
  const suffixPattern = {
    '/min': /\/\s*min$/i,
    'mm Hg': /mm\s*hg$/i,
    '%': /%$/i,
    'mg/dl': /mg\s*\/\s*dl$/i,
    Kg: /kg$/i,
    'deg F': /(?:deg\s*f|°\s*f)$/i,
  }[unit];
  if (suffixPattern?.test(valueText)) return valueText;
  return `${valueText} ${unit}`;
}

function formatDate(value) {
  if (!value) return 'not documented';
  return new Date(value).toISOString().slice(0, 10);
}

function formatDmy(value, { includeTime = false } = {}) {
  if (!value) return 'not documented';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'not documented';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  if (!includeTime) return `${dd}.${mm}.${yyyy}`;
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} at ${hh}:${min}`;
}

function ageYears(birthday) {
  if (!birthday) return null;
  const born = new Date(birthday);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - born.getFullYear();
  const monthDelta = now.getMonth() - born.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < born.getDate())) years -= 1;
  return years >= 0 ? years : null;
}

function shortGender(gender) {
  const normalized = text(gender).toLowerCase();
  if (normalized.startsWith('m')) return 'M';
  if (normalized.startsWith('f')) return 'F';
  return text(gender) || 'not documented';
}

function line(label, value) {
  return `${label.padEnd(27, ' ')} ${text(value) || 'not documented'}`;
}

function listLines(values, fallback = 'not documented') {
  const items = asArray(values).map((value) => text(value)).filter(Boolean);
  return items.length ? items.join('\n') : fallback;
}

function makeSourceHash(context) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      patient: context.patient?.uid,
      admission: context.admission?.id,
      timeline: context.timeline.map((event) => ({
        type: event.event_type,
        id: event.id,
        timestamp: event.timestamp,
        summary: event.summary,
      })),
    }))
    .digest('hex');
}

function diagnosisText(event) {
  const payload = event.payload || {};
  return text(`${payload.icd10_code || ''} ${payload.description || payload.icd10_description || event.summary}`.trim());
}

function latestByType(events, predicate = () => true) {
  return [...events]
    .filter(predicate)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0] || null;
}

function buildCitations(context, limit = 80) {
  return context.citations.slice(0, limit);
}

function buildSafetyFlags(context, summary = {}) {
  const flags = [];
  const diagnoses = asArray(context.diagnoses);
  const meds = asArray(summary.medications_on_discharge);
  const investigations = asArray(context.investigations);
  const orders = asArray(context.orders);
  const allergies = asArray(context.allergies);
  const radiologyOrders = asArray(context.radiology_orders);
  const chronicMeds = asArray(context.chronic_medications);

  if (!diagnoses.some((event) => /primary/i.test(text(event.payload?.diagnosis_type)))) {
    flags.push({
      severity: 'medium',
      code: 'NO_PRIMARY_DIAGNOSIS',
      message: 'No primary diagnosis is clearly documented.',
    });
  }

  const activeOrders = orders.filter((event) => !/completed|cancelled|discontinued/i.test(text(event.payload?.status)));
  if (activeOrders.length > 0) {
    flags.push({
      severity: 'medium',
      code: 'ACTIVE_ORDERS_AT_DISCHARGE',
      message: `${activeOrders.length} active order(s) still need review before discharge.`,
    });
  }

  const pendingInvestigations = investigations.filter((event) => /pending|requested|ordered/i.test(text(event.payload?.status)));
  if (pendingInvestigations.length > 0) {
    flags.push({
      severity: 'high',
      code: 'PENDING_INVESTIGATIONS',
      message: `${pendingInvestigations.length} investigation(s) appear pending.`,
    });
  }

  // Wave-4B-1 — pending radiology orders are a discharge-readiness blocker
  // (the prior gate only looked at `investigations`, missing ultrasound /
  // CT / MRI / X-ray orders). Finding:
  //   2026-05-10-inpatient-admission-discharge-pending-radiology-not-in-readiness
  const pendingRadiology = radiologyOrders.filter((row) => {
    const status = String(row.status || '').toLowerCase();
    return status && !['completed', 'cancelled', 'reported', 'signed_off'].includes(status);
  });
  if (pendingRadiology.length > 0) {
    flags.push({
      severity: 'high',
      code: 'PENDING_RADIOLOGY',
      message: `${pendingRadiology.length} pending radiology order(s): ${pendingRadiology
        .map((r) => `${r.modality || 'radiology'} ${r.body_part || ''} [${r.status}]`.trim())
        .slice(0, 3)
        .join('; ')}${pendingRadiology.length > 3 ? '; …' : ''}.`,
    });
  }

  // Wave-4B-1 — chronic medication reconciliation. Any chronic med the
  // patient was on pre-admission that isn't present in the discharge med
  // list AND isn't explicitly reconciled (continue / stop / hold / restart)
  // is a polypharmacy safety risk. Finding:
  //   2026-05-10-inpatient-admission-discharge-drug-reconciliation-drops-chronic-meds
  if (chronicMeds.length > 0) {
    const dischargeMedNames = new Set(
      meds.map((m) => text(m.name || m.medication_name).toLowerCase()).filter(Boolean),
    );
    const unreconciled = chronicMeds.filter((cm) => {
      const cmName = text(cm.name || cm.medication_name).toLowerCase();
      if (!cmName) return false;
      // Explicit reconciliation marker (set when the doctor reviewed it).
      if (cm.reconciled_at_discharge || cm.reconciliation_status) return false;
      // Fuzzy match against discharge meds — chronic Atorvastatin is OK
      // if discharge meds include "Atorvastatin 10mg".
      return !Array.from(dischargeMedNames).some((dn) => dn.includes(cmName) || cmName.includes(dn));
    });
    if (unreconciled.length > 0) {
      flags.push({
        severity: 'high',
        code: 'CHRONIC_MED_NOT_RECONCILED',
        message: `${unreconciled.length} chronic medication(s) not reconciled: ${unreconciled
          .map((m) => m.name || m.medication_name)
          .slice(0, 5)
          .join(', ')}${unreconciled.length > 5 ? ', …' : ''}. Mark continue / stop / hold / restart before discharge.`,
        chronic_unreconciled: unreconciled,
      });
    }
  }

  const latestVitals = latestByType(context.vitals);
  const vitalsPayload = latestVitals?.payload || {};
  if (Number(vitalsPayload.spo2) > 0 && Number(vitalsPayload.spo2) < 92) {
    flags.push({
      severity: 'high',
      code: 'LOW_SPO2',
      message: `Latest SpO2 is ${vitalsPayload.spo2}%. Confirm discharge safety.`,
    });
  }
  if (/high|medium/i.test(text(vitalsPayload.clinical_risk))) {
    flags.push({
      severity: /high/i.test(text(vitalsPayload.clinical_risk)) ? 'high' : 'medium',
      code: 'RECENT_NEWS2_RISK',
      message: `Recent NEWS2 risk is ${vitalsPayload.clinical_risk}.`,
    });
  }

  const allergyTerms = allergies
    .flatMap((row) => [row.allergen, row.name, row.allergy_name])
    .map((term) => text(term).toLowerCase())
    .filter(Boolean);
  const allergyHits = meds.filter((med) => {
    const name = text(med.name || med.medication_name).toLowerCase();
    return allergyTerms.some((term) => term.length >= 3 && name.includes(term));
  });
  if (allergyHits.length > 0) {
    flags.push({
      severity: 'critical',
      code: 'DISCHARGE_MED_ALLERGY_MATCH',
      message: `Possible allergy conflict in discharge medications: ${allergyHits.map((m) => m.name || m.medication_name).join(', ')}.`,
    });
  }

  if (!text(summary.follow_up_instructions)) {
    flags.push({
      severity: 'medium',
      code: 'MISSING_FOLLOW_UP',
      message: 'Follow-up instructions are empty.',
    });
  }

  return flags;
}

function buildTemplateHospitalCourse(context) {
  const admission = context.admission || {};
  const patient = context.patient || {};
  const diagnoses = context.diagnoses.map(diagnosisText).filter(Boolean);
  const noteHighlights = context.notes
    .filter((event) => text(event.sub_type).toLowerCase() !== 'case_sheet')
    .slice(-5)
    .map((event) => event.summary)
    .filter(Boolean);
  const procedureNames = context.notes
    .filter((event) => /procedure/i.test(text(event.sub_type)))
    .map((event) => event.payload?.content?.procedure_name || event.summary)
    .filter(Boolean);
  const investigationHighlights = context.investigations
    .slice(-8)
    .map((event) => event.summary)
    .filter(Boolean);

  const sections = [
    `${patient.name || 'The patient'} was admitted on ${formatDate(admission.admitted_at)} with ${admission.chief_complaint || admission.admitting_diagnosis || 'the documented presenting complaint not specified'}.`,
  ];

  if (diagnoses.length > 0) {
    sections.push(`Documented diagnoses include: ${diagnoses.join('; ')}.`);
  } else if (admission.admitting_diagnosis) {
    sections.push(`Admitting diagnosis: ${admission.admitting_diagnosis}.`);
  }

  if (noteHighlights.length > 0) {
    sections.push(`Clinical course highlights: ${noteHighlights.join(' ')}`);
  }

  if (procedureNames.length > 0) {
    sections.push(`Procedures performed: ${procedureNames.join('; ')}.`);
  }

  if (investigationHighlights.length > 0) {
    sections.push(`Investigations: ${investigationHighlights.join('; ')}.`);
  }

  return sections.join('\n\n');
}

function noteContent(event) {
  const content = event?.payload?.content;
  return content && typeof content === 'object' && !Array.isArray(content) ? content : {};
}

function getCaseSheetContent(context) {
  const event = [...asArray(context.notes)]
    .reverse()
    .find((note) => text(note.sub_type).toLowerCase() === 'case_sheet');
  return noteContent(event);
}

function firstNoteField(notes, fields) {
  for (const event of [...notes].reverse()) {
    const content = noteContent(event);
    for (const field of fields) {
      const value = text(content[field]);
      if (value) return value;
    }
  }
  return '';
}

function diagnosisLines(context) {
  const diagnoses = context.diagnoses.map(diagnosisText).filter(Boolean);
  if (diagnoses.length) return diagnoses;
  const admitting = text(context.admission?.admitting_diagnosis);
  return admitting ? [admitting] : ['Not documented'];
}

function buildPatientHeader(context) {
  const patient = context.patient || {};
  const admission = context.admission || {};
  const age = ageYears(patient.birthday);
  const primaryDoctor = asArray(context.attending_doctors)
    .find((doctor) => doctor.role === 'primary_consultant')
    || asArray(context.attending_doctors)[0];

  return {
    patient_name: patient.name || 'not documented',
    age_sex: `${age != null ? `${age}yrs` : 'age not documented'} / ${shortGender(patient.gender)}`,
    mrn: patient.hospital_number || patient.mrn || patient.mri_no || 'not documented',
    ip_no: admission.encounter_id || admission.id || 'not documented',
    ward_no: admission.ward || admission.bed_number || 'not documented',
    address: patient.address || 'not documented',
    mobile: patient.phone || 'not documented',
    primary_consultant: primaryDoctor?.name || admission.admitting_doctor || 'not documented',
    date_of_admission: formatDmy(admission.admitted_at, { includeTime: true }),
    date_of_discharge: formatDmy(admission.discharged_at || new Date()),
  };
}

function buildAttendingDoctors(context) {
  const doctors = asArray(context.attending_doctors);
  if (!doctors.length) {
    return [{
      name: 'Not documented',
      designation: 'Not documented',
    }];
  }
  return doctors.map((doctor) => ({
    name: doctor.name || 'Not documented',
    designation: doctor.designation || 'Doctor',
  }));
}

function buildPastHistory(context) {
  const caseSheet = getCaseSheetContent(context);
  const caseSheetHistory = [
    caseSheet.past_history,
    caseSheet.past_medical_surgical_history,
  ].map((value) => text(value)).filter(Boolean);
  if (caseSheetHistory.length) return caseSheetHistory;

  const chronic = asArray(context.chronic_medications)
    .map((med) => med.indication || med.condition || med.diagnosis)
    .map((value) => text(value))
    .filter(Boolean);
  const chronicDiagnoses = context.diagnoses
    .map(diagnosisText)
    .filter((value) => /diabetes|hypertension|dyslipidemia|asthma|copd|cad|ckd|seizure|epilepsy/i.test(value));
  return Array.from(new Set([...chronicDiagnoses, ...chronic]));
}

function buildRiskFactors(context) {
  const joined = [
    ...context.diagnoses.map(diagnosisText),
    ...asArray(context.chronic_medications).map((med) => `${med.name || ''} ${med.indication || ''}`),
  ].join(' ');
  const factors = [];
  if (/diabetes|dm\b/i.test(joined)) factors.push('DM');
  if (/hypertension|htn/i.test(joined)) factors.push('HTN');
  if (/dyslipidemia|hyperlipidemia/i.test(joined)) factors.push('Dyslipidemia');
  if (/smok/i.test(joined)) factors.push('Smoking');
  return factors;
}

function buildPreviousMedicationRows(context) {
  return asArray(context.chronic_medications).map((med) => ({
    medication: med.name || med.medication_name || 'Medication',
    dose: med.dose || med.dosage || '',
    morning: '',
    afternoon: '',
    night: '',
  }));
}

function buildExaminationText(context, latestVitals) {
  const caseSheet = getCaseSheetContent(context);
  const caseVitals = caseSheet.vitals && typeof caseSheet.vitals === 'object' && !Array.isArray(caseSheet.vitals)
    ? caseSheet.vitals
    : {};
  const caseExam = [
    caseVitals.pulse_rate ? `PR- ${valueWithUnit(caseVitals.pulse_rate, '/min')}` : null,
    caseVitals.bp ? `BP- ${valueWithUnit(caseVitals.bp, 'mm Hg')}` : null,
    caseVitals.spo2 ? `SpO2- ${valueWithUnit(caseVitals.spo2, '%')}` : null,
    caseVitals.cbg ? `CBG- ${valueWithUnit(caseVitals.cbg, 'mg/dl')}` : null,
    caseVitals.weight ? `Wt- ${valueWithUnit(caseVitals.weight, 'Kg')}` : null,
    caseVitals.temperature ? `Temp- ${valueWithUnit(caseVitals.temperature, 'deg F')}` : null,
    caseSheet.cvs ? `CVS- ${caseSheet.cvs}` : null,
    caseSheet.rs ? `RS- ${caseSheet.rs}` : null,
    caseSheet.pa ? `P/A- ${caseSheet.pa}` : null,
    caseSheet.cns ? `CNS- ${caseSheet.cns}` : null,
  ].filter(Boolean);
  if (caseExam.length) return caseExam.join('\n');

  const vitals = latestVitals?.payload || {};
  const objective = firstNoteField(context.notes, ['objective', 'examination', 'exam', 'clinical_examination']);
  const parts = [];
  if (objective) parts.push(objective);
  if (latestVitals) {
    parts.push([
      vitals.heart_rate ? `PR- ${valueWithUnit(vitals.heart_rate, '/min')}` : null,
      vitals.systolic_bp || vitals.diastolic_bp
        ? `BP- ${valueWithUnit(`${vitals.systolic_bp ?? '-'}/${vitals.diastolic_bp ?? '-'}`, 'mm Hg')}`
        : null,
      vitals.temperature ? `Temp- ${valueWithUnit(vitals.temperature, 'deg F')}` : null,
      vitals.spo2 ? `SpO2- ${valueWithUnit(vitals.spo2, '%')}` : null,
      vitals.blood_glucose ? `CBG- ${valueWithUnit(vitals.blood_glucose, 'mg/dl')}` : null,
    ].filter(Boolean).join('    '));
  }
  return parts.join('\n') || 'Final examination must be documented by the signing doctor.';
}

function buildInvestigationLines(context) {
  const investigations = context.investigations.slice(-8).map((event) => {
    const payload = event.payload || {};
    return `${payload.test_name || payload.test_type || payload.investigation_type || 'Investigation'} - ${payload.result_summary || payload.conclusion || payload.interpretation || payload.status || 'See source record'}`;
  });
  const radiology = asArray(context.radiology_orders).slice(0, 4).map((row) =>
    `${row.modality || 'Radiology'} ${row.body_part || ''} - ${row.status || 'status not documented'}`.trim());
  return [...investigations, ...radiology];
}

function scheduleFromFrequency(frequency) {
  const value = text(frequency).toLowerCase();
  if (/1-0-1|bd|twice|bid/.test(value)) return { morning: '1', afternoon: '0', night: '1' };
  if (/1-1-1|tds|tid|three/.test(value)) return { morning: '1', afternoon: '1', night: '1' };
  if (/0-0-1|night|hs|od at night/.test(value)) return { morning: '0', afternoon: '0', night: '1' };
  if (/1-0-0|morning|od|once|daily/.test(value)) return { morning: '1', afternoon: '0', night: '0' };
  return { morning: '', afternoon: '', night: '' };
}

function buildMedicationTable(meds) {
  return asArray(meds).map((med) => {
    const schedule = scheduleFromFrequency(med.frequency);
    return {
      medication: med.name || med.medication_name || 'Medication',
      dose: med.dose || med.dosage || '',
      route: med.route || '',
      morning: med.morning ?? schedule.morning,
      afternoon: med.afternoon ?? schedule.afternoon,
      night: med.night ?? schedule.night,
      duration: med.duration || '',
      instructions: med.instructions || med.reconciliation_status || '',
    };
  });
}

function formatMedicationTable(rows) {
  const header = [
    'MEDICATIONS'.padEnd(24),
    'DOSE'.padEnd(10),
    'ROUTE'.padEnd(16),
    'MORN'.padEnd(6),
    'NOON'.padEnd(6),
    'NIGHT'.padEnd(7),
    'DURATION',
  ].join(' ');
  const body = asArray(rows).map((row) => [
    text(row.medication).slice(0, 23).padEnd(24),
    text(row.dose).slice(0, 9).padEnd(10),
    text(row.route).slice(0, 15).padEnd(16),
    text(row.morning).slice(0, 5).padEnd(6),
    text(row.afternoon).slice(0, 5).padEnd(6),
    text(row.night).slice(0, 6).padEnd(7),
    text(row.duration || row.instructions || 'doctor review'),
  ].join(' '));
  return [header, ...body].join('\n');
}

function buildDischargeAdvice(summary) {
  return [
    summary.diet_instructions ? `Diet: ${summary.diet_instructions}` : 'Diet: as advised by treating doctor / dietician.',
    'PLEASE DO NOT STOP MEDICATIONS WITHOUT CONSULTING THE DOCTOR.',
    summary.warning_signs || 'Please report to hospital for fever, chest pain, breathlessness, bleeding, giddiness, worsening pain, or any significant concern.',
  ].filter(Boolean);
}

function buildSignatureBlocks(dischargeDate) {
  return [
    `DATE: ${dischargeDate}          CONSULTANT                     MEDICAL OFFICER`,
    'Typed By:',
    'Discharge summary explained by:',
    'I have been explained and understood the content of the summary:',
    'Patient Name & Signature:                 Patient Relative Name & Signature:',
    'Patient signature:                         Patient relative signature:',
    'Relationship to the Patient:',
    'Discharge summary explained to and received by:',
  ];
}

function buildHospitalFormattedSummary(context, summary) {
  const header = summary.patient_header;
  const doctors = asArray(summary.attending_doctors);
  const medRows = summary.medication_table;
  const previousRows = asArray(summary.previous_medications);
  const admission = context.admission || {};

  return [
    'DISCHARGE SUMMARY',
    '',
    line('Name of the Patient :', header.patient_name),
    line('Age /Sex :', header.age_sex),
    line('MRI No. :', header.mrn),
    line('I.P. No:', header.ip_no),
    line('Ward No. :', header.ward_no),
    line('Address :', header.address),
    line('Mobile No. / Land Line No.', header.mobile),
    line('Primary Consultant:', header.primary_consultant),
    line('Date of Admission :', header.date_of_admission),
    line('Date of Discharge :', header.date_of_discharge),
    '',
    'ATTENDING DOCTORS:',
    'Name'.padEnd(42, ' ') + 'Designation',
    ...doctors.map((doctor) => `${text(doctor.name).padEnd(42, ' ')}${text(doctor.designation) || 'Doctor'}`),
    '',
    'DIAGNOSIS:',
    listLines(summary.diagnosis_lines),
    '',
    'PLAN:',
    summary.plan || 'Not documented',
    '',
    `${header.patient_name}, ${header.age_sex}, was admitted ${admission.admission_type ? `as ${admission.admission_type}` : 'for inpatient care'}.`,
    summary.presenting_complaints || admission.chief_complaint || admission.reason_for_admission || 'Presenting complaints not documented.',
    '',
    'PAST HISTORY:',
    listLines(summary.past_history),
    '',
    `INTOLERANCE: ${summary.intolerance || 'Not documented'}`,
    `PERSONAL HISTORY: ${summary.personal_history || 'Not documented'}`,
    summary.menstrual_pregnancy_history
      ? `MENSTRUAL / PREGNANCY HISTORY: ${summary.menstrual_pregnancy_history}`
      : '',
    '',
    `FAMILY HISTORY: ${summary.family_history || 'Nil significant / not documented'}`,
    `RISK FACTORS: ${listLines(summary.risk_factors, 'Not documented')}`,
    '',
    'PREVIOUS MEDICATION:',
    previousRows.length
      ? previousRows.map((row) => `${row.medication || 'Medication'} ${row.dose || ''} ${row.morning || ''} ${row.afternoon || ''} ${row.night || ''}`.trim()).join('\n')
      : 'Not documented',
    '',
    'ON EXAMINATION:',
    summary.examination_on_admission || 'Not documented',
    '',
    'INVESTIGATIONS:',
    listLines(summary.investigation_lines, 'Enclosed / see EMR investigation records.'),
    '',
    'COURSE IN THE HOSPITAL:',
    summary.hospital_course || 'Not documented',
    '',
    'CONDITION AT DISCHARGE:',
    summary.discharge_condition || 'Not documented',
    '',
    'ADVISED TO CONTINUE:',
    formatMedicationTable(medRows),
    '',
    'DM ADVICE:',
    summary.dm_advice || 'As advised by diabetologist / treating doctor.',
    '',
    buildDischargeAdvice(summary).join('\n\n'),
    '',
    'Physiotherapy advice:',
    summary.physiotherapy_advice || 'Deep breathing, limb/ankle exercises, and walking as advised.',
    '',
    'FOLLOW UP:',
    summary.follow_up_instructions || 'Review with treating physician as advised.',
    '',
    ...summary.signature_blocks,
  ].join('\n');
}

// Order statuses that mean the medication is no longer active and must
// not be carried onto the take-home list. `discontinued`/`cancelled`
// are the orderEntryService lifecycle terminals; `stopped`/`held`/
// `on_hold`/`suspended` cover the free-text VARCHAR status values older
// rows / step-down notes use (a stopped IV must not reappear as a
// take-home drug); `completed` is a finished inpatient course, not a
// take-home med. Finding 2026-05-22-inpatient-admission-discharge-edb7c8ff.
const INACTIVE_ORDER_STATUS_RE =
  /cancelled|canceled|discontinued|stopped|\bheld\b|on[\s_-]?hold|suspended|completed/i;

// Parenteral / inpatient-only administration routes. An IV fluid, IV
// push, infusion, or IM/SC injection is administered on the ward — it
// is never a "continue at home" tablet. We still surface these for the
// doctor's reconciliation, but as `pending_review` (NOT `continue`) so
// the patient/relative is never told to keep taking IV saline. Finding
// 2026-05-22-inpatient-admission-discharge-edb7c8ff.
const PARENTERAL_ROUTE_RE =
  /\b(iv|i\.v\.?|intravenous|infusion|drip|im|i\.m\.?|intramuscular|sc|s\.c\.?|subcut|subcutaneous|epidural|intrathecal)\b/i;

function isParenteralMed({ route, name }) {
  if (PARENTERAL_ROUTE_RE.test(text(route))) return true;
  // Route is often blank on free-text orders — fall back to the name,
  // which commonly carries the form ("Normal Saline IV", "... infusion").
  return PARENTERAL_ROUTE_RE.test(text(name));
}

function buildDischargeMedications(context) {
  const activeMedicationOrders = context.orders
    .filter((event) => event.payload?.order_type === 'medication')
    .filter((event) => !INACTIVE_ORDER_STATUS_RE.test(text(event.payload?.status)));

  // De-duplicate the same drug ordered more than once during the stay
  // (e.g. ORS re-ordered on two days) so the take-home list doesn't list
  // it twice. Key on normalised name+route+dose. Finding
  // 2026-05-22-inpatient-admission-discharge-edb7c8ff (duplicate ORS from
  // source_order_id 59 and 60).
  const seenInpatient = new Set();
  const inpatientMeds = activeMedicationOrders.reduce((acc, event) => {
    const details = event.payload?.details || {};
    const name = details.medication_name || details.name || 'Medication not named';
    const dose = details.dose || details.dosage || '';
    const route = details.route || '';
    const dedupeKey = [name, route, dose]
      .map((v) => text(v).toLowerCase())
      .join('|');
    if (seenInpatient.has(dedupeKey)) return acc;
    seenInpatient.add(dedupeKey);

    // Parenteral inpatient drugs are not take-home meds — surface for
    // review but never auto-mark `continue`.
    const parenteral = isParenteralMed({ route, name });
    acc.push({
      name,
      dose,
      route,
      frequency: details.frequency || '',
      duration: details.duration || '',
      source_order_id: event.id,
      source: 'inpatient',
      reconciliation_status: parenteral ? 'pending_review' : 'continue',
      ...(parenteral
        ? { requires_review_reason: 'parenteral_inpatient_route_not_take_home' }
        : {}),
    });
    return acc;
  }, []);

  // Wave-4B-1 — merge in pre-admission chronic medications so the discharge
  // medication draft surfaces them for explicit continue / stop / hold /
  // restart review by the signing doctor. Chronic entries that the doctor
  // already reconciled (`reconciled_at_discharge: true` or a non-null
  // `reconciliation_status`) carry the status forward; un-reconciled ones
  // get `reconciliation_status: 'pending_review'` so the buildSafetyFlags
  // pass can emit CHRONIC_MED_NOT_RECONCILED. Finding:
  //   2026-05-10-inpatient-admission-discharge-drug-reconciliation-drops-chronic-meds
  const chronicMeds = asArray(context.chronic_medications);
  const inpatientNames = new Set(
    inpatientMeds.map((m) => text(m.name).toLowerCase()).filter(Boolean),
  );
  const chronicAsDischargeMeds = chronicMeds.map((cm) => {
    const cmName = cm.name || cm.medication_name || '';
    const alreadyOnList = Array.from(inpatientNames).some(
      (nm) => nm.includes(cmName.toLowerCase()) || cmName.toLowerCase().includes(nm),
    );
    return {
      name: cmName || 'Chronic medication (unnamed)',
      dose: cm.dose || cm.dosage || '',
      route: cm.route || '',
      frequency: cm.frequency || '',
      duration: cm.duration || 'chronic',
      indication: cm.indication || '',
      started_at: cm.started_at || null,
      source: 'pre_admission_chronic',
      reconciliation_status: cm.reconciliation_status
        || (cm.reconciled_at_discharge ? 'continue' : alreadyOnList ? 'continue' : 'pending_review'),
    };
  });

  return [...inpatientMeds, ...chronicAsDischargeMeds];
}

function buildStructuredSummary(context, hospitalCourse, aiResult) {
  const admission = context.admission || {};
  const caseSheet = getCaseSheetContent(context);
  const patientHeader = buildPatientHeader(context);
  const attendingDoctors = buildAttendingDoctors(context);
  const diagnoses = text(caseSheet.provisional_diagnosis)
    ? [text(caseSheet.provisional_diagnosis)]
    : diagnosisLines(context);
  const latestVitals = latestByType(context.vitals);
  const vitals = latestVitals?.payload || {};
  const procedures = context.notes
    .filter((event) => /procedure/i.test(text(event.sub_type)))
    .map((event) => event.payload?.content?.procedure_name || event.summary)
    .filter(Boolean);
  const investigations = context.investigations.slice(-12).map((event) => ({
    test: event.payload?.test_name || event.payload?.test_type || event.payload?.investigation_type || 'Investigation',
    status: event.payload?.status || 'unknown',
    result: event.payload?.result_summary || event.payload?.conclusion || event.payload?.interpretation || 'See source record',
    source_id: event.id,
  }));
  const medications = buildDischargeMedications(context);
  const medicationTable = buildMedicationTable(medications);
  const investigationLines = buildInvestigationLines(context);
  const pastHistory = buildPastHistory(context);
  const riskFactors = buildRiskFactors(context);
  const allergies = asArray(context.allergies)
    .map((row) => row.allergen || row.name || row.allergy_name)
    .map((value) => text(value))
    .filter(Boolean);
  const presentingComplaints = text(caseSheet.chief_complaints)
    || firstNoteField(context.notes, ['subjective', 'chief_complaint', 'presenting_complaints'])
    || admission.chief_complaint
    || admission.reason_for_admission
    || admission.reason
    || '';
  const historyOfPresentingIllness = text(caseSheet.history_of_presenting_illness);
  const plan = firstNoteField(context.notes, ['plan', 'discharge_plan'])
    || admission.discharge_type
    || '';
  const dietInstructions = firstNoteField(context.notes, ['diet', 'diet_instructions'])
    || '';
  const activityRestrictions = firstNoteField(context.notes, ['activity', 'activity_restrictions'])
    || '';
  const warningSigns = 'Please report to hospital for fever above 100 F, new or worsening pain, vomiting, chest pain, fast or slow heart beat, giddiness, bleeding, worsening symptoms, or any significant concern.';

  const summary = {
    patient_header: patientHeader,
    attending_doctors: attendingDoctors,
    diagnosis_lines: diagnoses,
    plan: plan || 'Not documented',
    presenting_complaints: [
      presentingComplaints,
      historyOfPresentingIllness,
    ].filter(Boolean).join('\n') || 'Not documented',
    past_history: pastHistory.length ? pastHistory : ['Not documented'],
    intolerance: text(caseSheet.allergies) || (allergies.length ? allergies.join(', ') : 'Not documented'),
    personal_history: text(caseSheet.personal_history) || 'Not documented',
    menstrual_pregnancy_history: text(caseSheet.menstrual_pregnancy_history) || '',
    family_history: text(caseSheet.family_history) || 'Nil significant / not documented',
    risk_factors: riskFactors.length ? riskFactors : ['Not documented'],
    previous_medications: buildPreviousMedicationRows(context),
    examination_on_admission: buildExaminationText(context, latestVitals),
    investigation_lines: investigationLines,
    hospital_course: hospitalCourse || buildTemplateHospitalCourse(context),
    discharge_diagnosis: diagnoses.join('; ') || admission.admitting_diagnosis || 'Not documented',
    discharge_condition: latestVitals
      ? `Latest documented vitals: HR ${valueWithUnit(vitals.heart_rate ?? '-', '/min')}, BP ${valueWithUnit(`${vitals.systolic_bp ?? '-'}/${vitals.diastolic_bp ?? '-'}`, 'mm Hg')}, SpO2 ${valueWithUnit(vitals.spo2 ?? '-', '%')}.`
      : 'Final discharge condition must be documented by the signing doctor.',
    medications_on_discharge: medications,
    medication_table: medicationTable,
    follow_up_instructions: 'Review with treating physician as advised. Return urgently for worsening symptoms, fever, breathlessness, chest pain, bleeding, confusion, or any new concerning symptom.',
    activity_restrictions: activityRestrictions,
    diet_instructions: dietInstructions,
    dm_advice: 'As advised by diabetologist / treating doctor.',
    physiotherapy_advice: 'Deep breathing, ankle exercises, and walking as advised.',
    warning_signs: warningSigns,
    procedures_performed: procedures,
    investigations_summary: investigations,
    signature_blocks: buildSignatureBlocks(patientHeader.date_of_discharge),
    generated_at: new Date().toISOString(),
    generated_by: null,
    is_draft: true,
    is_signed: false,
    signed_by: null,
    signed_at: null,
    ai_metadata: {
      provider: aiResult.provider,
      model: aiResult.model,
      tier: aiResult.tier || 'quick',
      model_tier: aiResult.tier || 'quick',
      module_key: aiResult.moduleKey,
      used_ai: aiResult.usedAi,
      prompt_tokens: aiResult.usage?.prompt_tokens || 0,
      completion_tokens: aiResult.usage?.completion_tokens || 0,
      total_tokens: aiResult.usage?.total_tokens || 0,
      estimated_cost_minor: aiResult.estimatedCostMinor || null,
      latency_ms: aiResult.usage?.latency_ms || null,
      provider_request_id: aiResult.usage?.provider_request_id || null,
      finish_reason: aiResult.usage?.finish_reason || null,
      prompt_version: PROMPT_VERSION,
      fallback_reason: aiResult.reason || null,
    },
    source_citations: buildCitations(context),
  };

  summary.safety_flags = buildSafetyFlags(context, summary);
  summary.formatted_summary = buildHospitalFormattedSummary(context, summary);
  return summary;
}

function buildPrompt(context) {
  const patient = context.patient || {};
  const admission = context.admission || {};
  const compactTimeline = context.timeline
    .filter((event) => !(event.event_type === 'clinical_note' && text(event.sub_type).toLowerCase() === 'case_sheet'))
    .map((event) => ({
      type: event.event_type,
      sub_type: event.sub_type,
      id: event.id,
      timestamp: event.timestamp,
      summary: event.summary,
    }));

  const systemPrompt = [
    'You are a clinical documentation assistant inside a hospital EMR.',
    'Use only the provided source data.',
    'Never invent diagnoses, procedures, medications, dates, or follow-up plans.',
    'If something is not documented, say "not documented".',
    'Return formal hospital-course prose in the style of an Indian inpatient discharge summary, not JSON.',
    'Include admission presentation, key investigations, procedures/treatment, specialist input, response, and discharge readiness when supported by source data.',
    'The output is a draft for doctor review and must not claim to be signed.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    task: 'Draft hospital course for a discharge summary',
    patient: {
      uid: patient.uid,
      name: patient.name,
      gender: patient.gender,
      birthday: patient.birthday,
    },
    admission: {
      id: admission.id,
      admitted_at: admission.admitted_at,
      discharged_at: admission.discharged_at,
      ward: admission.ward,
      chief_complaint: admission.chief_complaint,
      admitting_diagnosis: admission.admitting_diagnosis,
      code_status: admission.code_status,
    },
    allergies: context.allergies,
    timeline: compactTimeline,
  });

  return { systemPrompt, userPrompt };
}

async function saveAiGeneration(context, summary, requestedBy, sourceHash, tenantId = null) {
  const metadata = {
    tier: summary.ai_metadata.tier || 'quick',
    model_tier: summary.ai_metadata.model_tier || summary.ai_metadata.tier || 'quick',
    fallback_reason: summary.ai_metadata.fallback_reason,
    usage: {
      prompt_tokens: summary.ai_metadata.prompt_tokens || 0,
      completion_tokens: summary.ai_metadata.completion_tokens || 0,
      total_tokens: summary.ai_metadata.total_tokens || 0,
    },
  };

  return prisma.clinical_ai_generations.create({
    data: {
      tenant_id: tenantId || DEFAULT_TENANT_ID,
      patient_uid: context.admission.patient_uid,
      admission_id: context.admission.id,
      task_type: 'discharge_summary',
      module_key: summary.ai_metadata.module_key || 'discharge_summary',
      provider: summary.ai_metadata.provider,
      model: summary.ai_metadata.model,
      prompt_version: PROMPT_VERSION,
      source_hash: sourceHash,
      status: 'draft',
      used_ai: summary.ai_metadata.used_ai,
      safety_flags: summary.safety_flags || [],
      citations: summary.source_citations || [],
      draft: summary,
      generated_by: requestedBy || null,
      prompt_tokens: summary.ai_metadata.prompt_tokens || 0,
      completion_tokens: summary.ai_metadata.completion_tokens || 0,
      total_tokens: summary.ai_metadata.total_tokens || 0,
      estimated_cost_minor: summary.ai_metadata.estimated_cost_minor || null,
      latency_ms: summary.ai_metadata.latency_ms || null,
      provider_request_id: summary.ai_metadata.provider_request_id || null,
      finish_reason: summary.ai_metadata.finish_reason || null,
      metadata,
    },
    select: {
      id: true,
      provider: true,
      model: true,
      used_ai: true,
      status: true,
      created_at: true,
    },
  });
}

export async function collectClinicalData(admissionId) {
  return collectAdmissionClinicalContext(admissionId);
}

async function resolveSignerDetails(uid) {
  if (!uid) return null;
  try {
    const signer = await prisma.users.findUnique({
      where: { uid },
      select: { name: true, role: true },
    });
    if (!signer) return null;
    return {
      signed_by_name: signer.name || null,
      signed_by_role: signer.role || null,
    };
  } catch (e) {
    logger.warn(`resolveSignerDetails: failed to resolve signer ${uid}: ${e.message}`);
    return null;
  }
}

export async function getLatestDischargeSummary(admissionId) {
  const admission = await prisma.admissions.findUnique({
    where: { id: Number(admissionId) },
    select: ADMISSION_LOOKUP_SELECT,
  });
  if (!admission) throw AppError.notFound('Admission not found');

  const note = admission.encounter_id
    ? await prisma.clinical_notes.findFirst({
        where: {
          encounter_id: admission.encounter_id,
          note_type: 'discharge',
          is_addendum: false,
        },
        select: {
          id: true,
          title: true,
          content: true,
          version: true,
          is_signed: true,
          signed_by: true,
          signed_at: true,
          author_uid: true,
          author_role: true,
          ai_generation_id: true,
          created_at: true,
          updated_at: true,
        },
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      })
    : null;

  if (note) {
    const content = (note.content && typeof note.content === 'object' && !Array.isArray(note.content))
      ? note.content
      : {};
    const signedBy = note.signed_by || content.signed_by || null;
    const signer = await resolveSignerDetails(signedBy);
    return {
      source: 'clinical_note',
      note_id: note.id,
      title: note.title,
      version: note.version,
      content,
      is_signed: note.is_signed === true || content.is_signed === true,
      signed_by: signedBy,
      signed_by_name: content.signed_by_name || signer?.signed_by_name || null,
      signed_by_role: content.signed_by_role || signer?.signed_by_role || null,
      signed_at: note.signed_at || content.signed_at || null,
      author_uid: note.author_uid,
      author_role: note.author_role,
      ai_generation_id: note.ai_generation_id || content.draft_generation_id || null,
      created_at: note.created_at,
      updated_at: note.updated_at,
      ai_metadata: content.ai_metadata || null,
      safety_flags: Array.isArray(content.safety_flags) ? content.safety_flags : [],
      source_citations: Array.isArray(content.source_citations) ? content.source_citations : [],
    };
  }

  if (admission.discharge_summary) {
    const content = typeof admission.discharge_summary === 'object'
      ? admission.discharge_summary
      : { text: String(admission.discharge_summary) };
    const signedBy = content.signed_by || null;
    const signer = await resolveSignerDetails(signedBy);
    return {
      source: 'admission',
      note_id: null,
      title: 'Discharge summary',
      version: null,
      content,
      is_signed: content.is_signed === true,
      signed_by: signedBy,
      signed_by_name: content.signed_by_name || signer?.signed_by_name || null,
      signed_by_role: content.signed_by_role || signer?.signed_by_role || null,
      signed_at: content.signed_at || null,
      author_uid: null,
      author_role: null,
      ai_generation_id: content.draft_generation_id || null,
      created_at: null,
      updated_at: null,
      ai_metadata: content.ai_metadata || null,
      safety_flags: Array.isArray(content.safety_flags) ? content.safety_flags : [],
      source_citations: Array.isArray(content.source_citations) ? content.source_citations : [],
    };
  }

  return null;
}

export async function generateDischargeSummary(admissionId, requestedBy, req) {
  if (!requestedBy) throw AppError.badRequest('requestedBy is required');

  const context = await collectAdmissionClinicalContext(admissionId);
  const prompt = buildPrompt(context);
  const aiResult = await generateClinicalText({
    ...prompt,
    taskType: 'discharge_summary',
    tenantId: req?.tenantId,
  });
  const hospitalCourse = aiResult.usedAi ? aiResult.text : buildTemplateHospitalCourse(context);
  const summary = buildStructuredSummary(context, hospitalCourse, aiResult);
  summary.generated_by = requestedBy;

  const sourceHash = makeSourceHash(context);
  const generation = await saveAiGeneration(context, summary, requestedBy, sourceHash, req?.tenantId || null);
  summary.draft_generation_id = generation.id;

  logPhiAccess({
    userId: requestedBy,
    userRole: req?.user?.role,
    patientId: context.patient?.uid || context.admission.patient_uid,
    recordType: 'discharge_summary_generation',
    action: 'GENERATE',
    ip: req?.ip,
    requestId: req?.id,
  });

  await publishEvent({
    eventType: 'clinical_ai.discharge_summary.generated',
    aggregateType: 'admission',
    aggregateId: admissionId,
    patientUid: context.admission.patient_uid,
    payload: {
      generation_id: generation.id,
      used_ai: generation.used_ai,
      provider: generation.provider,
      safety_flag_count: summary.safety_flags.length,
    },
  });

  logger.info('Discharge summary draft generated', {
    admissionId,
    patientUid: context.admission.patient_uid,
    provider: generation.provider,
    usedAi: generation.used_ai,
  });

  return summary;
}

export async function saveDischargeSummary(admissionId, summary, savedBy, savedByRole) {
  if (!savedBy) throw AppError.badRequest('savedBy is required');
  if (!savedByRole) throw AppError.badRequest('savedByRole is required');
  if (!summary || typeof summary !== 'object') throw AppError.badRequest('summary is required');

  const admission = await prisma.admissions.findUnique({
    where: { id: admissionId },
    select: ADMISSION_LOOKUP_SELECT,
  });
  if (!admission) throw AppError.notFound('Admission not found');

  const content = {
    ...summary,
    is_draft: true,
    is_signed: false,
    reviewed_by: savedBy,
    reviewed_at: new Date().toISOString(),
  };

  // Match the pre-ORM ORDER BY version DESC, id DESC LIMIT 1.
  const existing = await prisma.clinical_notes.findFirst({
    where: {
      encounter_id: admission.encounter_id,
      note_type: 'discharge',
      is_addendum: false,
    },
    select: DISCHARGE_NOTE_SELECT,
    orderBy: [{ version: 'desc' }, { id: 'desc' }],
  });

  let result;
  if (existing) {
    if (existing.is_signed) {
      throw AppError.badRequest('Signed discharge summary cannot be modified. Add an addendum instead.');
    }

    const updated = await prisma.clinical_notes.update({
      where: { id: existing.id },
      data: {
        content,
        version: { increment: 1 },
        ai_generation_id: content.draft_generation_id || null,
        updated_at: new Date(),
      },
      select: { id: true },
    });
    result = { noteId: updated.id, action: 'updated' };
  } else {
    const created = await prisma.clinical_notes.create({
      data: {
        encounter_id: admission.encounter_id,
        patient_uid: admission.patient_uid,
        author_uid: savedBy,
        author_role: savedByRole,
        note_type: 'discharge',
        title: 'Draft discharge summary',
        content,
        version: 1,
        is_addendum: false,
        is_signed: false,
        ai_generation_id: content.draft_generation_id || null,
      },
      select: { id: true },
    });
    result = { noteId: created.id, action: 'created' };
  }

  if (content.draft_generation_id) {
    await prisma.clinical_ai_generations.update({
      where: { id: content.draft_generation_id },
      data: {
        draft: content,
        reviewed_by: savedBy,
        status: 'reviewed',
        updated_at: new Date(),
      },
    });
  }

  // Denormalize first-edit timestamp on the admission (T1) — only stamp
  // if not already set. Lets efficiency dashboards compute T1−T0 without
  // joining clinical_notes. Migration 173. Best-effort.
  try {
    await prisma.admissions.updateMany({
      where: { id: admissionId, summary_first_edit_at: null },
      data: { summary_first_edit_at: new Date(), updated_at: new Date() },
    });
  } catch (e) {
    logger.warn(`saveDischargeSummary: failed to denormalize summary_first_edit_at on admission ${admissionId}: ${e.message}`);
  }

  await publishEvent({
    eventType: 'clinical_document.discharge_summary.saved',
    aggregateType: 'clinical_note',
    aggregateId: result.noteId,
    patientUid: admission.patient_uid,
    payload: {
      admission_id: admissionId,
      action: result.action,
      generation_id: content.draft_generation_id || null,
    },
  });

  return result;
}

export async function signDischargeSummary(admissionId, doctorUid, tenantId = null) {
  if (!doctorUid) throw AppError.badRequest('doctorUid is required');

  const admission = await prisma.admissions.findUnique({
    where: { id: admissionId },
    select: ADMISSION_FOR_SIGN_SELECT,
  });
  if (!admission) throw AppError.notFound('Admission not found');

  // The read of `note` (for the jsonb_set replacement) and the write that
  // flips `is_signed` happen in one transaction. The write itself is
  // conditioned on `is_signed: false` via updateMany — if a concurrent
  // signer flipped the flag between our SELECT and UPDATE, count comes
  // back 0 and we surface a 400 instead of silently double-signing.
  // Single shared timestamp so the column value matches the JSON value
  // the original `to_jsonb(NOW())` produced.
  const signedAt = new Date();
  const signer = await resolveSignerDetails(doctorUid);

  const txnResult = await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
    const note = await tx.clinical_notes.findFirst({
      where: {
        encounter_id: admission.encounter_id,
        note_type: 'discharge',
        is_addendum: false,
      },
      select: DISCHARGE_NOTE_FOR_SIGN_SELECT,
      orderBy: [{ version: 'desc' }, { id: 'desc' }],
    });
    if (!note) throw AppError.notFound('No discharge summary found. Generate one first.');
    if (note.is_signed) throw AppError.badRequest('Discharge summary is already signed');

    // content may be null on pathological rows; default to {} so we don't NPE.
    const baseContent = (note.content && typeof note.content === 'object' && !Array.isArray(note.content))
      ? note.content
      : {};
    const updatedContent = {
      ...baseContent,
      is_signed: true,
      signed_by: doctorUid,
      signed_by_name: signer?.signed_by_name || null,
      signed_by_role: signer?.signed_by_role || null,
      signed_at: signedAt.toISOString(),
    };

    const flip = await tx.clinical_notes.updateMany({
      where: { id: note.id, is_signed: false },
      data: {
        is_signed: true,
        signed_at: signedAt,
        signed_by: doctorUid,
        updated_at: signedAt,
        content: updatedContent,
      },
    });
    if (flip.count === 0) {
      // Lost the race — another signer flipped is_signed between our
      // SELECT and UPDATE. Reject with a 400 (the signed copy stands).
      throw AppError.badRequest('Discharge summary is already signed');
    }

    if (note.ai_generation_id) {
      await tx.clinical_ai_generations.update({
        where: { id: note.ai_generation_id },
        data: {
          status: 'signed',
          reviewed_by: doctorUid,
          signed_note_id: note.id,
          updated_at: signedAt,
        },
      });
    }

    // Denormalize the sign timestamp onto the admission row so
    // discharge-cascade readiness checks (D2) and efficiency dashboards
    // (T0→T2) can read it without a clinical_notes join. Migration 173.
    // Best-effort — admission row may not exist in legacy/test data.
    try {
      await tx.admissions.update({
        where: { id: admissionId },
        data: { summary_signed_at: signedAt, updated_at: signedAt },
      });
    } catch (e) {
      logger.warn(`signDischargeSummary: failed to denormalize summary_signed_at on admission ${admissionId}: ${e.message}`);
    }

    await tx.audit_logs.create({
      data: {
        uid: doctorUid,
        action: 'SIGN_DISCHARGE_SUMMARY',
        resource: 'clinical_notes',
        resource_id: String(note.id),
        metadata: {
          admission_id: admissionId,
          patient_uid: admission.patient_uid,
          ai_generation_id: note.ai_generation_id || null,
        },
      },
    });

    return {
      noteId: note.id,
      aiGenerationId: note.ai_generation_id || null,
      signedByName: signer?.signed_by_name || null,
      signedByRole: signer?.signed_by_role || null,
    };
  });

  await publishEvent({
    eventType: 'clinical_document.discharge_summary.signed',
    aggregateType: 'clinical_note',
    aggregateId: txnResult.noteId,
    patientUid: admission.patient_uid,
    payload: {
      admission_id: admissionId,
      signed_by: doctorUid,
      signed_by_name: txnResult.signedByName,
      signed_by_role: txnResult.signedByRole,
      signed_at: signedAt,
      ai_generation_id: txnResult.aiGenerationId,
    },
  });

  // Materialise take-home medicines from the signed discharge note into
  // e_prescriptions so the patient app's Rx tab surfaces them. The
  // clinical_notes path stores the discharge summary as a structured
  // JSON object on `content` — medications_on_discharge is an array of
  // { name, dose, frequency, duration, instructions, ... } entries (see
  // buildDischargeMedications). The sibling Sprint-11 dischargeService
  // path does the same materialisation against discharge_summary_sections
  // free-text bodies. Best-effort: signing must not fail if no
  // medications are present.
  // Finding 2026-05-10-inpatient-admission-patient-takeaway-meds-missing.
  await materialiseDischargeMedsFromClinicalNote({
    note_id: txnResult.noteId,
    admission_id: admissionId,
    patient_uid: admission.patient_uid,
    doctor_uid: doctorUid,
  });

  return {
    noteId: txnResult.noteId,
    signed: true,
    signedBy: doctorUid,
    signedByName: txnResult.signedByName,
    signedByRole: txnResult.signedByRole,
    signedAt: signedAt,
  };
}

async function materialiseDischargeMedsFromClinicalNote({
  note_id, admission_id, patient_uid, doctor_uid,
}) {
  if (!patient_uid) return;
  try {
    const noteRows = await prisma.clinical_notes.findUnique({
      where: { id: Number(note_id) },
      select: { content: true },
    });
    const content = noteRows?.content;
    const meds = (content && typeof content === 'object' && !Array.isArray(content))
      ? asArray(content.medications_on_discharge)
      : [];
    if (!meds.length) return;

    // Idempotency probe — re-signing or backfilling should not create
    // duplicate Rx rows. Stamp a discharge marker in clinical_notes so
    // we can detect a prior insert via LIKE.
    const marker = `[discharge_clinical_note_id=${note_id}]`;
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM e_prescriptions
        WHERE patient_uid = $1::uuid
          AND clinical_notes LIKE $2
        LIMIT 1`,
      String(patient_uid), `%${marker}%`,
    );
    if (existing.length) return;

    // Resolve int ids for the FK columns. The patient must exist; the
    // doctor may not (legacy / name-only signers).
    const [patientRow, doctorRow] = await Promise.all([
      prisma.users.findUnique({
        where: { uid: String(patient_uid) },
        select: { id: true },
      }),
      doctor_uid
        ? prisma.users.findUnique({
            where: { uid: String(doctor_uid) },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    const patientId = patientRow?.id ?? null;
    const doctorId = doctorRow?.id ?? null;
    if (!patientId) {
      logger.warn(
        `materialiseDischargeMedsFromClinicalNote: no users row for patient_uid=${patient_uid}`,
      );
      return;
    }

    // Each entry is a structured medication record. Surface the array
    // verbatim into e_prescriptions.medications so the Rx tab card
    // renders the same fields the discharge note carried.
    const medications = meds.map((m) => {
      if (typeof m !== 'object' || m === null) {
        return { name: String(m), source: 'discharge_summary' };
      }
      return { ...m, source: 'discharge_summary' };
    });

    const clinicalNotesText =
      `Take-home medicines from discharge summary. ${marker}\n\n` +
      medications.map((m) => {
        const parts = [
          m.name,
          m.dose ? `(${m.dose})` : null,
          m.frequency || null,
          m.duration ? `× ${m.duration}` : null,
          m.instructions || null,
        ].filter(Boolean);
        return `• ${parts.join(' ')}`.trim();
      }).join('\n');

    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (appointment_id, patient_id, doctor_id, patient_uid, doctor_uid,
          diagnosis, clinical_notes, medications, status)
       VALUES (NULL, $1::int, $2::int, $3::uuid, $4::uuid,
               NULL, $5, $6::jsonb, 'active')`,
      patientId,
      doctorId,
      String(patient_uid),
      doctor_uid ? String(doctor_uid) : null,
      clinicalNotesText,
      JSON.stringify(medications),
    );
  } catch (e) {
    logger.warn(
      `materialiseDischargeMedsFromClinicalNote failed for admission ${admission_id} note ${note_id}: ${e.message}`,
    );
  }
}

export function getDischargeSummaryAiConfig() {
  return getClinicalAiConfig();
}

// Implementation detail exposed only for unit tests — asserts the
// take-home medication reconciliation excludes inactive/parenteral
// inpatient drugs and de-duplicates repeat orders. Not part of the
// public API. Finding 2026-05-22-inpatient-admission-discharge-edb7c8ff.
export const __testing__ = {
  buildDischargeMedications,
  isParenteralMed,
  INACTIVE_ORDER_STATUS_RE,
  PARENTERAL_ROUTE_RE,
};

export default {
  generateDischargeSummary,
  saveDischargeSummary,
  signDischargeSummary,
  collectClinicalData,
  getDischargeSummaryAiConfig,
};
