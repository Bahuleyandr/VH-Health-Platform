// src/controllers/upload/uploadController.js
//
// Generic file upload + lookup-by-key for the patient app.
// - GET /upload/by-key/* returns { quarantined, storage_url } for the
//   shape `your_health_screen.dart` expects to download cached uploads.
// - POST /upload accepts a multipart `file` field and returns
//   { storageKey, storage_url } for `investigations_screen.dart`'s
//   slip-upload step.

import multer from 'multer';
import {
  isScanStatusServable,
  normalizeScanStatus,
  resolveFileScanPolicy,
} from '../../config/fileScanPolicy.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizeUploadMimeType } from '../../middleware/uploadMiddleware.js';
import { screenUploadBuffer } from '../../services/security/fileScanService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { getSignedFileUrl, uploadFileToR2 } from '../../utils/r2Storage.js';
import { error, relayAppError, success } from '../../utils/responseHelper.js';

// Signed-URL lifetime for the by-key download path. Deliberately SHORT (was
// 3600): servability is checked at URL-issue time only, so the TTL is exactly
// how long an already-issued URL keeps serving after a row is quarantined or
// the policy flips. The patient app redeems the URL immediately after the
// by-key lookup (inline render / download start), so 5 minutes is generous
// for slow links without leaving an hour-long post-quarantine window.
// Pinned by src/tests/unit/uploadController.test.js.
const SIGNED_URL_TTL_SECONDS = 300;
const DOWNLOAD_BLOCKED_STATUS = 423;
const INTERNAL_ADMIN_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'INTEGRATION_ADMIN',
  'DATA_PROTECTION_OFFICER',
]);

export const uploadMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB cap, matches patient PDF limit
});

function normalizedRole(role) {
  return String(role || '').trim().toUpperCase();
}

function isInternalAdminRole(role) {
  return INTERNAL_ADMIN_ROLES.has(normalizedRole(role));
}

function storageKeyIsBoundToUploader(meta) {
  if (!meta?.storage_key || !meta?.uploaded_by) return false;
  return String(meta.storage_key).startsWith(`uploads/${meta.uploaded_by}/`);
}

function canAccessGenericUpload(req, meta) {
  if (isInternalAdminRole(req.user?.role)) return true;
  const callerUid = req.user?.uid;
  const ownerMatches = !!callerUid && !!meta.uploaded_by
    && String(meta.uploaded_by) === String(callerUid);
  return ownerMatches && storageKeyIsBoundToUploader(meta);
}

// A stored file whose scan_status is not servable under the active policy.
// The 423 carries the raw stored status and the active policy so an operator
// reading a support ticket can tell "we require scanning and this file predates
// the scanner" from "this file is quarantined" without a DB session.
function denyUnservableScanStatus(res, meta) {
  return error(
    res,
    'File is not available until its security scan passes',
    DOWNLOAD_BLOCKED_STATUS,
    {
      scan_status: meta.scan_status || 'PENDING',
      normalized_scan_status: normalizeScanStatus(meta.scan_status),
      scan_policy: resolveFileScanPolicy(),
      file_name: meta.file_name,
    },
  );
}

