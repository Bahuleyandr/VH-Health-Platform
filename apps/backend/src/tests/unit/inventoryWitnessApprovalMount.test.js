import { randomUUID } from 'node:crypto';

import { authClient } from '../testClient.js';
import { setTenantTx } from '../../lib/prisma.js';
import { grantPharmacyFacilityAuthority } from '../../services/pharmacy/pharmacyFacilityAuthorityService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const RUN_KEY = `inventory-witness-mount-${process.pid}-${Date.now()}`;
const DISPOSAL_APPROVE_PATHS = [
  '/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/not-an-id/approve',
  '/api/v1/pharmacy-orders/inventory/v2/disposals/witness-approvals/not-an-id/approve',
];
const RETIRED_DISPENSE_APPROVE_PATHS = [
  '/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/not-an-id/approve',
  '/api/v1/pharmacy-orders/inventory/v2/controlled-dispense/witness-approvals/not-an-id/approve',
];
const RETIRED_MOVEMENT_APPROVE_PATHS = [
  '/api/v1/pharmacy/inventory/v2/movements/witness-approvals/not-an-id/approve',
  '/api/v1/pharmacy-orders/inventory/v2/movements/witness-approvals/not-an-id/approve',
];

// The seed tenant's own administrator — the identity that issues the facility
// grants below through the genuine admin command.
const GRANT_ADMIN_UID = '550e8400-e29b-41d4-a716-446655440000';
const CUSTODY_ROLES = ['PHARMACY_STAFF', 'STORES_PURCHASE_INCHARGE'];
const custodyUids = new Map();
let custodyFacilityId = null;

function client(role) {
  return authClient(role, { tenant_id: TENANT });
}

// Since migration 753 an ordinary inventory read is a facility-custody read:
// listItems refuses without an exact facility_id, then checks the caller's own
// staff identity against an active pharmacy grant for that facility. A caller
// carrying nothing but a role cannot reach 200 any more, so this suite
// provisions the authority the way an administrator would — a real active
// facility, a real user + staff row per custody role, and a grant issued
// through grantPharmacyFacilityAuthority. Each role needs its OWN identity:
// assertPharmacyFacilityGrant requires the users row's canonical role to equal
// the role on the request, so one uid cannot stand in for both.
function custodyClient(role) {
  return authClient(role, { tenant_id: TENANT, uid: custodyUids.get(role) });
}

