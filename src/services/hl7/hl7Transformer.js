// src/services/hl7/hl7Transformer.js
// Transforms between HL7v2 messages and VH Health internal data structures.

import { parseHL7, formatHL7Date, generateControlId } from './hl7Parser.js';
import logger from '../../logging/logger.js';

// =============================================================================
// OUTBOUND: VH Health data  ->  HL7v2 messages
// =============================================================================

/**
 * Generate ADT^A01 (admission) message from VH Health admission + patient.
 * @param {Object} admission - Internal admission record
 * @param {Object} patient - Internal user/patient record
 * @returns {string} HL7v2 ADT^A01 message
 */
export function admissionToADT(admission, patient) {
  const now = formatHL7Date(new Date());
  const segments = [
    `MSH|^~\\&|VHHEALTH|VH_HOSPITALS||EXTERNAL|${now}||ADT^A01|${generateControlId()}|P|2.5`,
    buildPID(patient),
    buildPV1(admission, 'I'),
  ];
  return segments.join('\r');
}

/**
 * Generate ADT^A03 (discharge) message from VH Health admission + patient.
 * @param {Object} admission - Internal admission record
 * @param {Object} patient - Internal user/patient record
 * @returns {string} HL7v2 ADT^A03 message
 */
export function dischargeToADT(admission, patient) {
  const now = formatHL7Date(new Date());
  const segments = [
    `MSH|^~\\&|VHHEALTH|VH_HOSPITALS||EXTERNAL|${now}||ADT^A03|${generateControlId()}|P|2.5`,
    buildPID(patient),
    buildPV1(admission, 'I'),
  ];
  return segments.join('\r');
}

/**
 * Generate ORM^O01 (lab/investigation order) from VH Health order + patient.
 * @param {Object} order - Internal investigation/order record
 * @param {Object} patient - Internal user/patient record
 * @returns {string} HL7v2 ORM^O01 message
 */
export function orderToORM(order, patient) {
  const now = formatHL7Date(new Date());
  const segments = [
    `MSH|^~\\&|VHHEALTH|VH_HOSPITALS||EXTERNAL|${now}||ORM^O01|${generateControlId()}|P|2.5`,
    buildPID(patient),
    buildOBR(order),
  ];
  return segments.join('\r');
}

/**
 * Generate ORU^R01 (lab result) from VH Health investigation + patient.
 * @param {Object} investigation - Internal investigation record with results
 * @param {Object} patient - Internal user/patient record
 * @returns {string} HL7v2 ORU^R01 message
 */
export function resultToORU(investigation, patient) {
  const now = formatHL7Date(new Date());
  const segments = [
    `MSH|^~\\&|VHHEALTH|VH_HOSPITALS||EXTERNAL|${now}||ORU^R01|${generateControlId()}|P|2.5`,
    buildPID(patient),
    buildOBR(investigation),
  ];

  // Add OBX segments for each result
  const results = Array.isArray(investigation.results) ? investigation.results : [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (typeof r === 'object' && r !== null) {
      segments.push(buildOBX(r, i + 1));
    } else {
      // Simple string result
      segments.push(
        `OBX|${i + 1}|ST|${investigation.test_name || ''}||${String(r)}||||||F`
      );
    }
  }

  return segments.join('\r');
}

// =============================================================================
// INBOUND: HL7v2 messages  ->  VH Health data
// =============================================================================

/**
 * Parse incoming ADT message and extract VH Health admission data.
 * @param {string} hl7Message - Raw HL7v2 ADT message
 * @returns {Object} { admission, patient } VH Health-shaped records
 */
