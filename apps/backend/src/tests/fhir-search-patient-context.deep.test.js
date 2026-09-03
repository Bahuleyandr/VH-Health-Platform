// FHIR collection-search patient-context requirement (CAN-030).
//
// A FHIR PHI collection search (GET /Observation, /Condition, …) with no
// ?patient/subject enumerated tenant PHI. It now requires a patient context for
// non-export roles; patient-scoped searches and an export-role carve-out pass.
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SOME_PATIENT = 'c0de0030-0000-4000-8000-0000000007a1';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0030-00d0-4000-8000-00000000d001', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

d('FHIR collection-search patient context (CAN-030)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('c0de0030-00d0-4000-8000-00000000d001', { tenantId: TENANT_ID });
  });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('denies an unscoped PHI collection search for a clinical role', async () => {
    const res = await client('DOCTOR').get('/api/v1/fhir/Observation');
    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('FHIR_PATIENT_CONTEXT_REQUIRED');
  });

  it('allows a patient-scoped collection search', async () => {
    const res = await client('DOCTOR').get(`/api/v1/fhir/Observation?patient=${SOME_PATIENT}`);
    expect(res.statusCode).not.toBe(403);
  });

  it('allows an export role (MEDICAL_RECORDS) to run an unscoped search', async () => {
    const res = await client('MEDICAL_RECORDS').get('/api/v1/fhir/Observation');
    expect(res.statusCode).not.toBe(403);
  });
});