beforeAll(async () => {
  await setTenantTx(TENANT, async (tx) => {
    custodyFacilityId = Number((await tx.$queryRawUnsafe(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, $2::text, $3::text, 'active', FALSE)
       RETURNING id`,
      TENANT,
      RUN_KEY.slice(0, 80),
      'Inventory witness mount custody facility',
    ))[0].id);
    for (const role of CUSTODY_ROLES) {
      const uid = randomUUID();
      custodyUids.set(role, uid);
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, name, role, tenant_id, is_active, status, updated_at)
         VALUES ($1::uuid, $2::text, $3::text, $4::uuid, TRUE, 'active', NOW())`,
        uid,
        `Mount custody ${role}`,
        role,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO staff
           (tenant_id, user_id, employee_id, name, designation, skills,
            certifications, is_active, archived, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'Pharmacy',
                 '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())`,
        TENANT,
        uid,
        `WM-${process.pid}-${role}`.slice(0, 50),
        `Mount custody ${role}`,
      );
    }
  });
  for (const role of CUSTODY_ROLES) {
    await grantPharmacyFacilityAuthority({
      tenantId: TENANT,
      facilityId: custodyFacilityId,
      staffUid: custodyUids.get(role),
      actorUid: GRANT_ADMIN_UID,
      actorRole: 'ADMIN',
      reason: 'Inventory witness mount fixture pharmacy facility custody',
      commandKey: `${RUN_KEY}-grant-${role}`,
    });
  }
});

afterAll(async () => {
  // This suite borrows the shared seed tenant, so it removes exactly the rows
  // it created. The grant-event ledger is append-only in normal operation;
  // suspending triggers for the fixture's own teardown is the same move the
  // pharmacy deep suites make, and it never touches seed rows.
  await setTenantTx(TENANT, async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    for (const uid of custodyUids.values()) {
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grant_events
          WHERE tenant_id=$1::uuid
            AND grant_id IN (SELECT id FROM pharmacy_staff_facility_grants
                              WHERE tenant_id=$1::uuid AND staff_uid=$2::uuid)`,
        TENANT,
        uid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grants
          WHERE tenant_id=$1::uuid AND staff_uid=$2::uuid`,
        TENANT,
        uid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM staff WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
        TENANT,
        uid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE tenant_id=$1::uuid AND uid=$2::uuid`,
        TENANT,
        uid,
      );
    }
    if (custodyFacilityId != null) {
      await tx.$executeRawUnsafe(
        `DELETE FROM facilities WHERE tenant_id=$1::uuid AND id=$2::int`,
        TENANT,
        custodyFacilityId,
      );
    }
  });
});

describe('typed inventory-disposal witness app mount', () => {
  it.each(DISPOSAL_APPROVE_PATHS)('denies a clinical role at facility-bound route %s', async (path) => {
    const response = await client('DOCTOR').post(path)
      .set('Idempotency-Key', `${RUN_KEY}-${path.includes('pharmacy-orders') ? 'orders' : 'alias'}`)
      .send({
        disposal: { inventory_item_id: 17, quantity: 1 },
      });
    expect(response.statusCode).toBe(403);
  });

  it.each(['PHARMACY_STAFF', 'PHARMACY_INCHARGE'])(
    'lets disposal operator %s host the approval route for password step-up',
    async (role) => {
      const response = await client(role).post(DISPOSAL_APPROVE_PATHS[0])
        .set('Idempotency-Key', `${RUN_KEY}-operator-${role.toLowerCase()}`)
        .send({ disposal: { inventory_item_id: 17, quantity: 1 } });
      expect(response.statusCode).toBe(400);
      expect(response.body.code).toBe('INVENTORY_DISPOSAL_INPUT_INVALID');
    },
  );

  it.each(RETIRED_MOVEMENT_APPROVE_PATHS)(
    'keeps the generic movement approval tombstone reachable at %s',
    async (path) => {
      const response = await client('DOCTOR').post(path).send({});
      expect(response.statusCode).toBe(410);
      expect(response.body.code).toBe('INVENTORY_GENERIC_MOVEMENT_RETIRED');
    },
  );

  it.each(RETIRED_DISPENSE_APPROVE_PATHS)(
    'keeps the standalone controlled-dispense approval tombstone reachable at %s',
    async (path) => {
      const response = await client('DOCTOR').post(path).send({});
      expect(response.statusCode).toBe(410);
      expect(response.body.code).toBe('INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED');
    },
  );

  it('requires an idempotency key after a pharmacy witness reaches the approval route', async () => {
    const response = await client('PHARMACY_STAFF').post(DISPOSAL_APPROVE_PATHS[0]).send({
      disposal: { inventory_item_id: 17, quantity: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/);
  });

  it('requires an idempotency key for final typed disposal', async () => {
    const path = '/api/v1/pharmacy/inventory/v2/disposals';
    const response = await client('PHARMACY_STAFF').post(path).send({
      facility_id: 3,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      quantity: 1,
      reason_code: 'damaged',
      disposition_method: 'authorized_incineration',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/);
  });

  it.each([
    ['/api/v1/pharmacy/inventory/v2/movements', 'INVENTORY_GENERIC_MOVEMENT_RETIRED'],
    [
      '/api/v1/pharmacy/inventory/v2/controlled-dispense',
      'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
    ],
  ])('publishes retired final mutation %s as 410 without idempotency preconditions', async (
    path,
    code,
  ) => {
    const response = await client('PHARMACY_STAFF').post(path).send({});
    expect(response.statusCode).toBe(410);
    expect(response.body.code).toBe(code);
  });

  it('denies an unrelated role before the approval router', async () => {
    const response = await client('RECEPTIONIST').post(DISPOSAL_APPROVE_PATHS[0]).send({
      disposal: { inventory_item_id: 17, quantity: 1 },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not grant a clinical witness access to the rest of inventory', async () => {
    const response = await client('DOCTOR').get('/api/v1/pharmacy/inventory/v2/items');
    expect(response.statusCode).toBe(403);
  });

  it('preserves pharmacy and supply access to ordinary inventory routes', async () => {
    for (const role of CUSTODY_ROLES) {
      const response = await custodyClient(role).get(
        `/api/v1/pharmacy/inventory/v2/items?facility_id=${custodyFacilityId}&limit=1`,
      );
      expect(response.statusCode).toBe(200);
      // The route really served the list rather than short-circuiting: a
      // custody failure answers 403 with a code and no data array.
      expect(Array.isArray(response.body.data)).toBe(true);
    }
  });
});
