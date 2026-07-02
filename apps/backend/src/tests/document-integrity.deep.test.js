// Roadmap C4 — hash chain + e-signature deep round-trip.
//
// 1. Audit events written through the canonical service are chained by the
//    DB trigger (seq/prev/chain populated, linkage verified).
// 2. Tampering with a chained row is detected by the verification pass.
// 3. Signing a clinical note freezes a content hash; editing the note flips
//    the verification verdict; the signing act itself lands in the chain.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { recordClinicalAuditEvent } from '../services/clinical/canonicalClinicalPlatformService.js';
import { verifyAuditChain } from '../services/clinical/documentIntegrityService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199914${String(Date.now() % 10000).padStart(4, '0')}`;
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
let patientUid;
let noteId;
let signatureId;
let tamperedAuditId;

async function withAuditBypass(fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    return fn(tx);
  });
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_document_signatures WHERE signature_statement LIKE 'C4TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_notes WHERE title LIKE 'C4TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'C4TEST Patient'`).catch(() => {});
  // Reset the default-tenant audit hash chain so this suite verifies a clean,
  // self-contained chain. The chain is append-only by design, but sibling suites
  // sharing this DB (journeys, canonical-timeline-atomicity) delete their own
  // audit rows on cleanup; deleting any mid-chain row permanently breaks the
  // global per-tenant chain, which made the linkage/tamper assertions below fail
  // non-deterministically across runs. This test runs isolated (its own Jest
  // process via JEST_CI_ISOLATED_TESTS), so clearing the default-tenant chain
  // here is safe and makes the verdict deterministic. It still fully exercises
  // the trigger (rows chain on insert) + the verifier (tamper detected). NB:
  // clinical_audit_events is DB-enforced append-only (migration 324); test
  // maintenance uses the explicit transaction-local bypass documented there.
  await withAuditBypass((tx) => tx.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, DEFAULT_TENANT,
  )).catch(() => {});
}

d('Document integrity — deep round-trip (roadmap C4)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'C4TEST Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      PHONE,
    );
    patientUid = p[0].uid;
    const n = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_notes (patient_uid, note_type, title, content)
       VALUES ($1::uuid, 'progress', 'C4TEST Progress note', '{"assessment":"stable","plan":"continue"}'::jsonb)
       RETURNING id`,
      patientUid,
    );
    noteId = Number(n[0].id);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('audit inserts are chained by the trigger with intact linkage', async () => {
    const first = await recordClinicalAuditEvent({
      tenantId: DEFAULT_TENANT,
      patientUid,
      action: 'c4test.event_one',
      resourceTable: 'c4test',
      resourceId: '1',
    });
    const second = await recordClinicalAuditEvent({
      tenantId: DEFAULT_TENANT,
      patientUid,
      action: 'c4test.event_two',
      resourceTable: 'c4test',
      resourceId: '2',
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

    const verdict = await verifyAuditChain({ tenantId: DEFAULT_TENANT });
    expect(verdict.intact).toBe(true);
    expect(verdict.checked).toBeGreaterThanOrEqual(2);
  });

  test('tampering with a chained row is detected', async () => {
    await withAuditBypass((tx) => tx.$executeRawUnsafe(
      `UPDATE clinical_audit_events SET action = 'c4test.event_two_TAMPERED' WHERE id = $1::uuid`,
      tamperedAuditId,
    ));
    const verdict = await verifyAuditChain({ tenantId: DEFAULT_TENANT });
    expect(verdict.intact).toBe(false);
    expect(verdict.breaks).toBeGreaterThanOrEqual(1);
    expect(verdict.first_break_id).toBeTruthy();

    // Restore so later assertions (and other suites) see an intact chain.
    await withAuditBypass((tx) => tx.$executeRawUnsafe(
      `UPDATE clinical_audit_events SET action = 'c4test.event_two' WHERE id = $1::uuid`,
      tamperedAuditId,
    ));
    const restored = await verifyAuditChain({ tenantId: DEFAULT_TENANT });
    expect(restored.intact).toBe(true);
  });

  test('admin-only audit-chain endpoint works; nurse blocked', async () => {
    const nurse = await authClient('NURSING_STAFF').get('/api/v1/integrity/audit-chain/verify');
    expect(nurse.status).toBe(403);

    const admin = await authClient('ADMIN')
      .get('/api/v1/integrity/audit-chain/verify')
      .query({ limit: 50 });
    expect(admin.status).toBe(200);
    expect(admin.body.data.intact).toBe(true);
  });

  test('doctor signs a clinical note; verification is intact until the note changes', async () => {
    const nurse = await authClient('NURSING_STAFF')
      .post('/api/v1/integrity/sign')
      .send({ document_type: 'clinical_note', document_id: noteId });
    expect(nurse.status).toBe(403);

    const sign = await authClient('DOCTOR')
      .post('/api/v1/integrity/sign')
      .send({
        document_type: 'clinical_note',
        document_id: noteId,
        statement: 'C4TEST attested by author',
      });
    expect(sign.status).toBe(201);
    signatureId = sign.body.data.signature.id;
    expect(sign.body.data.signature.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sign.body.data.signature.audit_event_id).toBeTruthy();

    const intact = await authClient('DOCTOR').get(`/api/v1/integrity/signatures/${signatureId}/verify`);
    expect(intact.status).toBe(200);
    expect(intact.body.data.intact).toBe(true);

    // Edit the signed note → verification must flag the change.
    await prisma.$executeRawUnsafe(
      `UPDATE clinical_notes SET content = '{"assessment":"worse","plan":"escalate"}'::jsonb WHERE id = $1`,
      noteId,
    );
    const changed = await authClient('DOCTOR').get(`/api/v1/integrity/signatures/${signatureId}/verify`);
    expect(changed.status).toBe(200);
    expect(changed.body.data.intact).toBe(false);
    expect(changed.body.data.current_hash).not.toBe(changed.body.data.signed_hash);
  });

  test('signature list + signing act is itself in the hash chain', async () => {
    const list = await authClient('DOCTOR')
      .get(`/api/v1/integrity/signatures/clinical_note/${noteId}`);
    expect(list.status).toBe(200);
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
    const badType = await authClient('DOCTOR')
      .post('/api/v1/integrity/sign')
      .send({ document_type: 'tweet', document_id: 1 });
    expect(badType.status).toBe(400);

    const missing = await authClient('DOCTOR')
      .post('/api/v1/integrity/sign')
      .send({ document_type: 'clinical_note', document_id: 99999999 });
    expect(missing.status).toBe(404);
  });
});
