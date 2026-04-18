// src/services/billing/ediGenerator.js
//
// X12 837P Professional Claim generator.
//
// This is a *minimum-viable* 837P: enough structure to parse against a generic
// EDI parser and demonstrate the envelope/loop shape, not payer-ready. A full
// payer-specific implementation needs:
//   * Payer-specific "companion guides" (each insurer requires different
//     optional segments / qualifiers).
//   * NPI, tax ID, and tax-ID-qualifier validation.
//   * Multi-service-line claims + adjustments / COB.
//   * Validation against the X12 implementation guide (TR3).
//
// The shape below covers the structural required segments so downstream
// payer-specific layers can slot in extensions without reshaping the core.

const ISA_DELIMITER = '*';
const SEGMENT_TERMINATOR = '~';
const ELEMENT_SUB_SEPARATOR = ':';

function seg(...parts) {
  return parts.join(ISA_DELIMITER) + SEGMENT_TERMINATOR;
}

function pad(s, n, ch = ' ', align = 'left') {
  s = String(s ?? '');
  if (s.length >= n) return s.slice(0, n);
  return align === 'right' ? s.padStart(n, ch) : s.padEnd(n, ch);
}

function ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.toISOString().slice(0, 10).replace(/-/g, '');
}

function hhmm(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${String(x.getUTCHours()).padStart(2, '0')}${String(x.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Build an 837P Professional claim envelope for a single invoice.
 *
 * @param {object} input
 * @param {object} input.submitter    { name, id, contactName?, contactPhone? }
 * @param {object} input.receiver     { name, id }
 * @param {object} input.billingProvider { name, npi, taxId, address }
 * @param {object} input.subscriber   { firstName, lastName, memberId, dob, gender, payerId }
 * @param {object} input.patient      { firstName, lastName, dob, gender, address } — optional if same as subscriber
 * @param {object} input.claim        { id, total, serviceDate, diagnoses: [{ icd10 }], services: [{ cpt, charge, units?, diagnosisPointers? }] }
 * @returns {string} 837P EDI text
 */
export function build837P({
  submitter,
  receiver,
  billingProvider,
  subscriber,
  patient,
  claim,
}) {
  const now = new Date();
  const dateStr = ymd(now).slice(2); // YYMMDD for ISA
  const fullDateStr = ymd(now);
  const timeStr = hhmm(now);
  const ctrlNumber = String(Date.now()).slice(-9).padStart(9, '0');

  const lines = [];

  // ── ISA — interchange envelope ──
  lines.push(seg(
    'ISA',
    '00',                      // authorization qualifier
    pad('', 10),               // authorization info
    '00',                      // security qualifier
    pad('', 10),               // security info
    'ZZ',                      // sender ID qualifier
    pad(submitter.id, 15),     // sender ID
    'ZZ',                      // receiver ID qualifier
    pad(receiver.id, 15),      // receiver ID
    dateStr,                   // date YYMMDD
    timeStr,                   // time HHMM
    '^',                       // repetition separator
    '00501',                   // version
    ctrlNumber,                // interchange control number
    '0',                       // ack requested
    'P',                       // usage indicator (Production)
    ELEMENT_SUB_SEPARATOR,
  ));

  // ── GS — functional group ──
  lines.push(seg('GS', 'HC', submitter.id, receiver.id, fullDateStr, timeStr, '1', 'X', '005010X222A1'));

  // ── ST — transaction set ──
  lines.push(seg('ST', '837', '0001', '005010X222A1'));
  lines.push(seg('BHT', '0019', '00', `BHT-${claim.id}`, fullDateStr, timeStr, 'CH'));

  // ── Submitter / receiver ──
  lines.push(seg('NM1', '41', '2', submitter.name, '', '', '', '', '46', submitter.id));
  if (submitter.contactName || submitter.contactPhone) {
    lines.push(seg('PER', 'IC', submitter.contactName || '', 'TE', submitter.contactPhone || ''));
  }
  lines.push(seg('NM1', '40', '2', receiver.name, '', '', '', '', '46', receiver.id));

  // ── HL*1 Billing provider ──
  lines.push(seg('HL', '1', '', '20', '1'));
  lines.push(seg('PRV', 'BI', 'PXC', '207Q00000X'));
  lines.push(seg('NM1', '85', '2', billingProvider.name, '', '', '', '', 'XX', billingProvider.npi));
  if (billingProvider.address) {
    lines.push(seg('N3', billingProvider.address.line1 || ''));
    lines.push(seg('N4', billingProvider.address.city || '', billingProvider.address.state || '', billingProvider.address.postalCode || ''));
  }
  lines.push(seg('REF', 'EI', billingProvider.taxId));

  // ── HL*2 Subscriber ──
  lines.push(seg('HL', '2', '1', '22', '0'));
  lines.push(seg('SBR', 'P', '18', '', '', '', '', '', '', 'CI'));
  lines.push(seg(
    'NM1', 'IL', '1',
    subscriber.lastName, subscriber.firstName, '', '', '',
    'MI', subscriber.memberId,
  ));
  lines.push(seg('DMG', 'D8', ymd(subscriber.dob), subscriber.gender));
  lines.push(seg('NM1', 'PR', '2', receiver.name, '', '', '', '', 'PI', subscriber.payerId));

  // ── CLM claim ──
  const svcDate = ymd(claim.serviceDate);
  lines.push(seg('CLM', String(claim.id), claim.total.toFixed(2), '', '', '11:B:1', 'Y', 'A', 'Y', 'Y'));

  // HI diagnoses — principal = ABK, secondary = ABF
  const dxSegments = (claim.diagnoses || []).map((d, i) => {
    const qual = i === 0 ? 'ABK' : 'ABF';
    return `${qual}${ELEMENT_SUB_SEPARATOR}${(d.icd10 || '').replace(/\./g, '')}`;
  });
  if (dxSegments.length > 0) {
    lines.push(seg('HI', ...dxSegments));
  }

  // Service lines
  (claim.services || []).forEach((svc, idx) => {
    lines.push(seg('LX', String(idx + 1)));
    const dxPointers = (svc.diagnosisPointers || [1]).join(ELEMENT_SUB_SEPARATOR);
    lines.push(seg(
      'SV1',
      `HC${ELEMENT_SUB_SEPARATOR}${svc.cpt}`,
      svc.charge.toFixed(2),
      'UN',
      String(svc.units ?? 1),
      '',
      '',
      dxPointers,
    ));
    lines.push(seg('DTP', '472', 'D8', svcDate));
  });

  // ── SE — end of transaction set ──
  // Count = all segments between ST and SE inclusive. We emitted ST at index N
  // so walk forward and count.
  const stIndex = lines.findIndex((l) => l.startsWith('ST*'));
  const segCountSoFar = lines.length - stIndex + 1; // +1 for the SE we're adding
  lines.push(seg('SE', String(segCountSoFar), '0001'));

  // ── GE / IEA envelopes ──
  lines.push(seg('GE', '1', '1'));
  lines.push(seg('IEA', '1', ctrlNumber));

  return lines.join('');
}

export default { build837P };
