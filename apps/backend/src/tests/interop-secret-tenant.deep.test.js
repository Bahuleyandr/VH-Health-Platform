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
  resolveTenantBySender, getInteropSecret, upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';
import { verifySignedRequest } from '../utils/signedRequest.js';

const TENANT_A = 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a601';
const TENANT_B = 'b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b602';
const SFX = String(Date.now() % 100000);
const HIP_A = `HIP-A-${SFX}`;
const HIP_B = `HIP-B-${SFX}`;
const SECRET_A = 'tenant-a-abdm-secret';
const SECRET_B = 'tenant-b-abdm-secret';

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
    await prisma.$executeRawUnsafe(`DELETE FROM tenant_interop_secrets WHERE sender_identifier IN ($1,$2)`, HIP_A, HIP_B).catch(() => {});
    await ensureTenant(TENANT_A, `w3-ws6-a-${SFX}`);
    await ensureTenant(TENANT_B, `w3-ws6-b-${SFX}`);
    await upsertInteropSecret({ tenantId: TENANT_A, kind: 'abdm_callback', senderIdentifier: HIP_A, secret: SECRET_A });
    await upsertInteropSecret({ tenantId: TENANT_B, kind: 'abdm_callback', senderIdentifier: HIP_B, secret: SECRET_B });
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM tenant_interop_secrets WHERE sender_identifier IN ($1,$2)`, HIP_A, HIP_B).catch(() => {});
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
});
