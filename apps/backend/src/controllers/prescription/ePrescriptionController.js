// src/controllers/prescription/ePrescriptionController.js
// E-Prescription system — structured prescription entry, PDF generation, auto-pharmacy order

import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import {
  ensureEncounterForAppointment,
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
} from '../../services/clinical/canonicalClinicalPlatformService.js';
import { maybePropagateAncSupplements } from '../../services/maternity/maternityService.js';
import { createPrescriptionReminders } from '../../services/patient/medicationReminderService.js';
import { dispatch } from '../../utils/notifications/notificationDispatcher.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
import { formatTemperatureForDisplay } from '../../services/prescription/prescriptionPdfHelper.js';
import { success, error } from '../../utils/responseHelper.js';
import { logAudit } from '../../utils/logAudit.js';

// ─── Frequency label map ─────────────────────────────────────────────────────
const FREQ_LABELS = {
  OD: 'Once daily',
  BD: 'Twice daily',
  TDS: 'Three times daily',
  QID: 'Four times daily',
  SOS: 'As needed (SOS)',
  HS: 'At bedtime',
  STAT: 'Immediately'
};

// Visit-type discriminator on e_prescriptions (migration 229). An IPD
// prescription carries 'inpatient' so the pharmacy queue / nursing MAR
// can split it from OPD scripts; everything else is 'outpatient'.
const VALID_VISIT_TYPES = ['outpatient', 'inpatient'];
const TERMINAL_PRESCRIPTION_STATUSES = new Set(['fulfilled', 'cancelled', 'canceled']);
const PRIVILEGED_PRESCRIPTION_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

async function bestEffortPrescriptionCanonical(label, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`Canonical prescription event failed during ${label}: ${err?.message || err}`);
    return null;
  }
}

