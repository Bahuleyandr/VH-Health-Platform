// src/routes/admin/services/uploadService.js
import logger from '../../../logging/logger.js';
import {
  tableExists,
  columnExists,
  safeQuery,
  safeScalar,
} from './common.js';

/* -----------------------------------------------------------------------------
   Helpers to adapt to different schemas
----------------------------------------------------------------------------- */

async function resolveUploadsTable() {
  const candidates = ['uploads', 'file_uploads', 'files', 'documents'];
  for (const t of candidates) {
    if (await tableExists(t)) return t;
  }
  return null;
}

async function pickDateColumn(table) {
  const preferred = ['created_at', 'uploaded_at', 'createdon', 'inserted_at'];
  for (const c of preferred) {
    if (await columnExists(table, c)) return c;
  }
  return null;
}

async function pickFilenameColumn(table) {
  const candidates = ['filename', 'name', 'original_name', 'file_name'];
  for (const c of candidates) {
    if (await columnExists(table, c)) return c;
  }
  return null;
}

async function pickSizeExpr(table) {
  const sizes = ['size_bytes', 'size', 'bytes', 'file_size'];
  for (const c of sizes) {
    if (await columnExists(table, c)) return `COALESCE(${c},0)`;
  }
  return null;
}

async function hasHipaaColumn(table) {
  const cols = ['hipaa_protected', 'is_hipaa', 'is_hipaa_protected'];
  for (const c of cols) {
    if (await columnExists(table, c)) return c;
  }
  return null;
}

async function hasQuarantineColumn(table) {
  const cols = ['is_quarantined', 'quarantined'];
  for (const c of cols) {
    if (await columnExists(table, c)) return c;
  }
  return null;
}

/* -----------------------------------------------------------------------------
   Summaries & Listings
----------------------------------------------------------------------------- */

