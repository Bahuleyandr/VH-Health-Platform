// administer-with-scan accepts an optional administered_at (the bedside time an
// offline dose was actually given). The time-right is evaluated against it (not
// drain-time), and it is recorded as administered_at — so a dose given offline
// at T but drained later records T and isn't spuriously time-rejected. Re-send
// dedup is unchanged (uniq_mar_administered_dose).
import { randomUUID } from 'crypto';
const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;
const prisma = (await import('../lib/prisma.js')).default;
const { administerWithScan } = await import('../services/clinical/marFiveRightsService.js');

const TENANT = randomUUID();
const PATIENT = randomUUID();
const NURSE = randomUUID();
const PHONE = `+9197${String(Math.floor(Math.random()*1e8)).padStart(8,'0')}`;
let maId;

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM medication_administrations WHERE patient_uid=$1::uuid`, PATIENT).catch(()=>{});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, PATIENT, NURSE).catch(()=>{});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id=$1::uuid`, TENANT).catch(()=>{});
}

d('MAR administer-with-scan bedside administered_at', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(`INSERT INTO tenants (id,slug,name) VALUES ($1::uuid,$2,'MAR AdmAt') ON CONFLICT (id) DO NOTHING`, TENANT, `maradmat-${TENANT.slice(0,8)}`);
    await prisma.$executeRawUnsafe(`INSERT INTO users (uid,phone,name,role,is_active,tenant_id,updated_at) VALUES ($1::uuid,$2,'P','PATIENT',true,$3::uuid,NOW())`, PATIENT, PHONE, TENANT);
    await prisma.$executeRawUnsafe(`INSERT INTO users (uid,phone,name,role,is_active,tenant_id,updated_at) VALUES ($1::uuid,$2,'N','NURSING_STAFF',true,$3::uuid,NOW())`, NURSE, `${PHONE}1`, TENANT);
  }, 60_000);
  afterAll(async () => { await cleanup(); await prisma.$disconnect().catch(()=>{}); });

  async function seedDose(scheduledOffsetMin) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status, tenant_id)
       VALUES ($1::uuid,'Paracetamol','500mg','oral', NOW() + ($2 || ' minutes')::interval, 'scheduled', $3::uuid) RETURNING id`,
      PATIENT, String(scheduledOffsetMin), TENANT);
    return rows[0].id;
  }

  it('records the passed bedside time + evaluates time-right against it', async () => {
    maId = await seedDose(-70); // scheduled ~70 min ago → drain-time NOW() time-right would FAIL (>60)
    // Anchor the bedside time off true JS wall-clock, NOT the timestamptz Date
    // round-trip of scheduled_time: on this host the node-postgres driver skews
    // a parsed timestamptz by the server's IST offset (CLAUDE.md "Postgres
    // timezone matters"). The bound we send is a correct UTC instant; the
    // SQL-side right-time compares scheduled_time and $2::timestamptz entirely
    // inside Postgres, so it is unaffected by the JS-side parse skew.
    // bedside ≈ now−30m; scheduled ≈ now−70m → minutes_from_scheduled ≈ +40
    // → inside ±60. (Drain-time NOW() would be ≈ +70 → time-right would FAIL.)
    const bedsideAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const rec = await administerWithScan({
      ma_id: maId, scanned_patient_uid: PATIENT, scanned_barcode: 'Paracetamol',
      administeredBy: NURSE, tenantId: TENANT, administeredAt: bedsideAt,
    });
    expect(rec.status).toBe('administered');
    // rec.administered_at carries the same driver parse-skew as any timestamptz
    // read on this host, so compare it against the same-driver round-trip of the
    // bound we sent — the skew cancels and the residual is the true delta (≈0).
    const roundTrip = (await prisma.$queryRawUnsafe(`SELECT $1::timestamptz AS t`, bedsideAt))[0].t;
    expect(Math.abs(new Date(rec.administered_at).getTime() - new Date(roundTrip).getTime())).toBeLessThan(2000);
    expect(rec.all_rights_passed).toBe(true);
  }, 30_000);

  it('rejects an absurd future administered_at', async () => {
    const id = await seedDose(0);
    const future = new Date(Date.now() + 48 * 3600_000).toISOString();
    await expect(administerWithScan({ ma_id: id, scanned_patient_uid: PATIENT, scanned_barcode: 'Paracetamol', administeredBy: NURSE, tenantId: TENANT, administeredAt: future }))
      .rejects.toThrow();
  }, 30_000);

  it('a re-send does not double-administer (dedup unchanged)', async () => {
    await expect(administerWithScan({ ma_id: maId, scanned_patient_uid: PATIENT, scanned_barcode: 'Paracetamol', administeredBy: NURSE, tenantId: TENANT }))
      .rejects.toThrow();
  }, 30_000);
});