export function parseADTToAdmission(hl7Message) {
  const parsed = parseHL7(hl7Message);

  if (!parsed.msh) {
    throw new Error('Invalid HL7 message: missing MSH segment');
  }

  const patient = {};
  if (parsed.pid) {
    patient.uid = parsed.pid.patientId || undefined;
    patient.name = parsed.pid.name || undefined;
    patient.birthday = parseHL7DateToISO(parsed.pid.birthDate) || undefined;
    patient.gender = mapHL7Gender(parsed.pid.gender);
    patient.address = parsed.pid.address || undefined;
    patient.phone = parsed.pid.phone || undefined;
  }

  const admission = {};
  if (parsed.pv1) {
    const location = (parsed.pv1.assignedLocation || '').split('^');
    admission.ward = location[0] || undefined;
    admission.bed_number = location[1] || undefined;
    admission.admitting_doctor = parsed.pv1.attendingDoctor || undefined;
    admission.admitted_at = parseHL7DateToISO(parsed.pv1.admitDate) || undefined;
    admission.discharged_at = parseHL7DateToISO(parsed.pv1.dischargeDate) || undefined;
    admission.patient_class = parsed.pv1.patientClass || undefined;

    // Determine status from message type
    const msgType = parsed.msh.messageType || '';
    if (msgType.includes('A03')) {
      admission.status = 'DISCHARGED';
    } else if (msgType.includes('A01')) {
      admission.status = 'ADMITTED';
    } else if (msgType.includes('A02')) {
      admission.status = 'TRANSFERRED';
    }
  }

  return { admission, patient };
}

/**
 * Parse incoming ORM message and extract VH Health investigation order.
 * @param {string} hl7Message - Raw HL7v2 ORM message
 * @returns {Object} { order, patient } VH Health-shaped records
 */
export function parseORMToOrder(hl7Message) {
  const parsed = parseHL7(hl7Message);

  if (!parsed.msh) {
    throw new Error('Invalid HL7 message: missing MSH segment');
  }

  const patient = {};
  if (parsed.pid) {
    patient.uid = parsed.pid.patientId || undefined;
    patient.name = parsed.pid.name || undefined;
    patient.phone = parsed.pid.phone || undefined;
  }

  const order = {};
  if (parsed.obr) {
    order.placer_order_number = parsed.obr.placerOrderNumber || undefined;
    order.filler_order_number = parsed.obr.fillerOrderNumber || undefined;
    order.test_name = parsed.obr.testCode || undefined;
    order.ordered_at = parseHL7DateToISO(parsed.obr.orderDateTime) || undefined;
    order.status = mapOBRStatus(parsed.obr.resultStatus);
  }

  // Extract results from OBX segments
  if (parsed.obx && parsed.obx.length > 0) {
    order.results = parsed.obx.map((obx) => ({
      name: obx.observationId || '',
      value: obx.value || '',
      unit: obx.units || '',
      reference_range: obx.referenceRange || '',
      abnormal_flag: obx.abnormalFlag || '',
      status: obx.resultStatus || '',
    }));
  }

  return { order, patient };
}

// =============================================================================
// SEGMENT BUILDERS
// =============================================================================

function buildPID(patient) {
  if (!patient) return 'PID|||||||||||||||';
  const name = patient.name || '';
  const dob = formatHL7Date(patient.birthday) || '';
  const gender = mapGender(patient.gender);
  const address = patient.address || '';
  const phone = patient.phone || '';
  // PID|1||patientId||name||birthDate|gender|||address|||phone
  return `PID|||${patient.uid || ''}||${name}||${dob}|${gender}|||${address}|||${phone}`;
}

function buildPV1(admission, defaultClass) {
  if (!admission) return `PV1||${defaultClass || 'I'}`;
  const ward = admission.ward || '';
  const bed = admission.bed_number || '';
  const location = ward || bed ? `${ward}^${bed}` : '';
  const priority = admission.priority === 'emergent' ? 'E' : 'R';
  const doctor = admission.admitting_doctor || admission.attending_doctor || '';
  const encounterId = admission.encounter_id || admission.id || '';
  const admitDate = formatHL7Date(admission.admitted_at) || '';
  const dischargeDate = formatHL7Date(admission.discharged_at) || '';

  // PV1||class|location||priority|||doctor|||||||||||encounterId|||||||||||||||||admitDate|dischargeDate
  // Fields: PV1.2=patientClass, PV1.3=location, PV1.5=priority, PV1.7=attendingDoctor
  //         PV1.19=encounterId, PV1.44=admitDate, PV1.45=dischargeDate
  const fields = new Array(46).fill('');
  fields[0] = 'PV1';
  fields[2] = defaultClass || 'I';
  fields[3] = location;
  fields[5] = priority;
  fields[7] = doctor;
  fields[19] = String(encounterId);
  fields[44] = admitDate;
  fields[45] = dischargeDate;
  return fields.join('|');
}

