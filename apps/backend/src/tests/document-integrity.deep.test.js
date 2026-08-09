// Roadmap C4 — hash chain + e-signature deep round-trip.
//
// 1. Audit events written through the canonical service are chained by the
//    DB trigger (seq/prev/chain populated, linkage verified).
// 2. Tampering with a chained row is detected by the verification pass.
// 3. Signing a clinical note freezes a content hash; editing the note flips
//    the verification verdict; the signing act itself lands in the chain.

import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { recordClinicalAuditEvent } from '../services/clinical/canonicalClinicalPlatformService.js';
import { verifyAuditChain } from '../services/clinical/documentIntegrityService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const PATIENT_UID = randomUUID();
const SUFFIX = TENANT_ID.replaceAll('-', '').slice(0, 10);
const PHONE_SUFFIX = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
const TENANT_SLUG = `c4-integrity-${SUFFIX}`;
const ACTOR_PHONE = `7${PHONE_SUFFIX}`;
const PATIENT_PHONE = `6${PHONE_SUFFIX}`;
let actorId;
let noteId;
let signatureId;
let tamperedAuditId;
let expectedPhiAuditWrites = 0;

function testClient(role) {
  return authClient(role, {
    uid: ACTOR_UID,
    id: actorId,
    tenant_id: TENANT_ID,
  });
}

async function withAuditBypass(fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    return fn(tx);
  });
}

