// src/services/fileService.js - Hospital File Operations Service

import prisma from '../lib/prisma.js';
import { HOSPITAL_UPLOAD_CONFIG } from '../config/uploadConfig.js';
import logger from '../logging/logger.js';
import { scanFileWithClamAV } from '../utils/clamavScanHelper.js';
import { 
  generateSecureFileKey, 
  optimizeImage, 
  compressPDF, 
  calculateRetentionDate,
  formatFileResponse 
} from '../utils/fileProcessingUtils.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { uploadFileToR2, deleteObject, getSignedFileUrl } from '../utils/r2Storage.js';
import * as auditService from './auditService.js';

export async function processAndUploadFile(file, metadata, user) {
  const { 
    category = 'general', 
    description, 
    isPrivate = false,
    hipaaProtected = false,
    patientPhone,
    relatedId,
    relatedType,
    urgencyLevel = 'normal'
  } = metadata;
  
  const uploadedBy = user?.uid || 'system';
  const uploadedByRole = user?.role || 'unknown';
  const ipAddress = metadata.ipAddress;
  const userAgent = metadata.userAgent;

  // Auto-detect HIPAA protection based on category
  const isHipaaCategory = HOSPITAL_UPLOAD_CONFIG.hipaaCategories.includes(category);
  const finalHipaaProtected = hipaaProtected || isHipaaCategory;

  // Role-based access control for HIPAA files
  if (finalHipaaProtected && !['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(uploadedByRole)) {
    throw new Error('Insufficient permissions to upload HIPAA protected files');
  }

  let processedBuffer = file.buffer;
  let compressionApplied = false;
  let processingTime = Date.now();

  // Apply file optimization based on type and HIPAA requirements
  if (file.mimetype.startsWith('image/')) {
    processedBuffer = await optimizeImage(file.buffer, file.mimetype, finalHipaaProtected);
    compressionApplied = processedBuffer.length !== file.buffer.length;
  } else if (file.mimetype === 'application/pdf') {
    processedBuffer = await compressPDF(file.buffer, finalHipaaProtected);
    compressionApplied = processedBuffer.length !== file.buffer.length;
  }

  processingTime = Date.now() - processingTime;

  // Generate secure storage key
  const key = generateSecureFileKey(file.originalname, category, patientPhone);
  
  // Upload to R2 with encryption for HIPAA files
  const url = await uploadFileToR2(processedBuffer, key, file.mimetype);

  // Calculate retention date
  const retentionDate = calculateRetentionDate(category);

  // Store comprehensive metadata
  const result = await prisma.$queryRawUnsafe(`
    INSERT INTO file_metadata (
      file_name, file_type, file_size, original_size, storage_key, storage_url,
      category, description, is_private, is_hipaa_protected, uploaded_by,
      uploaded_by_role, patient_phone, related_id, related_type,
      compression_applied, processing_time_ms, scan_status, retention_date,
      urgency_level, upload_ip, upload_user_agent, uploaded_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21, $22, NOW()
    ) RETURNING id, storage_key, scan_status, retention_date`,
    [
      file.originalname, file.mimetype, processedBuffer.length, file.buffer.length,
      key, url, category, description, isPrivate, finalHipaaProtected, uploadedBy,
      uploadedByRole, normalizePhone(patientPhone), relatedId, relatedType,
      compressionApplied, processingTime, 'pending', retentionDate,
      urgencyLevel, ipAddress, userAgent
    ]
  );

  const fileId = result[0].id;

  // Log file upload
  await auditService.logFileAccess(fileId, 'upload', uploadedBy, ipAddress, userAgent, 
    `File uploaded: ${file.originalname} (${category})`);

  // Schedule async virus scan
  scheduleVirusScan(fileId, url, file.originalname, urgencyLevel, ipAddress, key);

  logger.info(`📤 Hospital file uploaded: ${file.originalname} | Category: ${category} | HIPAA: ${finalHipaaProtected} | User: ${uploadedBy} (${uploadedByRole})`);

  return {
    fileId,
    fileName: file.originalname,
    fileSize: processedBuffer.length,
    originalSize: file.buffer.length,
    compressionApplied,
    compressionRatio: compressionApplied 
      ? ((1 - (processedBuffer.length / file.buffer.length)) * 100).toFixed(1) + '%'
      : null,
    category,
    isHipaaProtected: finalHipaaProtected,
    storageKey: key,
    retentionDate: result[0].retention_date,
    url: (isPrivate || finalHipaaProtected) ? null : url,
    scanStatus: 'pending',
    processingTimeMs: processingTime,
    urgencyLevel,
    uploadedBy
  };
}

function scheduleVirusScan(fileId, url, fileName, urgencyLevel, ipAddress, key) {
  const scanDelay = urgencyLevel === 'urgent' ? 50 : 200;
  
  setTimeout(async () => {
    try {
      const scanStartTime = Date.now();
      const scanResult = await scanFileWithClamAV(url);
      const scanDuration = Date.now() - scanStartTime;
      
      let status = 'failed';
      let resultText = 'Unknown error';

      if (scanResult.status === 'clean') {
        status = 'clean';
        resultText = null;
      } else if (scanResult.status === 'infected') {
        status = 'infected';
        resultText = scanResult.virus;
      } else {
        status = 'failed';
        resultText = scanResult.error;
      }

      // Update scan results
      await prisma.$queryRawUnsafe(`
        UPDATE file_metadata SET 
          scan_status = $1, scan_result = $2, scanned_at = NOW(),
          scan_duration_ms = $3
        WHERE id = $4
      `, [status, resultText, scanDuration, fileId]);

      // Immediate quarantine for infected files
      if (status === 'infected') {
        await prisma.$queryRawUnsafe(`
          UPDATE file_metadata SET 
            is_quarantined = true, quarantined_at = NOW(), 
            quarantine_reason = $1, quarantined_by = 'system'
          WHERE id = $2
        `, [resultText, fileId]);
        
        // Alert admins for infected files
        await auditService.createSystemAlert(
          'virus_detected', 
          'critical', 
          `Infected file quarantined: ${fileName}`, 
          fileId
        );
        
        logger.error(`🦠 CRITICAL: Infected file quarantined - ${key} - ${resultText}`);
      }

      // Log scan completion
      await auditService.logFileAccess(fileId, 'virus_scan', 'system', ipAddress, null, 
        `Scan completed: ${status}${resultText ? ` (${resultText})` : ''}`);

    } catch (scanError) {
      logger.error('File scanning error:', scanError);
      await prisma.$queryRawUnsafe(`
        UPDATE file_metadata SET 
          scan_status = $1, scan_result = $2, scanned_at = NOW()
        WHERE id = $3
      `, ['failed', scanError.message, fileId]);
    }
  }, scanDelay);
}

export async function getFileMetadata(fileId, userId, userRole) {
  const result = await prisma.$queryRawUnsafe(`
    SELECT 
      fm.*,
      u.name as uploaded_by_name,
      u.phone as uploaded_by_phone,
      COUNT(fal.id) as access_count,
      MAX(fal.accessed_at) as last_accessed,
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
    LEFT JOIN file_access_logs fal ON fm.id = fal.file_id
    WHERE fm.id = $1
    GROUP BY fm.id, u.name, u.phone
  `, [fileId]);

  if (result.rows.length === 0) {
    return null;
  }

  const file = result[0];

  // Access control checks
  const canAccess = 
    file.uploaded_by === userId ||
    ['ADMIN', 'DOCTOR'].includes(userRole) ||
    (!file.is_private && !file.is_hipaa_protected) ||
    (file.is_hipaa_protected && ['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole));

  if (!canAccess) {
    throw new Error('Access denied to this hospital file');
  }

  return file;
}

export async function generateDownloadUrl(fileId, userId, userRole, expiresIn = 3600, ipAddress) {
  const result = await prisma.$queryRawUnsafe(`
    SELECT 
      storage_key, file_name, is_private, is_hipaa_protected, 
      is_quarantined, scan_status, uploaded_by, urgency_level,
      retention_date, file_size
    FROM file_metadata 
    WHERE id = $1
  `, [fileId]);

  if (result.rows.length === 0) {
    throw new Error('Hospital file not found');
  }

  const file = result[0];

  // Security checks
  if (file.is_quarantined) {
    throw new Error('File is quarantined and cannot be downloaded');
  }

  if (file.scan_status === 'infected') {
    throw new Error('File is infected and cannot be downloaded');
  }

  if (file.scan_status === 'pending') {
    throw new Error('File is still being scanned, please try again later');
  }

  // Check if file has expired
  if (file.retention_date && new Date(file.retention_date) < new Date()) {
    throw new Error('File has expired and is no longer available for download');
  }

  // Access control
  const canAccess = 
    file.uploaded_by === userId ||
    ['ADMIN', 'DOCTOR'].includes(userRole) ||
    (!file.is_private && !file.is_hipaa_protected) ||
    (file.is_hipaa_protected && ['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole));

  if (!canAccess) {
    throw new Error('Access denied to this hospital file');
  }

  // Shorter expiry for HIPAA files
  const maxExpiry = file.is_hipaa_protected ? Math.min(expiresIn, 1800) : expiresIn; // 30 min max for HIPAA

  // Generate signed URL
  const signedUrl = await getSignedFileUrl(file.storage_key, parseInt(maxExpiry));
  const expiresAt = new Date(Date.now() + (parseInt(maxExpiry) * 1000));

  // Log download URL generation
  await auditService.logFileAccess(fileId, 'download_url_generated', userId, ipAddress, 
    null, `Download URL generated, expires: ${expiresAt.toISOString()}${file.is_hipaa_protected ? ' (HIPAA)' : ''}`);

  // Special logging for HIPAA files
  if (file.is_hipaa_protected) {
    logger.info(`🔒 HIPAA file download URL generated: ${file.file_name} | User: ${userId} (${userRole}) | IP: ${ipAddress}`);
  }

  return {
    downloadUrl: signedUrl,
    fileName: file.file_name,
    fileSize: file.file_size,
    fileSizeMB: (file.file_size / 1024 / 1024).toFixed(2),
    expiresInSeconds: parseInt(maxExpiry),
    expiresAt,
    isHipaaProtected: file.is_hipaa_protected,
    urgencyLevel: file.urgency_level,
    securityNotice: file.is_hipaa_protected 
      ? 'This is a HIPAA protected file. Unauthorized access or sharing is prohibited.'
      : null
  };
}

export async function deleteFile(fileId, userId, userRole, reason, permanentDelete, ipAddress) {
  const fileResult = await prisma.$queryRawUnsafe(`
    SELECT 
      storage_key, file_name, uploaded_by, is_private, is_hipaa_protected,
      file_size, category, retention_date
    FROM file_metadata 
    WHERE id = $1
  `, [fileId]);

  if (fileResult.rows.length === 0) {
    throw new Error('Hospital file not found');
  }

  const file = fileResult[0];

  // Permission checks
  const canDelete = 
    file.uploaded_by === userId || 
    userRole === 'ADMIN' ||
    (userRole === 'DOCTOR' && file.is_hipaa_protected);

  if (!canDelete) {
    throw new Error('Permission denied. You can only delete your own files or have appropriate medical permissions.');
  }

  // HIPAA files require admin approval for permanent deletion
  if (file.is_hipaa_protected && permanentDelete && userRole !== 'ADMIN') {
    throw new Error('HIPAA protected files require admin approval for permanent deletion');
  }

  // Check if file is within retention period and requires special handling
  const retentionDate = new Date(file.retention_date);
  const now = new Date();
  const isWithinRetention = retentionDate > now;

  if (file.is_hipaa_protected && isWithinRetention && !permanentDelete) {
    // Soft delete for HIPAA files within retention period
    await prisma.$queryRawUnsafe(`
      UPDATE file_metadata 
      SET is_deleted = true, deleted_at = NOW(), deleted_by = $1, deletion_reason = $2
      WHERE id = $3
    `, [userId, reason, fileId]);

    // Log soft deletion
    await auditService.logFileAccess(fileId, 'soft_delete', userId, ipAddress, 
      null, `HIPAA file soft deleted: ${reason}`);

    logger.info(`🗃️ HIPAA file soft deleted: ${file.file_name} (ID: ${fileId}) by ${userId} (${userRole})`);

    return {
      deletionType: 'soft_delete',
      retentionDate,
      note: 'HIPAA file soft deleted due to retention requirements. File will be permanently deleted after retention period.'
    };
  } else {
    // Permanent deletion
    if (permanentDelete || !isWithinRetention) {
      // Delete from R2 storage
      await deleteObject(file.storage_key);
    }

    // Remove from database
    await prisma.$queryRawUnsafe('DELETE FROM file_metadata WHERE id = $1', [fileId]);

    // Log permanent deletion
    await auditService.logFileDeletion(
      { ...file, id: fileId },
      userId,
      reason,
      permanentDelete ? 'permanent' : 'expired',
      ipAddress
    );

    logger.info(`🗑️ Hospital file permanently deleted: ${file.file_name} (ID: ${fileId}) by ${userId} (${userRole}) - Reason: ${reason}`);

    return {
      deletionType: 'permanent',
      wasHipaaProtected: file.is_hipaa_protected
    };
  }
}