import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';
import { StaffAuthService } from '../services/auth/staffAuthService.js';

const TENANT_A = '00000000-0000-4000-8000-0000a8770001';
const TENANT_B = '00000000-0000-4000-8000-0000a8770002';
const STAFF_A = 'a8770001-0000-4000-8000-000000000001';
const STAFF_B = 'a8770002-0000-4000-8000-000000000002';
const TENANT_IDS = [TENANT_A, TENANT_B];
const STAFF_IDS = [STAFF_A, STAFF_B];
const EMPLOYEE_ID = 'DUP-WIT-877';
const PASSWORD_A = 'tenant-a-secret';
const PASSWORD_B = 'tenant-b-secret';
const REQUEST = {
  ip: '127.0.0.1',
  headers: { 'user-agent': 'jest-witness-tenant' },
  originalUrl: '/api/v1/pharmacy/counter-sales/witness-approvals/approve',
};

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM auth_logs
      WHERE tenant_id = ANY($1::uuid[])
        AND phone = $2
        AND action = 'CONTROLLED_DISPENSE_WITNESS'`,
    TENANT_IDS, EMPLOYEE_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM staff WHERE user_id = ANY($1::uuid[])',
    STAFF_IDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM users WHERE uid = ANY($1::uuid[])',
    STAFF_IDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM tenants WHERE id = ANY($1::uuid[])',
    TENANT_IDS,
  ).catch(() => {});
}

async function clearWitnessAuthLogs() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM auth_logs
      WHERE tenant_id = ANY($1::uuid[])
        AND phone = $2
        AND action = 'CONTROLLED_DISPENSE_WITNESS'`,
    TENANT_IDS, EMPLOYEE_ID,
  );
}

async function authenticateWithPermissiveRls(tenantId, password) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant_id', '', true)");
    return StaffAuthService._authenticateStaffPassword(
      EMPLOYEE_ID,
      password,
      REQUEST,
      REQUEST.originalUrl,
      {
        tenantId,
        client: tx,
        authAction: 'CONTROLLED_DISPENSE_WITNESS',
      },
    );
  });
}

beforeAll(async () => {
  await cleanup();
  const [hashA, hashB] = await Promise.all([
    bcrypt.hash(PASSWORD_A, 4),
    bcrypt.hash(PASSWORD_B, 4),
  ]);

  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
     VALUES
       ($1::uuid, 'witness-auth-a-877', 'Witness Auth A', 'IN', 'active', NOW(), NOW()),
       ($2::uuid, 'witness-auth-b-877', 'Witness Auth B', 'IN', 'active', NOW(), NOW())`,
    TENANT_A, TENANT_B,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, name, role, tenant_id, encrypted_password, is_active, status, updated_at)
     VALUES
       ($1::uuid, 'Tenant A Witness', 'PHARMACY_STAFF', $3::uuid, $5, true, 'active', NOW()),
       ($2::uuid, 'Tenant B Witness', 'PHARMACY_STAFF', $4::uuid, $6, true, 'active', NOW())`,
    STAFF_A, STAFF_B, TENANT_A, TENANT_B, hashA, hashB,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff
       (user_id, employee_id, name, is_active, archived, tenant_id, updated_at)
     VALUES
       ($1::uuid, $3, 'Tenant A Witness', true, false, $4::uuid, NOW()),
       ($2::uuid, $3, 'Tenant B Witness', true, false, $5::uuid, NOW())`,
    STAFF_A, STAFF_B, EMPLOYEE_ID, TENANT_A, TENANT_B,
  );
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 15000);

beforeEach(clearWitnessAuthLogs);

describe('controlled-dispense witness tenant-bound authentication', () => {
  test('selects the expected tenant when duplicate employee IDs are visible with permissive RLS', async () => {
    await expect(authenticateWithPermissiveRls(TENANT_A, PASSWORD_A)).resolves.toMatchObject({
      uid: STAFF_A,
      tenant_id: TENANT_A,
    });
    await expect(authenticateWithPermissiveRls(TENANT_B, PASSWORD_B)).resolves.toMatchObject({
      uid: STAFF_B,
      tenant_id: TENANT_B,
    });
  });

  test('does not accept the duplicate employee password from another tenant with permissive RLS', async () => {
    await expect(authenticateWithPermissiveRls(TENANT_A, PASSWORD_B)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_CREDENTIALS',
    });
  });

  test('public witness authentication preserves tenant context through lookup and audit', async () => {
    await expect(StaffAuthService.authenticateControlledDispenseWitness({
      employeeId: EMPLOYEE_ID,
      password: PASSWORD_A,
      tenantId: TENANT_A,
      req: REQUEST,
    })).resolves.toEqual({
      uid: STAFF_A,
      tenantId: TENANT_A,
      role: 'PHARMACY_STAFF',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, success
         FROM auth_logs
        WHERE tenant_id = $1::uuid
          AND phone = $2
          AND action = 'CONTROLLED_DISPENSE_WITNESS'
        ORDER BY created_at DESC
        LIMIT 1`,
      TENANT_A, EMPLOYEE_ID,
    );
    expect(rows).toEqual([expect.objectContaining({ tenant_id: TENANT_A, success: true })]);
  });

  test('atomically caps concurrent failures and locks only the targeted tenant identity', async () => {
    const attempts = await Promise.all(Array.from({ length: 10 }, async () => {
      try {
        await StaffAuthService.authenticateControlledDispenseWitness({
          employeeId: EMPLOYEE_ID,
          password: PASSWORD_B,
          tenantId: TENANT_A,
          req: REQUEST,
        });
        return 'unexpected_success';
      } catch (error) {
        return error.code;
      }
    }));

    expect(attempts.filter(code => code === 'INVALID_CREDENTIALS')).toHaveLength(5);
    expect(attempts.filter(code => code === 'STAFF_LOGIN_RATE_LIMITED')).toHaveLength(5);
    expect(attempts).not.toContain('unexpected_success');

    const counts = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, COUNT(*)::int AS failures
         FROM auth_logs
        WHERE tenant_id = ANY($1::uuid[])
          AND phone = $2
          AND action = 'CONTROLLED_DISPENSE_WITNESS'
          AND success = false
        GROUP BY tenant_id`,
      TENANT_IDS, EMPLOYEE_ID,
    );
    expect(counts).toEqual([{ tenant_id: TENANT_A, failures: 5 }]);

    await expect(StaffAuthService._checkStaffLockout(
      EMPLOYEE_ID,
      REQUEST,
    )).resolves.toBeUndefined();

    await expect(StaffAuthService.authenticateControlledDispenseWitness({
      employeeId: EMPLOYEE_ID,
      password: PASSWORD_A,
      tenantId: TENANT_A,
      req: REQUEST,
    })).rejects.toMatchObject({ statusCode: 429, code: 'STAFF_LOGIN_RATE_LIMITED' });

    await expect(StaffAuthService.authenticateControlledDispenseWitness({
      employeeId: EMPLOYEE_ID,
      password: PASSWORD_B,
      tenantId: TENANT_B,
      req: REQUEST,
    })).resolves.toMatchObject({ uid: STAFF_B, tenantId: TENANT_B });
  });
});
