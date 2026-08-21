// src/routes/admin/services/uploadService.js
//
// Admin file-management surface over the REAL scan-status stores.
//
// This module used to probe for tables named uploads/file_uploads/files/
// documents — none of which have ever existed in this schema — so the admin
// uploads dashboard reported 0 quarantined files forever and "rescan" would
// have stamped the never-servable legacy 'pending' status (871-F3). It now
// targets the two stores that actually carry a scan_status:
//
//   * file_metadata              — generic uploads (uploadController)
//   * staff_message_attachments  — staff messaging attachments
//
// and makes every status it writes come from the unified vocabulary in
// src/config/fileScanPolicy.js. Nothing here can mint a permanently-blocked
// row: a rescan outcome is either a real verdict ('clean'/'quarantined'), the
// declared no-scanner status ('not_scanned'), or NO write at all.

import {
  FILE_SCAN_POLICY,
  FILE_SCAN_STATUS,
  normalizeScanStatus,
  resolveFileScanPolicy,
} from '../../../config/fileScanPolicy.js';
import logger from '../../../logging/logger.js';
import { SCAN_OUTCOME, scanBufferVerdict } from '../../../utils/virusScanner.js';
import { deleteObject, getFileFromR2 } from '../../../utils/r2Storage.js';
import { safeQuery, safeScalar } from './common.js';

// Rows an admin needs to review: statuses that are never servable under ANY
// policy. ('not_scanned' is deliberately absent — it is the declared, visible
// posture of this deployment, not a stuck state.) Matches the normalization
// idiom of migrations 674/676: legacy rows may carry 'PENDING', blank, or NULL.
const REVIEW_PREDICATE =
  "LOWER(TRIM(COALESCE(scan_status, ''))) IN ('quarantined', 'failed', 'pending', '')";

const QUARANTINED_PREDICATE =
  "LOWER(TRIM(COALESCE(scan_status, ''))) = 'quarantined'";

// Composite ids keep the two stores unambiguous through the REST surface:
// 'generic:<int>' → file_metadata, 'attachment:<uuid>' → staff_message_attachments.
// A bare number is accepted as file_metadata for back-compat.
//
// The id SHAPE is store-specific because the underlying key types differ:
// file_metadata.id is an integer (SERIAL) while staff_message_attachments.id
// is a uuid. The quarantine listing emits exactly these composite forms, so
// parse → load → stamp must round-trip both. A uuid on the generic side or an
// integer on the attachment side can never address a real row and is rejected
// here rather than deep in a query error.
const SOURCE_GENERIC = 'generic';
const SOURCE_ATTACHMENT = 'attachment';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUploadFileId(raw) {
  const text = String(raw ?? '').trim();
  const genericMatch = /^(?:generic:)?(\d+)$/.exec(text);
  if (genericMatch) {
    return { source: SOURCE_GENERIC, id: Number(genericMatch[1]) };
  }
  const attachmentMatch = /^attachment:(.+)$/.exec(text);
  if (attachmentMatch && UUID_RE.test(attachmentMatch[1])) {
    return { source: SOURCE_ATTACHMENT, id: attachmentMatch[1].toLowerCase() };
  }
  return null;
}

/* -----------------------------------------------------------------------------
   Summaries & Listings
----------------------------------------------------------------------------- */

