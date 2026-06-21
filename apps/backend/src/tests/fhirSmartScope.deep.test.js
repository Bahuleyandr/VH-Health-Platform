// Audit §3 (FHIR/interop) deferred MEDIUM — SMART-on-FHIR scope enforcement,
// DB-integration proof.
//
// The companion unit suite (unit/fhirSmartScopeEnforcement.test.js) mocks the
// SMART verifier to drive the enforcement branches deterministically. This deep
// test proves the SAME enforcement against REAL Postgres + the REAL
// smartOAuthService: it seeds two patients, registers a real SMART app, and
// inserts real smart_access_tokens rows (hashed exactly the way
// verifyAccessToken looks them up), then drives the FHIR router with those real
// bearer tokens. No mocking of the SMART service.
//
// The FHIR router is mounted on a bare express app (the established
// fhir-server / tenant-isolation pattern) rather than the full app.js, because
// the app.js global jwtAuth + the FHIR-mount requireRole reject any
// non-platform-JWT bearer before the router runs (that mount wiring is the one
// app.js change REPORTED separately). Mounting the router directly is exactly
// the surface this fix owns + exercises the real verify→scope→patient-context
// chain end to end.

import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import { __testing__, registerSmartApp, verifyAccessToken } from '../services/smartFhir/smartOAuthService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import fhirRouter from '../routes/fhir/fhirRoutes.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = DEFAULT_TENANT_ID;
const STAMP = String(Date.now()).slice(-9);
const CLIENT_ID = `c3smart_${STAMP}`;

let patientAUid;
let patientBUid;
let smartAppId;

// Build a bare app that mimics the SMART path: no platform JWT (req.user unset),
// tenant resolved by the FHIR router from req.tenantId. The bearer carries the
// SMART token; enforceSmartScopes verifies it and gates the scope/patient.
function buildSmartApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    next();
  });
  app.use('/fhir', fhirRouter);
  return app;
}