function buildOBR(order) {
  if (!order) return 'OBR|1';
  const placerOrder = order.placer_order_number || order.id || '';
  const fillerOrder = order.filler_order_number || '';
  const testCode = order.test_name || order.investigation_type || '';
  const orderDate = formatHL7Date(order.ordered_at || order.created_at) || '';
  const resultStatus = order.status === 'COMPLETED' ? 'F' : (order.status === 'PENDING' ? 'O' : 'I');

  // OBR|1|placerOrderNum|fillerOrderNum|testCode|||orderDateTime||||||||||||||||||resultStatus
  const fields = new Array(26).fill('');
  fields[0] = 'OBR';
  fields[1] = '1';
  fields[2] = String(placerOrder);
  fields[3] = String(fillerOrder);
  fields[4] = testCode;
  fields[7] = orderDate;
  fields[25] = resultStatus;
  return fields.join('|');
}

function buildOBX(result, setId) {
  const valueType = result.value_type || 'ST';
  const obsId = result.name || result.observation_id || '';
  const value = result.value || '';
  const units = result.unit || result.units || '';
  const refRange = result.reference_range || '';
  const abnFlag = result.abnormal_flag || '';
  const status = result.status || 'F';

  // OBX|setId|valueType|observationId||value|units|referenceRange|abnormalFlag|||resultStatus
  const fields = new Array(12).fill('');
  fields[0] = 'OBX';
  fields[1] = String(setId || 1);
  fields[2] = valueType;
  fields[3] = obsId;
  fields[5] = String(value);
  fields[6] = units;
  fields[7] = refRange;
  fields[8] = abnFlag;
  fields[11] = status;
  return fields.join('|');
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Map VH Health gender to HL7v2 single-char code.
 * @param {string} gender
 * @returns {string} M, F, O, or U
 */
function mapGender(gender) {
  if (!gender) return 'U';
  const g = gender.toLowerCase().trim();
  if (g === 'male' || g === 'm') return 'M';
  if (g === 'female' || g === 'f') return 'F';
  if (g === 'other' || g === 'non-binary') return 'O';
  return 'U';
}

/**
 * Map HL7v2 gender code back to VH Health gender.
 * @param {string} code
 * @returns {string|null}
 */
function mapHL7Gender(code) {
  if (!code) return null;
  const map = { M: 'Male', F: 'Female', O: 'Other', U: null };
  return map[code.toUpperCase()] ?? null;
}

/**
 * Parse HL7v2 date (YYYYMMDD or YYYYMMDDHHMMSS) to ISO string.
 * @param {string} hl7Date
 * @returns {string|null}
 */
function parseHL7DateToISO(hl7Date) {
  if (!hl7Date || hl7Date.length < 8) return null;
  const year = hl7Date.slice(0, 4);
  const month = hl7Date.slice(4, 6);
  const day = hl7Date.slice(6, 8);
  const hour = hl7Date.slice(8, 10) || '00';
  const min = hl7Date.slice(10, 12) || '00';
  const sec = hl7Date.slice(12, 14) || '00';
  const d = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Map OBR result status code to VH Health investigation status.
 * @param {string} resultStatus
 * @returns {string}
 */
function mapOBRStatus(resultStatus) {
  if (!resultStatus) return 'PENDING';
  const map = {
    O: 'PENDING',       // Order received
    I: 'IN_PROGRESS',   // Pending, in-progress
    S: 'IN_PROGRESS',   // Partial results
    P: 'IN_PROGRESS',   // Preliminary
    A: 'IN_PROGRESS',   // Some, not all results
    F: 'COMPLETED',     // Final results
    C: 'COMPLETED',     // Correction to results
    X: 'CANCELLED',     // Cancelled
  };
  return map[resultStatus.toUpperCase()] || 'PENDING';
}

export default {
  admissionToADT,
  dischargeToADT,
  orderToORM,
  resultToORU,
  parseADTToAdmission,
  parseORMToOrder,
};
