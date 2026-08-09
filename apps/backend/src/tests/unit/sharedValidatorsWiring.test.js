// Behavioral + wiring coverage for the composed domain validators in
// src/validators/sharedValidators.js.
//
// Two layers:
//  1. Behavior: each validator chain is mounted in a minimal express app
//     (chain → validate → 200 sink) and driven with (a) a payload matching
//     the LIVE route contract, which must pass, and (b) a malformed payload,
//     which must produce a 400 validation response — never a 500 or a crash.
//  2. Wiring pins: each intended route file must actually spread the
//     validator into its route chain, so an accidental unwiring fails CI.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { validationResult } from 'express-validator';
import request from 'supertest';

import {
  vitalsValidator,
  marScheduleValidator,
  marAdministerValidator,
  handoverValidator,
  invoiceValidator,
  paymentValidator,
  insuranceClaimValidator,
  radiologyOrderValidator,
  bloodRequestValidator,
  dietaryOrderValidator,
  theatreScheduleValidator,
  referralValidator,
  consentValidator,
  messageValidator,
  reminderValidator,
  breachReportValidator,
  qualityIncidentValidator,
  systemSettingsValidator,
  featureFlagValidator,
  doctorCreateValidator,
} from '../../validators/sharedValidators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..');

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

function appFor(chain, { withIdParam = false } = {}) {
  const app = express();
  app.use(express.json());
  app.post(withIdParam ? '/t/:id' : '/t', ...chain, validate, (req, res) => res.status(200).json({ ok: true, body: req.body }));
  return app;
}

