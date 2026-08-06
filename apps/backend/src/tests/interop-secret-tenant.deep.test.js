// WS6 (W3): per-tenant inbound interop secrets.
//
// Proves the security property the route relies on: a callback signed with
// tenant A's secret verifies under A's resolved secret but NOT under B's, the
// sender→tenant resolution is correct, and an unknown sender is unresolved
// (the route rejects). Exercises the service + verifySignedRequest directly
// (the full ABDM/HL7 HTTP plumbing is covered by their own route suites).
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import {
  resolveInteropCredentialSnapshot,
  resolveTenantBySender,
  getInteropSecret,
  upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';
import { verifySignedRequest } from '../utils/signedRequest.js';

const TENANT_A = 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a601';
const TENANT_B = 'b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b602';
const SFX = String(Date.now() % 100000);
const HIP_A = `HIP-A-${SFX}`;
const HIP_B = `HIP-B-${SFX}`;
const SECRET_A = 'tenant-a-abdm-secret';
const SECRET_B = 'tenant-b-abdm-secret';
const HL7_FACILITY_A = `HL7-FAC-A-${SFX}`;
const HL7_FACILITY_A_ALT = `HL7-FAC-A-ALT-${SFX}`;
const HL7_SECRET_A = 'tenant-a-hl7-exact-secret';
const ALT_SECRET = 'tenant-a-hl7-other-row-secret';

function signed(secret, payload) {
  const timestamp = String(Date.now());
  const requestId = `req-${SFX}-${Math.round(Number(`0.${timestamp.slice(-6)}`) * 1e6)}`;
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.${JSON.stringify(payload)}`)
    .digest('hex');
  return { timestamp, requestId, signature };
}

async function ensureTenant(id, slug) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
     VALUES ($1::uuid,$2,$3,'IN','DPDP','active','{}'::jsonb,NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
    id, slug, `W3 WS6 ${slug}`,
  );
}

describe('W3 WS6 — per-tenant interop secrets', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenant_interop_secrets
        WHERE sender_identifier IN ($1,$2,$3,$4)`,
      HIP_A,
      HIP_B,
      HL7_FACILITY_A,
      HL7_FACILITY_A_ALT,
    ).catch(() => {});
    await ensureTenant(TENANT_A, `w3-ws6-a-${SFX}`);
    await ensureTenant(TENANT_B, `w3-ws6-b-${SFX}`);
    await upsertInteropSecret({ tenantId: TENANT_A, kind: 'abdm_callback', senderIdentifier: HIP_A, secret: SECRET_A });
    await upsertInteropSecret({ tenantId: TENANT_B, kind: 'abdm_callback', senderIdentifier: HIP_B, secret: SECRET_B });
    await upsertInteropSecret({
      tenantId: TENANT_A,
      kind: 'hl7_inbound',
      senderIdentifier: HL7_FACILITY_A,
      secret: HL7_SECRET_A,
    });
    await upsertInteropSecret({
      tenantId: TENANT_A,
      kind: 'hl7_inbound',
      senderIdentifier: HL7_FACILITY_A_ALT,
      secret: ALT_SECRET,
    });
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenant_interop_secrets
        WHERE sender_identifier IN ($1,$2,$3,$4)`,
      HIP_A,
      HIP_B,
      HL7_FACILITY_A,
      HL7_FACILITY_A_ALT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('resolves the sender identifier to the right tenant', async () => {
    expect(await resolveTenantBySender('abdm_callback', HIP_A)).toBe(TENANT_A);
    expect(await resolveTenantBySender('abdm_callback', HIP_B)).toBe(TENANT_B);
  });

  it('an unknown sender is unresolved (the route rejects)', async () => {
    expect(await resolveTenantBySender('abdm_callback', `HIP-UNKNOWN-${SFX}`)).toBeNull();
  });

  it('round-trips the encrypted per-tenant secret', async () => {
    expect(await getInteropSecret(TENANT_A, 'abdm_callback')).toBe(SECRET_A);
    expect(await getInteropSecret(TENANT_B, 'abdm_callback')).toBe(SECRET_B);
  });

  it('retains legacy tenant-wide selection with two active HL7 credential rows', async () => {
    const tenantId = await resolveTenantBySender('hl7_inbound', HL7_FACILITY_A);

    expect(tenantId).toBe(TENANT_A);
    expect(await getInteropSecret(tenantId, 'hl7_inbound')).toBe(ALT_SECRET);
  });

  it("tenant A's callback verifies under A's secret but NOT under B's", async () => {
    const payload = { notification: { consentId: 'c-1' } };
    const { timestamp, requestId, signature } = signed(SECRET_A, payload);

    // Resolve as the route would: HIP-A -> tenant A -> A's secret -> verifies.
    const tenantId = await resolveTenantBySender('abdm_callback', HIP_A);
    const secretForA = await getInteropSecret(tenantId, 'abdm_callback');
    expect(() => verifySignedRequest({
      secret: secretForA, signature, timestamp, requestId, payload,
      context: 'ABDM callback', codePrefix: 'ABDM_CALLBACK', replayNamespace: `ws6-ok-${SFX}`,
    })).not.toThrow();

    // Tenant B's secret must NOT verify a callback meant for tenant A.
    const secretForB = await getInteropSecret(TENANT_B, 'abdm_callback');
    expect(() => verifySignedRequest({
      secret: secretForB, signature, timestamp, requestId, payload,
      context: 'ABDM callback', codePrefix: 'ABDM_CALLBACK', replayNamespace: `ws6-bad-${SFX}`,
    })).toThrow();
  });

  it('resolves one exact active DB credential row without selecting another tenant secret', async () => {
    const snapshot = await resolveInteropCredentialSnapshot('hl7_inbound', HL7_FACILITY_A);
    const other = await resolveInteropCredentialSnapshot('hl7_inbound', HL7_FACILITY_A_ALT);

    expect(snapshot).toMatchObject({
      id: expect.stringMatching(/^[1-9][0-9]*$/),
      tenant_id: TENANT_A,
      kind: 'hl7_inbound',
      sender_identifier: HL7_FACILITY_A,
      status: 'active',
      secret: HL7_SECRET_A,
    });
    expect(other).toMatchObject({
      tenant_id: TENANT_A,
      sender_identifier: HL7_FACILITY_A_ALT,
      secret: ALT_SECRET,
    });
    expect(snapshot.id).not.toBe(other.id);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('refuses inactive credentials and fails closed when exact-row decryption fails', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE tenant_interop_secrets SET status = 'inactive'
        WHERE kind = 'hl7_inbound' AND sender_identifier = $1`,
      HL7_FACILITY_A,
    );
    expect(await resolveInteropCredentialSnapshot('hl7_inbound', HL7_FACILITY_A)).toBeNull();

    await prisma.$executeRawUnsafe(
      `UPDATE tenant_interop_secrets
          SET status = 'active', secret_ciphertext = $2
        WHERE kind = 'hl7_inbound' AND sender_identifier = $1`,
      HL7_FACILITY_A,
      'enc:v2:not-a-valid-envelope',
    );
    await expect(resolveInteropCredentialSnapshot('hl7_inbound', HL7_FACILITY_A))
      .rejects.toMatchObject({ code: 'INTEROP_CREDENTIAL_LOOKUP_FAILED' });
    expect(await resolveInteropCredentialSnapshot(
      'hl7_inbound',
      HL7_FACILITY_A,
      { failClosed: false },
    )).toBeNull();

    await upsertInteropSecret({
      tenantId: TENANT_A,
      kind: 'hl7_inbound',
      senderIdentifier: HL7_FACILITY_A,
      secret: HL7_SECRET_A,
    });
  });
});