// Insert a real access token row, returning the plaintext bearer. Mirrors how
// exchangeAuthorizationCode persists tokens (hashSecret of the plaintext), so
// verifyAccessToken('<plaintext>') resolves it.
async function seedAccessToken({ scopes, patientUid }) {
  const plaintext = `vh_access_${STAMP}_${Math.random().toString(36).slice(2, 10)}`;
  const hash = __testing__.hashSecret(plaintext);
  await prisma.$executeRawUnsafe(
    `INSERT INTO smart_access_tokens
       (tenant_id, smart_app_id, access_token_hash, granted_scopes,
        patient_uid, status, access_expires_at, environment)
     VALUES ($1::uuid, $2, $3, $4::text[], $5::uuid, 'active', NOW() + INTERVAL '1 hour', 'sandbox')`,
    TENANT, smartAppId, hash, scopes, patientUid,
  );
  return plaintext;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM smart_access_tokens WHERE smart_app_id IN
       (SELECT id FROM smart_apps WHERE client_id = $1)`, CLIENT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM smart_apps WHERE client_id = $1`, CLIENT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM vitals_chart WHERE notes = $1`, `SMARTSCOPE ${STAMP}`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, `SMARTSCOPE Patient ${STAMP}`).catch(() => {});
}

d('FHIR SMART scope enforcement (DB integration)', () => {
  beforeAll(async () => {
    await cleanup();

    const pa = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1, $2, 'PATIENT', true, $3::uuid, NOW()) RETURNING uid`,
      `+9199916${STAMP.slice(-4)}`, `SMARTSCOPE Patient ${STAMP}`, TENANT,
    );
    patientAUid = pa[0].uid;
    const pb = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1, $2, 'PATIENT', true, $3::uuid, NOW()) RETURNING uid`,
      `+9199917${STAMP.slice(-4)}`, `SMARTSCOPE Patient ${STAMP}`, TENANT,
    );
    patientBUid = pb[0].uid;

    // A real vitals row for each patient so Observation reads can return data.
    for (const uid of [patientAUid, patientBUid]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO vitals_chart (patient_uid, tenant_id, heart_rate, recorded_at, recorded_by, notes)
         VALUES ($1::uuid, $2::uuid, 72, NOW(), $1::uuid, $3)`,
        uid, TENANT, `SMARTSCOPE ${STAMP}`,
      );
    }

    // Register a real confidential SMART app (confidential ⇒ no PKCE needed for
    // the grant path; we seed tokens directly here regardless).
    const reg = await registerSmartApp({
      tenantId: TENANT,
      clientId: CLIENT_ID,
      displayName: 'C3 SMART Scope Test App',
      appKind: 'confidential',
      redirectUris: ['https://app.example/cb'],
      allowedScopes: ['patient/Observation.read', 'patient/Patient.read', 'user/*.read'],
      environment: 'sandbox',
    });
    smartAppId = reg.app.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('a real token WITHOUT Observation scope is rejected 403', async () => {
    // patient/Patient.read only — cannot read Observation.
    const bearer = await seedAccessToken({
      scopes: ['patient/Patient.read'], patientUid: patientAUid,
    });
    const res = await request(buildSmartApp())
      .get('/fhir/Observation')
      .query({ patient: patientAUid })
      .set('Authorization', `Bearer ${bearer}`);
    expect(res.status).toBe(403);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].code).toBe('forbidden');
  });

  test('a real token WITH patient/Observation.read can read its own patient', async () => {
    const bearer = await seedAccessToken({
      scopes: ['patient/Observation.read'], patientUid: patientAUid,
    });
    const res = await request(buildSmartApp())
      .get('/fhir/Observation')
      .query({ patient: patientAUid })
      .set('Authorization', `Bearer ${bearer}`);
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Bundle');
    // The seeded heart-rate row for patient A comes back.
    const subjects = (res.body.entry || []).map((e) => e.resource?.subject?.reference);
    expect(subjects).toContain(`Patient/${patientAUid}`);
  });

  test('a real token scoped to patient A cannot read patient B (403)', async () => {
    const bearer = await seedAccessToken({
      scopes: ['patient/Observation.read'], patientUid: patientAUid,
    });
    const res = await request(buildSmartApp())
      .get('/fhir/Observation')
      .query({ patient: patientBUid })
      .set('Authorization', `Bearer ${bearer}`);
    expect(res.status).toBe(403);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].details?.text).toBe('FHIR_SMART_PATIENT_FORBIDDEN');
  });

  test('a real user/*.read (org-context) token reads Observation across patients', async () => {
    // No patient_uid ⇒ user-context token; user/*.read covers Observation.read.
    const bearer = await seedAccessToken({
      scopes: ['user/*.read'], patientUid: null,
    });
    const res = await request(buildSmartApp())
      .get('/fhir/Observation')
      .query({ patient: patientBUid })
      .set('Authorization', `Bearer ${bearer}`);
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Bundle');
  });

  test('an unrecognised bearer (no platform JWT, no SMART token) is 401', async () => {
    const res = await request(buildSmartApp())
      .get('/fhir/Observation')
      .query({ patient: patientAUid })
      .set('Authorization', 'Bearer vh_access_not_a_real_token_value');
    expect(res.status).toBe(401);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('verifyAccessToken still resolves a seeded token (sanity on the real service)', async () => {
    const bearer = await seedAccessToken({
      scopes: ['patient/Observation.read'], patientUid: patientAUid,
    });
    const row = await verifyAccessToken({
      tenantId: TENANT, accessToken: bearer, environment: 'sandbox',
    });
    expect(row).toBeTruthy();
    expect(row.patient_uid).toBe(patientAUid);
    expect(row.granted_scopes).toContain('patient/Observation.read');
  });

  test('/metadata stays open (no token required)', async () => {
    const res = await request(buildSmartApp()).get('/fhir/metadata');
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('CapabilityStatement');
  });
});
