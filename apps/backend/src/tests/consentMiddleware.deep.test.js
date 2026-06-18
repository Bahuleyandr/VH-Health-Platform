// consentMiddleware.deep.test.js
//
// PHI finding #3 (PLATFORM_AUDIT_2026-06-18 §3): requireConsent was dead code
// (mounted nowhere). Decision = (a): it is now mounted on the third-party/interop
// EXPORT surfaces (FHIR $everything in fhirRoutes.js; CCDA/fhir-bundle export in
// documentRoutes.js — reported for app.js). These tests prove the middleware is
// correct as an export gate:
//
//   * a missing / revoked active consent → 403 on the export route
//   * a present active consent of the required type → passes (200)
//   * tenant isolation: a consent in another tenant does not authorize here
//   * the optional resolvePatientUid hook lets FHIR addressing (Patient/<uuid>,
//     ?patient=, subject.reference) feed the same generic check
//
// DB-backed; self-skips without a test DB. Self-isolating fixtures.

import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { requireConsent } from '../middleware/consentMiddleware.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const RUN = `${process.pid}${Date.now() % 100000}`;
const SUF = String(RUN).slice(-6).padStart(6, '0');
const PATIENT_NAME = `CONSENT Patient ${RUN}`;
const PATIENT_PHONE = `+91982${SUF}`; // +91 + 10 digits
// A real, distinct tenant that exists in the test DB (FK fk_patient_consents_tenant).
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const EXPORT_CONSENT = 'data_sharing';

let patientUid;

// Build a throwaway app that injects a staff identity + tenant, then mounts
// requireConsent on a stand-in export route. `resolver` lets a test exercise the
// optional FHIR-addressing hook.
function exportApp({ role = 'MEDICAL_RECORDS', tenantId = DEFAULT_TENANT_ID, resolver } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { uid: 'staff-uid', role, tenant_id: tenantId };
    req.tenantId = tenantId;
    next();
  });
  const mw = resolver ? requireConsent(EXPORT_CONSENT, { resolvePatientUid: resolver }) : requireConsent(EXPORT_CONSENT);
  app.get('/export/:patientUid', mw, (_req, res) => res.json({ success: true, exported: true }));
  // FHIR-style export: patient addressed as /Patient/:id (no patient_uid param).
  app.get('/fhir/Patient/:id/everything', mw, (_req, res) => res.json({ success: true, exported: true }));
  return app;
}

async function clearConsents() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_consents WHERE patient_uid = $1::uuid`,
    patientUid,
  ).catch(() => {});
}

async function grantConsent({ type = EXPORT_CONSENT, tenantId = DEFAULT_TENANT_ID, revoked = false } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_consents
       (patient_uid, consent_type, granted, status, granted_at, revoked_at,
        data_categories, version, source, tenant_id, created_at, updated_at)
     VALUES ($1::uuid, $2, true, $3, NOW(), $4,
        '[]'::jsonb, 'v1', 'test', $5::uuid, NOW(), NOW())`,
    patientUid,
    type,
    revoked ? 'revoked' : 'active',
    revoked ? new Date() : null,
    tenantId,
  );
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_consents WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    PATIENT_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, PATIENT_NAME).catch(() => {});
}

d('requireConsent as an export gate (audit §3 finding #3)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1, $2, 'PATIENT', true, $3::uuid, NOW()) RETURNING uid`,
      PATIENT_PHONE, PATIENT_NAME, DEFAULT_TENANT_ID,
    );
    patientUid = p[0].uid;
  });

  beforeEach(clearConsents);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('export route 403s when no active consent exists', async () => {
    const res = await request(exportApp()).get(`/export/${patientUid}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test('export route passes (200) when an active consent of the required type exists', async () => {
    await grantConsent();
    const res = await request(exportApp()).get(`/export/${patientUid}`);
    expect(res.status).toBe(200);
    expect(res.body.exported).toBe(true);
  });

  test('a REVOKED consent does not authorize the export (403)', async () => {
    await grantConsent({ revoked: true });
    const res = await request(exportApp()).get(`/export/${patientUid}`);
    expect(res.status).toBe(403);
  });

  test('a consent of a DIFFERENT type does not authorize the export (403)', async () => {
    await grantConsent({ type: 'treatment' });
    const res = await request(exportApp()).get(`/export/${patientUid}`);
    expect(res.status).toBe(403);
  });

  test('a consent in ANOTHER tenant does not authorize this tenant (403)', async () => {
    await grantConsent({ tenantId: OTHER_TENANT_ID });
    // Caller is in DEFAULT_TENANT_ID; the only consent row is in OTHER_TENANT_ID.
    const res = await request(exportApp()).get(`/export/${patientUid}`);
    expect(res.status).toBe(403);
  });

  test('the optional resolvePatientUid hook feeds FHIR Patient/:id addressing into the same check', async () => {
    await grantConsent();
    const resolver = (req) => req.params.id; // FHIR route uses :id, not :patientUid
    const res = await request(exportApp({ resolver })).get(`/fhir/Patient/${patientUid}/everything`);
    expect(res.status).toBe(200);
    expect(res.body.exported).toBe(true);
  });

  test('FHIR-addressed export still 403s without consent (resolver does not bypass the gate)', async () => {
    const resolver = (req) => req.params.id;
    const res = await request(exportApp({ resolver })).get(`/fhir/Patient/${patientUid}/everything`);
    expect(res.status).toBe(403);
  });
});