// validator | uses :id param | one valid live-contract payload | malformed payloads
const CASES = [
  ['vitalsValidator', vitalsValidator, false,
    [{ patient_uid: UUID, heart_rate: 118, spo2: 94 }, { patient_id: 42 }],
    [{}, { patient_uid: UUID, heart_rate: 'racing' }, { patient_uid: 'nope' },
      { patient_id: '12abc' }, { patient_uid: UUID, visit_id: '7suffix' }]],
  ['marScheduleValidator', marScheduleValidator, false,
    [{ patient_uid: UUID }, { patient_uid: UUID, medications: [{ medication_name: 'Amoxicillin', dose: '500mg', route: 'oral', scheduled_time: '2026-08-10T08:00:00Z' }] }],
    [{ patient_uid: 'nope' }, { patient_uid: UUID, medications: 'paracetamol' }, { patient_uid: UUID, medications: ['paracetamol'] }]],
  ['marAdministerValidator', marAdministerValidator, true,
    [{ notes: 'given with food' }, { override_reason: 'scanner down, verified manually', witness_uid: UUID2 }],
    [{ witness_uid: 'nurse-bob' }, { notes: 'x'.repeat(501) }]],
  ['handoverValidator', handoverValidator, false,
    [{ patient_uid: UUID, summary: 'Post-op, stable', incoming_nurse: UUID2, shift: 'morning', pending_tasks: ['pain review'] }],
    [{ patient_uid: UUID, summary: 'Post-op', shift: 'morning' },
      { patient_uid: UUID, summary: 'Post-op', incoming_nurse: 'nurse-bob', shift: 'morning' },
      { patient_uid: UUID, summary: 'Post-op', incoming_nurse: UUID2, shift: 'morning', pending_tasks: 'call ICU' }]],
  ['invoiceValidator', invoiceValidator, false,
    [{ patient_uid: UUID, type: 'consultation', items: [{ description: 'OPD', amount: 500 }], subtotal: 500, total_amount: 500 },
      { patient_uid: UUID, type: 'pharmacy', items: [{}], subtotal: 0, total_amount: 0 }],
    [{ patient_uid: UUID, type: 'consultation', items: [], subtotal: 100, total_amount: 100 },
      { patient_uid: UUID, type: 'consultation', items: ['OPD'], subtotal: 100, total_amount: 100 },
      { patient_uid: UUID, type: 'consultation', items: [{}], total_amount: 100 },
      { patient_uid: UUID, items: [{}], subtotal: 1, total_amount: 1 }]],
  ['paymentValidator', paymentValidator, true,
    [{ amount: 100, payment_method: 'CASH', transaction_ref: 'TXN-1' },
      { amount: 100, payment_method: 'upi' }],
    [{ amount: 100, payment_method: 'BITCOIN' }, { payment_method: 'CASH' }]],
  ['insuranceClaimValidator', insuranceClaimValidator, false,
    [{ patient_uid: UUID, policy_number: 'POL-9', insurance_provider: 'Acme Health', claim_amount: 1200, invoice_id: '7' }],
    [{ patient_uid: UUID, policy_number: 'POL-9', claim_amount: 1200 },
      { patient_uid: UUID, policy_number: 'POL-9', insurance_provider: 'Acme', claim_amount: 1200, invoice_id: 'seven' }]],
  ['radiologyOrderValidator', radiologyOrderValidator, false,
    [{ patient_uid: UUID, modality: 'XRAY', body_part: 'chest', clinical_indication: 'cough' }],
    [{ patient_uid: UUID, body_part: 'chest' }, { patient_uid: UUID, modality: 'XRAY' }]],
  ['bloodRequestValidator', bloodRequestValidator, false,
    [{ patient_uid: UUID, blood_group: 'A+', units: 2, component: 'prbc', clinical_indication: 'anemia', urgency: 'urgent' }],
    [{ patient_uid: UUID, blood_group: 'A+', units: 2, component: 'PACKED_RBC', clinical_indication: 'anemia' },
      { patient_uid: UUID, blood_group: 'A+', units: 2, component: 'prbc' },
      { patient_uid: UUID, blood_group: 'A+', units: 1.5, component: 'prbc', clinical_indication: 'anemia' },
      { patient_uid: UUID, blood_group: 'Z+', units: 2, component: 'prbc', clinical_indication: 'anemia' }]],
  ['dietaryOrderValidator', dietaryOrderValidator, false,
    [{ patient_uid: UUID, diet_type: 'diabetic', restrictions: ['low salt'], allergies: 'nuts, shellfish' }],
    [{ patient_uid: UUID, diet_type: 'keto' }, { patient_uid: UUID, diet_type: 'diabetic', restrictions: 42 }]],
  ['theatreScheduleValidator', theatreScheduleValidator, false,
    [{ patient_uid: UUID, procedure_name: 'Lap chole', surgeon: UUID2, scheduled_date: '2026-09-01', equipment_needed: ['laparoscope'], consent_obtained: true }],
    [{ patient_uid: UUID, procedure_name: 'Lap chole', surgeon: 'dr-bob', scheduled_date: '2026-09-01' },
      { patient_uid: UUID, procedure_name: 'Lap chole', surgeon: UUID2 },
      { patient_uid: UUID, procedure_name: 'Lap chole', surgeon: UUID2, scheduled_date: 'next tuesday' },
      { patient_uid: UUID, procedure_name: 'Lap chole', surgeon: UUID2, scheduled_date: '2026-09-01', equipment_needed: [{}] }]],
  ['referralValidator', referralValidator, false,
    [{ patient_uid: UUID, reason: 'Acute abdomen', referred_to_department: 'Surgery' },
      { patient_uid: UUID, reason: 'Acute abdomen', to_department: 'Surgery' }],
    [{ patient_uid: UUID, reason: 'Acute abdomen' }, { reason: 'Acute abdomen', referred_to_department: 'Surgery' }]],
  ['consentValidator', consentValidator, false,
    [{ patient_uid: UUID, consent_type: 'surgery', consent_method: 'verbal', purpose: 'Procedure', data_categories: ['clinical'], expires_at: '2027-08-10', witness_name: 'A. Witness', witness_uid: UUID2 }],
    [{ patient_uid: UUID }, { patient_uid: UUID, consent_type: 'surgery', witness_uid: 'mr-witness' },
      { patient_uid: UUID, consent_type: 'surgery', consent_method: 'telephone' },
      { patient_uid: UUID, consent_type: 'surgery', data_categories: [{}] }]],
  ['messageValidator', messageValidator, false,
    [{ recipient_uid: UUID2, body: 'Please review bed 4', priority: 'urgent' }],
    [{ recipient_uid: UUID2 }, { recipient_uid: 'nurse-bob', body: 'hi' },
      { recipient_uid: UUID2, body: 'hi', priority: 'high' }]],
  ['reminderValidator', reminderValidator, false,
    [{ medication_name: 'Metformin', dosage: '500mg', frequency: 'BD', reminder_times: ['08:00', '20:00'], start_date: '2026-08-10' }],
    [{ medication_name: 'Metformin', dosage: '500mg', frequency: 'BD', reminder_times: [], start_date: '2026-08-10' },
      { medication_name: 'Metformin', dosage: '500mg', frequency: 'BD', reminder_times: ['8am'], start_date: '2026-08-10' },
      { medication_name: 'Metformin', dosage: '500mg', frequency: 'BD', reminder_times: [800], start_date: '2026-08-10' },
      { medication_name: 'Metformin', dosage: '500mg', frequency: 'BD', reminder_times: ['08:00'] }]],
  ['breachReportValidator', breachReportValidator, false,
    [{ title: 'Unauthorised export', description: 'Laptop stolen', severity: 'high', affected_records: 12, affected_patient_uids: [UUID], phi_involved: true }],
    [{ title: 'Unauthorised export', description: 'Laptop stolen', severity: 'HIGH' },
      { title: 'Unauthorised export', severity: 'high' },
      { title: 'Unauthorised export', description: 'Laptop stolen', severity: 'high', affected_records: 1.5 },
      { title: 'Unauthorised export', description: 'Laptop stolen', severity: 'high', affected_patient_uids: 'all' },
      { title: 'Unauthorised export', description: 'Laptop stolen', severity: 'high', affected_patient_uids: ['not-a-uuid'] },
      { title: 'Unauthorised export', description: 'Laptop stolen', severity: 'high', phi_involved: 'false' }]],
  ['qualityIncidentValidator', qualityIncidentValidator, false,
    [{ description: 'Patient fall in ward B', incident_type: 'fall', severity: 'moderate', date_occurred: '2026-08-01', patient_uid: UUID }],
    [{ description: 'fall', incident_type: 'FALL', severity: 'moderate', date_occurred: '2026-08-01' },
      { description: 'fall', incident_type: 'fall', severity: 'moderate' }]],
  ['systemSettingsValidator', systemSettingsValidator, false,
    [{ maintenance_mode: true }],
    [[1, 2, 3]]],
  ['featureFlagValidator', featureFlagValidator, false,
    [{ name: 'new-portal', enabled: true, rollout_percentage: 50, allowed_roles: ['ADMIN'] }],
    [{ enabled: true }, { name: 'new-portal', rollout_percentage: 150 }, { name: 'new-portal', enabled: 'sometimes' },
      { name: 'new-portal', allowed_roles: [{}] }]],
  ['doctorCreateValidator', doctorCreateValidator, false,
    [{ name: 'Dr. A', department: 'Cardiology', intro: 'Senior cardiologist' }],
    [{ name: 'Dr. A' }, { department: 'Cardiology' }]],
];

