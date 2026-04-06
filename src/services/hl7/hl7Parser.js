// src/services/hl7/hl7Parser.js
// Simple pipe-delimited HL7v2 parser — no external dependencies needed.
// HL7v2 messages are CR-delimited segments with pipe-separated fields.


// =============================================================================
// PARSE HL7v2
// =============================================================================

/**
 * Parse an HL7v2 message string into a structured object.
 * @param {string} message - Raw HL7v2 message (segments separated by \r or \n)
 * @returns {Object} Parsed message with typed segment accessors
 */
export function parseHL7(message) {
  if (!message || typeof message !== 'string') {
    throw new Error('HL7 message must be a non-empty string');
  }

  // HL7v2 uses \r as segment separator; also handle \n and \r\n
  const segments = message.trim().split(/\r\n|\r|\n/).filter(Boolean);
  const parsed = { segments: [] };

  for (const line of segments) {
    const fields = line.split('|');
    const segmentType = fields[0]; // MSH, PID, PV1, OBR, OBX, etc.
    parsed.segments.push({ type: segmentType, fields });

    if (segmentType === 'MSH') parsed.msh = parseMSH(fields);
    if (segmentType === 'PID') parsed.pid = parsePID(fields);
    if (segmentType === 'PV1') parsed.pv1 = parsePV1(fields);
    if (segmentType === 'OBR') parsed.obr = parseOBR(fields);
    if (segmentType === 'OBX') {
      if (!parsed.obx) parsed.obx = [];
      parsed.obx.push(parseOBX(fields));
    }
  }

  return parsed;
}

// =============================================================================
// SEGMENT PARSERS
// =============================================================================

function parseMSH(fields) {
  return {
    sendingApp: fields[2] || '',
    sendingFacility: fields[3] || '',
    receivingApp: fields[4] || '',
    receivingFacility: fields[5] || '',
    dateTime: fields[6] || '',
    messageType: fields[8] || '',
    messageControlId: fields[9] || '',
    processingId: fields[10] || '',
    version: fields[11] || '',
  };
}

function parsePID(fields) {
  return {
    patientId: fields[3] || '',
    name: fields[5] || '',
    birthDate: fields[7] || '',
    gender: fields[8] || '',
    address: fields[11] || '',
    phone: fields[13] || '',
  };
}

function parsePV1(fields) {
  return {
    patientClass: fields[2] || '',
    assignedLocation: fields[3] || '',
    attendingDoctor: fields[7] || '',
    admitDate: fields[44] || '',
    dischargeDate: fields[45] || '',
  };
}

function parseOBR(fields) {
  return {
    placerOrderNumber: fields[2] || '',
    fillerOrderNumber: fields[3] || '',
    testCode: fields[4] || '',
    orderDateTime: fields[7] || '',
    resultStatus: fields[25] || '',
  };
}

function parseOBX(fields) {
  return {
    valueType: fields[2] || '',
    observationId: fields[3] || '',
    value: fields[5] || '',
    units: fields[6] || '',
    referenceRange: fields[7] || '',
    abnormalFlag: fields[8] || '',
    resultStatus: fields[11] || '',
  };
}

// =============================================================================
// GENERATE HL7v2
// =============================================================================

/**
 * Generate an HL7v2 message from an array of segment strings.
 * @param {string} messageType - e.g. 'ADT^A01', 'ORM^O01', 'ORU^R01'
 * @param {Object} data - Structured data with segment arrays
 * @returns {string} HL7v2 message string (CR-delimited)
 */
export function generateHL7(messageType, data) {
  if (!data || !data.segments || !Array.isArray(data.segments)) {
    throw new Error('generateHL7 requires data.segments array');
  }

  return data.segments.join('\r');
}

// =============================================================================
// ACK GENERATOR
// =============================================================================

/**
 * Generate an HL7v2 ACK (acknowledgment) message.
 * @param {string} messageControlId - Original message control ID to acknowledge
 * @param {string} ackCode - AA (accept), AE (error), AR (reject)
 * @param {string} [textMessage] - Optional text message
 * @returns {string} HL7v2 ACK message
 */
export function generateACK(messageControlId, ackCode, textMessage) {
  const now = formatHL7Date(new Date());
  const ackControlId = generateControlId();
  const segments = [
    `MSH|^~\\&|VHHEALTH|VH_HOSPITALS||EXTERNAL|${now}||ACK|${ackControlId}|P|2.5`,
    `MSA|${ackCode}|${messageControlId}|${textMessage || ''}`,
  ];
  return segments.join('\r');
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format a Date to HL7v2 datetime (YYYYMMDDHHMMSS).
 * @param {Date|string} date
 * @returns {string}
 */
export function formatHL7Date(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Generate a unique message control ID.
 * @returns {string}
 */
export function generateControlId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `VH${ts}${rand}`.toUpperCase();
}

export default {
  parseHL7,
  generateHL7,
  generateACK,
  formatHL7Date,
  generateControlId,
};
