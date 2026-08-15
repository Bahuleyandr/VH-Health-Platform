// services/investigation/fileService.js
// Migrated from raw pg to Prisma ORM

import crypto from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { isScanStatusServable, normalizeScanStatus } from '../../config/fileScanPolicy.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { screenUploadBuffer } from '../security/fileScanService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads/investigations';
const ALLOWED_FILE_TYPES = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

async function ensureUploadDir() {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  } catch (err) {
    logger.error('Failed to create upload directory:', err);
  }
}

async function recordRequiredFileEvent(tx, investigation, file, {
  eventType,
  actorUid,
  actorRole,
  summary,
  beforeState = null,
  afterState = null,
}) {
  const fileState = {
    ...file,
    file_size: file.file_size == null ? null : String(file.file_size),
  };
  const event = await recordCanonicalClinicalEvent({
    tenantId: investigation.tenant_id,
    patientUid: investigation.patient_uid,
    eventType,
    eventSubtype: investigation.test_type || investigation.type || null,
    eventStatus: investigation.status,
    sourceTable: 'investigation_files',
    sourceId: file.id,
    resourceType: 'investigation_file',
    resourceId: file.id,
    actorUid,
    actorRole,
    summary,
    payload: {
      investigation_id: investigation.id,
      file_name: file.file_name,
      file_type: file.file_type,
      file_size: fileState.file_size,
    },
    beforeState: beforeState ? fileState : null,
    afterState: afterState ? fileState : null,
    timelineIdempotencyKey: `investigation_files:${file.id}:${eventType}`,
    auditIdempotencyKey: `investigation_files:${file.id}:audit:${eventType}`,
  }, { db: tx });
  if (!event?.timeline?.id || !event?.audit?.id) {
    throw AppError.internal(
      'Investigation file write requires canonical timeline and audit events',
      'INVESTIGATION_FILE_CANONICAL_EVENT_REQUIRED',
    );
  }
}

export const uploadInvestigationFile = async (
  investigationId,
  file,
  uploadedBy,
  { tenantId = null, actorRole = null } = {},
) => {
  await ensureUploadDir();

  const fileExt = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_FILE_TYPES.includes(fileExt)) {
    throw new Error('Invalid file type. Allowed types: ' + ALLOWED_FILE_TYPES.join(', '));
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File size exceeds 10MB limit');
  }

  // Check if investigation exists
  const effectiveTenantId = requireTenantId(tenantId);
  const rows = await prisma.$queryRaw`
    SELECT id, tenant_id, patient_uid, test_name, test_type, type, status
      FROM investigations
     WHERE id = ${parseInt(investigationId)}
       AND tenant_id = ${effectiveTenantId}::uuid
  `;
  if (rows.length === 0) throw new Error('Investigation not found');
  if (!rows[0].patient_uid) {
    throw AppError.conflict(
      'Investigation is not linked to a patient timeline',
      'INVESTIGATION_PATIENT_REQUIRED',
    );
  }

  // Screen BEFORE anything touches disk. Policy-aware (FILE_SCAN_POLICY):
  // under `required` an unscannable or infected file is refused and nothing is
  // stored; under `disabled_accepted_risk` the verdict is 'not_scanned'. The
  // returned status is persisted on the row and read back by the download gate.
  const screened = await screenUploadBuffer(file.buffer, {
    subject: 'Investigation file',
    context: { investigationId, uploadedBy, tenantId: effectiveTenantId },
  });

  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const fileName = `inv_${investigationId}_${timestamp}_${randomString}${fileExt}`;
  const filePath = path.join(UPLOAD_DIR, fileName);

  try {
    await fs.writeFile(filePath, file.buffer);

    const result = await setTenantTx(effectiveTenantId, async (tx) => {
      // Raw INSERT (not tx.investigation_files.create): scan_status was added
      // by migration 676 after the checked-in Prisma client was generated, and
      // the typed delegate rejects columns it does not know about.
      const createdRows = await tx.$queryRawUnsafe(
        `INSERT INTO investigation_files
           (investigation_id, file_name, file_path, file_type, file_size,
            uploaded_by, tenant_id, scan_status)
         VALUES ($1::int, $2, $3, $4, $5::bigint, $6::uuid, $7::uuid, $8)
         RETURNING id, investigation_id, file_name, file_path, file_type,
                   file_size, uploaded_by, tenant_id, scan_status, created_at`,
        parseInt(investigationId),
        file.originalname,
        filePath,
        fileExt,
        String(file.size),
        uploadedBy || null,
        effectiveTenantId,
        screened.scanStatus,
      );
      const created = createdRows[0];
      await recordRequiredFileEvent(tx, rows[0], created, {
        eventType: 'investigation.file_uploaded',
        actorUid: uploadedBy,
        actorRole,
        summary: `File uploaded for ${rows[0].test_name}`,
        afterState: created,
      });
      return created;
    });

    logger.info(`File uploaded for investigation ${investigationId}: ${fileName}`);
    return result;
  } catch (err) {
    try { await fs.unlink(filePath); } catch (_e) { /* ignore */ }
    throw err;
  }
};

