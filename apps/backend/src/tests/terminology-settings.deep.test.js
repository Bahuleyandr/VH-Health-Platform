import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import {
  clearTerminologySettingsCache,
  getTenantTerminologySettings,
  setTenantTerminologySettings,
} from '../services/terminology/terminologySettingsService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-0000000a3700';
const TENANT_B = '00000000-0000-4000-8000-0000000b3700';

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenant_terminology_settings WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_concepts WHERE code LIKE 'NL5SET.%'`,
  ).catch(() => {});
  clearTerminologySettingsCache();
}

d('tenant terminology settings (NL-5 P1)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'nl5-term-a', 'NL5 Terminology Tenant A')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'nl5-term-b', 'NL5 Terminology Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('defaults fail closed to current inert behavior when no row exists', async () => {
    const settings = await getTenantTerminologySettings(TENANT_A);
    expect(settings).toMatchObject({
      tenant_id: TENANT_A,
      preferred_diagnosis_system: 'ICD11',
      enabled_systems: ['ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC'],
      snomed_pickers_enabled: false,
      is_default: true,
    });
    await expect(getTenantTerminologySettings(null)).resolves.toMatchObject({
      preferred_diagnosis_system: 'ICD11',
      snomed_pickers_enabled: false,
      is_default: true,
    });
  });

  test('upserted settings are per-tenant cached without cross-tenant poisoning', async () => {
    await setTenantTerminologySettings(TENANT_A, {
      preferred_diagnosis_system: 'ICD10',
      enabled_systems: ['ICD10', 'ICD11'],
      snomed_pickers_enabled: true,
    }, { actorUid: '11111111-1111-4111-8111-111111111111' });

    const a1 = await getTenantTerminologySettings(TENANT_A);
    expect(a1).toMatchObject({
      preferred_diagnosis_system: 'ICD10',
      enabled_systems: ['ICD10', 'ICD11'],
      snomed_pickers_enabled: true,
      is_default: false,
    });

    const b = await getTenantTerminologySettings(TENANT_B);
    expect(b).toMatchObject({ preferred_diagnosis_system: 'ICD11', is_default: true });

    const a2 = await getTenantTerminologySettings(TENANT_A);
    expect(a2).toMatchObject({
      preferred_diagnosis_system: 'ICD10',
      enabled_systems: ['ICD10', 'ICD11'],
      snomed_pickers_enabled: true,
    });
  });

  test('settings endpoint reads defaults, updates as curator, and rejects non-curator writes', async () => {
    const doctorGet = await authClient('DOCTOR', { tenant_id: TENANT_A })
      .get('/api/v1/terminology/settings');
    expect(doctorGet.status).toBe(200);
    expect(doctorGet.body.data.settings.tenant_id).toBe(TENANT_A);

    const nurseWrite = await authClient('NURSING_STAFF', { tenant_id: TENANT_A })
      .put('/api/v1/terminology/settings')
      .send({ preferred_diagnosis_system: 'ICD11', enabled_systems: ['ICD11'] });
    expect(nurseWrite.status).toBe(403);

    const adminWrite = await authClient('ADMIN', { tenant_id: TENANT_A })
      .put('/api/v1/terminology/settings')
      .send({
        preferred_diagnosis_system: 'ICD11',
        enabled_systems: ['ICD10', 'ICD11'],
        snomed_pickers_enabled: false,
      });
    expect(adminWrite.status).toBe(200);
    expect(adminWrite.body.data.settings).toMatchObject({
      preferred_diagnosis_system: 'ICD11',
      enabled_systems: ['ICD10', 'ICD11'],
      snomed_pickers_enabled: false,
    });
  });

  test('search rejects a system disabled for the requesting tenant', async () => {
    await setTenantTerminologySettings(TENANT_A, {
      preferred_diagnosis_system: 'ICD10',
      enabled_systems: ['ICD10'],
      snomed_pickers_enabled: false,
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO terminology_concepts (system_key, code, display, status)
       VALUES ('SNOMED_CT', 'NL5SET.SNOMED', 'NL5SET SNOMED disabled search', 'active')
       ON CONFLICT (system_key, code) DO UPDATE SET status = 'active', display = EXCLUDED.display`,
    );

    const disabled = await authClient('DOCTOR', { tenant_id: TENANT_A })
      .get('/api/v1/terminology/search')
      .query({ system: 'SNOMED_CT', q: 'NL5SET' });
    expect(disabled.status).toBe(400);

    const enabled = await authClient('DOCTOR', { tenant_id: TENANT_A })
      .get('/api/v1/terminology/search')
      .query({ system: 'ICD10', q: 'NL5' });
    expect(enabled.status).toBe(200);
  });
});