export async function getUploadSummary() {
  const table = await resolveUploadsTable();
  if (!table) {
    return {
      totalFiles: 0,
      totalSizeBytes: 0,
      hipaaProtected: 0,
      quarantined: 0,
      expired: 0,
      last7Days: [],
    };
  }

  const dateCol = await pickDateColumn(table);
  const sizeExpr = await pickSizeExpr(table);
  const hipaaCol = await hasHipaaColumn(table);
  const quarantineCol = await hasQuarantineColumn(table);

  const totalFiles = await safeScalar(`SELECT COUNT(*) FROM ${table}`, [], 0);

  const totalSizeBytes = sizeExpr
    ? await safeScalar(`SELECT COALESCE(SUM(${sizeExpr}),0) FROM ${table}`, [], 0)
    : 0;

  const hipaaProtected = hipaaCol
    ? await safeScalar(`SELECT COUNT(*) FROM ${table} WHERE ${hipaaCol} = true`, [], 0)
    : 0;

  // Quarantine via dedicated table OR column on uploads
  let quarantined = 0;
  if (await tableExists('quarantined_files')) {
    quarantined = await safeScalar(`SELECT COUNT(*) FROM quarantined_files`, [], 0);
  } else if (quarantineCol) {
    quarantined = await safeScalar(
      `SELECT COUNT(*) FROM ${table} WHERE ${quarantineCol} = true`,
      [],
      0
    );
  }

  // Expired if an expires_at column exists
  const expired = (await columnExists(table, 'expires_at'))
    ? await safeScalar(
        `SELECT COUNT(*) FROM ${table} WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
        [],
        0
      )
    : 0;

  // Trend (past 7 days)
  const last7Days = dateCol
    ? await safeQuery(
        `
        SELECT date_trunc('day', ${dateCol}) AS date, COUNT(*)::int AS count
        FROM ${table}
        WHERE ${dateCol} >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY 1
        ORDER BY 1
        `,
        [],
        'uploads.trend7'
      )
    : [];

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
  // Prefer dedicated quarantined_files table
  if (await tableExists('quarantined_files')) {
    return await safeQuery(
      `
      SELECT id, filename, quarantine_reason, created_at
      FROM quarantined_files
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset],
      'uploads.quarantine.list_dedicated'
    );
  }

  // Fallback to uploads table with is_quarantined column
  const table = await resolveUploadsTable();
  if (!table) return [];
  const quarantineCol = await hasQuarantineColumn(table);
  const dateCol = await pickDateColumn(table);
  const nameCol = await pickFilenameColumn(table);

  if (!quarantineCol) return [];

  const orderCol = dateCol || '1';
  const selectName = nameCol ? `${nameCol} AS filename,` : '';
  return await safeQuery(
    `
    SELECT id, ${selectName} ${quarantineCol} AS is_quarantined${dateCol ? `, ${dateCol} AS created_at` : ''}
    FROM ${table}
    WHERE ${quarantineCol} = true
    ORDER BY ${orderCol} DESC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset],
    'uploads.quarantine.list_fallback'
  );
}

export async function getHipaaAuditReport({ limit = 50, offset = 0, startDate = null, endDate = null } = {}) {
  const table = await resolveUploadsTable();
  if (!table) return { files: [], total: 0 };

  const hipaaCol = await hasHipaaColumn(table);
  if (!hipaaCol) return { files: [], total: 0 };

  const nameCol = await pickFilenameColumn(table);
  const dateCol = await pickDateColumn(table);
  const accessedCol = (await columnExists(table, 'last_accessed_at')) ? 'last_accessed_at' : null;

  const params = [startDate, endDate, limit, offset];
  const whereDate =
    dateCol ? `AND ${dateCol} >= COALESCE($1::timestamp, '-infinity') AND ${dateCol} <= COALESCE($2::timestamp, 'infinity')` : '';

  const rows = await safeQuery(
    `
    SELECT
      id
      ${nameCol ? `, ${nameCol} AS filename` : ''}
      ${dateCol ? `, ${dateCol} AS created_at` : ''}
      ${accessedCol ? `, ${accessedCol} AS last_accessed_at` : ''}
    FROM ${table}
    WHERE ${hipaaCol} = true
    ${whereDate}
    ORDER BY ${dateCol || 'id'} DESC
    LIMIT $3 OFFSET $4
    `,
    params,
    'uploads.hipaa.audit'
  );

  // total count with same filters
  const total = await safeScalar(
    `
    SELECT COUNT(*) FROM ${table}
    WHERE ${hipaaCol} = true
    ${whereDate}
    `,
    [startDate, endDate],
    0
  );

  return { files: rows, total: Number(total) || 0 };
}

/* -----------------------------------------------------------------------------
   Admin Actions (safe, no-throw; act as stubs when columns/tables missing)
----------------------------------------------------------------------------- */

export async function rescanFile(fileId) {
  const table = await resolveUploadsTable();
  if (!table) return { success: true, updated: 0, message: 'No uploads table' };

  const canSetStatus = await columnExists(table, 'scan_status');
  const canSetScannedAt = await columnExists(table, 'scanned_at');

  if (!canSetStatus && !canSetScannedAt) {
    logger.warn('[uploads.rescan] missing scan columns; returning stub response');
    return { success: true, updated: 0, message: 'Scan columns not present' };
  }

  const sets = [];
  if (canSetStatus) sets.push(`scan_status = 'pending'`);
  if (canSetScannedAt) sets.push(`scanned_at = NOW()`);

  const r = await safeQuery(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
    [fileId],
    'uploads.rescan'
  );
  return { success: true, updated: r.length, fileId };
}

export async function cleanupExpiredFiles(dryRun = true) {
  const table = await resolveUploadsTable();
  if (!table || !(await columnExists(table, 'expires_at'))) {
    return { success: true, deleted: 0, dryRun, details: [] };
  }

  if (dryRun) {
    const rows = await safeQuery(
      `SELECT id FROM ${table} WHERE expires_at IS NOT NULL AND expires_at < NOW() ORDER BY expires_at ASC LIMIT 500`,
      [],
      'uploads.cleanup.preview'
    );
    return { success: true, deleted: 0, dryRun, details: rows.map(r => r.id) };
  }

  const result = await safeQuery(
    `DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at < NOW() RETURNING id`,
    [],
    'uploads.cleanup.delete'
  );
  return { success: true, deleted: result.length, dryRun: false, details: result.map(r => r.id) };
}

export async function bulkUpdateHipaaProtection({ ids = [], protect = true } = {}) {
  const table = await resolveUploadsTable();
  if (!table) return { success: true, updated: 0 };

  const hipaaCol = await hasHipaaColumn(table);
  if (!hipaaCol || !Array.isArray(ids) || ids.length === 0) {
    return { success: true, updated: 0 };
  }

  const r = await safeQuery(
    `UPDATE ${table} SET ${hipaaCol} = $1 WHERE id = ANY($2::uuid[]) RETURNING id`,
    [Boolean(protect), ids],
    'uploads.hipaa.bulk'
  );
  return { success: true, updated: r.length };
}

export async function purgeQuarantinedFiles(dryRun = true) {
  // Prefer dedicated table
  if (await tableExists('quarantined_files')) {
    if (dryRun) {
      const rows = await safeQuery(
        `SELECT id FROM quarantined_files ORDER BY created_at DESC LIMIT 500`,
        [],
        'uploads.quarantine.preview'
      );
      return { success: true, purged: 0, dryRun, details: rows.map(r => r.id) };
    }
    const del = await safeQuery(
      `DELETE FROM quarantined_files RETURNING id`,
      [],
      'uploads.quarantine.delete'
    );
    return { success: true, purged: del.length, dryRun: false, details: del.map(r => r.id) };
  }

  // Fallback: flag column on uploads
  const table = await resolveUploadsTable();
  if (!table) return { success: true, purged: 0, dryRun, details: [] };

  const quarantineCol = await hasQuarantineColumn(table);
  if (!quarantineCol) return { success: true, purged: 0, dryRun, details: [] };

  if (dryRun) {
    const rows = await safeQuery(
      `SELECT id FROM ${table} WHERE ${quarantineCol} = true ORDER BY id DESC LIMIT 500`,
      [],
      'uploads.quarantine.preview2'
    );
    return { success: true, purged: 0, dryRun, details: rows.map(r => r.id) };
  }

  const upd = await safeQuery(
    `UPDATE ${table} SET ${quarantineCol} = false WHERE ${quarantineCol} = true RETURNING id`,
    [],
    'uploads.quarantine.clearflag'
  );
  return { success: true, purged: upd.length, dryRun: false, details: upd.map(r => r.id) };
}

export default {
  getUploadSummary,
  listQuarantinedFiles,
  getHipaaAuditReport,
  rescanFile,
  cleanupExpiredFiles,
  bulkUpdateHipaaProtection,
  purgeQuarantinedFiles,
};
