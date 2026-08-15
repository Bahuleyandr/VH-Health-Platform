// controllers/investigation/uploadController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { 
  uploadInvestigationFile, 
  getInvestigationFiles,
  getFileById,
  deleteFile,
  getFileStream 
} from '../../services/investigation/fileService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

async function checkInvestigationAccess(req, rawInvestigationId) {
  const investigationId = parseInt(rawInvestigationId, 10);
  if (!Number.isFinite(investigationId)) {
    return { ok: false, status: 400, message: 'Invalid investigation id' };
  }

  const requestedBy = req.user?.uid;
  const userRole = req.user?.role?.toUpperCase();
  const tenantId = tenantOf(req);

  if (userRole === 'PATIENT') {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT i.id
      FROM investigations i
      JOIN users u ON i.patient_id = u.id
      WHERE i.id = $1::int
        AND u.uid = $2::uuid
        AND i.tenant_id = $3::uuid
      LIMIT 1
    `, investigationId, requestedBy, tenantId);

    if (rows.length === 0) {
      return {
        ok: false,
        status: 403,
        message: 'Access denied: Cannot view files for other patients',
      };
    }
    return { ok: true, investigationId, tenantId };
  }

  const rows = await prisma.$queryRawUnsafe(`
    SELECT id
    FROM investigations
    WHERE id = $1::int
      AND tenant_id = $2::uuid
    LIMIT 1
  `, investigationId, tenantId);

  if (rows.length === 0) {
    return { ok: false, status: 404, message: 'Investigation not found' };
  }
  return { ok: true, investigationId, tenantId };
}

async function getBoundInvestigationFile(investigationId, fileId) {
  const file = await getFileById(fileId);
  if (!file) return null;
  if (Number(file.investigation_id) !== Number(investigationId)) return null;
  return file;
}

// Upload investigation result file
export const uploadResult = async (req, res) => {
  try {
    const { id } = req.params;
    const file = req.file;
    const uploadedBy = req.user?.uid;
    const userRole = req.user?.role?.toUpperCase();
    
    // Access control - only medical staff can upload
    const allowedRoles = ['DOCTOR', 'LAB_STAFF', 'LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return error(res, 'Access denied: Medical staff privileges required', 403);
    }

    if (!file) {
      return error(res, 'No file uploaded', 400);
    }

    const access = await checkInvestigationAccess(req, id);
    if (!access.ok) {
      return error(res, access.message, access.status);
    }
    
    // Log file details for debugging
    logger.info(`File upload attempt for investigation ${id}:`, {
      filename: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      uploadedBy
    });
    
    const result = await uploadInvestigationFile(id, file, uploadedBy, {
      tenantId: access.tenantId,
      actorRole: req.user?.role,
    });
    
    await logAudit(req, 'investigation-file-uploaded', {
      investigation_id: id,
      file_id: result.id,
      file_name: file.originalname,
      file_size: file.size
    });
    
    success(res, {
      file: result,
      uploadedBy
    }, 'File uploaded successfully');
    
  } catch (err) {
    logger.error('Upload Error:', err);

    // Screening refusals (422 FILE_SCAN_QUARANTINED / 503 FILE_SCAN_UNAVAILABLE)
    // are deliberate, caller-actionable answers from fileScanService — relay
    // them instead of collapsing to a generic 500.
    if (err && err.statusCode) {
      return relayAppError(res, err, 'Failed to upload file', { safe: true });
    }

    // Specific error handling
    if (err.message === 'Investigation not found') {
      return error(res, 'Investigation not found', 404);
    } else if (err.message.includes('Invalid file type')) {
      return error(res, err.message, 400);
    } else if (err.message.includes('File size exceeds')) {
      return error(res, err.message, 400);
    }

    error(res, 'Failed to upload file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get all files for an investigation
export const getFiles = async (req, res) => {
  try {
    const { id } = req.params;
    const requestedBy = req.user?.uid;

    const access = await checkInvestigationAccess(req, id);
    if (!access.ok) {
      return error(res, access.message, access.status);
    }
    
    const files = await getInvestigationFiles(id);
    
    await logAudit(req, 'investigation-files-viewed', {
      investigation_id: id,
      file_count: files.length
    });
    
    success(res, {
      files,
      count: files.length,
      requestedBy
    }, 'Files retrieved successfully');
    
  } catch (err) {
    logger.error('Get Files Error:', err);
    error(res, 'Failed to retrieve files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Download a specific file
export const downloadFile = async (req, res) => {
  try {
    const { id, fileId } = req.params;

    const access = await checkInvestigationAccess(req, id);
    if (!access.ok) {
      return error(res, access.message, access.status);
    }

    const file = await getBoundInvestigationFile(access.investigationId, fileId);
    if (!file) {
      return error(res, 'File not found', 404);
    }
    
    const fileData = await getFileStream(fileId);

    if (!fileData) {
      return error(res, 'File not found', 404);
    }
    
    await logAudit(req, 'investigation-file-downloaded', {
      investigation_id: id,
      file_id: fileId,
      file_name: fileData.fileName
    });
    
    // Set appropriate headers for file download
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileData.fileName}"`);

    // Stream the file. A stream 'error' after piping has started fires
    // asynchronously — the surrounding try/catch cannot see it, and with no
    // listener it becomes an uncaught exception that takes down the whole
    // process (bin/www.js shuts the API down on uncaughtException). Guard it
    // the same way routes/storage/storageRoutes.js does.
    fileData.stream.on('error', (streamErr) => {
      logger.error('Download File stream error:', streamErr);
      if (!res.headersSent) {
        res.removeHeader('Content-Disposition');
        res.removeHeader('Content-Type');
        return error(res, 'Failed to download file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
      // Response already started — nothing valid can be sent; abort it so the
      // client sees a truncated transfer instead of a hung connection.
      res.destroy();
    });
    // If the client goes away mid-download, destroy the source stream so the
    // underlying file descriptor is released instead of leaking.
    res.on('close', () => {
      if (typeof fileData.stream.destroy === 'function' && !fileData.stream.destroyed) {
        fileData.stream.destroy();
      }
    });
    fileData.stream.pipe(res);

  } catch (err) {
    logger.error('Download File Error:', err);

    // The scan-policy gate in getFileStream throws 423 FILE_SCAN_NOT_CLEAN —
    // relay it (same contract as the generic-upload / messaging gates).
    if (err && err.statusCode) {
      return relayAppError(res, err, 'Failed to download file', { safe: true });
    }

    if (err.message === 'File not found' || err.message === 'File not found on disk') {
      return error(res, 'File not found', 404);
    }

    error(res, 'Failed to download file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Delete a file
export const removeFile = async (req, res) => {
  try {
    const { id, fileId } = req.params;
    const deletedBy = req.user?.uid;
    const userRole = req.user?.role?.toUpperCase();

    const access = await checkInvestigationAccess(req, id);
    if (!access.ok) {
      return error(res, access.message, access.status);
    }
    
    // Only admins and the uploader can delete files
    const file = await getBoundInvestigationFile(access.investigationId, fileId);
    if (!file) {
      return error(res, 'File not found', 404);
    }

    if (userRole !== 'ADMIN' && file.uploaded_by !== deletedBy) {
      return error(res, 'Access denied: Only admin or file uploader can delete files', 403);
    }
    
    await deleteFile(fileId, deletedBy, {
      tenantId: access.tenantId,
      actorRole: req.user?.role,
    });
    
    await logAudit(req, 'investigation-file-deleted', {
      investigation_id: id,
      file_id: fileId,
      file_name: file.file_name
    });
    
    success(res, {
      message: 'File deleted successfully',
      deletedBy
    }, 'File deleted successfully');
    
  } catch (err) {
    logger.error('Delete File Error:', err);
    
    if (err.message === 'File not found') {
      return error(res, 'File not found', 404);
    }

    error(res, 'Failed to delete file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get file metadata without downloading
export const getFileInfo = async (req, res) => {
  try {
    const { id, fileId } = req.params;
    const requestedBy = req.user?.uid;

    const access = await checkInvestigationAccess(req, id);
    if (!access.ok) {
      return error(res, access.message, access.status);
    }

    const file = await getBoundInvestigationFile(access.investigationId, fileId);

    if (!file) {
      return error(res, 'File not found', 404);
    }
    
    success(res, {
      file: {
        id: file.id,
        name: file.file_name,
        type: file.file_type,
        size: file.file_size,
        uploadedAt: file.uploaded_at,
        uploadedBy: file.uploaded_by
      },
      requestedBy
    }, 'File info retrieved successfully');
    
  } catch (err) {
    logger.error('Get File Info Error:', err);
    error(res, 'Failed to retrieve file info', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