function parseJsonField(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function catalogSelectionKey(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim().toLowerCase();
}

function collectCatalogSelections(body = {}) {
  const selections = new Map();
  const put = (key, catalogId) => {
    const normalizedKey = catalogSelectionKey(key);
    const id = Number.parseInt(catalogId, 10);
    if (normalizedKey && Number.isInteger(id) && id > 0) {
      selections.set(normalizedKey, id);
    }
  };

  if (body.catalog_id) put('0', body.catalog_id);

  for (const source of [
    body.catalog_overrides,
    body.catalogOverrides,
    body.catalog_selections,
    body.catalogSelections,
    body.items,
    body.medications
  ]) {
    if (!source) continue;
    if (Array.isArray(source)) {
      source.forEach((item, index) => {
        if (!item || typeof item !== 'object') return;
        const id = item.catalog_id ?? item.catalogId ?? item.id;
        put(index, id);
        put(item.name ?? item.medication_name ?? item.drug_name, id);
      });
      continue;
    }
    if (typeof source === 'object') {
      for (const [key, value] of Object.entries(source)) {
        const id =
          value && typeof value === 'object'
            ? (value.catalog_id ?? value.catalogId ?? value.id)
            : value;
        put(key, id);
      }
    }
  }

  return selections;
}

function findCatalogSelection(selections, med, medName, index) {
  for (const key of [index, medName, med?.name, med?.medication_name, med?.drug_name]) {
    const normalizedKey = catalogSelectionKey(key);
    if (normalizedKey && selections.has(normalizedKey)) {
      return selections.get(normalizedKey);
    }
  }
  return null;
}

function parseMlFromText(...values) {
  for (const value of values) {
    let last = null;
    for (const match of String(value || '').matchAll(/(\d+(?:\.\d+)?)\s*m\s*l\b/gi)) {
      last = match[1];
    }
    if (last) {
      const ml = Number.parseFloat(last);
      if (Number.isFinite(ml) && ml > 0) return ml;
    }
  }
  return null;
}

function parseWeightKgFromText(...values) {
  for (const value of values) {
    const s = String(value || '');
    // Prefer an explicit "weight:"/"wt:" prefixed figure when present.
    const prefixed = s.match(/(?:weight|wt)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*kg\b/i);
    if (prefixed) {
      const kg = Number.parseFloat(prefixed[1]);
      if (Number.isFinite(kg) && kg > 0) return kg;
    }
    // Otherwise accept the common clinician phrasings that omit the keyword:
    // "for 12.5kg child", "in a 12 kg infant", "12kg toddler". A bare "12 kg"
    // anywhere in the dose/instruction text is, in a pediatric liquid context,
    // the child's weight — but we anchor on a paediatric noun OR a leading
    // "for/in a" so an unrelated "60 kg bag" style token can't be misread.
    // Finding: 2026-05-22-pediatric-opd-pharmacy-f346bf82.
    const contextual = s.match(
      /(?:for|in)\s*(?:a|an)?\s*(\d+(?:\.\d+)?)\s*kg\b|(\d+(?:\.\d+)?)\s*kg\s*(?:child|infant|baby|toddler|neonate|kid|paediatric|pediatric|patient)/i
    );
    if (contextual) {
      const kg = Number.parseFloat(contextual[1] ?? contextual[2]);
      if (Number.isFinite(kg) && kg > 0) return kg;
    }
  }
  return null;
}

function defaultMeasuringInstruction(ml) {
  if (!Number.isFinite(ml) || ml <= 0) return null;
  return `Measure ${ml} ml using an oral syringe or marked medicine cup; do not use a household spoon.`;
}

// Dosage-form classification for the dispense label. A liquid (mL-dosed)
// oral form — syrup/suspension/solution/elixir/drops/liquid, or anything
// carrying an explicit mg/mL concentration — is the ONLY form for which a
// "measure X ml with an oral syringe" instruction or an mL dose-conversion
// warning is appropriate. A solid oral form (tablet/capsule/etc.) must never
// receive that wording. Returns true (liquid), false (solid), or null (no
// form signal at all). Pure — no DB. Finding: 2026-05-21-walk-in-opd-pharmacy-1646bc24.
const LIQUID_FORM_RE =
  /\b(syrup|suspension|solution|soln|elixir|drops?|liquid|oral\s*liquid|tonic|emulsion|mixture|sachet|syr\b)/i;
const SOLID_FORM_RE =
  /\b(tab(?:let)?s?|cap(?:sule)?s?|pill|caplet|chewable|lozenge|troche|powder|granules?|sachet\s*powder|patch|suppositor(?:y|ies)|pessar(?:y|ies)|cream|ointment|gel|inhaler|puff|spray|drops?\s*\(eye\))/i;

export function isLiquidForm(...values) {
  let sawSolid = false;
  for (const value of values) {
    const s = String(value || '');
    if (!s) continue;
    // An explicit mg/mL concentration is an unambiguous liquid signal and
    // wins over any incidental solid token (e.g. "Paracetamol Syrup tab-free").
    if (parseConcentrationMgPerMl(s) != null) return true;
    if (LIQUID_FORM_RE.test(s)) return true;
    if (SOLID_FORM_RE.test(s)) sawSolid = true;
  }
  return sawSolid ? false : null;
}

// Doses-per-day from a frequency expression. Handles dash patterns
// ("1-1-1" → 3, "1-0-1" → 2, "1-1-1-1" → 4), the FREQ_LABELS codes
// (OD/BD/TDS/QID/HS), and a few common longhand forms. SOS / PRN have no
// fixed daily count → null (the pharmacist must set the quantity). Pure.
function parseDailyDoseCount(frequency) {
  const raw = String(frequency || '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  // PRN / SOS: dose is as-needed, no derivable daily count.
  if (/\b(SOS|PRN|AS\s*NEEDED|STAT)\b/.test(upper)) return null;
  // Dash pattern like 1-1-1 / 1-0-1 / 0-0-1 / 1-1-1-1: sum the slots.
  const dash = raw.match(/^\s*\d+(?:\s*-\s*\d+)+\s*$/);
  if (dash) {
    const total = raw.split('-').reduce((sum, part) => sum + (Number.parseInt(part, 10) || 0), 0);
    return total > 0 ? total : null;
  }
  const codeMap = { OD: 1, HS: 1, BD: 2, BID: 2, TDS: 3, TID: 3, QID: 4, QDS: 4 };
  const codeMatch = upper.match(/\b(OD|HS|BD|BID|TDS|TID|QID|QDS)\b/);
  if (codeMatch) return codeMap[codeMatch[1]];
  // "3 times a day" / "twice daily" / "once daily" longhand.
  if (/\bONCE\b/.test(upper)) return 1;
  if (/\bTWICE\b/.test(upper)) return 2;
  if (/\bTHRICE\b/.test(upper)) return 3;
  const timesMatch = upper.match(/(\d+)\s*(?:TIMES?|X)\s*(?:A|PER)?\s*DAY/);
  if (timesMatch) {
    const n = Number.parseInt(timesMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

// Number of days from a duration expression. "3 days" → 3, "1 week" → 7,
// "2 weeks" → 14, "5" (bare) → 5. Pure; null when unparseable.
function parseDurationDays(duration) {
  const raw = String(duration || '').trim();
  if (!raw) return null;
  const weeks = raw.match(/(\d+(?:\.\d+)?)\s*(?:weeks?|wks?|wk)\b/i);
  if (weeks) {
    const n = Number.parseFloat(weeks[1]);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 7) : null;
  }
  const days = raw.match(/(\d+(?:\.\d+)?)\s*(?:days?|d)\b/i);
  if (days) {
    const n = Number.parseFloat(days[1]);
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  }
  const bare = raw.match(/^\s*(\d+)\s*$/);
  if (bare) {
    const n = Number.parseInt(bare[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

// Derive the total dispense quantity for a count-dosed (solid oral) line from
// its frequency and duration: doses/day × days × units/dose (units/dose
// defaults to 1). Returns a positive integer, or null when either factor is
// unparseable (e.g. SOS frequency, free-text duration) so the caller can
// flag the line for an explicit pharmacist quantity rather than guessing.
// Pure — no DB. Finding: 2026-05-21-walk-in-opd-pharmacy-1646bc24.
export function deriveDispenseQuantity({ frequency, duration, unitsPerDose = 1 } = {}) {
  const perDay = parseDailyDoseCount(frequency);
  const days = parseDurationDays(duration);
  if (perDay == null || days == null) return null;
  const units = Number(unitsPerDose);
  const perDoseUnits = Number.isFinite(units) && units > 0 ? units : 1;
  const total = Math.ceil(perDay * days * perDoseUnits);
  return total > 0 ? total : null;
}

// Extract mg/mL concentration ratio from a medication name or strength string.
// Matches patterns like "250mg/5mL", "125 mg / 5 ml", "500mg/10ml".
// Returns mg-per-mL as a number, or null if unparseable.
function parseConcentrationMgPerMl(...values) {
  for (const value of values) {
    const match = String(value || '').match(
      /(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)\s*m[lL]\b/i
    );
    if (match) {
      const mg = Number.parseFloat(match[1]);
      const ml = Number.parseFloat(match[2]);
      if (Number.isFinite(mg) && mg > 0 && Number.isFinite(ml) && ml > 0) {
        return mg / ml;
      }
    }
  }
  return null;
}

// The mL denominator of a "mg/mL" concentration (the `5` in "125mg/5ml").
// Used to distinguish a concentration's own volume from the prescribed dose
// volume so the latter is never mistaken for the former on the label.
// Finding: 2026-05-22-pediatric-opd-pharmacy-f346bf82.
function parseConcentrationMl(...values) {
  for (const value of values) {
    const match = String(value || '').match(
      /(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)\s*m[lL]\b/i
    );
    if (match) {
      const ml = Number.parseFloat(match[2]);
      if (Number.isFinite(ml) && ml > 0) return ml;
    }
  }
  return null;
}

function parseIntegerField(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : NaN;
}

function normalizeRole(role) {
  return String(role || '').toUpperCase();
}

function normalizeMedicationList(value) {
  const parsed = parseJsonField(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function isPrescriptionOwner(req, rx) {
  const role = normalizeRole(req.user?.role);
  if (PRIVILEGED_PRESCRIPTION_ROLES.has(role)) return true;
  if (role !== 'DOCTOR') return false;
  const actorId = req.user?.id ?? req.user?.userId;
  const actorUid = req.user?.uid;
  return (
    (actorId != null && rx?.doctor_id != null && String(actorId) === String(rx.doctor_id)) ||
    (actorUid && rx?.doctor_uid && String(actorUid) === String(rx.doctor_uid))
  );
}

function assertPrescriptionEditable(req, rx) {
  if (!rx) return 'Prescription not found';
  if (!isPrescriptionOwner(req, rx))
    return 'Only the prescribing doctor or Admin/SuperAdmin can edit this prescription';
  if (
    rx.signed_at ||
    rx.locked_at ||
    String(rx.lifecycle_status || '').toLowerCase() === 'signed'
  ) {
    return 'Prescription is signed and locked';
  }
  if (
    rx.pharmacy_opted ||
    rx.pharmacy_order_id ||
    String(rx.status || '').toLowerCase() === 'pharmacy_linked'
  ) {
    return 'Prescription has already been sent to pharmacy and cannot be edited';
  }
  if (TERMINAL_PRESCRIPTION_STATUSES.has(String(rx.status || '').toLowerCase())) {
    return 'Prescription is in a terminal status and cannot be edited';
  }
  return null;
}

function assertPrescriptionSignable(req, rx) {
  if (!rx) return 'Prescription not found';
  if (!isPrescriptionOwner(req, rx))
    return 'Only the prescribing doctor or Admin/SuperAdmin can sign this prescription';
  if (
    rx.signed_at ||
    rx.locked_at ||
    String(rx.lifecycle_status || '').toLowerCase() === 'signed'
  ) {
    return 'Prescription is already signed';
  }
  if (TERMINAL_PRESCRIPTION_STATUSES.has(String(rx.status || '').toLowerCase())) {
    return 'Prescription is in a terminal status and cannot be signed';
  }
  return null;
}

async function loadPrescriptionRow(id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM e_prescriptions WHERE id = $1`, id);
  return rows[0] || null;
}

async function regeneratePrescriptionPdf(req, prescription) {
  if (!prescription?.id) return prescription;
  const [patientRes, doctorRes] = await Promise.all([
    prisma.$queryRawUnsafe(
      'SELECT id, name, phone, gender, birthday, weight_kg FROM users WHERE id=$1',
      prescription.patient_id
    ),
    prisma.$queryRawUnsafe(
      `SELECT u.id, u.name, u.phone, d.specialty AS specialization, NULL::text AS qualification
              FROM users u LEFT JOIN doctors d ON d.user_id = u.id
              WHERE u.id=$1`,
      prescription.doctor_id
    )
  ]);
  const patient = patientRes[0] || {};
  const doctor = doctorRes[0] || {};
  const pdfBuffer = await generatePrescriptionPDF(prescription, patient, doctor);
  const pdfKey = `prescriptions/pdf/${prescription.prescription_number || `RX-${prescription.id}`}-rev${prescription.revision || 1}.pdf`;
  await uploadFileToR2(pdfBuffer, pdfKey, 'application/pdf');
  await prisma.$queryRawUnsafe(
    'UPDATE e_prescriptions SET pdf_key=$1 WHERE id=$2',
    pdfKey,
    prescription.id
  );
  prescription.pdf_key = pdfKey;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    prescription.pdf_url = await getSignedFileUrl(pdfKey, 3600, { baseUrl });
  } catch (signedErr) {
    logger.warn(`Prescription PDF signed URL failed for ${prescription.id}: ${signedErr.message}`);
  }
  return prescription;
}

// Extract a per-kg dose rate (mg/kg) from a dose / strength string. Matches
// "15 mg/kg", "10mg/kg/dose", "7.5 mg / kg" — but deliberately NOT "mg/mL"
// (\bkg\b anchors it to a kilogram denominator). Returns mg-per-kg or null.
function parseMgPerKg(...values) {
  for (const value of values) {
    const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*mg\s*\/\s*kg\b/i);
    if (match) {
      const mgPerKg = Number.parseFloat(match[1]);
      if (Number.isFinite(mgPerKg) && mgPerKg > 0) return mgPerKg;
    }
  }
  return null;
}

// Compute the weight-based dose for a pediatric prescription line. When the
// dose text encodes a mg/kg rate and a positive weight is known, returns the
// explicit calculation { mgPerKg, weightKg, totalMg } so the Rx PDF can show
// "15 mg/kg × 12 kg = 180 mg" — the figure a parent/pharmacist needs to
// verify a child's actual dose. Returns null when no per-kg rate is present
// or the weight is unknown. Pure + exported for unit testing.
// Finding 2026-05-21-pediatric-opd-patient-ffea3aba.
export function computeWeightBasedDose(doseText, weightKg) {
  const mgPerKg = parseMgPerKg(doseText);
  const kg = Number(weightKg);
  if (mgPerKg == null || !Number.isFinite(kg) || kg <= 0) return null;
  const totalMg = Math.round(mgPerKg * kg * 100) / 100;
  return { mgPerKg, weightKg: kg, totalMg };
}

// Derive the per-dose VOLUME (mL) for a pediatric liquid line — the figure
// that goes on the dispense label ("Measure X ml"). This is the safety-
// critical companion to computeWeightBasedDose: paracetamol et al. are dosed
// by weight, so the label volume must be weight-derived, NOT lifted from the
// concentration denominator.
//
// The previous order-pharmacy code used parseMlFromText(), which returns the
// LAST "<n> ml" token in the text. For a real clinician string like
// "187.5mg = 7.5ml of 125mg/5ml syrup" that last token is the concentration's
// `5ml`, so a 12.5 kg child was labelled to receive a flat 5 mL regardless of
// weight — a ~33% underdose of a fever medication. Finding:
//   2026-05-22-pediatric-opd-pharmacy-f346bf82.
//
// Resolution order (first that yields a positive volume wins):
//   1. weight-based: (mg/kg × weightKg) ÷ concentrationMgPerMl  — the
//      clinically-correct volume, used when both a mg/kg rate and a
//      concentration are known. This is independent of the free-text ml.
//   2. mg→ml: an explicit "<n> mg" dose ÷ concentration — honours a clinician
//      who wrote the absolute mg dose (e.g. "187.5 mg") even without a rate.
//   3. text ml that is NOT the concentration denominator: the first "<n> ml"
//      token whose value differs from the concentration's own mL figure, so
//      "7.5ml ... 125mg/5ml" yields 7.5, never the trailing 5.
// Returns { ml, source, ... } or null. Pure + exported for unit testing.
const CONCENTRATION_TOKEN_RE = /(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)\s*m[lL]\b/gi;

export function deriveLiquidDoseMl({
  doseText = '',
  instructionText = '',
  concentrationMgPerMl = null,
  concentrationMl = null,
  weightKg = null
} = {}) {
  const conc = Number(concentrationMgPerMl);
  const hasConc = Number.isFinite(conc) && conc > 0;
  const round2 = n => Math.round(n * 100) / 100;

  // Strip the "mg/mL" concentration token(s) out of the dose/instruction text
  // before scanning for the absolute mg dose or the dose mL. In a string like
  // "Syrup 250 mg/5 mL: 3.75 mL" the "250 mg" and "5 mL" are the STRENGTH, and
  // only the standalone "3.75 mL" is the dose; likewise "187.5mg = 7.5ml of
  // 125mg/5ml" has the dose mg/ml first and the strength last. Removing the
  // concentration substring leaves only dose-bearing tokens.
  const stripConc = s => String(s || '').replace(CONCENTRATION_TOKEN_RE, ' ');
  const doseNoConc = stripConc(doseText);

  // 1. Weight-based — the authoritative path. (mg/kg × weight) ÷ concentration.
  const mgPerKg = parseMgPerKg(doseText, instructionText);
  const kg = Number(weightKg);
  if (mgPerKg != null && Number.isFinite(kg) && kg > 0 && hasConc) {
    const totalMg = mgPerKg * kg;
    const ml = round2(totalMg / conc);
    if (Number.isFinite(ml) && ml > 0) {
      return { ml, source: 'weight_based', totalMg: round2(totalMg), mgPerKg, weightKg: kg };
    }
  }

  // 2. Explicit absolute mg dose ÷ concentration. Scan the concentration-
  //    stripped text so the strength's own mg numerator can't be mistaken for
  //    the dose. First remaining mg token is the prescribed dose.
  if (hasConc) {
    const mgMatch = doseNoConc.match(/(\d+(?:\.\d+)?)\s*mg\b/i);
    if (mgMatch) {
      const mg = Number.parseFloat(mgMatch[1]);
      if (Number.isFinite(mg) && mg > 0) {
        const ml = round2(mg / conc);
        if (Number.isFinite(ml) && ml > 0) {
          return { ml, source: 'mg_per_concentration', totalMg: round2(mg) };
        }
      }
    }
  }

  // 3. A free-text "<n> ml" dose token. Scan the concentration-stripped text
  //    so the concentration's own mL denominator is never a candidate; as a
  //    belt-and-braces guard also drop any token equal to concentrationMl.
  //    Take the first remaining (the dose volume the clinician wrote).
  const concMl = Number(concentrationMl);
  const hasConcMl = Number.isFinite(concMl) && concMl > 0;
  for (const value of [doseNoConc, stripConc(instructionText)]) {
    const tokens = [];
    for (const match of String(value || '').matchAll(/(\d+(?:\.\d+)?)\s*m\s*l\b/gi)) {
      const ml = Number.parseFloat(match[1]);
      if (Number.isFinite(ml) && ml > 0) tokens.push(ml);
    }
    const candidate = tokens.find(ml => !hasConcMl || Math.abs(ml - concMl) > 0.001);
    if (candidate != null) {
      return { ml: round2(candidate), source: 'dose_text_ml' };
    }
  }

  return null;
}

// ─── PDF Generation ──────────────────────────────────────────────────────────
async function generatePrescriptionPDF(prescription, patient, doctor) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      size: 'A4'
    });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const leftX = 40;
    const pageWidth = 515;

    // ─── Header ──────────────────────────────────────────────────────────
    doc.rect(leftX, 30, pageWidth, 55).fill('#007A64');
    doc
      .fillColor('white')
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('VENKATAESWARA HOSPITALS', leftX + 10, 38, { align: 'center', width: pageWidth });
    doc
      .fontSize(8)
      .font('Helvetica')
      .text('Nandanam, Chennai – 600 035 | Tel: 044-24334455', leftX + 10, 58, {
        align: 'center',
        width: pageWidth
      });

    // ─── Rx Title ────────────────────────────────────────────────────────
    doc.fillColor('#007A64').fontSize(22).font('Helvetica-Bold').text('℞', leftX, 100);
    doc
      .fillColor('#333')
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('PRESCRIPTION', leftX + 30, 104);
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(prescription.prescription_number, leftX + 140, 104);

    const prescDate = new Date(prescription.created_at).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
    doc.text(`Date: ${prescDate}`, leftX + pageWidth - 150, 104, { width: 150, align: 'right' });

    // ─── Divider ─────────────────────────────────────────────────────────
    doc
      .moveTo(leftX, 125)
      .lineTo(leftX + pageWidth, 125)
      .stroke('#007A64');

    // ─── Patient Info ────────────────────────────────────────────────────
    let y = 135;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#333');
    doc.text('Patient:', leftX, y);
    doc.font('Helvetica').text(patient.name || 'N/A', leftX + 55, y);

    doc.font('Helvetica-Bold').text('Age/Gender:', leftX + 250, y);
    const age = patient.birthday
      ? Math.floor(
          (Date.now() - new Date(patient.birthday).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
        )
      : '-';
    const gender = patient.gender ? patient.gender.charAt(0).toUpperCase() : '-';
    doc.font('Helvetica').text(`${age} / ${gender}`, leftX + 320, y);

    y += 16;
    doc.font('Helvetica-Bold').text('Phone:', leftX, y);
    doc.font('Helvetica').text(patient.phone || '-', leftX + 55, y);

    // Patient weight drives pediatric (mg/kg) dosing — prefer the
    // visit-recorded vital, fall back to the registered weight. Surfaced
    // here so the weight-based dose calc below is verifiable.
    // Finding 2026-05-21-pediatric-opd-patient-ffea3aba.
    const patientWeightKg =
      Number(prescription?.vitals?.weight) || Number(patient?.weight_kg) || null;
    if (patientWeightKg) {
      doc.font('Helvetica-Bold').text('Weight:', leftX + 250, y);
      doc.font('Helvetica').text(`${patientWeightKg} kg`, leftX + 320, y);
    }

    // ─── Doctor Info ─────────────────────────────────────────────────────
    y += 16;
    doc.font('Helvetica-Bold').text('Doctor:', leftX, y);
    doc.font('Helvetica').text(doctor.name || 'N/A', leftX + 55, y);
    if (doctor.specialization) {
      doc.font('Helvetica-Bold').text('Specialization:', leftX + 250, y);
      doc.font('Helvetica').text(doctor.specialization, leftX + 340, y);
    }

    if (doctor.qualification) {
      y += 16;
      doc.font('Helvetica-Bold').text('Qualification:', leftX, y);
      doc.font('Helvetica').text(doctor.qualification, leftX + 80, y);
    }

    // ─── Divider ─────────────────────────────────────────────────────────
    y += 20;
    doc
      .moveTo(leftX, y)
      .lineTo(leftX + pageWidth, y)
      .stroke('#ddd');

    // ─── Diagnosis ───────────────────────────────────────────────────────
    if (prescription.diagnosis) {
      y += 10;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Diagnosis:', leftX, y);
      y += 14;
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#333')
        .text(prescription.diagnosis, leftX, y, { width: pageWidth });
      y += doc.heightOfString(prescription.diagnosis, { width: pageWidth }) + 8;
    }

    // ─── Vitals ──────────────────────────────────────────────────────────
    const vitals = prescription.vitals;
    if (vitals && Object.keys(vitals).length > 0) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Vitals:', leftX, y);
      y += 14;
      const vitalParts = [];
      if (vitals.bp_systolic && vitals.bp_diastolic)
        vitalParts.push(`BP: ${vitals.bp_systolic}/${vitals.bp_diastolic} mmHg`);
      if (vitals.pulse) vitalParts.push(`Pulse: ${vitals.pulse} bpm`);
      const tempDisplay = formatTemperatureForDisplay(vitals.temperature, vitals.temperature_unit);
      if (tempDisplay) vitalParts.push(`Temp: ${tempDisplay}`);
      if (vitals.spo2) vitalParts.push(`SpO2: ${vitals.spo2}%`);
      if (vitals.weight) vitalParts.push(`Weight: ${vitals.weight} kg`);
      if (vitals.blood_sugar) vitalParts.push(`Blood Sugar: ${vitals.blood_sugar} mg/dL`);
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#333')
        .text(vitalParts.join('  |  '), leftX, y, { width: pageWidth });
      y += 18;
    }

    // ─── Medications Table ───────────────────────────────────────────────
    y += 5;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Medications:', leftX, y);
    y += 16;

    const medications = prescription.medications || [];
    if (medications.length > 0) {
      // Table header
      const colWidths = [25, 140, 55, 70, 60, 50, 115];
      const headers = ['#', 'Medicine', 'Dosage', 'Frequency', 'Duration', 'Route', 'Instructions'];

      doc.rect(leftX, y, pageWidth, 16).fill('#007A64');
      doc.fillColor('white').fontSize(7).font('Helvetica-Bold');
      let cx = leftX + 3;
      headers.forEach((h, i) => {
        doc.text(h, cx, y + 4, { width: colWidths[i] });
        cx += colWidths[i];
      });
      y += 16;

      // Table rows
      medications.forEach((med, idx) => {
        // Check if we need a new page
        if (y > 720) {
          doc.addPage();
          y = 40;
        }

        const bgColor = idx % 2 === 0 ? '#f8f8f8' : '#ffffff';
        const rowHeight = 24;
        doc.rect(leftX, y, pageWidth, rowHeight).fill(bgColor);

        doc.fillColor('#333').fontSize(7).font('Helvetica');
        cx = leftX + 3;
        const doseSlots =
          Array.isArray(med.dose_times) && med.dose_times.length
            ? ` (${med.dose_times.map(slot => String(slot).charAt(0).toUpperCase()).join('/')})`
            : '';
        const instructionParts = [med.food_timing || null, med.instructions || null].filter(
          Boolean
        );
        const rowData = [
          `${idx + 1}`,
          `${med.display_name || med.displayName || med.name}${med.generic_name ? ` (${med.generic_name})` : ''}`,
          med.dosage || '-',
          `${FREQ_LABELS[med.frequency] || med.frequency || '-'}${doseSlots}`,
          med.duration || '-',
          med.route || 'Oral',
          instructionParts.join('; ') || '-'
        ];
        rowData.forEach((val, i) => {
          doc.text(val, cx, y + 5, { width: colWidths[i], lineBreak: false });
          cx += colWidths[i];
        });
        y += rowHeight;
      });

      // Bottom border
      doc
        .moveTo(leftX, y)
        .lineTo(leftX + pageWidth, y)
        .stroke('#ddd');

      // ─── Weight-based dosing (pediatric) ───────────────────────────────
      // Pediatric lines are dosed per kg (e.g. "15 mg/kg"); the table shows
      // only the rate, so a parent/pharmacist could not verify the child's
      // actual dose. For each line whose dose encodes a mg/kg rate, show the
      // explicit calculation against the patient's (or that line's) weight.
      // Finding 2026-05-21-pediatric-opd-patient-ffea3aba.
      const weightDoseLines = [];
      for (const med of medications) {
        const lineWeightKg =
          med.child_weight_kg != null && Number(med.child_weight_kg) > 0
            ? Number(med.child_weight_kg)
            : patientWeightKg;
        const calc = computeWeightBasedDose(med.dose || med.dosage || med.strength, lineWeightKg);
        if (calc) {
          weightDoseLines.push(
            `${med.display_name || med.displayName || med.name}: ${calc.mgPerKg} mg/kg × ${calc.weightKg} kg = ${calc.totalMg} mg per dose`
          );
        }
      }
      if (weightDoseLines.length) {
        y += 15;
        if (y > 720) {
          doc.addPage();
          y = 40;
        }
        doc
          .fontSize(10)
          .font('Helvetica-Bold')
          .fillColor('#007A64')
          .text('Weight-based dosing:', leftX, y);
        y += 14;
        doc.fontSize(8).font('Helvetica').fillColor('#333');
        for (const line of weightDoseLines) {
          if (y > 740) {
            doc.addPage();
            y = 40;
          }
          doc.text(line, leftX, y, { width: pageWidth });
          y += 12;
        }
      }
    }

    // ─── Follow-up ───────────────────────────────────────────────────────
    if (prescription.follow_up_date) {
      y += 15;
      const fuDate = new Date(prescription.follow_up_date).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Follow-up:', leftX, y);
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#333')
        .text(fuDate, leftX + 65, y);
      if (prescription.follow_up_notes) {
        y += 14;
        doc.text(prescription.follow_up_notes, leftX, y, { width: pageWidth });
        y += doc.heightOfString(prescription.follow_up_notes, { width: pageWidth });
      }
    }

    // ─── Clinical Notes ──────────────────────────────────────────────────
    if (prescription.clinical_notes) {
      y += 15;
      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .fillColor('#007A64')
        .text('Clinical Notes:', leftX, y);
      y += 14;
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#333')
        .text(prescription.clinical_notes, leftX, y, { width: pageWidth });
      y += doc.heightOfString(prescription.clinical_notes, { width: pageWidth });
    }

    // ─── Footer / Signature ──────────────────────────────────────────────
    y = Math.max(y + 40, 680);
    if (y > 750) {
      doc.addPage();
      y = 40;
    }
    doc
      .moveTo(leftX + pageWidth - 200, y)
      .lineTo(leftX + pageWidth, y)
      .stroke('#333');
    y += 5;
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor('#333')
      .text(`Dr. ${doctor.name || 'N/A'}`, leftX + pageWidth - 200, y, {
        width: 200,
        align: 'center'
      });
    y += 12;
    if (doctor.specialization) {
      doc
        .fontSize(8)
        .font('Helvetica')
        .text(doctor.specialization, leftX + pageWidth - 200, y, { width: 200, align: 'center' });
    }

    // ─── Disclaimer ──────────────────────────────────────────────────────
    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#999')
      .text(
        "This is a computer-generated prescription. Valid only with doctor's signature.",
        leftX,
        790,
        { width: pageWidth, align: 'center' }
      );

    doc.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /prescriptions/create — staff enters structured prescription
// ═══════════════════════════════════════════════════════════════════════════════
export const createPrescription = async (req, res) => {
  try {
    const {
      appointment_id,
      admission_id,
      visit_type,
      patient_id,
      doctor_id,
      diagnosis,
      clinical_notes,
      medications: rawMedications,
      follow_up_date,
      follow_up_notes,
      vitals: rawVitals
    } = req.body;

    const patientId = parseIntegerField(patient_id);
    const doctorId = parseIntegerField(doctor_id);
    const appointmentId = parseIntegerField(appointment_id);
    const admissionId = parseIntegerField(admission_id);
    const medications = parseJsonField(rawMedications, []);
    const vitals = parseJsonField(rawVitals, null);
    const override = parseJsonField(req.body.override, null); // { reason, approvedBy? }

    if (!Number.isInteger(patientId) || !Number.isInteger(doctorId)) {
      return error(res, 'patient_id and doctor_id are required', HTTP_STATUS.BAD_REQUEST);
    }
    if (appointment_id && !Number.isInteger(appointmentId)) {
      return error(res, 'appointment_id must be a valid integer', HTTP_STATUS.BAD_REQUEST);
    }
    // IPD prescriptions link to an admission instead of (or alongside) an
    // OPD appointment. admission_id implies visit_type 'inpatient';
    // otherwise honour an explicit visit_type, defaulting to 'outpatient'.
    if (admission_id && !Number.isInteger(admissionId)) {
      return error(res, 'admission_id must be a valid integer', HTTP_STATUS.BAD_REQUEST);
    }
    const rawVisitType = visit_type ? String(visit_type).toLowerCase().trim() : null;
    if (rawVisitType && !VALID_VISIT_TYPES.includes(rawVisitType)) {
      return error(
        res,
        `visit_type must be one of: ${VALID_VISIT_TYPES.join(', ')}`,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const resolvedVisitType = admissionId ? 'inpatient' : rawVisitType || 'outpatient';
    if (!medications || !Array.isArray(medications) || medications.length === 0) {
      return error(res, 'At least one medication is required', HTTP_STATUS.BAD_REQUEST);
    }

    // ── Clinical Decision Support hard-block ──
    // Run safety check; if blockers[] non-empty, require an explicit override payload.
    // Override requires a non-empty reason; we log it to prescription_safety_overrides
    // after the prescription is inserted so there's always a prescription_id to link.
    const safety = await validatePrescriptionSafety(patientId, medications);
    if (!safety.safe) {
      if (!override || typeof override.reason !== 'string' || override.reason.trim().length < 5) {
        return error(res, 'Prescription blocked by clinical safety check', HTTP_STATUS.CONFLICT, {
          blockers: safety.blockers,
          warnings: safety.warnings,
          requiresOverride: true
        });
      }
      logger.warn(
        `CDS override used by user=${req.user?.id} patient=${patientId} blockers=${safety.blockers.length}`
      );
    }

    // Validate appointment if provided
    if (appointmentId) {
      const apptCheck = await prisma.$queryRawUnsafe(
        'SELECT id FROM appointments WHERE id=$1',
        appointmentId
      );
      if (apptCheck.length === 0) {
        return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
      }
      if (resolvedVisitType === 'outpatient') {
        const existingForVisit = await prisma.$queryRawUnsafe(
          `SELECT id, prescription_number, status, lifecycle_status, signed_at, locked_at
             FROM e_prescriptions
            WHERE appointment_id = $1::int
              AND COALESCE(visit_type, 'outpatient') = 'outpatient'
              AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled')
            ORDER BY created_at DESC
            LIMIT 1`,
          appointmentId
        );
        if (existingForVisit.length > 0) {
          return error(
            res,
            'This OP visit already has a prescription; edit the existing draft or create a new appointment for a new prescription',
            HTTP_STATUS.CONFLICT,
            {
              prescription_id: existingForVisit[0].id,
              prescription_number: existingForVisit[0].prescription_number,
              lifecycle_status: existingForVisit[0].lifecycle_status,
              status: existingForVisit[0].status
            }
          );
        }
      }
    }

    // Upload handwritten photo if present (multer file)
    let handwritten_photo_key = null;
    if (req.file) {
      const key = `prescriptions/handwritten/${Date.now()}-${req.file.originalname || 'photo.jpg'}`;
      await uploadFileToR2(req.file.buffer, key, req.file.mimetype);
      handwritten_photo_key = key;
    }

    // Get creator (staff user) from auth context
    const created_by = req.user?.id || req.user?.userId || null;

    // Resolve patient_uid + doctor_uid for the dedicated UUID columns
    // (added in migration 176). The patient app's Rx-list filter and
    // pharmacy lookups join by uid, not the int id — leaving these null
    // made every walk-in's prescriptions invisible in the patient app.
    // See finding 2026-05-08-walk-in-opd-doctor-prescription-uid-fields-null.
    //
    // Pre-flight existence check: discharge-takeaway rx is created from
    // the discharge desk with patient/doctor ids that may not exist
    // (e.g. doctor id passed from the doctors table rather than users).
    // Surface that as a clean 404 — without this, the downstream INSERT
    // still succeeded with null uids but the patient app could never
    // see the prescription, and any clinical-context probe (PDF, follow-
    // up notification) silently degraded. Finding:
    //   2026-05-10-surgical-day-care-discharge-prescription-create-500.
    const [patientRow, doctorRow] = await Promise.all([
      prisma.$queryRawUnsafe('SELECT uid FROM users WHERE id=$1', patientId),
      prisma.$queryRawUnsafe('SELECT uid FROM users WHERE id=$1', doctorId)
    ]);
    if (!patientRow?.length) {
      return error(res, `Patient ${patientId} not found`, HTTP_STATUS.NOT_FOUND);
    }
    if (!doctorRow?.length) {
      return error(res, `Doctor ${doctorId} not found`, HTTP_STATUS.NOT_FOUND);
    }
    const patientUid = patientRow[0].uid ?? null;
    const doctorUid = doctorRow[0].uid ?? null;

    // Validate the linked admission exists and belongs to this patient —
    // an admission_id pointing at a different patient's stay is exactly
    // the IPD/OPD mix-up that routes an IV order to the wrong bed.
    if (admissionId) {
      const admCheck = await prisma.$queryRawUnsafe(
        'SELECT id, patient_uid FROM admissions WHERE id=$1',
        admissionId
      );
      if (admCheck.length === 0) {
        return error(res, 'Admission not found', HTTP_STATUS.NOT_FOUND);
      }
      if (
        admCheck[0].patient_uid &&
        patientUid &&
        String(admCheck[0].patient_uid) !== String(patientUid)
      ) {
        return error(res, 'admission_id belongs to a different patient', HTTP_STATUS.BAD_REQUEST);
      }
    }

    // Insert prescription.
    // The table has `clinical_notes` (not `notes`); patient_uid + doctor_uid
    // are populated explicitly so downstream uid-based lookups work.
    const insertResult = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
        (appointment_id, patient_id, doctor_id, patient_uid, doctor_uid,
         diagnosis, clinical_notes, medications,
         follow_up_date, follow_up_notes, vitals, handwritten_photo_key, created_by,
         admission_id, visit_type)
       VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::jsonb, $9::date, $10, $11::jsonb, $12, $13,
               $14, $15)
       RETURNING id, appointment_id, patient_id, doctor_id, patient_uid, doctor_uid,
                 medications, status, lifecycle_status, revision, signed_at, signed_by, locked_at, locked_by,
                 created_at,
                 prescription_number, diagnosis, clinical_notes, vitals,
                 follow_up_date, follow_up_notes, pdf_key, handwritten_photo_key,
                 admission_id, visit_type`,
      appointmentId || null,
      patientId,
      doctorId,
      patientUid,
      doctorUid,
      diagnosis || null,
      clinical_notes || null,
      JSON.stringify(medications),
      follow_up_date || null,
      follow_up_notes || null,
      vitals ? JSON.stringify(vitals) : null,
      handwritten_photo_key,
      created_by,
      admissionId || null,
      resolvedVisitType
    );

    const prescription = insertResult[0];
    const encounter = appointmentId
      ? await bestEffortPrescriptionCanonical('prescription encounter ensure', () => ensureEncounterForAppointment({
        tenantId: req.user?.tenant_id || req.user?.tenantId,
        appointmentId,
        patientUid,
        doctorUid,
        actorUid: req.user?.uid,
        metadata: {
          source: 'prescriptions.create',
          prescription_id: prescription.id,
        },
      }))
      : null;

    logAudit(
      req,
      'OP_PRESCRIPTION_CREATED',
      {
        prescription_id: prescription.id,
        prescription_number: prescription.prescription_number,
        patient_id: patientId,
        patient_uid: patientUid,
        doctor_id: doctorId,
        doctor_uid: doctorUid,
        appointment_id: appointmentId || null,
        admission_id: admissionId || null,
        visit_type: resolvedVisitType,
        medication_count: medications.length,
        pharmacy: medications[0]?.pharmacy || null
      },
      { resource: 'e_prescriptions', resourceId: prescription.id }
    ).catch(auditErr => {
      logger.warn(`Prescription create audit failed for ${prescription.id}: ${auditErr.message}`);
    });

    await bestEffortPrescriptionCanonical('prescription safety review', () => recordMedicationSafetyReviews({
      tenantId: req.user?.tenant_id || req.user?.tenantId,
      patientUid,
      patientId,
      encounterId: encounter?.id || null,
      prescriptionId: prescription.id,
      safety,
      override,
      actorUid: req.user?.uid,
    }));

    await bestEffortPrescriptionCanonical('prescription create event', () => recordCanonicalClinicalEvent({
      tenantId: req.user?.tenant_id || req.user?.tenantId,
      patientUid,
      encounterId: encounter?.id || null,
      eventType: 'prescription.created',
      eventStatus: prescription.lifecycle_status || prescription.status || 'draft',
      sourceTable: 'e_prescriptions',
      sourceId: prescription.id,
      resourceType: 'prescription',
      resourceId: prescription.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      summary: `Prescription ${prescription.prescription_number} created`,
      payload: {
        prescription_number: prescription.prescription_number,
        appointment_id: appointmentId || null,
        admission_id: admissionId || null,
        visit_type: resolvedVisitType,
        diagnosis: prescription.diagnosis,
        medication_count: medications.length,
        safety,
      },
      afterState: prescription,
    }));

    // If CDS blockers were overridden, persist the audit row linked to the new Rx.
    if (!safety.safe && override) {
      try {
        await prisma.$queryRawUnsafe(
          `INSERT INTO prescription_safety_overrides
             (prescription_id, patient_id, doctor_id, blockers, reason, approved_by, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          prescription.id,
          patientId,
          doctorId,
          JSON.stringify(safety.blockers),
          override.reason.trim(),
          override.approvedBy || null,
          created_by
        );
      } catch (auditErr) {
        logger.error('Failed to persist CDS override audit row:', auditErr.message);
      }
    }

    // Fetch patient and doctor info for PDF
    const [patientRes, doctorRes] = await Promise.all([
      prisma.$queryRawUnsafe(
        'SELECT id, name, phone, gender, birthday, weight_kg FROM users WHERE id=$1',
        patientId
      ),
      prisma.$queryRawUnsafe(
        `SELECT u.id, u.name, u.phone, d.specialty AS specialization, NULL::text AS qualification
                FROM users u LEFT JOIN doctors d ON d.user_id = u.id
                WHERE u.id=$1`,
        doctorId
      )
    ]);
    const patient = patientRes[0] || {};
    const doctor = doctorRes[0] || {};

    // Generate PDF
    try {
      const pdfBuffer = await generatePrescriptionPDF(prescription, patient, doctor);
      const pdfKey = `prescriptions/pdf/${prescription.prescription_number}.pdf`;
      await uploadFileToR2(pdfBuffer, pdfKey, 'application/pdf');
      await prisma.$queryRawUnsafe(
        'UPDATE e_prescriptions SET pdf_key=$1 WHERE id=$2',
        pdfKey,
        prescription.id
      );
      prescription.pdf_key = pdfKey;
    } catch (pdfErr) {
      logger.error('Failed to generate prescription PDF:', pdfErr);
      // Non-blocking — prescription still created
    }

    // Fire-and-forget notification to patient
    dispatch({
      userId: patient.phone || String(patient_id),
      title: '📋 Prescription Ready',
      body: `Your prescription ${prescription.prescription_number} is ready. Open the app to view and order medicines.`,
      channels: ['push', 'inapp'],
      data: { type: 'prescription', prescriptionId: String(prescription.id) },
      type: 'prescription'
    }).catch(err => logger.error('Prescription notification failed:', err));

    // Phase 1.5 — best-effort follow-up appointment auto-booking. The
    // doctor's Rx form has a `follow_up_date` field that was previously
    // captured only as a printed instruction on the prescription PDF.
    // The receptionist had to remember to manually book the follow-up
    // — and frequently didn't, so the 28-week ANC return / 14-day
    // post-op review / chronic-care visit never materialised. Finding:
    //   2026-05-09-walk-in-opd-patient-follow-up-appt-not-booked.
    //
    // Idempotency: skip if an appointment for the same
    // (patient_id, doctor_id, appointment_date) already exists in a
    // non-terminal state. The matcher uses DATE() to ignore time
    // components — patients typically don't care which slot of the
    // recommended day they get, only that one is reserved.
    if (follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(String(follow_up_date))) {
      try {
        const existing = await prisma.$queryRawUnsafe(
          `SELECT id FROM appointments
            WHERE patient_id = $1::int
              AND doctor_id  = $2::int
              AND DATE(appointment_date) = $3::date
              AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
            LIMIT 1`,
          patientId,
          doctorId,
          follow_up_date
        );
        let followUpApptId = existing[0]?.id ?? null;
        if (!followUpApptId) {
          const created = await prisma.$queryRawUnsafe(
            `INSERT INTO appointments
               (patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes,
                status, visit_type, parent_appointment_id, created_by, updated_at)
             VALUES ($1::int, $2::int, $3::date, $4, $5, $6, $7,
                     'SCHEDULED', 'FOLLOW_UP', $8, $9::uuid, NOW())
             RETURNING id`,
            patientId,
            doctorId,
            follow_up_date,
            // appointment_time is VARCHAR(10) NOT NULL. The Rx didn't
            // capture a slot time — the receptionist will assign one
            // when the day comes. Use the 'Follow-up' literal as a
            // placeholder that the appointment dashboard recognises.
            'Follow-up',
            patient.phone || '',
            `Follow-up for prescription ${prescription.prescription_number}`,
            follow_up_notes || null,
            appointmentId || null,
            req.user?.uid || null
          );
          followUpApptId = created[0]?.id ?? null;
        }
        // Link the prescription back to the follow-up appointment when
        // the prescription itself wasn't tied to a source visit (the
        // discharge-desk path: discharge meds prescribed with no current
        // appointment, but a follow-up scheduled). With the link, the
        // patient app can render "your follow-up is on X — here are the
        // meds to take until then" as a single card. Without it, the two
        // cards appear unrelated. Don't overwrite a real source-visit
        // appointment_id (walk-in OPD case). Finding:
        //   2026-05-09-inpatient-admission-patient-discharge-rx-unlinked-to-followup
        if (followUpApptId && !appointmentId) {
          await prisma.$executeRawUnsafe(
            `UPDATE e_prescriptions
                SET appointment_id = $1::int, updated_at = NOW()
              WHERE id = $2::int AND appointment_id IS NULL`,
            followUpApptId,
            prescription.id
          );
          prescription.appointment_id = followUpApptId;
        }
      } catch (followUpErr) {
        // Non-blocking — the prescription is already saved.
        logger.warn('Follow-up appointment auto-booking failed:', {
          prescription_id: prescription.id,
          err: followUpErr?.message
        });
      }
    }

    // Phase 1.5 — best-effort ANC supplement propagation. Iron / folic
    // acid / calcium / vitamin D / B-complex prescribed for a patient
    // with an ongoing pregnancy must land in `maternity_supplements`,
    // because that's the source the patient-app medication-reminder
    // projection reads. Without this, prescribing supplements in the
    // standard Rx flow leaves the reminder pipeline silent. Finding:
    //   2026-05-09-obstetric-anc-patient-supplements-missing.
    try {
      await maybePropagateAncSupplements({
        tenantId: req.user?.tenantId || '00000000-0000-4000-8000-000000000001',
        patient_uid: patientUid,
        medications,
        prescribed_by: doctorUid
      });
    } catch (suppErr) {
      logger.warn('ANC supplement propagation failed:', {
        prescription_id: prescription.id,
        err: suppErr?.message
      });
    }

    try {
      const reminderRows = await createPrescriptionReminders(patientUid, medications, {
        prescriptionNumber: prescription.prescription_number
      });
      if (reminderRows.length > 0) {
        logger.info('Prescription medication reminders synced', {
          prescription_id: prescription.id,
          patient_uid: patientUid,
          reminder_count: reminderRows.length
        });
      }
    } catch (reminderErr) {
      logger.warn('Prescription medication reminder sync failed:', {
        prescription_id: prescription.id,
        err: reminderErr?.message
      });
    }

    success(
      res,
      prescription,
      `Prescription ${prescription.prescription_number} created`,
      HTTP_STATUS.CREATED
    );
  } catch (err) {
    // Log enough context to actually diagnose the next swarm 500. The
    // previous catch logged the bare Error and surfaced a generic
    // "Failed to create prescription" — every subsequent tick filed
    // an opaque finding (see 2026-05-10-surgical-day-care-discharge-
    // prescription-create-500). Now: log err.code, err.meta (Prisma's
    // FK/unique-constraint diagnostics), and err.stack so the
    // operations log carries the actual fault.
    logger.error('Create e-prescription error', {
      message: err?.message,
      code: err?.code,
      meta: err?.meta,
      stack: err?.stack
    });
    error(res, 'Failed to create prescription', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /prescriptions/:id — edit draft prescription during active consultation
// ═══════════════════════════════════════════════════════════════════════════════
export const updatePrescription = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }

    const existing = await loadPrescriptionRow(id);
    if (!existing) return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);

    const editError = assertPrescriptionEditable(req, existing);
    if (editError) return error(res, editError, HTTP_STATUS.FORBIDDEN);

    const medications =
      req.body.medications !== undefined
        ? normalizeMedicationList(req.body.medications)
        : normalizeMedicationList(existing.medications);
    if (!Array.isArray(medications) || medications.length === 0) {
      return error(res, 'At least one medication is required', HTTP_STATUS.BAD_REQUEST);
    }

    const override = parseJsonField(req.body.override, null);
    const safety = await validatePrescriptionSafety(existing.patient_id, medications);
    if (!safety.safe) {
      if (!override || typeof override.reason !== 'string' || override.reason.trim().length < 5) {
        return error(res, 'Prescription blocked by clinical safety check', HTTP_STATUS.CONFLICT, {
          blockers: safety.blockers,
          warnings: safety.warnings,
          requiresOverride: true
        });
      }
    }

    const diagnosis = req.body.diagnosis !== undefined ? req.body.diagnosis : existing.diagnosis;
    const clinicalNotes =
      req.body.clinical_notes !== undefined ? req.body.clinical_notes : existing.clinical_notes;
    const followUpDate =
      req.body.follow_up_date !== undefined ? req.body.follow_up_date : existing.follow_up_date;
    const followUpNotes =
      req.body.follow_up_notes !== undefined ? req.body.follow_up_notes : existing.follow_up_notes;
    const vitals =
      req.body.vitals !== undefined ? parseJsonField(req.body.vitals, null) : existing.vitals;

    const result = await prisma.$queryRawUnsafe(
      `UPDATE e_prescriptions
          SET diagnosis=$1,
              clinical_notes=$2,
              medications=$3::jsonb,
              follow_up_date=$4::date,
              follow_up_notes=$5,
              vitals=$6::jsonb,
              revision=COALESCE(revision, 1) + 1,
              lifecycle_status='draft',
              updated_at=NOW()
        WHERE id=$7
        RETURNING *`,
      diagnosis || null,
      clinicalNotes || null,
      JSON.stringify(medications),
      followUpDate || null,
      followUpNotes || null,
      vitals ? JSON.stringify(vitals) : null,
      id
    );

    const updated = result[0];

    if (!safety.safe && override) {
      try {
        await prisma.$queryRawUnsafe(
          `INSERT INTO prescription_safety_overrides
             (prescription_id, patient_id, doctor_id, blockers, reason, approved_by, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          updated.id,
          updated.patient_id,
          updated.doctor_id,
          JSON.stringify(safety.blockers),
          override.reason.trim(),
          override.approvedBy || null,
          req.user?.id || req.user?.userId || null
        );
      } catch (auditErr) {
        logger.error('Failed to persist edit CDS override audit row:', auditErr.message);
      }
    }

    try {
      await regeneratePrescriptionPdf(req, updated);
    } catch (pdfErr) {
      logger.error(`Failed to regenerate prescription PDF for ${updated.id}:`, pdfErr.message);
    }

    logAudit(
      req,
      'OP_PRESCRIPTION_EDITED',
      {
        prescription_id: updated.id,
        prescription_number: updated.prescription_number,
        patient_id: updated.patient_id,
        patient_uid: updated.patient_uid,
        doctor_id: updated.doctor_id,
        doctor_uid: updated.doctor_uid,
        appointment_id: updated.appointment_id || null,
        admission_id: updated.admission_id || null,
        revision: updated.revision,
        medication_count: medications.length
      },
      { resource: 'e_prescriptions', resourceId: updated.id }
    ).catch(auditErr => {
      logger.warn(`Prescription edit audit failed for ${updated.id}: ${auditErr.message}`);
    });

    await bestEffortPrescriptionCanonical('prescription edit safety review', () => recordMedicationSafetyReviews({
      tenantId: req.user?.tenant_id || req.user?.tenantId,
      patientUid: updated.patient_uid || existing.patient_uid,
      patientId: updated.patient_id || existing.patient_id,
      prescriptionId: updated.id,
      safety,
      override,
      actorUid: req.user?.uid,
    }));

    await bestEffortPrescriptionCanonical('prescription edit event', () => recordCanonicalClinicalEvent({
      tenantId: req.user?.tenant_id || req.user?.tenantId,
      patientUid: updated.patient_uid || existing.patient_uid,
      eventType: 'prescription.edited',
      eventStatus: updated.lifecycle_status || updated.status || 'draft',
      sourceTable: 'e_prescriptions',
      sourceId: updated.id,
      resourceType: 'prescription',
      resourceId: updated.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      summary: `Prescription ${updated.prescription_number} edited`,
      payload: {
        prescription_number: updated.prescription_number,
        appointment_id: updated.appointment_id || null,
        admission_id: updated.admission_id || null,
        revision: updated.revision,
        medication_count: medications.length,
        safety,
      },
      beforeState: existing,
      afterState: updated,
      timelineIdempotencyKey: `e_prescriptions:${updated.id}:edited:rev${updated.revision || 1}`,
      auditIdempotencyKey: `e_prescriptions:${updated.id}:audit:edited:rev${updated.revision || 1}`,
    }));

    success(res, updated, 'Prescription updated');
  } catch (err) {
    logger.error('Update prescription error:', err);
    error(res, 'Failed to update prescription', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /prescriptions/:id/sign — sign and lock prescription
// ═══════════════════════════════════════════════════════════════════════════════
export const signPrescription = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }

    const existing = await loadPrescriptionRow(id);
    if (!existing) return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);

    const signError = assertPrescriptionSignable(req, existing);
    if (signError) return error(res, signError, HTTP_STATUS.FORBIDDEN);

    const actorUid = req.user?.uid || null;
    const result = await prisma.$queryRawUnsafe(
      `UPDATE e_prescriptions
          SET signed_at=NOW(),
              signed_by=$1::uuid,
              locked_at=NOW(),
              locked_by=$1::uuid,
              lifecycle_status='signed',
              updated_at=NOW()
        WHERE id=$2
        RETURNING *`,
      actorUid,
      id
    );
    const signed = result[0];
    const encounter = signed.appointment_id
      ? await bestEffortPrescriptionCanonical('prescription sign encounter ensure', () => ensureEncounterForAppointment({
        tenantId: req.user?.tenant_id || req.user?.tenantId,
        appointmentId: signed.appointment_id,
        patientUid: signed.patient_uid,
        doctorUid: signed.doctor_uid,
        actorUid,
        metadata: {
          source: 'prescriptions.sign',
          prescription_id: signed.id,
        },
      }))
      : null;

    logAudit(
      req,
      'OP_PRESCRIPTION_SIGNED',
      {
        prescription_id: signed.id,
        prescription_number: signed.prescription_number,
        patient_id: signed.patient_id,
        patient_uid: signed.patient_uid,
        doctor_id: signed.doctor_id,
        doctor_uid: signed.doctor_uid,
        appointment_id: signed.appointment_id || null,
        admission_id: signed.admission_id || null,
        revision: signed.revision
      },
      { resource: 'e_prescriptions', resourceId: signed.id }
    ).catch(auditErr => {
      logger.warn(`Prescription sign audit failed for ${signed.id}: ${auditErr.message}`);
    });

    await bestEffortPrescriptionCanonical('prescription sign event', () => recordCanonicalClinicalEvent({
      tenantId: req.user?.tenant_id || req.user?.tenantId,
      patientUid: signed.patient_uid || existing.patient_uid,
      encounterId: encounter?.id || null,
      eventType: 'prescription.signed',
      eventStatus: 'signed',
      sourceTable: 'e_prescriptions',
      sourceId: signed.id,
      resourceType: 'prescription',
      resourceId: signed.id,
      actorUid,
      actorRole: req.user?.role,
      summary: `Prescription ${signed.prescription_number} signed`,
      payload: {
        prescription_number: signed.prescription_number,
        appointment_id: signed.appointment_id || null,
        admission_id: signed.admission_id || null,
        revision: signed.revision,
        signed_at: signed.signed_at,
      },
      beforeState: existing,
      afterState: signed,
      timelineIdempotencyKey: `e_prescriptions:${signed.id}:signed:${signed.signed_at?.toISOString?.() || 'now'}`,
      auditIdempotencyKey: `e_prescriptions:${signed.id}:audit:signed:${signed.signed_at?.toISOString?.() || 'now'}`,
    }));

    success(res, signed, 'Prescription signed and locked');
  } catch (err) {
    logger.error('Sign prescription error:', err);
    error(res, 'Failed to sign prescription', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /prescriptions/safety-check — preview CDS result before save (no insert).
// Clients call this to drive the hard-block UX without committing anything.
// Body: { patient_id, medications: [{ name | medication_name, ... }] }
// ═══════════════════════════════════════════════════════════════════════════════
export const previewSafetyCheck = async (req, res) => {
  try {
    const { patient_id, medications } = req.body;
    if (!patient_id || !Array.isArray(medications) || medications.length === 0) {
      return error(res, 'patient_id and medications are required', HTTP_STATUS.BAD_REQUEST);
    }
    const safety = await validatePrescriptionSafety(patient_id, medications);
    success(res, safety, safety.safe ? 'Safe to prescribe' : 'Blockers detected');
  } catch (err) {
    logger.error('Preview safety check error:', err);
    error(res, 'Failed to run safety check', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/:id/safety — patient-facing safety context for the Rx detail
// sheet. Returns allergy warnings the patient should see + any override reason
// so they know when a clinician consciously prescribed through a caution.
// ═══════════════════════════════════════════════════════════════════════════════
export const getPrescriptionSafety = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }
    const rx = await prisma.$queryRawUnsafe(
      'SELECT patient_id, medications, diagnosis FROM e_prescriptions WHERE id = $1',
      id
    );
    if (rx.length === 0) return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);

    // Patient role may only view their own prescription's safety context.
    if (req.user?.role === 'PATIENT' && String(rx[0].patient_id) !== String(req.user.id)) {
      return error(res, 'Forbidden', HTTP_STATUS.FORBIDDEN);
    }

    const meds = Array.isArray(rx[0].medications)
      ? rx[0].medications
      : typeof rx[0].medications === 'string'
        ? JSON.parse(rx[0].medications)
        : [];
    const safety = await validatePrescriptionSafety(rx[0].patient_id, meds);

    const overrides = await prisma.$queryRawUnsafe(
      `SELECT reason, created_at FROM prescription_safety_overrides
       WHERE prescription_id = $1 ORDER BY created_at DESC`,
      id
    );

    success(
      res,
      {
        warnings: safety.warnings,
        blockers: safety.blockers,
        overrides: overrides.map(o => ({
          reason: o.reason,
          at: o.created_at
        })),
        indication: rx[0].diagnosis || null
      },
      'Prescription safety context'
    );
  } catch (err) {
    logger.error('Get prescription safety error:', err);
    error(res, 'Failed to fetch safety context', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/:id — get prescription detail
// ═══════════════════════════════════════════════════════════════════════════════
export const getPrescription = async (req, res) => {
  try {
    // `e_prescriptions.id` is an `integer` column. node-postgres types the
    // raw `req.params.id` string as `text` and Postgres rejects the
    // comparison with the int column → swallowed 500. Coerce here.
    // See finding 2026-05-08-walk-in-opd-doctor-prescription-get-by-id-fails.
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await prisma.$queryRawUnsafe(
      `SELECT ep.*,
              p.name AS patient_name, p.phone AS patient_phone, p.gender AS patient_gender, p.birthday AS patient_birthday,
              d.name AS doctor_name, doc.specialty AS doctor_specialization, NULL::text AS doctor_qualification
       FROM e_prescriptions ep
       JOIN users p ON p.id = ep.patient_id
       JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
       WHERE ep.id = $1`,
      id
    );
    if (result.length === 0) {
      return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);
    }

    const rx = result[0];

    // B-2 IDOR check. Patient-role callers may only read their own
    // prescriptions; staff (DOCTOR / NURSING / PHARMACY / ADMIN) read
    // any. The role helpers normalise across the role enum so a single
    // isStaff()-or-isAdmin() gate suffices. Scoped here rather than in
    // routing because the route-level RBAC already allows PATIENT (and
    // we need PATIENT to reach /:id for their OWN script).
    if (!callerMayAccessPrescription(req, rx.patient_id)) {
      return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);
    }

    // Sign URLs — pass the request-derived baseUrl so the pdf/photo URL
    // points back at whatever host the client actually used. Without this
    // the URL falls back to PUBLIC_BASE_URL (default `localhost:5000`),
    // which is the wrong port in the QA env and the wrong host on a
    // patient phone. Finding:
    // 2026-05-09-follow-up-opd-patient-pdf-url-wrong-base.
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    if (rx.pdf_key) {
      try {
        rx.pdf_url = await getSignedFileUrl(rx.pdf_key, 3600, { baseUrl });
      } catch (e) {
        logger.warn('Signed URL generation failed for PDF:', e.message);
      }
    }
    if (rx.handwritten_photo_key) {
      try {
        rx.handwritten_photo_url = await getSignedFileUrl(rx.handwritten_photo_key, 3600, {
          baseUrl
        });
      } catch (e) {
        logger.warn('Signed URL generation failed for handwritten photo:', e.message);
      }
    }

    success(res, rx, 'Prescription detail');
  } catch (err) {
    logger.error('Get prescription error:', err);
    error(res, 'Failed to fetch prescription', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/appointment/:appointmentId
// ═══════════════════════════════════════════════════════════════════════════════
export const getPrescriptionByAppointment = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    // Cast the bound param to int — Postgres won't auto-coerce when the
    // route param arrives as text and the column is integer, surfacing as
    // a generic 500 even when no row exists. Parse + reject malformed ids
    // up front and use `$1::int` so the operator matches `appointment_id`.
    // Finding: 2026-05-09-follow-up-opd-patient-prescription-by-appointment-500.
    const apptIdInt = parseInt(appointmentId, 10);
    if (!Number.isInteger(apptIdInt) || apptIdInt <= 0) {
      return error(res, 'appointmentId must be a positive integer', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await prisma.$queryRawUnsafe(
      `SELECT ep.*,
              p.name AS patient_name, p.phone AS patient_phone,
              d.name AS doctor_name, doc.specialty AS doctor_specialization
       FROM e_prescriptions ep
       JOIN users p ON p.id = ep.patient_id
       JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
       WHERE ep.appointment_id = $1::int
       ORDER BY ep.created_at DESC LIMIT 1`,
      apptIdInt
    );
    if (result.length === 0) {
      return error(res, 'No prescription found for this appointment', HTTP_STATUS.NOT_FOUND);
    }

    const rx = result[0];
    // IDOR: a PATIENT may only read their OWN prescription (this endpoint is
    // PATIENT-reachable by RBAC and keys on appointment_id).
    if (!callerMayAccessPrescription(req, rx.patient_id)) {
      return error(res, 'No prescription found for this appointment', HTTP_STATUS.NOT_FOUND);
    }
    if (rx.pdf_key) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      try {
        rx.pdf_url = await getSignedFileUrl(rx.pdf_key, 3600, { baseUrl });
      } catch (e) {
        logger.warn('Signed URL generation failed for PDF:', e.message);
      }
    }

    success(res, rx, 'Prescription for appointment');
  } catch (err) {
    logger.error('Get prescription by appointment error:', err);
    error(res, 'Failed to fetch prescription', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/patient/my — patient's own prescriptions
// ═══════════════════════════════════════════════════════════════════════════════
export const getMyPrescriptions = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      return error(res, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT ep.*,
              d.name AS doctor_name, doc.specialty AS doctor_specialization,
              po.order_number AS pharmacy_order_number,
              po.status AS pharmacy_order_status,
              po.payment_status AS pharmacy_payment_status,
              po.payment_mode AS pharmacy_payment_mode,
              po.amount_collected AS pharmacy_amount_collected,
              po.total_amount AS pharmacy_total_amount,
              po.partial_dispense AS pharmacy_partial_dispense,
              po.partial_reason AS pharmacy_partial_reason,
              po.dispensed_at AS pharmacy_dispensed_at
       FROM e_prescriptions ep
       JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
       LEFT JOIN pharmacy_orders po ON po.id = ep.pharmacy_order_id
       WHERE ep.patient_id = $1
       ORDER BY ep.created_at DESC`,
      userId
    );

    // Sign PDF URLs — pass request-derived baseUrl so the patient app
    // can fetch the PDF from the host it actually reached the API on
    // (not the hardcoded PUBLIC_BASE_URL fallback). Same finding as
    // getPrescriptionByAppointment above.
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    for (const rx of result) {
      if (rx.pdf_key) {
        try {
          rx.pdf_url = await getSignedFileUrl(rx.pdf_key, 3600, { baseUrl });
        } catch (e) {
          logger.warn('Signed URL generation failed for PDF:', e.message);
        }
      }
    }

    success(res, result, 'My prescriptions');
  } catch (err) {
    logger.error('Get my prescriptions error:', err);
    error(res, 'Failed to fetch prescriptions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/all — admin list all prescriptions
// ═══════════════════════════════════════════════════════════════════════════════
export const getAllPrescriptions = async (req, res) => {
  try {
    const {
      doctor_id,
      phone,
      from_date,
      to_date,
      status,
      prescription_number,
      patient_id,
      visit_no,
      page = 1,
      limit = 50
    } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (doctor_id) {
      params.push(doctor_id);
      where += ` AND ep.doctor_id = $${params.length}`;
    }
    // Phone filter — scope to one patient via the joined users row or, for
    // dependent pediatric patients, the linked/stored guardian contact.
    // Without this branch the param was silently ignored and the query
    // returned every patient's prescriptions (PHI leak; finding
    // 2026-05-08-walk-in-opd-pharmacy-prescription-phone-filter-leaks-all-patients).
    if (phone) {
      params.push(phone);
      where += ` AND (
        p.phone = $${params.length}
        OR p.guardian_phone = $${params.length}
        OR guardian.phone = $${params.length}
      )`;
    }
    // Pharmacy counter look-ups: dispense-against-the-paper-Rx flow.
    // Pharmacists often hold just the RX-number, a patient id from the
    // patient card, or a visit number from the doctor handoff. Pre-fix
    // all three were silently ignored and the search returned an
    // unrelated patient's prescription at the top of the list —
    // wrong-patient-dispensing risk. Each filter resolves to exactly
    // the one matching row (or zero) when supplied. Finding:
    // 2026-05-15-pediatric-opd-pharmacy-34cc16a5.
    if (prescription_number) {
      params.push(prescription_number);
      where += ` AND ep.prescription_number = $${params.length}`;
    }
    if (patient_id) {
      const pidInt = parseInt(patient_id, 10);
      if (Number.isFinite(pidInt)) {
        params.push(pidInt);
        where += ` AND ep.patient_id = $${params.length}`;
      }
    }
    // visit_no lives on the appointments table; resolve via the FK that
    // e_prescriptions already carries. A LEFT-JOIN-with-WHERE would
    // exclude prescriptions whose appointment_id is null and surprise
    // the other branches — keeping it a scalar IN keeps every existing
    // WHERE-branch independent.
    if (visit_no) {
      params.push(visit_no);
      where += ` AND ep.appointment_id IN (
        SELECT id FROM appointments WHERE visit_no = $${params.length}
      )`;
    }
    if (from_date) {
      params.push(from_date);
      where += ` AND ep.created_at >= $${params.length}::date`;
    }
    if (to_date) {
      params.push(to_date);
      where += ` AND ep.created_at < ($${params.length}::date + interval '1 day')`;
    }
    if (status) {
      params.push(status);
      where += ` AND ep.status = $${params.length}`;
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit));
    params.push(offset);

    const result = await prisma.$queryRawUnsafe(
      `SELECT ep.*,
              p.name AS patient_name,
              COALESCE(NULLIF(guardian.phone, ''), NULLIF(p.guardian_phone, ''), p.phone) AS patient_phone,
              d.name AS doctor_name, doc.specialty AS doctor_specialization
       FROM e_prescriptions ep
       JOIN users p ON p.id = ep.patient_id
       LEFT JOIN users guardian ON guardian.id = p.guardian_user_id
       JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
       ${where}
       ORDER BY ep.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params
    );

    success(res, result, 'All prescriptions');
  } catch (err) {
    logger.error('Get all prescriptions error:', err);
    error(res, 'Failed to fetch prescriptions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /prescriptions/:id/order-pharmacy — patient opts to get medicines
// ═══════════════════════════════════════════════════════════════════════════════
export const orderPharmacyFromPrescription = async (req, res) => {
  try {
    // Same string→int coercion as getPrescription. See finding
    // 2026-05-08-walk-in-opd-doctor-prescription-get-by-id-fails.
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }
    // Stage-4-C — same handler backs both POST /:id/order-pharmacy and
    // POST /:id/refill. Detect which path was hit so the refill route
    // can repeat-dispense a fulfilled prescription instead of being
    // rejected by the first-time-order guard.
    // Findings:
    //   2026-05-10-pediatric-opd-pharmacy-refill-endpoint-blocks-fulfilled-rx
    //   2026-05-10-walk-in-opd-pharmacy-refill-blocked-after-fulfillment
    const isRefill = (req.route?.path || req.path || '').includes('refill');

    // Accept `dispense_type` as a back-compat alias for `delivery_type` so a
    // pharmacist passing the older field name still routes the order through
    // the counter/delivery flow they intended, instead of silently defaulting
    // to delivery. Canonical name is `delivery_type` (matches Wave 1.5 ship).
    const { delivery_address, delivery_phone } = req.body;
    const delivery_type = req.body.delivery_type ?? req.body.dispense_type ?? 'delivery';
    const catalogSelections = collectCatalogSelections(req.body);

    // Fetch prescription
    const rxResult = await prisma.$queryRawUnsafe(
      `SELECT ep.*, p.name AS patient_name,
              COALESCE(NULLIF(guardian.phone, ''), NULLIF(p.guardian_phone, ''), p.phone) AS patient_phone,
              -- Recorded weight drives pediatric (mg/kg → mL) dose derivation
              -- when the clinician didn't put the weight in the dose text.
              -- Prefer the most-recent charted vital, fall back to the
              -- registered weight (users.weight_kg, migration 202).
              -- Finding: 2026-05-22-pediatric-opd-pharmacy-f346bf82.
              COALESCE(
                (SELECT vc.weight_kg FROM vitals_chart vc
                  WHERE vc.patient_uid = p.uid AND vc.weight_kg IS NOT NULL
                  ORDER BY vc.recorded_at DESC NULLS LAST LIMIT 1),
                p.weight_kg
              ) AS patient_weight_kg
       FROM e_prescriptions ep
       JOIN users p ON p.id = ep.patient_id
       LEFT JOIN users guardian ON guardian.id = p.guardian_user_id
       WHERE ep.id = $1`,
      id
    );
    if (rxResult.length === 0) {
      return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);
    }
    const rx = rxResult[0];

    if (isRefill) {
      // Refill flow: only allow when the previous order is *complete*
      // (e_prescriptions.status='fulfilled' AND pharmacy_order_id set).
      // Anything else means a previous order is still in-flight or no
      // order was ever placed — both are operationally unsafe to
      // refill from the same endpoint.
      if (rx.status !== 'fulfilled' || !rx.pharmacy_order_id) {
        return error(
          res,
          'Refill not allowed: original pharmacy order is not yet fulfilled. Use /order-pharmacy for first-time dispense or wait for the in-flight order to complete.',
          HTTP_STATUS.BAD_REQUEST
        );
      }
      // Refill proceeds — pharmacy_opted stays true on the row (it has
      // already been opted in once); the UPDATE below repoints
      // pharmacy_order_id to the new repeat order.
    } else if (rx.pharmacy_opted) {
      return error(
        res,
        'Pharmacy order already placed for this prescription. Use /refill for a repeat dispense.',
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Build items list from medications + catalog prices.
    //
    // The e_prescriptions.medications JSONB carries clinician-entered shape
    // — `medication_name` is the canonical field, with `name` accepted as
    // alias for older Rx payloads. Pull every dispensing-relevant field
    // (dose, frequency, route, duration, instructions) into the order's
    // items_list so the counter pharmacist + label endpoint have what they
    // need without re-reading the prescription. Resolve catalog_id when we
    // can — this is what markCounterDispensed/markDelivered use to decrement
    // stock; otherwise stock movement silently drops to zero.
    //
    // Findings:
    //   2026-05-09-walk-in-opd-pharmacy-order-items-missing-medication-details
    //   2026-05-09-inpatient-admission-pharmacy-order-pharmacy-items-zero-price-no-stock
    //   2026-05-09-walk-in-opd-pharmacy-stock-not-decremented
    const medications = rx.medications || [];
    const itemsList = [];
    let totalCost = 0;

    // Catalog-match every line; if any medication can't be resolved to a
    // catalog row, refuse the order. Previously unmatched lines silently
    // landed at price=0 / catalog_id=null / line_total=0, and the
    // counter-dispense flow then marked the order DISPENSED + the Rx
    // fulfilled with zero stock movement and zero bill. For a paediatric
    // patient that means the formulation never matched (e.g. syrup vs
    // tablet) and the system closed the medication loop without proof
    // that the right product left the shelf. Finding:
    //   2026-05-10-pediatric-opd-pharmacy-syrup-non-catalog-zero-bill-fulfilled.
    const unmatched = [];
    // Per-unmatched-name: ranked list of catalog rows that look like a
    // formulation of the same generic, so the pharmacist's counter UI can
    // show alternatives and re-submit with an explicit catalog_id instead
    // of asking the doctor to re-prescribe with the exact brand string.
    // Closes finding 2026-05-15-walk-in-opd-pharmacy-f095b90a — a generic
    // 'Paracetamol' Rx for a 2 y/o failed even though four stocked
    // paediatric syrups existed (Paracetamol Syrup 125mg/5ml etc.). The
    // exact ILIKE match below is preserved as the happy path; the
    // alternatives are surfaced only when no exact match exists, with
    // stock + price so the UI can sort/filter.
    const suggestions = {};

    for (const [medIndex, med] of medications.entries()) {
      const medName = med.base_name || med.medication_name || med.name || med.drug_name || '';
      const medDisplayName = med.display_name || med.displayName || medName;
      let price = 0;
      let catalogName = null;
      const selectedCatalogId = findCatalogSelection(catalogSelections, med, medName, medIndex);
      let catalogId = selectedCatalogId ?? (med.catalog_id ? Number(med.catalog_id) : null);
      if (Number.isFinite(catalogId)) {
        const catRes = await prisma.$queryRawUnsafe(
          `SELECT id, name, unit_price
             FROM pharmacy_catalog
            WHERE id=$1
              AND COALESCE(is_active, true) = true`,
          catalogId
        );
        if (catRes.length > 0) {
          price = parseFloat(catRes[0].unit_price) || 0;
          catalogName = catRes[0].name;
        } else {
          catalogId = null;
        }
      }
      if (!catalogId && medName) {
        const catRes = await prisma.$queryRawUnsafe(
          'SELECT id, name, unit_price FROM pharmacy_catalog WHERE name ILIKE $1 LIMIT 1',
          medName
        );
        if (catRes.length > 0) {
          catalogId = catRes[0].id;
          price = parseFloat(catRes[0].unit_price) || 0;
          catalogName = catRes[0].name;
        }
      }
      if (!catalogId) {
        unmatched.push(medName || '(unnamed medication)');
        // Build the alternative list only when we're going to surface
        // it — a prefix-ILIKE on pharmacy_catalog with the first token
        // of the medication name covers the common "generic vs branded
        // formulation" mismatch. Limited to 6 rows per medication so
        // the response stays bounded.
        if (medName) {
          const firstToken = medName.split(/[\s,/-]/, 1)[0]?.trim();
          if (firstToken && firstToken.length >= 3) {
            try {
              const altRes = await prisma.$queryRawUnsafe(
                `SELECT id, name, unit_price, stock_quantity, in_stock
                   FROM pharmacy_catalog
                  WHERE name ILIKE $1 || '%'
                    AND COALESCE(is_active, true) = true
                  ORDER BY (COALESCE(stock_quantity, 0) > 0) DESC,
                           COALESCE(stock_quantity, 0) DESC,
                           name ASC
                  LIMIT 6`,
                firstToken
              );
              if (altRes.length > 0) {
                suggestions[medName] = altRes.map(r => ({
                  id: r.id,
                  name: r.name,
                  unit_price: parseFloat(r.unit_price) || 0,
                  stock_quantity: r.stock_quantity ?? 0,
                  in_stock: Boolean(r.in_stock) && (r.stock_quantity ?? 0) > 0
                }));
              }
            } catch (suggestErr) {
              // Best-effort — failure to build alternatives should not
              // mask the underlying ITEM_NOT_IN_CATALOG error.
              logger.warn(
                `pharmacy alt-suggest lookup failed for "${medName}":`,
                suggestErr.message
              );
            }
          }
        }
      }
      const doseText = med.dose || med.dosage || med.strength || '';
      const instructionText = med.instructions || med.notes || '';
      const foodTiming = med.food_timing || med.foodTiming || null;
      const doseTimes = Array.isArray(med.dose_times)
        ? med.dose_times
        : Array.isArray(med.doseTimes)
          ? med.doseTimes
          : [];

      // Child weight for weight-based (mg/kg) liquid dosing. Explicit field
      // wins; then a weight named in the dose/instruction free-text; then the
      // patient's recorded weight (charted vital / users.weight_kg) resolved
      // in the rx query above. Without the recorded-weight fallback a script
      // that says "15mg/kg for 12.5kg child" but uses no "weight:" keyword
      // left child_weight_kg null on the label.
      // Finding: 2026-05-22-pediatric-opd-pharmacy-f346bf82.
      const childWeightKg =
        med.child_weight_kg != null
          ? Number(med.child_weight_kg)
          : (parseWeightKgFromText(doseText, instructionText) ??
            (Number(rx.patient_weight_kg) > 0 ? Number(rx.patient_weight_kg) : null));

      // Concentration of the liquid AS PRESCRIBED (mg/mL + its mL
      // denominator), parsed from the clinician's own strength / dosage /
      // dose text / medication name — deliberately NOT the catalog name, so
      // the derived baseline volume reflects what the doctor prescribed. A
      // catalog substitution to a different concentration is handled (and
      // recalculated) separately below. Needed so the dose VOLUME is derived
      // from the prescribed mg, not copied from the concentration denominator.
      const concentrationMgPerMl = parseConcentrationMgPerMl(
        med.strength,
        med.dosage,
        doseText,
        medName
      );
      const concentrationMl = parseConcentrationMl(med.strength, med.dosage, doseText, medName);

      // Per-dose volume for the label. An explicitly-supplied value wins.
      // Otherwise derive it weight-first: (mg/kg × weight) ÷ concentration,
      // falling back to an explicit mg ÷ concentration, then to a free-text
      // mL token that is NOT the concentration denominator. Only as a last
      // resort do we use the legacy last-ml-token parse (kept for lines with
      // no concentration at all, e.g. "Syp K-Lyte 15mL"). This replaces the
      // old parseMlFromText() default that grabbed the trailing "5ml" out of
      // "7.5ml of 125mg/5ml syrup" and underdosed the child.
      // Finding: 2026-05-22-pediatric-opd-pharmacy-f346bf82.
      let doseMlMeta = null;
      let dispensedQuantityMl;
      if (med.dispensed_quantity_ml != null) {
        dispensedQuantityMl = Number(med.dispensed_quantity_ml);
      } else {
        doseMlMeta = deriveLiquidDoseMl({
          doseText,
          instructionText,
          concentrationMgPerMl,
          concentrationMl,
          weightKg: childWeightKg
        });
        dispensedQuantityMl = doseMlMeta
          ? doseMlMeta.ml
          : parseMlFromText(doseText, instructionText);
      }

      // Is this a liquid (mL-dosed) oral form? Only liquids get mL volume
      // recalculation and the "measure X ml with an oral syringe" wording.
      // A solid oral form (tablet/capsule) carrying an explicit mL volume
      // is treated as liquid (the volume is the dosing signal); otherwise a
      // solid is solid and never gets liquid instructions. An explicitly
      // supplied dispensed_quantity_ml also counts as a liquid signal.
      // Finding: 2026-05-21-walk-in-opd-pharmacy-1646bc24.
      const formSignal = isLiquidForm(
        catalogName,
        medName,
        med.form,
        med.dosage_form,
        doseText,
        med.strength,
        instructionText
      );
      const lineIsLiquid =
        formSignal === true ||
        (formSignal === null && Number.isFinite(dispensedQuantityMl) && dispensedQuantityMl > 0);

      // A solid form never carries an mL measuring volume — drop any value
      // parsed incidentally from free text so it can't leak onto the label.
      if (!lineIsLiquid) dispensedQuantityMl = null;

      // Quantity resolution. Previously this silently defaulted any line
      // with no explicit quantity to 1 — so a "1-1-1 × 3 days" tablet Rx
      // (clinically 9 tablets) became a 1-tablet order, and a busy counter
      // could hand over a single tablet for a 3-day course. Now: an explicit
      // positive quantity always wins; otherwise, for a count-dosed (solid)
      // line we derive frequency × duration; only when neither is possible do
      // we fall back to 1 AND flag the line so the counter UI / dispense guard
      // knows the quantity was guessed, never confirmed.
      // Finding: 2026-05-21-walk-in-opd-pharmacy-1646bc24 (+ 938226ba).
      const explicitQty = parseIntegerField(med.quantity ?? med.qty);
      let qty;
      let quantitySource;
      let quantityNeedsConfirmation = false;
      if (Number.isInteger(explicitQty) && explicitQty > 0) {
        qty = explicitQty;
        quantitySource = 'explicit';
      } else {
        const derived = lineIsLiquid
          ? null
          : deriveDispenseQuantity({ frequency: med.frequency, duration: med.duration });
        if (derived != null) {
          qty = derived;
          quantitySource = 'derived_frequency_duration';
        } else {
          qty = 1;
          quantitySource = 'defaulted';
          quantityNeedsConfirmation = true;
        }
      }
      const lineTotal = Number((price * qty).toFixed(2));

      // When the pharmacist substitutes a catalog item with a different
      // concentration (e.g. 250mg/5mL → 125mg/5mL), the original mL volume
      // is no longer correct. Scale it to preserve the prescribed mg dose;
      // if concentrations cannot be parsed, null the volume so the counter
      // pharmacist must enter it manually rather than silently dispensing
      // the wrong amount. Finding: 2026-05-21-walk-in-opd-pharmacy-c05e2adb.
      // The whole mL-conversion path is liquid-only: a tablet matched to its
      // own catalog row (with a trivial whitespace name diff) must NOT raise
      // a "confirm the volume" dose-conversion warning. Finding: 1646bc24.
      let substitutionMeta = null;
      const isExplicitSubstitution = Boolean(
        selectedCatalogId && catalogName && catalogName.toLowerCase() !== medName.toLowerCase()
      );
      if (isExplicitSubstitution && !lineIsLiquid) {
        // Solid-form substitution: record it for traceability, but never
        // emit mL recalculation or a dose-conversion warning.
        substitutionMeta = { requested_name: medName, catalog_name: catalogName, explicit: true };
      } else if (isExplicitSubstitution) {
        const origConc = parseConcentrationMgPerMl(med.strength || med.dosage || medName);
        const newConc = parseConcentrationMgPerMl(catalogName);
        const origVol = Number.isFinite(dispensedQuantityMl) ? dispensedQuantityMl : null;
        if (origConc && newConc && Math.abs(origConc - newConc) > 0.001 && origVol !== null) {
          const recalcVol = Number(((origVol * origConc) / newConc).toFixed(2));
          substitutionMeta = {
            requested_name: medName,
            catalog_name: catalogName,
            explicit: true,
            original_dispensed_quantity_ml: origVol,
            recalculated_dispensed_quantity_ml:
              Number.isFinite(recalcVol) && recalcVol > 0 ? recalcVol : null
          };
          dispensedQuantityMl = Number.isFinite(recalcVol) && recalcVol > 0 ? recalcVol : null;
        } else if (origConc && newConc && Math.abs(origConc - newConc) <= 0.001) {
          substitutionMeta = { requested_name: medName, catalog_name: catalogName, explicit: true };
        } else {
          // Could not determine whether concentrations match — require manual dose check.
          substitutionMeta = {
            requested_name: medName,
            catalog_name: catalogName,
            explicit: true,
            dose_conversion_required: true
          };
          dispensedQuantityMl = null;
        }
      }

      // Substitution-aware measuring instruction: when a concentration change
      // recalculated the volume, regenerate from the new volume (don't keep a
      // stale prescription instruction); when conversion can't be computed,
      // make it explicit so the label never reads a wrong/"null ml" amount.
      // Finding: 2026-05-21-walk-in-opd-pharmacy-c05e2adb.
      // The mL "measure with an oral syringe" wording is liquid-only — a
      // solid oral form keeps only an explicit pharmacist-set instruction
      // (never the auto liquid default). Finding: 1646bc24.
      let measuringInstruction;
      if (!lineIsLiquid) {
        measuringInstruction = med.measuring_instruction || null;
      } else if (substitutionMeta?.dose_conversion_required) {
        measuringInstruction =
          'Dose conversion required — pharmacist to confirm the volume for the substituted concentration before dispensing.';
      } else if (substitutionMeta && substitutionMeta.recalculated_dispensed_quantity_ml != null) {
        measuringInstruction = defaultMeasuringInstruction(dispensedQuantityMl);
      } else {
        measuringInstruction =
          med.measuring_instruction || defaultMeasuringInstruction(dispensedQuantityMl);
      }
      totalCost += lineTotal;
      itemsList.push({
        catalog_id: catalogId,
        name: medName,
        medication_name: medName,
        display_name: medDisplayName,
        catalog_name: catalogName,
        substitution: substitutionMeta,
        strength: med.strength || med.dosage || null,
        dose: doseText || null,
        route: med.route || null,
        frequency: med.frequency || null,
        dose_times: doseTimes,
        food_timing: foodTiming,
        duration: med.duration || null,
        instructions: instructionText || null,
        dispensed_quantity_ml: Number.isFinite(dispensedQuantityMl) ? dispensedQuantityMl : null,
        child_weight_kg: Number.isFinite(childWeightKg) ? childWeightKg : null,
        measuring_instruction: measuringInstruction,
        label_instruction:
          [foodTiming, instructionText || null, measuringInstruction].filter(Boolean).join(' ') ||
          null,
        qty,
        prescribed_qty: qty,
        quantity_source: quantitySource,
        // Solid lines that fell back to qty=1 because frequency/duration
        // could not be parsed: the dispense flow must require the pharmacist
        // to confirm/correct the count rather than silently honour 1.
        quantity_needs_confirmation: quantityNeedsConfirmation,
        price,
        line_total: lineTotal
      });
    }
    totalCost = Number(totalCost.toFixed(2));

    if (unmatched.length) {
      const detail = { code: 'ITEM_NOT_IN_CATALOG', unmatched };
      if (Object.keys(suggestions).length > 0) {
        detail.suggestions = suggestions;
      }
      const hint =
        Object.keys(suggestions).length > 0
          ? ' Available alternatives included in `suggestions` — re-submit with the chosen catalog_id.'
          : ' Add the catalog entry (correct formulation/strength) and retry.';
      return error(
        res,
        `Cannot create pharmacy order — items not in catalog: ${unmatched.join('; ')}.${hint}`,
        HTTP_STATUS.BAD_REQUEST,
        detail
      );
    }

    // Create pharmacy order.
    // Three drift fixes per finding 2026-05-08-pediatric-opd-pharmacy-order-from-rx-500:
    //   1. `updated_at` is NOT NULL with no default — insert NOW().
    //   2. `order_number` has a DB default in main schema but absent in the
    //      under-migrated swarm tenant DB. Generate it explicitly so the
    //      INSERT succeeds either way (RETURNING then surfaces it).
    //   3. Status default + downstream state machine are UPPERCASE
    //      (`PENDING`); lowercase `pending` was rejected by transitions in
    //      pharmacyOrderController and broke confirm/dispatch flows.
    const phone = delivery_phone || rx.patient_phone;
    const orderNumber = `PO-${randomUUID().replace(/-/g, '')}`;
    // Stage-4-C — `patient_phone` is a distinct column from `phone`
    // (delivery-channel identifier) and is what /pharmacy/orders/queue +
    // /pharmacy/orders/:id/detail surface to the counter pharmacist for
    // ready-call SMS. The previous INSERT only set `phone` + delivery_phone,
    // leaving patient_phone NULL even when the patient row had a number.
    // Finding: 2026-05-09-inpatient-admission-pharmacy-patient-phone-null-in-order
    const orderResult = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders
        (phone, patient_id, patient_name, patient_phone, order_note, delivery_type, delivery_address, delivery_phone,
         items_list, total_amount, status, order_number, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'PENDING', $11, NOW())
       RETURNING id, uid, patient_id, patient_name, patient_phone, status, order_note, total_amount, created_at, updated_at, order_number, delivery_type`,
      phone,
      rx.patient_id,
      rx.patient_name,
      rx.patient_phone || null,
      `Auto-order from prescription ${rx.prescription_number}`,
      delivery_type,
      delivery_address || null,
      delivery_phone || phone,
      JSON.stringify(itemsList),
      totalCost,
      orderNumber
    );
    const pharmacyOrder = orderResult[0];

    // Link back to prescription. For a refill, repoint pharmacy_order_id
    // to the new order and re-arm the Rx for the new fulfillment cycle
    // (status flips back to pharmacy_linked from fulfilled).
    await prisma.$queryRawUnsafe(
      `UPDATE e_prescriptions
       SET pharmacy_order_id = $1, pharmacy_opted = TRUE, pharmacy_opt_type = $2,
           status = 'pharmacy_linked', updated_at = NOW()
       WHERE id = $3`,
      pharmacyOrder.id,
      delivery_type,
      id
    );

    logAudit(
      req,
      isRefill ? 'OP_PRESCRIPTION_REFILL_SENT_TO_PHARMACY' : 'OP_PRESCRIPTION_SENT_TO_PHARMACY',
      {
        prescription_id: id,
        prescription_number: rx.prescription_number,
        pharmacy_order_id: pharmacyOrder.id,
        pharmacy_order_uid: pharmacyOrder.uid,
        pharmacy_order_number: pharmacyOrder.order_number,
        patient_id: rx.patient_id,
        patient_name: rx.patient_name,
        delivery_type,
        item_count: itemsList.length,
        total_amount: totalCost
      },
      { resource: 'pharmacy_orders', resourceId: pharmacyOrder.id }
    ).catch(auditErr => {
      logger.warn(`Prescription pharmacy audit failed for rx ${id}: ${auditErr.message}`);
    });

    // Notify pharmacy staff
    dispatch({
      userId: 'pharmacy', // will fail gracefully — intended for in-app
      title: isRefill ? '🔁 Rx Refill Order' : '🛒 New Rx Pharmacy Order',
      body: `Order ${pharmacyOrder.order_number}${isRefill ? ' (refill)' : ''} from prescription ${rx.prescription_number}`,
      channels: ['inapp'],
      type: 'pharmacy_order'
    }).catch(e => logger.warn('Pharmacy staff notification failed:', e.message));

    success(
      res,
      pharmacyOrder,
      `Pharmacy ${isRefill ? 'refill order' : 'order'} ${pharmacyOrder.order_number} created from prescription`
    );
  } catch (err) {
    logger.error('Order pharmacy from prescription error:', err);
    error(res, 'Failed to create pharmacy order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Shared prescription-access predicate. Patient-role callers may only access
// their OWN prescriptions; the listed staff roles read any. Single-sourced so
// the by-id, by-appointment, and PDF endpoints can't drift apart — the PDF +
// by-appointment endpoints previously OMITTED this and were patient-to-patient
// IDOR-able by enumerating the SERIAL prescription/appointment id (#4).
const PRESCRIPTION_READ_ROLES = [
  'ADMIN',
  'SUPER_ADMIN',
  'DOCTOR',
  'NURSING_STAFF',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
  'BILLING_STAFF',
];

function callerMayAccessPrescription(req, patientId) {
  const role = String(req.user?.role || '').toUpperCase();
  if (PRESCRIPTION_READ_ROLES.includes(role)) return true;
  const callerId = req.user?.id ?? req.user?.userId;
  return !!callerId && String(patientId) === String(callerId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/pdf/:id — download prescription PDF (signed URL redirect)
// ═══════════════════════════════════════════════════════════════════════════════
export const downloadPrescriptionPDF = async (req, res) => {
  try {
    // Same string→int coercion as getPrescription. See finding
    // 2026-05-08-walk-in-opd-doctor-prescription-get-by-id-fails.
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await prisma.$queryRawUnsafe(
      'SELECT pdf_key, patient_id FROM e_prescriptions WHERE id=$1',
      id
    );
    if (result.length === 0 || !result[0].pdf_key) {
      return error(res, 'PDF not found', HTTP_STATUS.NOT_FOUND);
    }
    // IDOR: a PATIENT may only download their OWN prescription PDF.
    if (!callerMayAccessPrescription(req, result[0].patient_id)) {
      return error(res, 'PDF not found', HTTP_STATUS.NOT_FOUND);
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = await getSignedFileUrl(result[0].pdf_key, 3600, { baseUrl });
    success(res, { url }, 'PDF URL');
  } catch (err) {
    logger.error('Download prescription PDF error:', err);
    error(res, 'Failed to get PDF', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