describe('sharedValidators domain chains (behavior)', () => {
  describe.each(CASES)('%s', (_name, chain, withIdParam, validPayloads, invalidPayloads) => {
    const app = appFor(chain, { withIdParam });
    const path = withIdParam ? '/t/123' : '/t';

    it.each(validPayloads.map((p) => [JSON.stringify(p).slice(0, 80), p]))(
      'accepts live-contract payload %s', async (_label, payload) => {
        const res = await request(app).post(path).send(payload);
        expect(res.statusCode).toBe(200);
      });

    it.each(invalidPayloads.map((p) => [JSON.stringify(p).slice(0, 80), p]))(
      'rejects malformed payload %s with 400', async (_label, payload) => {
        const res = await request(app).post(path).send(payload);
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(Array.isArray(res.body.errors)).toBe(true);
      });
  });

  it('normalizes validated numeric and boolean strings before controllers receive them', async () => {
    const vitalsApp = appFor(vitalsValidator);
    const vitals = await request(vitalsApp).post('/t').send({
      patient_uid: UUID,
      heart_rate: '118',
      supplemental_o2: 'false',
    });
    expect(vitals.statusCode).toBe(200);
    expect(vitals.body.body).toMatchObject({ heart_rate: 118, supplemental_o2: false });

    const paymentApp = appFor(paymentValidator, { withIdParam: true });
    const payment = await request(paymentApp).post('/t/7').send({
      amount: '100.50',
      payment_method: 'UPI',
    });
    expect(payment.statusCode).toBe(200);
    expect(payment.body.body).toMatchObject({ amount: 100.5, payment_method: 'upi' });

    const invoiceApp = appFor(invoiceValidator);
    const invoice = await request(invoiceApp).post('/t').send({
      patient_uid: UUID,
      type: 'consultation',
      items: [{}],
      subtotal: '0',
      total_amount: '0',
    });
    expect(invoice.statusCode).toBe(200);
    expect(invoice.body.body).toMatchObject({ subtotal: 0, total_amount: 0 });

    const claimApp = appFor(insuranceClaimValidator);
    const claim = await request(claimApp).post('/t').send({
      patient_uid: UUID,
      policy_number: 'POL-9',
      insurance_provider: 'Acme Health',
      claim_amount: 1200,
      invoice_id: '7',
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.body.body.invoice_id).toBe(7);
  });
});

describe('sharedValidators route wiring pins', () => {
  const WIRING = [
    ['routes/emr/vitalsRoutes.js', ['vitalsValidator']],
    ['routes/clinical/clinicalRoutes.js', ['marScheduleValidator', 'marAdministerValidator', 'handoverValidator']],
    ['routes/billing/billingRoutes.js', ['invoiceValidator', 'paymentValidator', 'insuranceClaimValidator']],
    ['routes/radiology/radiologyRoutes.js', ['radiologyOrderValidator']],
    ['routes/bloodbank/bloodBankRoutes.js', ['bloodRequestValidator']],
    ['routes/dietary/dietaryRoutes.js', ['dietaryOrderValidator']],
    ['routes/theatre/theatreRoutes.js', ['theatreScheduleValidator']],
    ['routes/referral/referralRoutes.js', ['referralValidator']],
    ['routes/consentRoutes.js', ['consentValidator']],
    ['routes/messaging/messagingRoutes.js', ['messageValidator']],
    ['routes/reminders/index.js', ['reminderValidator']],
    ['routes/compliance/breachRoutes.js', ['breachReportValidator']],
    ['routes/quality/qualityRoutes.js', ['qualityIncidentValidator']],
    ['routes/system/index.js', ['systemSettingsValidator']],
    ['routes/admin/featureFlagRoutes.js', ['featureFlagValidator']],
    ['routes/doctor/adminDoctorRoutes.js', ['doctorCreateValidator']],
  ];

  it.each(WIRING)('%s spreads its shared validator(s) into a route chain', (file, validators) => {
    const source = readFileSync(join(SRC_ROOT, file), 'utf8');
    for (const name of validators) {
      expect(source).toMatch(new RegExp(`\\.\\.\\.${name}\\b`));
    }
  });
});
