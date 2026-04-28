// src/controllers/upload/uploadController.js
//
// Generic file upload + lookup-by-key for the patient app.
// - GET /upload/by-key/* returns { quarantined, storage_url } for the
//   shape `your_health_screen.dart` expects to download cached uploads.
// - POST /upload accepts a multipart `file` field and returns
//   { storageKey, storage_url } for `investigations_screen.dart`'s
//   slip-upload step.

import multer from 'multer';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { isStaff } from '../../utils/roleHelpers.js';
import { getSignedFileUrl, uploadFileToR2 } from '../../utils/r2Storage.js';
import { error, success } from '../../utils/responseHelper.js';

const SIGNED_URL_TTL_SECONDS = 3600;

export const uploadMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB cap, matches patient PDF limit
});

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

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, file_name, file_type, storage_key, file_size,
              uploaded_by, scan_status, is_active
       FROM file_metadata
       WHERE storage_key = $1
       LIMIT 1`,
      fileKey
    );
    if (!rows.length) {
      return error(res, 'File not found', HTTP_STATUS.NOT_FOUND);
    }

    const meta = rows[0];

    // Quarantined → patient app shows a localized "fileQuarantined" snackbar.
    if (meta.scan_status === 'QUARANTINED') {
      return success(res, { quarantined: true, file_name: meta.file_name }, 'File is quarantined');
    }

    if (!meta.is_active) {
      return error(res, 'File no longer available', 410);
    }

    const callerUid = req.user?.uid;
    const callerRole = req.user?.role;
    const ownerMatches = !!callerUid && !!meta.uploaded_by
      && String(meta.uploaded_by) === String(callerUid);
    const staffBypass = isStaff(callerRole);
    if (!ownerMatches && !staffBypass) {
      return error(res, 'Not authorized to access this file', HTTP_STATUS.FORBIDDEN);
    }

    const signedUrl = await getSignedFileUrl(fileKey, SIGNED_URL_TTL_SECONDS);

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
    const safeName = originalName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || `file.${ext}`;
    const storageKey = `uploads/${callerUid}/${ts}_${safeName}`;
    const contentType = req.file.mimetype || 'application/octet-stream';

    let storageUrl;
    try {
      storageUrl = await uploadFileToR2(req.file.buffer, storageKey, contentType);
    } catch (e) {
      logger.error('uploadFile R2 upload failed:', e);
      return error(res, 'File upload failed', 503);
    }

    await prisma.$queryRawUnsafe(
      `INSERT INTO file_metadata
         (file_name, file_type, storage_key, storage_url, file_size,
          uploaded_by, scan_status, privacy_level, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::uuid, 'PENDING', 'RESTRICTED', TRUE, NOW())
       ON CONFLICT (storage_key) DO NOTHING`,
      safeName, contentType, storageKey, storageUrl, req.file.size, callerUid
    );

    return success(res, {
      storageKey,
      storage_url: storageUrl,
      file_name: safeName,
      file_type: contentType,
      file_size: req.file.size
    }, 'File uploaded');
  } catch (e) {
    logger.error('uploadFile error:', e);
    return error(res, 'Failed to upload file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
