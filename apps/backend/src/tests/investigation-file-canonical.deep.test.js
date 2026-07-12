import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import {
  deleteFile,
  uploadInvestigationFile,
} from '../services/investigation/fileService.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = randomUUID();
const ACTOR_UID = randomUUID();
const PHONE = `6${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let patientId;
let investigationId;

async function cleanup() {
  const paths = await prisma.$queryRawUnsafe(
    `SELECT file_path FROM investigation_files WHERE investigation_id = $1`,
    investigationId || 0,
  ).catch(() => []);
  for (const row of paths) {
    if (row.file_path) await fs.unlink(row.file_path).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigation_files WHERE investigation_id = $1`,
    investigationId || 0,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigations WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    ACTOR_UID,
  ).catch(() => {});
}

d('investigation file canonical audit', () => {
  beforeAll(async () => {
    await cleanup();
    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Investigation File Patient', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID,
      PHONE,
      TENANT_ID,
    );
    patientId = patient[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Investigation File Doctor', 'DOCTOR', true, $3::uuid, NOW())`,
      ACTOR_UID,
      `5${PHONE.slice(1)}`,
      TENANT_ID,
    );
    const investigation = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, patient_uid, patient_id, phone, test_name, test_type, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'Investigation document test', 'LAB', 'REQUESTED', NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      patientId,
      PHONE,
    );
    investigationId = investigation[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('writes upload/delete detail and canonical events with the staff actor', async () => {
    const buffer = Buffer.from('%PDF-1.4 canonical investigation document');
    const file = await uploadInvestigationFile(investigationId, {
      originalname: 'investigation-result.pdf',
      size: buffer.length,
      buffer,
    }, ACTOR_UID, {
      tenantId: TENANT_ID,
      actorRole: 'DOCTOR',
    });

    await expect(fs.access(file.file_path)).resolves.toBeUndefined();
    const persisted = await prisma.$queryRawUnsafe(
      `SELECT id FROM investigation_files WHERE id = $1 AND tenant_id = $2::uuid`,
      file.id,
      TENANT_ID,
    );
    expect(persisted).toHaveLength(1);

    await deleteFile(file.id, ACTOR_UID, {
      tenantId: TENANT_ID,
      actorRole: 'DOCTOR',
    });
    await expect(fs.access(file.file_path)).rejects.toThrow();

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, actor_uid FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND source_table = 'investigation_files'
        ORDER BY occurred_at`,
      PATIENT_UID,
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, actor_uid FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND resource_table = 'investigation_files'
        ORDER BY occurred_at`,
      PATIENT_UID,
    );
    expect(timeline.map((row) => row.event_type)).toEqual([
      'investigation.file_uploaded',
      'investigation.file_deleted',
    ]);
    expect(audit.map((row) => row.action)).toEqual([
      'investigation.file_uploaded',
      'investigation.file_deleted',
    ]);
    expect(timeline.every((row) => String(row.actor_uid) === ACTOR_UID)).toBe(true);
    expect(audit.every((row) => String(row.actor_uid) === ACTOR_UID)).toBe(true);
  });
});
