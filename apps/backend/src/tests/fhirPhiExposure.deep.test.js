// fhirPhiExposure.deep.test.js
//
// PHI/FHIR HIGH findings (PLATFORM_AUDIT_2026-06-18 §3):
//
//   #1 FHIR enumeration oracle — GET /Patient/:id and /Patient/:id/$everything
//      returned 404 for an unresolvable patient ref, while a RESOLVED but
//      no-relationship patient gets 403 under the careTeam guard (on the enforce
//      flip). That 404-vs-403 split is a patient-existence oracle. The fix makes
//      a present-but-unresolvable ref return 403 too ("403-both"), matching the
//      CDS/documents precedent. GET /metadata (no patient context) stays OPEN.
//
//   #2 GET /Patient search was an unrestricted tenant directory — it returned
//      ANY tenant user's demographics by name/phone (incl. staff/admin rows) with
//      no role filter. The fix adds role='PATIENT' AND gates the search to
//      directory-appropriate roles (MEDICAL_RECORDS / front-office / admin).
//
// DB-backed; self-skips when no test DB is configured. Self-isolating fixtures
// (users.phone globally unique via a per-run suffix; rows torn down by name).

import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const RUN = `${process.pid}${Date.now() % 100000}`;
const SUF = String(RUN).slice(-6).padStart(6, '0'); // 6 digits → fits a 10-digit phone
const PATIENT_NAME = `FHIRPHI Patient ${RUN}`;
const STAFF_NAME = `FHIRPHI Nurse ${RUN}`;
const PATIENT_PHONE = `+91980${SUF}`; // +91 + 10 digits (98 0xxxxxx)
const STAFF_PHONE = `+91981${SUF}`; // +91 + 10 digits (98 1xxxxxx)
// A syntactically valid UUID that does not exist in the tenant.
const ABSENT_UID = '00000000-0000-4000-8000-0000deadbeef';

let patientUid;
let staffUid;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log
      WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`,
    PATIENT_NAME, STAFF_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE name IN ($1, $2)`,
    PATIENT_NAME, STAFF_NAME,
  ).catch(() => {});
}

d('FHIR PHI exposure HIGH fixes (audit §3)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, email, gender, is_active, tenant_id, updated_at)
       VALUES ($1, $2, 'PATIENT', 'fhirphi.patient@example.test', 'female', true, $3::uuid, NOW())
       RETURNING uid`,
      PATIENT_PHONE, PATIENT_NAME, DEFAULT_TENANT_ID,
    );
    patientUid = p[0].uid;

    // A NON-patient user (clinical staff) in the same tenant, with a name and
    // phone that the directory search would otherwise expose.
    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, email, is_active, tenant_id, updated_at)
       VALUES ($1, $2, 'NURSING_STAFF', 'fhirphi.nurse@example.test', true, $3::uuid, NOW())
       RETURNING uid`,
      STAFF_PHONE, STAFF_NAME, DEFAULT_TENANT_ID,
    );
    staffUid = s[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // ── #1 Enumeration oracle ────────────────────────────────────────────────
  describe('#1 enumeration oracle — unresolvable ref returns 403, not 404', () => {
    test('GET /Patient/:id for an ABSENT uuid returns 403 (not 404)', async () => {
      const res = await authClient('DOCTOR').get(`/api/v1/fhir/Patient/${ABSENT_UID}`);
      expect(res.status).toBe(403);
      // FHIR error contract: OperationOutcome, not the platform envelope.
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue?.[0]?.code).toBe('forbidden');
    });

    test('GET /Patient/:id/$everything for an ABSENT uuid returns 403 (not 404)', async () => {
      const res = await authClient('DOCTOR').get(`/api/v1/fhir/Patient/${ABSENT_UID}/$everything`);
      expect(res.status).toBe(403);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue?.[0]?.code).toBe('forbidden');
    });

    test('a present (resolvable) patient does NOT 403 on /Patient/:id (no premature care-team enforce)', async () => {
      // The mount runs patientAccessGuard in SHADOW today, so a resolved patient
      // with no relationship still passes (200). The oracle fix must not flip
      // that to a premature enforce — it only converts the NOT-FOUND case to 403.
      const res = await authClient('DOCTOR').get(`/api/v1/fhir/Patient/${patientUid}`);
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('Patient');
      expect(res.body.id).toBe(patientUid);
    });

    test('a non-PATIENT uid resolves to 403 on /Patient/:id (no demographics leak)', async () => {
      // The staff uid exists but is not a PATIENT — the access resolver filters
      // role='PATIENT', so it is unresolvable as a patient → 403, and the raw
      // demographic row never reaches the caller.
      const res = await authClient('DOCTOR').get(`/api/v1/fhir/Patient/${staffUid}`);
      expect(res.status).toBe(403);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });

    test('GET /metadata carries no patient context and stays OPEN (200)', async () => {
      const res = await authClient('DOCTOR').get('/api/v1/fhir/metadata');
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('CapabilityStatement');
    });
  });

  // ── #2 Directory restriction ─────────────────────────────────────────────
  describe('#2 GET /Patient search — role-restricted + PATIENT-only', () => {
    test('MEDICAL_RECORDS can search and gets the PATIENT, never the staff row', async () => {
      const res = await authClient('MEDICAL_RECORDS').get(`/api/v1/fhir/Patient?name=FHIRPHI`);
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('Bundle');
      const ids = (res.body.entry || []).map((e) => e.resource?.id);
      expect(ids).toContain(patientUid);
      // The NON-patient (staff) row must never appear in the FHIR directory.
      expect(ids).not.toContain(staffUid);
    });

    test('phone search returns the patient but NOT a staff row with that phone', async () => {
      const res = await authClient('MEDICAL_RECORDS').get(`/api/v1/fhir/Patient?phone=${encodeURIComponent(STAFF_PHONE)}`);
      expect(res.status).toBe(200);
      const ids = (res.body.entry || []).map((e) => e.resource?.id);
      // STAFF_PHONE belongs to a NURSING_STAFF row — the role filter excludes it,
      // so the directory returns nothing for it.
      expect(ids).not.toContain(staffUid);
    });

    test('a general clinical role (NURSING_STAFF) is NOT a directory role → 403', async () => {
      const res = await authClient('NURSING_STAFF').get(`/api/v1/fhir/Patient?name=FHIRPHI`);
      expect(res.status).toBe(403);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue?.[0]?.code).toBe('forbidden');
    });

    test('a plain DOCTOR is NOT a directory role → 403 (search is front-office/records only)', async () => {
      const res = await authClient('DOCTOR').get(`/api/v1/fhir/Patient?name=FHIRPHI`);
      expect(res.status).toBe(403);
    });

    test('ADMIN may use the directory search (200)', async () => {
      const res = await authClient('ADMIN').get(`/api/v1/fhir/Patient?name=FHIRPHI`);
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('Bundle');
    });
  });
});
