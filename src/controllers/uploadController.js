// src/controllers/uploadController.js - Hospital Upload Controller

import crypto from 'crypto';
import { validationResult } from 'express-validator';
import db from '../config/database.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import * as auditService from '../services/auditService.js';
import * as fileService from '../services/fileService.js';
import { formatFileResponse } from '../utils/fileProcessingUtils.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { success, error } from '../utils/responseHelper.js';

export async function uploadSingleFile(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  if (!req.file) {
    return error(res, 'No file uploaded', HTTP_STATUS.BAD_REQUEST);
  }

  try {
    const metadata = {
      ...req.body,
      ipAddress: req.uploadMetadata.ipAddress,
      userAgent: req.uploadMetadata.userAgent
    };

    const result = await fileService.processAndUploadFile(req.file, metadata, req.user);

    success(res, {
      ...result,
      retentionDate: result.retentionDate.toISOString().split('T')[0],
      retentionDateFormatted: result.retentionDate.toLocaleDateString('en-GB'),
      requestedBy: req.user?.uid
    }, 'Hospital file uploaded successfully and queued for security scan');

  } catch (err) {
    logger.error('Hospital File Upload Error:', err.stack || err.toString());
    error(res, 'Hospital file upload failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function uploadBatchFiles(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  if (!req.files || req.files.length === 0) {
    return error(res, 'No files uploaded for batch processing', HTTP_STATUS.BAD_REQUEST);
  }

  const generatedBatchId = req.body.batchId || crypto.randomUUID();
  const results = [];
  const errors_list = [];
  let totalProcessingTime = 0;

  try {
    // Process each file
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      
      try {
        const processingStart = Date.now();
        
        const metadata = {
          ...req.body,
          ipAddress: req.uploadMetadata.ipAddress,
          userAgent: req.uploadMetadata.userAgent,
          batchId: generatedBatchId
        };

        const result = await fileService.processAndUploadFile(file, metadata, req.user);
        
        const processingTime = Date.now() - processingStart;
        totalProcessingTime += processingTime;

        results.push({
          fileId: result.fileId,
          fileName: result.fileName,
          fileSize: result.fileSize,
          originalSize: result.originalSize,
          storageKey: result.storageKey,
          processingTimeMs: processingTime,
          status: 'uploaded',
          position: i + 1
        });

        // Log individual file upload
        await auditService.logFileAccess(result.fileId, 'batch_upload', req.user?.uid, 
          req.uploadMetadata.ipAddress, req.uploadMetadata.userAgent, 
          `Batch upload ${generatedBatchId} - File ${i + 1}/${req.files.length}`);

      } catch (fileError) {
        logger.error(`Batch upload file ${i + 1} failed:`, fileError);
        errors_list.push({
          fileName: file.originalname,
          position: i + 1,
          error: fileError.message,
          fileSize: file.size
        });
      }
    }

    // Log batch completion
    await db.query(`
      INSERT INTO batch_upload_logs (
        batch_id, uploaded_by, total_files, successful_files, failed_files,
        total_processing_time_ms, category, is_hipaa_protected, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      generatedBatchId, req.user?.uid, req.files.length, results.length, 
      errors_list.length, totalProcessingTime, req.body.category, 
      req.body.hipaaProtected || false
    ]);

    logger.info(`📤 Hospital batch upload completed: ${results.length}/${req.files.length} files | Batch: ${generatedBatchId} | User: ${req.user?.uid}`);

    success(res, {
      batchId: generatedBatchId,
      uploadedFiles: results,
      failedFiles: errors_list,
      summary: {
        totalFiles: req.files.length,
        successful: results.length,
        failed: errors_list.length,
        successRate: `${((results.length / req.files.length) * 100).toFixed(1)}%`,
        totalProcessingTimeMs: totalProcessingTime,
        category: req.body.category,
        isHipaaProtected: req.body.hipaaProtected || false
      },
      requestedBy: req.user?.uid
    }, `Hospital batch upload completed: ${results.length}/${req.files.length} files processed successfully`);

  } catch (err) {
    logger.error('Hospital Batch Upload Error:', err);
    error(res, 'Hospital batch upload failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function listFiles(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { 
      page = 1, limit = 50, category, scanStatus = 'all',
      isPrivate, uploadedBy, patientPhone, hipaaOnly = false,
      urgencyLevel, batchId, dateFrom, dateTo
    } = req.query;
    
    const userRole = req.user?.role;
    const userId = req.user?.uid;
    const offset = (page - 1) * limit;
    
    let whereClause = 'WHERE 1=1';
    const params = [limit, offset];
    let paramIndex = 3;

    // Role-based filtering
    if (!['ADMIN', 'DOCTOR'].includes(userRole)) {
      // Non-admin/doctor users can only see their own files or non-HIPAA files they have access to
      whereClause += ` AND (uploaded_by = $${paramIndex} OR (is_hipaa_protected = false AND is_private = false))`;
      params.push(userId);
      paramIndex++;
    }

    // Apply filters
    if (category) {
      whereClause += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (scanStatus !== 'all') {
      whereClause += ` AND scan_status = $${paramIndex}`;
      params.push(scanStatus);
      paramIndex++;
    }

    if (hipaaOnly === 'true') {
      whereClause += ` AND is_hipaa_protected = true`;
    }

    if (isPrivate !== undefined) {
      whereClause += ` AND is_private = $${paramIndex}`;
      params.push(isPrivate === 'true');
      paramIndex++;
    }

    if (uploadedBy) {
      whereClause += ` AND uploaded_by = $${paramIndex}`;
      params.push(uploadedBy);
      paramIndex++;
    }

    if (patientPhone) {
      whereClause += ` AND patient_phone = $${paramIndex}`;
      params.push(normalizePhone(patientPhone));
      paramIndex++;
    }

    if (urgencyLevel) {
      whereClause += ` AND urgency_level = $${paramIndex}`;
      params.push(urgencyLevel);
      paramIndex++;
    }

    if (batchId) {
      whereClause += ` AND batch_id = $${paramIndex}`;
      params.push(batchId);
      paramIndex++;
    }

    if (dateFrom) {
      whereClause += ` AND uploaded_at >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      whereClause += ` AND uploaded_at <= $${paramIndex}`;
      params.push(dateTo);
      paramIndex++;
    }

    // Main query
    const files = await db.query(`
      SELECT 
        fm.id, fm.file_name, fm.file_type, fm.file_size, fm.original_size,
        fm.category, fm.description, fm.is_private, fm.is_hipaa_protected,
        fm.scan_status, fm.scan_result, fm.is_quarantined, fm.urgency_level,
        fm.uploaded_at, fm.scanned_at, fm.retention_date, fm.batch_id,
        fm.compression_applied, fm.processing_time_ms,
        u.name as uploaded_by_name, fm.uploaded_by_role,
        CASE 
          WHEN fm.is_quarantined = true THEN true
          WHEN fm.scan_status IN ('infected', 'failed') THEN true
          ELSE false
        END as quarantined,
        CASE 
          WHEN fm.retention_date < CURRENT_DATE THEN true
          ELSE false
        END as expired
      FROM file_metadata fm
      LEFT JOIN users u ON fm.uploaded_by = u.uid
      ${whereClause}
      ORDER BY 
        CASE WHEN fm.urgency_level = 'urgent' THEN 1
             WHEN fm.urgency_level = 'high' THEN 2
             ELSE 3 END,
        fm.uploaded_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    // Count total
    const totalQuery = `SELECT COUNT(*) FROM file_metadata fm ${whereClause}`;
    const total = await db.query(totalQuery, params.slice(2));

    // Format dates
    const formattedFiles = files.rows.map(formatFileResponse);

    success(res, {
      files: formattedFiles,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total.rows[0].count),
        totalPages: Math.ceil(total.rows[0].count / limit)
      },
      filters: { 
        category, scanStatus, isPrivate, uploadedBy, patientPhone, 
        hipaaOnly, urgencyLevel, batchId, dateFrom, dateTo 
      },
      userAccess: {
        role: userRole,
        canViewHipaa: ['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole),
        canViewAll: ['ADMIN', 'DOCTOR'].includes(userRole)
      },
      requestedBy: userId
    }, 'Hospital files retrieved successfully');

  } catch (err) {
    logger.error('List Hospital Files Error:', err);
    error(res, 'Failed to fetch hospital files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getFileMetadata(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { fileId } = req.params;
    const userRole = req.user?.role;
    const userId = req.user?.uid;
    const ipAddress = req.uploadMetadata?.ipAddress;

    const file = await fileService.getFileMetadata(fileId, userId, userRole);
    
    if (!file) {
      return error(res, 'Hospital file not found', HTTP_STATUS.NOT_FOUND);
    }

    // Log metadata access for HIPAA files
    if (file.is_hipaa_protected) {
      await auditService.logFileAccess(fileId, 'metadata_view', userId, ipAddress, 
        req.headers['user-agent'], 'HIPAA file metadata accessed');
    }

    // Get recent access logs (admin/doctor only)
    let recentAccess = [];
    if (['ADMIN', 'DOCTOR'].includes(userRole)) {
      recentAccess = await auditService.getFileAccessLogs(fileId);
    }

    const formattedFile = {
      ...formatFileResponse(file),
      recentAccess
    };

    success(res, {
      file: formattedFile,
      userAccess: {
        role: userRole,
        canDownload: !file.quarantined,
        canDelete: file.uploaded_by === userId || userRole === 'ADMIN',
        canViewLogs: ['ADMIN', 'DOCTOR'].includes(userRole)
      },
      requestedBy: userId
    }, 'Hospital file metadata retrieved successfully');

  } catch (err) {
    logger.error('Get Hospital File Metadata Error:', err);
    error(res, 'Failed to fetch hospital file metadata', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function generateDownloadUrl(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { fileId } = req.params;
    const { expiresIn = 3600 } = req.query;
    const userRole = req.user?.role;
    const userId = req.user?.uid;
    const ipAddress = req.uploadMetadata?.ipAddress;

    const result = await fileService.generateDownloadUrl(fileId, userId, userRole, expiresIn, ipAddress);

    success(res, {
      ...result,
      expiresAt: result.expiresAt.toISOString(),
      expiresAtFormatted: result.expiresAt.toLocaleDateString('en-GB'),
      requestedBy: userId
    }, 'Secure hospital file download URL generated successfully');

  } catch (err) {
    logger.error('Generate Hospital Download URL Error:', err);
    const statusCode = err.message.includes('not found') ? HTTP_STATUS.NOT_FOUND :
                      err.message.includes('Access denied') ? HTTP_STATUS.FORBIDDEN :
                      err.message.includes('quarantined') ? HTTP_STATUS.FORBIDDEN :
                      err.message.includes('infected') ? HTTP_STATUS.FORBIDDEN :
                      err.message.includes('being scanned') ? HTTP_STATUS.TOO_EARLY :
                      err.message.includes('expired') ? HTTP_STATUS.GONE :
                      HTTP_STATUS.INTERNAL_SERVER_ERROR;
    error(res, 'Failed to generate secure download URL', statusCode);
  }
}

export async function deleteFile(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { fileId } = req.params;
    const { reason = 'User requested deletion', permanentDelete = false } = req.body;
    const userRole = req.user?.role;
    const userId = req.user?.uid;
    const ipAddress = req.uploadMetadata?.ipAddress;

    const result = await fileService.deleteFile(fileId, userId, userRole, reason, permanentDelete, ipAddress);

    success(res, {
      fileId,
      ...result,
      reason,
      deletedBy: userId,
      retentionDate: result.retentionDate?.toISOString().split('T')[0],
      requestedBy: userId
    }, result.deletionType === 'soft_delete' 
      ? 'HIPAA protected file soft deleted successfully' 
      : 'Hospital file permanently deleted successfully');

  } catch (err) {
    logger.error('Delete Hospital File Error:', err);
    const statusCode = err.message.includes('not found') ? HTTP_STATUS.NOT_FOUND :
                      err.message.includes('Permission denied') ? HTTP_STATUS.FORBIDDEN :
                      err.message.includes('admin approval') ? HTTP_STATUS.FORBIDDEN :
                      HTTP_STATUS.INTERNAL_SERVER_ERROR;
    error(res, 'Failed to delete hospital file', statusCode);
  }
}