export const getInvestigationFiles = async (investigationId) => {
  return prisma.investigation_files.findMany({
    where: { investigation_id: parseInt(investigationId) },
    select: {
      id: true, file_name: true, file_type: true,
      file_size: true, created_at: true, uploaded_by: true,
    },
    orderBy: { created_at: 'desc' },
  });
};

export const getFileById = async (fileId) => {
  // Raw SELECT (not the typed delegate): scan_status postdates the generated
  // Prisma client — see the INSERT in uploadInvestigationFile.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, investigation_id, file_name, file_path, file_type, file_size,
            uploaded_by, scan_status, created_at
       FROM investigation_files
      WHERE id = $1::int
      LIMIT 1`,
    parseInt(fileId),
  );
  return rows[0] || null;
};

export const deleteFile = async (
  fileId,
  deletedBy,
  { tenantId = null, actorRole = null } = {},
) => {
  const effectiveTenantId = requireTenantId(tenantId);
  const files = await prisma.$queryRaw`
    SELECT f.id, f.investigation_id, f.file_name, f.file_path, f.file_type,
           f.file_size, f.uploaded_by, f.created_at, f.tenant_id,
           i.patient_uid, i.test_name, i.test_type, i.type, i.status
      FROM investigation_files f
      JOIN investigations i ON i.id = f.investigation_id
       AND i.tenant_id = f.tenant_id
     WHERE f.id = ${parseInt(fileId)}
       AND f.tenant_id = ${effectiveTenantId}::uuid
     LIMIT 1
  `;
  const file = files[0];

  if (!file) throw new Error('File not found');
  if (!file.patient_uid) {
    throw AppError.conflict(
      'Investigation is not linked to a patient timeline',
      'INVESTIGATION_PATIENT_REQUIRED',
    );
  }

  await setTenantTx(effectiveTenantId, async (tx) => {
    await tx.investigation_files.delete({ where: { id: parseInt(fileId) } });
    await recordRequiredFileEvent(tx, {
      id: file.investigation_id,
      tenant_id: file.tenant_id,
      patient_uid: file.patient_uid,
      test_name: file.test_name,
      test_type: file.test_type,
      type: file.type,
      status: file.status,
    }, file, {
      eventType: 'investigation.file_deleted',
      actorUid: deletedBy,
      actorRole,
      summary: `File deleted from ${file.test_name}`,
      beforeState: file,
    });
  });

  if (file.file_path) {
    try { await fs.unlink(file.file_path); } catch (_e) { /* ignore */ }
  }

  logger.info(`File deleted: ${file.file_name} by ${deletedBy}`);
  return true;
};

export const getFileStream = async (fileId) => {
  const file = await getFileById(fileId);
  if (!file) throw new Error('File not found');

  // ALLOWLIST gate before any bytes leave disk — the same shared servable-set
  // decision the generic-upload, messaging, and brand-kit gates make
  // (src/config/fileScanPolicy.js). Backfilled legacy rows carry
  // 'not_scanned' (migration 676): servable under disabled_accepted_risk,
  // blocked under `required` until actually scanned.
  if (!isScanStatusServable(file.scan_status)) {
    throw AppError.locked(
      'File is not available until its security scan passes',
      'FILE_SCAN_NOT_CLEAN',
      {
        scan_status: file.scan_status || 'pending',
        normalized_scan_status: normalizeScanStatus(file.scan_status),
      },
    );
  }

  try {
    await fs.access(file.file_path);
  } catch (_e) {
    throw new Error('File not found on disk');
  }

  return {
    // NOTE: createReadStream comes from 'fs' — it does not exist on the
    // 'fs/promises' namespace this module otherwise uses; the previous
    // `fs.createReadStream(...)` was a guaranteed TypeError on every download.
    stream: createReadStream(file.file_path),
    fileName: file.file_name,
    fileType: file.file_type,
  };
};
