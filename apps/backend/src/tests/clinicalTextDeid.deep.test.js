// Clinical text de-identification — research-export wiring, deep round-trip.
//
// The deterministic PHI de-identifier (src/services/ai/deidentificationService.js)
// is wired into research registry export: when exportRegistry is called with
// { deidentify: true }, every free-text CRF cell is pseudonymized using the
// patient's chart-anchored identifiers (name, phone, …) plus the structured
// regex sweep, and the raw patient_uid column is never emitted.
//
// This test seeds a real registry → published CRF (with a free-text `note`
// field) → enrollment → CRF response whose note embeds the patient's own name
// and phone, then proves the de-id flag is what scrubs them from the export.
// It mirrors the tenant + cleanup conventions of research-registry.deep.test.js
// but cleans up by the exact ids/uid it created so it leaves ZERO residue.

import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import {
  createRegistry,
  createCrfForm,
  publishCrfForm,
  enrollPatient,
  captureCrfResponse,
  exportRegistry,
} from '../services/research/researchRegistryService.js';
import { collectKnownIdentifiers } from '../services/ai/deidentificationService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PATIENT_NAME = 'Ramesh Kumar';
const PATIENT_PHONE = '9876543210';
const REG_CODE = `DEIDT${String(Date.now()).slice(-6)}`;
// A unique phone for the users row (E.164-ish) so seeding never collides with
// other suites; the de-id-relevant value lives in the note free text.
const SEED_PHONE = `+91${PATIENT_PHONE}`;

let patientUid;
let registryId;
let formId;
let enrollmentId;
let responseId;

async function cleanup() {
  // Delete in FK-safe order, scoped to exactly what this suite created.
  if (responseId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM research_crf_responses WHERE id = $1`, Number(responseId),
    ).catch(() => {});
  }
  if (enrollmentId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM research_enrollments WHERE id = $1`, Number(enrollmentId),
    ).catch(() => {});
  }
  if (formId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM research_crf_forms WHERE id = $1`, Number(formId),
    ).catch(() => {});
  }
  if (registryId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM research_registries WHERE id = $1`, Number(registryId),
    ).catch(() => {});
  }
  // Belt-and-braces: clear anything left under this run's unique code/phone.
  await prisma.$executeRawUnsafe(
    `DELETE FROM research_registries WHERE code = $1`, REG_CODE,
  ).catch(() => {});
  if (patientUid) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid`, patientUid,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE phone = $1`, SEED_PHONE,
  ).catch(() => {});
}

d('Clinical text de-id — research export free-text scrubbing (deep)', () => {
  beforeAll(async () => {
    await cleanup();

    // Patient whose own name + phone we will embed in a CRF free-text cell.
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, gender, birthday, is_active, tenant_id, updated_at)
       VALUES ($1, $2, 'PATIENT', 'male', '1985-07-21', true, $3::uuid, NOW())
       RETURNING uid`,
      SEED_PHONE,
      PATIENT_NAME,
      DEFAULT_TENANT_ID,
    );
    patientUid = u[0].uid;

    // Registry defaults to status 'active' (migration 289), so enrollment is
    // allowed straight away — no API publish step needed.
    const registry = await createRegistry(
      { code: REG_CODE, title: 'De-id export probe registry', kind: 'registry' },
      { tenantId: DEFAULT_TENANT_ID },
    );
    registryId = registry.id;

    // CRF with one free-text, unbound field so our seeded note survives to the
    // export grid verbatim as a string cell.
    const form = await createCrfForm(
      registryId,
      {
        name: 'Clinical note form',
        fields: [{ key: 'note', label: 'Clinical note', type: 'text' }],
      },
      { tenantId: DEFAULT_TENANT_ID },
    );
    formId = form.id;
    await publishCrfForm(formId, { tenantId: DEFAULT_TENANT_ID });

    const enrollment = await enrollPatient(
      registryId,
      { patientUid },
      { tenantId: DEFAULT_TENANT_ID },
    );
    enrollmentId = enrollment.id;

    // autofill:false keeps the note exactly as supplied (no binding pulls).
    const response = await captureCrfResponse(
      formId,
      {
        enrollmentId,
        visitLabel: 'baseline',
        data: { note: `${PATIENT_NAME}, ph ${PATIENT_PHONE}, febrile` },
        autofill: false,
      },
      { tenantId: DEFAULT_TENANT_ID },
    );
    responseId = response.id;
    // Guard the seed: the note must have survived validation as a string cell.
    expect(response.data.note).toBe(`${PATIENT_NAME}, ph ${PATIENT_PHONE}, febrile`);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('collectKnownIdentifiers returns the patient name + phone', async () => {
    const ids = await collectKnownIdentifiers(patientUid, { tenantId: DEFAULT_TENANT_ID });
    const byCategory = (cat) => ids.filter((i) => i.category === cat).map((i) => i.value);
    expect(byCategory('NAME')).toContain(PATIENT_NAME);
    expect(byCategory('PHONE')).toContain(SEED_PHONE);
  });

  test('de-identified export pseudonymizes free-text PHI but keeps the subject code', async () => {
    const subjectCode = `${REG_CODE}-${String(enrollmentId).padStart(4, '0')}`;

    const res = await exportRegistry(registryId, { deidentify: true, salt: 's', tenantId: DEFAULT_TENANT_ID });
    const csv = res.buffer.toString('utf8');

    // The raw name + phone must be gone, replaced by a stable NAME pseudonym.
    expect(csv).not.toContain(PATIENT_NAME);
    expect(csv).not.toContain(PATIENT_PHONE);
    expect(csv).toMatch(/\[NAME-[0-9a-f]{8}\]/);
    // De-id never emits the raw patient_uid column, but subject_code stays.
    expect(csv).toContain(subjectCode);
    expect(csv).not.toContain(patientUid);
    expect(typeof res.deidResidual).toBe('number');
  });

  test('export WITHOUT de-id still contains the raw name (flag is what changed it)', async () => {
    const res = await exportRegistry(registryId, { tenantId: DEFAULT_TENANT_ID });
    const csv = res.buffer.toString('utf8');
    expect(csv).toContain(PATIENT_NAME);
    expect(res.deidResidual).toBe(0);
  });
});
