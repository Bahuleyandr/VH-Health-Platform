// Adherence-risk scoring tenant scope (CAN-037).
//
// scoreAdherenceRisk resolved the patient by users.id and read mar/refill/vitals
// with no tenant filter. It now accepts a tenantId and scopes every read. The
// longitudinal-risk caller runs from a non-request context where RLS isn't
// seeded, so the explicit predicate matters. This proves the patient resolution
// is tenant-scoped: scoring a tenant-B patient id under tenant A resolves
// nothing.
import { scoreAdherenceRisk } from '../services/gamification/adherenceRiskService.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT = 'c0de0037-00b0-4000-8000-0000000000b1';

let patientIntId;

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
}

d('Adherence-risk tenant scope (CAN-037)', () => {
  beforeAll(async () => {
    await clean();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000037701','Adherence Patient','PATIENT',true,NOW())
       RETURNING id`, PATIENT, TENANT_B);
    patientIntId = Number(rows[0].id);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('scoring a tenant-B patient under tenant A resolves nothing (null)', async () => {
    const result = await scoreAdherenceRisk(patientIntId, TENANT_A);
    expect(result).toBeNull();
  });

  it('scoring under the patient\'s own tenant resolves a score', async () => {
    const result = await scoreAdherenceRisk(patientIntId, TENANT_B);
    expect(result).not.toBeNull();
    expect(typeof result.score).toBe('number');
  });
});