// GET /api/v1/upload/by-key/*
// Wildcard captures storage keys that may contain `/` (e.g. `uploads/<uid>/123_x.pdf`).
export const getFileByKey = async (req, res) => {
  try {
    // Express 5 / path-to-regexp v8 returns named wildcard segments either as
    // a joined string OR an array (depending on minor version). Normalize.
    const splat = req.params.splat;
    const fileKey = Array.isArray(splat) ? splat.join('/') : splat;
    if (!fileKey) {
      return error(res, 'fileKey is required', HTTP_STATUS.BAD_REQUEST);
    }

    // CAN-023: scope the by-key lookup to the caller's tenant so a file key
    // can never resolve another tenant's file (and so the internal-admin bypass
    // in canAccessGenericUpload stays within-tenant). Defense-in-depth alongside
    // RLS auto-scoping.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, file_name, file_type, storage_key, file_size,
              uploaded_by, scan_status, is_active
       FROM file_metadata
       WHERE storage_key = $1
         AND tenant_id = $2::uuid
       LIMIT 1`,
      fileKey, resolveTenantOrThrow(req)
    );
    if (!rows.length) {
      return error(res, 'File not found', HTTP_STATUS.NOT_FOUND);
    }

    const meta = rows[0];

    if (!meta.is_active) {
      return error(res, 'File no longer available', 410);
    }

    if (!canAccessGenericUpload(req, meta)) {
      return error(res, 'Not authorized to access this file', HTTP_STATUS.FORBIDDEN);
    }

    // CAN-022: a file that is not servable under the active scan policy is NEVER
    // downloadable through this endpoint — the previous client-supplied
    // `x-vh-internal-download` header let admin browser/API sessions bypass
    // malware-scan blocking. Quarantine review must use a dedicated,
    // server-identity-proven, audited path, not a request header.
    //
    // The allowlist is shared with the messaging and brand-kit gates
    // (src/config/fileScanPolicy.js) so all three agree on the same row.
    if (!isScanStatusServable(meta.scan_status)) {
      return denyUnservableScanStatus(res, meta);
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const signedUrl = await getSignedFileUrl(fileKey, SIGNED_URL_TTL_SECONDS, { baseUrl });

    return success(res, {
      quarantined: false,
      storage_url: signedUrl,
      storage_key: fileKey,
      file_name: meta.file_name,
      file_type: meta.file_type,
      file_size: Number(meta.file_size)
    }, 'File metadata retrieved');
  } catch (e) {
    logger.error('getFileByKey error:', e);
    return error(res, 'Failed to fetch file metadata', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /api/v1/upload  (multipart/form-data, field name "file")
export const uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return error(res, 'File is required', HTTP_STATUS.BAD_REQUEST);
    }

    const callerUid = req.user?.uid;
    if (!callerUid) {
      return error(res, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);
    }

    const ts = Date.now();
    const originalName = req.file.originalname || 'file';
    const ext = originalName.includes('.') ? originalName.split('.').pop() : 'bin';
    // Strip leading dots so `..pdf` / `.htaccess` style names can't survive
    // even though the path-traversal guard in r2Storage would catch a real
    // attempt; defense in depth against accidentally-hidden files on the
    // local-disk fallback's filesystem listing too.
    const safeName = (originalName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 200))
      || `file.${ext}`;
    const storageKey = `uploads/${callerUid}/${ts}_${safeName}`;
    const contentType = normalizeUploadMimeType(req.file) || 'application/octet-stream';

    // Screen BEFORE anything is written. This endpoint used to store the bytes,
    // stamp a literal 'PENDING' that no worker ever advanced, and answer 201 —
    // so the download gate below refused the file forever and the caller was
    // never told. The screening decision now happens at ingest and is reported
    // to the caller in the same response, so `download_available` is a fact
    // rather than a hope. A refusal (422 infected / 503 scanner required but
    // unavailable) stores nothing at all.
    const screened = await screenUploadBuffer(req.file.buffer, {
      subject: 'File',
      context: { uploadedBy: callerUid, storageKey, contentType },
    });

    let storageUrl;
    try {
      storageUrl = await uploadFileToR2(req.file.buffer, storageKey, contentType);
    } catch (e) {
      logger.error('uploadFile R2 upload failed:', e);
      return error(res, 'File upload failed', 503);
    }

    // CAN-023: stamp the tenant explicitly rather than relying on the GUC
    // default, so the row is correctly attributed even if the request runs
    // outside an RLS context.
    await prisma.$queryRawUnsafe(
      `INSERT INTO file_metadata
         (file_name, file_type, storage_key, storage_url, file_size,
          uploaded_by, scan_status, scan_result, privacy_level, is_active, tenant_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, 'RESTRICTED', TRUE, $9::uuid, NOW())
       ON CONFLICT (storage_key) DO NOTHING`,
      safeName, contentType, storageKey, storageUrl, req.file.size, callerUid,
      screened.scanStatus, JSON.stringify(screened.metadata), resolveTenantOrThrow(req)
    );

    return success(res, {
      storageKey,
      storage_url: null,
      file_name: safeName,
      file_type: contentType,
      file_size: req.file.size,
      scan_status: screened.scanStatus,
      scan_policy: screened.metadata.scan_policy,
      download_available: isScanStatusServable(screened.scanStatus)
    }, 'File uploaded');
  } catch (e) {
    // Screening refusals (422 FILE_SCAN_QUARANTINED / 503 FILE_SCAN_UNAVAILABLE)
    // are deliberate, caller-actionable answers, not 500s. relayAppError lifts
    // `code` to the response root and relays `details`; `safe: true` is what
    // keeps the hand-written 503 message intact through production
    // sanitization — a clinician must be told WHY the slip was not accepted,
    // and the point of this change is that they learn it at upload time.
    // Anything that is not an AppError still falls through to a generic 500
    // with the raw error logged server-side, never returned.
    return relayAppError(res, e, 'Failed to upload file', { safe: true });
  }
};
