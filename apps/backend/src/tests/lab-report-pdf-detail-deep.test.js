// Regression test for finding 2026-05-21-lab-walk-in-patient-2747d82d
// (and the CBC/lipid + lab-only siblings).
//
// For a COMPLETED, signed-off lab order:
//   (a) the lab-report PDF endpoint 500ed, and
//   (b) the investigation detail read came back blank (no values).
//
// Root cause (a): the documents route GET /documents/lab-report/:id/pdf
// passes req.params.investigationId as a STRING; generateLabReportPDF
// then ran `WHERE i.id = $1` against the int PK, and a bound `$1` is typed
// `text` by the driver → Postgres 42883 (`operator does not exist:
// integer = text`) → 500. The generator now Number.parseInt's the id (bad
// id → clean 400) and binds `$1::int`.
//
// Root cause (b): the finalised result values for a lab order live in
// `lab_results` (filed on result entry, frozen on sign-off), NOT in
// `investigations.results` — which stays NULL for the order-set/HL7 flow.
// Both the PDF generator and the patient detail read (getMyLabOrder) now
// merge the verified `lab_results` rows linked by investigation_id.
//
// The test does NOT touch the sign-off notification (#155) or the
// IN_PROGRESS → COMPLETED transition (#160) — those are exercised by
// lab-result-ready-notification.test.js and lab-order-complete-on-signoff.test.js.

import PDFDocument from 'pdfkit';
import prisma from '../lib/prisma.js';
import * as portal from '../services/portal/patientPortalService.js';
import { generateLabReportPDF } from '../services/documents/clinicalPdfGenerator.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d60701';

const createdInvestigationIds = [];

async function seedCompletedOrderWithResults() {
  const inv = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (patient_uid, patient_id, phone, test_name, test_type, status,
        tenant_id, requested_at, completed_at, updated_at)
     VALUES ($1::uuid,
             (SELECT id FROM users WHERE uid = $1::uuid),
             '9006060801', 'Complete Blood Count', 'LAB', 'COMPLETED',
             $2::uuid, NOW(), NOW(), NOW())
     RETURNING id`,
    PATIENT_UID, TENANT,
  );
  const invId = inv[0].id;
  createdInvestigationIds.push(invId);

  // Two verified (signed-off) analytes — these MUST appear on the report.
  await prisma.$executeRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, patient_name, investigation_id, test_code,
        test_name, value_text, value_numeric, unit, reference_range,
        abnormal_flag, status, signed_off_at, hl7_segment_index)
     VALUES ($1::uuid, $2::uuid, 'R. Subramaniam', $3::int, 'HB',
             'Haemoglobin', '13.2', 13.2, 'g/dL', '13-17', NULL,
             'final', NOW(), 1)`,
    TENANT, PATIENT_UID, invId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, patient_name, investigation_id, test_code,
        test_name, value_text, value_numeric, unit, reference_range,
        abnormal_flag, status, signed_off_at, hl7_segment_index)
     VALUES ($1::uuid, $2::uuid, 'R. Subramaniam', $3::int, 'WBC',
             'WBC Count', '12.1', 12.1, 'x10^9/L', '4-11', 'H',
             'final', NOW(), 2)`,
    TENANT, PATIENT_UID, invId,
  );
  // A preliminary (unsigned) analyte — medico-legally unverified, MUST be
  // excluded from the patient-facing report + detail read.
  await prisma.$executeRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, patient_name, investigation_id, test_code,
        test_name, value_text, status, hl7_segment_index)
     VALUES ($1::uuid, $2::uuid, 'R. Subramaniam', $3::int, 'PLT',
             'Platelets', '250', 'preliminary', 3)`,
    TENANT, PATIENT_UID, invId,
  );
  return invId;
}

// Capture every string written to the PDF so we can assert on rendered
// content (pdfkit deflate-compresses the page stream, so byte-grep is
// unreliable). Restored after each test.
function withTextCapture(fn) {
  const captured = [];
  const original = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function patched(text, ...args) {
    captured.push(String(text));
    return original.call(this, text, ...args);
  };
  return Promise.resolve(fn(captured)).finally(() => {
    PDFDocument.prototype.text = original;
  });
}

describe('Lab report PDF + detail for a completed signed-off order', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, gender, birthday, updated_at)
       VALUES ($1::uuid, '9006060801', 'R. Subramaniam', 'PATIENT', true, 'MALE', '1955-03-10', NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT_UID,
    );
  });

  afterAll(async () => {
    for (const id of createdInvestigationIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE investigation_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('returns a valid PDF buffer (not a 500) when the id arrives as a string — the documents-route shape', async () => {
    const invId = await seedCompletedOrderWithResults();
    // Passing String(invId) is exactly what GET /documents/lab-report/:id/pdf
    // does. Before the fix this threw PrismaClientKnownRequestError 42883.
    const buffer = await generateLabReportPDF(String(invId));
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.slice(0, 4).toString()).toBe('%PDF');
  });

  it('renders the finalised result values + units (the report is not blank)', async () => {
    const invId = await seedCompletedOrderWithResults();
    await withTextCapture(async (captured) => {
      const buffer = await generateLabReportPDF(invId);
      expect(buffer.slice(0, 4).toString()).toBe('%PDF');
      const joined = captured.join('\n');
      expect(joined).toContain('Results');
      expect(joined).toContain('Haemoglobin');
      expect(joined).toContain('13.2');
      expect(joined).toContain('g/dL');
      expect(joined).toContain('WBC Count');
      expect(joined).toContain('x10^9/L');
      // Abnormal flag surfaced.
      expect(joined).toContain('[H]');
      // Preliminary (unsigned) analyte must not leak onto the report.
      expect(joined).not.toContain('Platelets');
    });
  });

  it('throws a clean 400 (not a 500) for a non-numeric id', async () => {
    await expect(generateLabReportPDF('not-a-number')).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_INVESTIGATION_ID',
    });
  });

  it('throws a clean 404 (not a 500) for an unknown id', async () => {
    await expect(generateLabReportPDF(987654321)).rejects.toMatchObject({
      statusCode: 404,
      code: 'INVESTIGATION_NOT_FOUND',
    });
  });

  it('detail read merges the verified lab_results so the values are not blank', async () => {
    const invId = await seedCompletedOrderWithResults();
    const detail = await portal.getMyLabOrder({ patient_uid: PATIENT_UID, id: String(invId) });

    expect(Array.isArray(detail.lab_results)).toBe(true);
    // Two verified analytes returned; the preliminary one excluded.
    expect(detail.lab_results).toHaveLength(2);
    const byCode = Object.fromEntries(detail.lab_results.map((r) => [r.test_code, r]));
    expect(byCode.HB.value_text).toBe('13.2');
    expect(byCode.HB.unit).toBe('g/dL');
    expect(byCode.WBC.abnormal_flag).toBe('H');
    expect(detail.lab_results.some((r) => r.test_code === 'PLT')).toBe(false);
  });
});