export async function getUploadSummary() {
  const totalFiles =
    (await safeScalar('SELECT COUNT(*) FROM file_metadata', [], 0)) +
    (await safeScalar('SELECT COUNT(*) FROM staff_message_attachments', [], 0));

  const totalSizeBytes =
    (await safeScalar('SELECT COALESCE(SUM(file_size), 0) FROM file_metadata', [], 0)) +
    (await safeScalar('SELECT COALESCE(SUM(file_size), 0) FROM staff_message_attachments', [], 0));

  // file_metadata has no per-file HIPAA flag; privacy_level='RESTRICTED' is the
  // real column that expresses "not generally accessible" (every generic upload
  // is written RESTRICTED today).
  const hipaaProtected = await safeScalar(
    "SELECT COUNT(*) FROM file_metadata WHERE privacy_level = 'RESTRICTED'",
    [],
    0,
  );

  // The count the "Quarantined" tile reports is the review backlog — every row
  // no policy will ever serve — so the tile agrees with the list below.
  const quarantined =
    (await safeScalar(`SELECT COUNT(*) FROM file_metadata WHERE ${REVIEW_PREDICATE}`, [], 0)) +
    (await safeScalar(
      `SELECT COUNT(*) FROM staff_message_attachments WHERE ${REVIEW_PREDICATE}`,
      [],
      0,
    ));

  // No expires_at concept exists in this schema; deactivated generic uploads
  // (is_active = false — purged or withdrawn) are the closest real state.
  const expired = await safeScalar(
    'SELECT COUNT(*) FROM file_metadata WHERE is_active = false',
    [],
    0,
  );

  const last7Days = await safeQuery(
    `
    SELECT date_trunc('day', uploaded)::date::text AS date, COUNT(*)::int AS count
      FROM (
        SELECT uploaded_at AS uploaded FROM file_metadata
         WHERE uploaded_at >= CURRENT_DATE - INTERVAL '7 days'
        UNION ALL
        SELECT created_at AS uploaded FROM staff_message_attachments
         WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
      ) u
     GROUP BY 1
     ORDER BY 1
    `,
    [],
    'uploads.trend7',
  );

  return {
    totalFiles: Number(totalFiles) || 0,
    totalSizeBytes: Number(totalSizeBytes) || 0,
    hipaaProtected: Number(hipaaProtected) || 0,
    quarantined: Number(quarantined) || 0,
    expired: Number(expired) || 0,
    last7Days,
  };
}

export async function listQuarantinedFiles(limit = 50, offset = 0) {
  return await safeQuery(
    `
    SELECT source || ':' || id AS id,
           source,
           file_name,
           scan_status,
           reason,
           uploaded_by,
           quarantined_at,
           size_bytes
      FROM (
        -- id is cast to text in BOTH branches: file_metadata.id is an integer
        -- while staff_message_attachments.id is a uuid, and Postgres rejects
        -- the UNION at parse time otherwise ("UNION types integer and uuid
        -- cannot be matched") — which 500'd the whole admin uploads page.
        SELECT '${SOURCE_GENERIC}' AS source, id::text AS id, file_name,
               scan_status,
               'scan_status=' || COALESCE(scan_status, 'NULL') AS reason,
               uploaded_by::text AS uploaded_by,
               uploaded_at AS quarantined_at,
               COALESCE(file_size, 0) AS size_bytes
          FROM file_metadata
         WHERE ${REVIEW_PREDICATE}
        UNION ALL
        SELECT '${SOURCE_ATTACHMENT}' AS source, id::text AS id, file_name,
               scan_status,
               'scan_status=' || COALESCE(scan_status, 'NULL') AS reason,
               uploaded_by_uid::text AS uploaded_by,
               created_at AS quarantined_at,
               COALESCE(file_size, 0) AS size_bytes
          FROM staff_message_attachments
         WHERE ${REVIEW_PREDICATE}
      ) q
     ORDER BY quarantined_at DESC NULLS LAST
     LIMIT $1 OFFSET $2
    `,
    [limit, offset],
    'uploads.quarantine.list',
  );
}

export async function getHipaaAuditReport({ limit = 50, offset = 0, startDate = null, endDate = null } = {}) {
  // The real PHI access ledger (written by utils/hipaaAudit.js), mapped to the
  // shape the admin dashboard renders (actor / action / resource / created_at).
  const whereDate = `
    WHERE accessed_at >= COALESCE($1::timestamptz, '-infinity')
      AND accessed_at <= COALESCE($2::timestamptz, 'infinity')
  `;

  const rows = await safeQuery(
    `
    SELECT id,
           COALESCE(accessed_by::text, 'unknown')
             || COALESCE(' (' || accessed_by_role || ')', '') AS actor,
           action,
           record_type AS resource_type,
           patient_id  AS resource_id,
           accessed_at AS created_at
      FROM hipaa_access_log
      ${whereDate}
     ORDER BY accessed_at DESC
     LIMIT $3 OFFSET $4
    `,
    [startDate, endDate, limit, offset],
    'uploads.hipaa.audit',
  );

  const total = await safeScalar(
    `SELECT COUNT(*) FROM hipaa_access_log ${whereDate}`,
    [startDate, endDate],
    0,
  );

  return { files: rows, total: Number(total) || 0 };
}