async function cleanup() {
  await withAuditBypass(async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_document_signatures WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_log WHERE tenant_id = $1::uuid OR uid = $2::uuid`,
      TENANT_ID,
      ACTOR_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = $1::uuid OR uid = $2::uuid`,
      TENANT_ID,
      ACTOR_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM hipaa_access_log WHERE tenant_id = $1::uuid OR accessed_by = $2::uuid`,
      TENANT_ID,
      ACTOR_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_notes WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      TENANT_ID,
    );
  });
}

/** phiAccessLogger writes hipaa_access_log rows AFTER the response. Wait for
 *  this suite's tenant-scoped rows before teardown so a late insert cannot
 *  recreate an FK child after cleanup() has deleted hipaa_access_log. */
async function waitForPhiAuditWrites(expected, timeoutMs = 10000) {
  if (expected === 0) return;

  const deadline = Date.now() + timeoutMs;
  let observed = 0;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM hipaa_access_log
        WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    observed = Number(row.count);
    if (observed >= expected) return;
    await new Promise((r) => setTimeout(r, 25));
  }

  throw new Error(`Timed out waiting for ${expected} PHI audit writes; observed ${observed}`);
}

d('Document integrity — deep round-trip (roadmap C4)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, status, updated_at)
         VALUES ($1::uuid, $2, 'C4TEST Document Integrity', 'active', NOW())`,
        TENANT_ID,
        TENANT_SLUG,
      );
      const actor = await tx.$queryRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'C4TEST Actor', 'DOCTOR', true, 'active', NOW())
         RETURNING id`,
        ACTOR_UID,
        TENANT_ID,
        ACTOR_PHONE,
      );
      actorId = Number(actor[0].id);
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'C4TEST Patient', 'PATIENT', true, 'active', NOW())`,
        PATIENT_UID,
        TENANT_ID,
        PATIENT_PHONE,
      );
      const note = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_notes (tenant_id, patient_uid, note_type, title, content)
         VALUES ($1::uuid, $2::uuid, 'progress', 'C4TEST Progress note',
                 '{"assessment":"stable","plan":"continue"}'::jsonb)
         RETURNING id`,
        TENANT_ID,
        PATIENT_UID,
      );
      noteId = Number(note[0].id);
    });
  });

  afterAll(async () => {
    await waitForPhiAuditWrites(expectedPhiAuditWrites);
    await cleanup();
    await prisma.$disconnect();
  }, 120000);

  test('audit inserts are chained by the trigger with intact linkage', async () => {
    const first = await recordClinicalAuditEvent({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      action: 'c4test.event_one',
      resourceTable: 'c4test',
      resourceId: '1',
      idempotencyKey: `c4test:${TENANT_ID}:event-one`,
    });
    const second = await recordClinicalAuditEvent({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      action: 'c4test.event_two',
      resourceTable: 'c4test',
      resourceId: '2',
      idempotencyKey: `c4test:${TENANT_ID}:event-two`,
    });
    tamperedAuditId = second.id;

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, chain_seq, prev_hash, chain_hash FROM clinical_audit_events
        WHERE id IN ($1::uuid, $2::uuid) ORDER BY chain_seq`,
      first.id, second.id,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].chain_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(rows[1].chain_seq)).toBeGreaterThan(Number(rows[0].chain_seq));

    const verdict = await verifyAuditChain({ tenantId: TENANT_ID });
    expect(verdict.intact).toBe(true);
    expect(verdict.checked).toBeGreaterThanOrEqual(2);
  });

  test('tampering with a chained row is detected', async () => {
    await withAuditBypass((tx) => tx.$executeRawUnsafe(
      `UPDATE clinical_audit_events SET action = 'c4test.event_two_TAMPERED' WHERE id = $1::uuid`,
      tamperedAuditId,
    ));
    const verdict = await verifyAuditChain({ tenantId: TENANT_ID });
    expect(verdict.intact).toBe(false);
    expect(verdict.breaks).toBeGreaterThanOrEqual(1);
    expect(verdict.first_break_id).toBeTruthy();

    // Restore so later assertions (and other suites) see an intact chain.
    await withAuditBypass((tx) => tx.$executeRawUnsafe(
      `UPDATE clinical_audit_events SET action = 'c4test.event_two' WHERE id = $1::uuid`,
      tamperedAuditId,
    ));
    const restored = await verifyAuditChain({ tenantId: TENANT_ID });
    expect(restored.intact).toBe(true);
  });

  test('admin-only audit-chain endpoint works; nurse blocked', async () => {
    const nurse = await testClient('NURSING_STAFF').get('/api/v1/integrity/audit-chain/verify');
    expect(nurse.status).toBe(403);

    const admin = await testClient('ADMIN')
      .get('/api/v1/integrity/audit-chain/verify')
      .query({ limit: 50 });
    expect(admin.status).toBe(200);
    // Only 2xx responses write hipaa_access_log rows here — the denied 403s
    // and the 400/404 below never resolve a patient, so they log nothing.
    expectedPhiAuditWrites += 1;
    expect(admin.body.data.intact).toBe(true);
  });

  test('doctor signs a clinical note; verification is intact until the note changes', async () => {
    const nurse = await testClient('NURSING_STAFF')
      .post('/api/v1/integrity/sign')
      .send({ document_type: 'clinical_note', document_id: noteId });
    expect(nurse.status).toBe(403);

    const sign = await testClient('DOCTOR')
      .post('/api/v1/integrity/sign')
      .send({
        document_type: 'clinical_note',
        document_id: noteId,
        statement: 'C4TEST attested by author',
      });
    expect(sign.status).toBe(201);
    expectedPhiAuditWrites += 1;
    signatureId = sign.body.data.signature.id;
    expect(sign.body.data.signature.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sign.body.data.signature.audit_event_id).toBeTruthy();

    const intact = await testClient('DOCTOR').get(`/api/v1/integrity/signatures/${signatureId}/verify`);
    expect(intact.status).toBe(200);
    expectedPhiAuditWrites += 1;
    expect(intact.body.data.intact).toBe(true);

    // Edit the signed note → verification must flag the change.
    await prisma.$executeRawUnsafe(
      `UPDATE clinical_notes SET content = '{"assessment":"worse","plan":"escalate"}'::jsonb WHERE id = $1`,
      noteId,
    );
    const changed = await testClient('DOCTOR').get(`/api/v1/integrity/signatures/${signatureId}/verify`);
    expect(changed.status).toBe(200);
    expectedPhiAuditWrites += 1;
    expect(changed.body.data.intact).toBe(false);
    expect(changed.body.data.current_hash).not.toBe(changed.body.data.signed_hash);
  });

  test('signature list + signing act is itself in the hash chain', async () => {
    const list = await testClient('DOCTOR')
      .get(`/api/v1/integrity/signatures/clinical_note/${noteId}`);
    expect(list.status).toBe(200);
    expectedPhiAuditWrites += 1;
    expect(list.body.data.count).toBeGreaterThanOrEqual(1);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT chain_hash FROM clinical_audit_events
        WHERE action = 'document.signed' AND resource_id = $1
        ORDER BY chain_seq DESC LIMIT 1`,
      String(noteId),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].chain_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('unknown document type and bogus ids are clean 400/404s', async () => {
    const badType = await testClient('DOCTOR')
      .post('/api/v1/integrity/sign')
      .send({ document_type: 'tweet', document_id: 1 });
    expect(badType.status).toBe(400);

    const missing = await testClient('DOCTOR')
      .post('/api/v1/integrity/sign')
      .send({ document_type: 'clinical_note', document_id: 99999999 });
    expect(missing.status).toBe(404);
  });
});