/* -----------------------------------------------------------------------------
   Admin Actions
----------------------------------------------------------------------------- */

// The two stores key differently: staff_message_attachments.id is a uuid,
// file_metadata.id an integer. parseUploadFileId already guarantees the id
// value matches its store; the explicit ::uuid / ::int casts keep the bound
// parameter's type unambiguous either way.
async function loadUploadRow({ source, id }) {
  if (source === SOURCE_ATTACHMENT) {
    const rows = await safeQuery(
      `SELECT id, file_name, storage_key, scan_status
         FROM staff_message_attachments WHERE id = $1::uuid`,
      [id],
      'uploads.rescan.load_attachment',
    );
    return rows[0] || null;
  }
  const rows = await safeQuery(
    `SELECT id, file_name, storage_key, scan_status
       FROM file_metadata WHERE id = $1::int`,
    [id],
    'uploads.rescan.load_generic',
  );
  return rows[0] || null;
}

async function stampScanStatus({ source, id }, scanStatus) {
  const isAttachment = source === SOURCE_ATTACHMENT;
  const table = isAttachment ? 'staff_message_attachments' : 'file_metadata';
  const idCast = isAttachment ? 'uuid' : 'int';
  const rows = await safeQuery(
    `UPDATE ${table}
        SET scan_status = $1, updated_at = NOW()
      WHERE id = $2::${idCast}
      RETURNING id`,
    [scanStatus, id],
    'uploads.rescan.stamp',
  );
  return rows.length;
}

/**
 * Re-evaluate one stored file against the active FILE_SCAN_POLICY.
 *
 * Every written status is a terminal vocabulary value — this action can never
 * re-create the stuck-'pending' defect the old stub carried:
 *   * disabled_accepted_risk: no scan is attempted (there is no scanner, by
 *     declaration); a legacy 'failed'/'pending' row is re-stamped to the same
 *     'not_scanned' status any new upload gets — this is the admin release
 *     path for pre-policy backlogs. A 'quarantined' row is REFUSED: known-bad
 *     stays blocked unless an actual scan proves otherwise.
 *   * required: the bytes are fetched and actually scanned. clean →
 *     'clean', infected → 'quarantined'; scanner unavailable/erroring →
 *     NO write at all (the row keeps its current status) and the outcome is
 *     reported to the operator.
 */
export async function rescanFile(fileId) {
  const target = parseUploadFileId(fileId);
  if (!target) {
    return { success: false, updated: 0, message: 'Invalid file id (expected generic:<int> or attachment:<uuid>)' };
  }

  const row = await loadUploadRow(target);
  if (!row) {
    return { success: false, updated: 0, message: 'File not found' };
  }

  const policy = resolveFileScanPolicy();
  const currentStatus = normalizeScanStatus(row.scan_status);

  if (policy === FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK) {
    if (currentStatus === FILE_SCAN_STATUS.QUARANTINED) {
      return {
        success: false,
        updated: 0,
        fileId,
        scan_status: FILE_SCAN_STATUS.QUARANTINED,
        message: 'File is quarantined (known-bad); it can only be released by an actual clean scan under FILE_SCAN_POLICY=required',
      };
    }
    const updated = await stampScanStatus(target, FILE_SCAN_STATUS.NOT_SCANNED);
    logger.info('[uploads.rescan] released under disabled_accepted_risk', {
      fileId, previous_status: row.scan_status,
    });
    return {
      success: true,
      updated,
      fileId,
      scan_status: FILE_SCAN_STATUS.NOT_SCANNED,
      message: 'No scanner is deployed (disabled_accepted_risk); file recorded as not_scanned, the same status any new upload receives',
    };
  }

  let bytes;
  try {
    bytes = Buffer.from(await getFileFromR2(row.storage_key));
  } catch (fetchErr) {
    logger.error('[uploads.rescan] could not fetch stored bytes', { fileId, error: fetchErr.message });
    return { success: false, updated: 0, fileId, message: 'Stored file could not be fetched for scanning' };
  }

  const verdict = await scanBufferVerdict(bytes);

  if (verdict.outcome === SCAN_OUTCOME.CLEAN) {
    const updated = await stampScanStatus(target, FILE_SCAN_STATUS.CLEAN);
    return { success: true, updated, fileId, scan_status: FILE_SCAN_STATUS.CLEAN };
  }
  if (verdict.outcome === SCAN_OUTCOME.INFECTED) {
    const updated = await stampScanStatus(target, FILE_SCAN_STATUS.QUARANTINED);
    logger.warn('[uploads.rescan] malware detected on stored file', {
      fileId, signature: verdict.signature,
    });
    return { success: true, updated, fileId, scan_status: FILE_SCAN_STATUS.QUARANTINED };
  }

  // UNAVAILABLE / ERROR: write nothing. Stamping 'failed' here would mint the
  // permanently-blocked status this wave exists to retire.
  return {
    success: false,
    updated: 0,
    fileId,
    scan_status: row.scan_status,
    message: 'Scanner did not answer; file status unchanged — retry when clamd is reachable',
  };
}

// No expires_at / retention column exists on either real store, so there is
// nothing to clean up. Deterministic honest no-op (the old version probed
// nonexistent tables and pretended); retention for these stores is a
// deliberate future decision, not a silent delete.
export async function cleanupExpiredFiles(dryRun = true) {
  return {
    success: true,
    deleted: 0,
    dryRun,
    details: [],
    message: 'No retention/expiry column exists on file_metadata or staff_message_attachments; nothing to clean up',
  };
}

// No per-file HIPAA flag exists (privacy_level is set at ingest and is not an
// admin toggle). Deterministic honest no-op instead of a stub that pretends.
export async function bulkUpdateHipaaProtection({ ids = [], protect = true } = {}) {
  void ids; void protect;
  return {
    success: true,
    updated: 0,
    message: 'file_metadata has no per-file HIPAA flag; privacy_level is assigned at ingest and is not admin-togglable',
  };
}

/**
 * Purge KNOWN-BAD files only: rows whose scan_status is 'quarantined'
 * (a scanner positively identified malware). The stored object is deleted;
 * the database row is kept as evidence with its 'quarantined' status, which
 * every serving gate already refuses, and generic uploads are additionally
 * deactivated (is_active = false → 410 on lookup). Review-backlog statuses
 * ('failed'/'pending') are NEVER purged — they are unreviewed, not condemned.
 */
export async function purgeQuarantinedFiles(dryRun = true) {
  const rows = await safeQuery(
    `
    SELECT source, id, storage_key FROM (
      -- Same id::text cast as listQuarantinedFiles: integer vs uuid ids
      -- cannot be UNIONed without it.
      SELECT '${SOURCE_GENERIC}' AS source, id::text AS id, storage_key
        FROM file_metadata
       WHERE ${QUARANTINED_PREDICATE} AND is_active = true
      UNION ALL
      SELECT '${SOURCE_ATTACHMENT}' AS source, id::text AS id, storage_key
        FROM staff_message_attachments
       WHERE ${QUARANTINED_PREDICATE}
    ) q
    ORDER BY source, id
    LIMIT 500
    `,
    [],
    'uploads.quarantine.purge_candidates',
  );

  const details = rows.map(r => `${r.source}:${r.id}`);
  if (dryRun) {
    return { success: true, purged: 0, dryRun: true, details };
  }

  let purged = 0;
  for (const row of rows) {
    try {
      await deleteObject(row.storage_key);
      if (row.source === SOURCE_GENERIC) {
        await safeQuery(
          // row.id arrives as text (the candidate query casts both stores'
          // ids to text for the UNION); cast back for the integer column.
          'UPDATE file_metadata SET is_active = false, updated_at = NOW() WHERE id = $1::int RETURNING id',
          [row.id],
          'uploads.quarantine.deactivate',
        );
      }
      purged += 1;
    } catch (purgeErr) {
      logger.error('[uploads.purge] failed to purge quarantined object', {
        source: row.source, id: row.id, error: purgeErr.message,
      });
    }
  }
  return { success: true, purged, dryRun: false, details };
}

export default {
  getUploadSummary,
  listQuarantinedFiles,
  getHipaaAuditReport,
  rescanFile,
  cleanupExpiredFiles,
  bulkUpdateHipaaProtection,
  purgeQuarantinedFiles,
  parseUploadFileId,
};
