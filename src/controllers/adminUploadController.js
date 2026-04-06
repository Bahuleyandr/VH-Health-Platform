// src/controllers/adminUploadController.js - Hospital Admin Upload Controller

import { validationResult } from 'express-validator';
import prisma from '../lib/prisma.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import * as auditService from '../services/auditService.js';
import { scanFileWithClamAV } from '../utils/clamavScanHelper.js';
import { formatFileResponse } from '../utils/fileProcessingUtils.js';
import { deleteObject as deleteFileFromR2 } from '../utils/r2Storage.js';
import { success, error } from '../utils/responseHelper.js';

export async function getFileStats(req, res) {
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
    const { timeframe = '30d', detailed = false } = req.query;
    const userRole = req.user?.role;
    const userId = req.user?.uid;
    
    let interval;
    switch (timeframe) {
      case '7d': interval = '7 days'; break;
      case '30d': interval = '30 days'; break;
      case '90d': interval = '90 days'; break;
      case '1y': interval = '1 year'; break;
      default: interval = '30 days';
    }

    // Role-based access filtering
    let roleFilter = '';
    if (!['ADMIN', 'DOCTOR'].includes(userRole)) {
      roleFilter = `AND (uploaded_by = '${userId}' OR (is_hipaa_protected = false AND is_private = false))`;
    }

    // Overall statistics
    const stats = await prisma.$queryRawUnsafe(`
      SELECT 
        COUNT(*) as total_files,
        SUM(file_size) as total_size_bytes,
        AVG(file_size) as avg_file_size,
        COUNT(DISTINCT uploaded_by) as unique_uploaders,
        COUNT(*) FILTER (WHERE scan_status = 'clean') as clean_files,
        COUNT(*) FILTER (WHERE scan_status = 'infected') as infected_files,
        COUNT(*) FILTER (WHERE scan_status = 'pending') as pending_scans,
        COUNT(*) FILTER (WHERE is_quarantined = true) as quarantined_files,
        COUNT(*) FILTER (WHERE compression_applied = true) as compressed_files,
        COUNT(*) FILTER (WHERE is_hipaa_protected = true) as hipaa_files,
        COUNT(*) FILTER (WHERE urgency_level = 'urgent') as urgent_files,
        COUNT(*) FILTER (WHERE retention_date < CURRENT_DATE) as expired_files,
        AVG(processing_time_ms) as avg_processing_time,
        SUM(CASE WHEN compression_applied THEN original_size - file_size ELSE 0 END) as total_savings_bytes
      FROM file_metadata 
      WHERE uploaded_at > NOW() - INTERVAL '${interval}' ${roleFilter}
    `);

    // Category breakdown
    const categoryStats = await prisma.$queryRawUnsafe(`
      SELECT 
        category,
        COUNT(*) as file_count,
        SUM(file_size) as total_size,
        AVG(file_size) as avg_size,
        COUNT(*) FILTER (WHERE is_hipaa_protected = true) as hipaa_count,
        COUNT(*) FILTER (WHERE scan_status = 'infected') as infected_count
      FROM file_metadata 
      WHERE uploaded_at > NOW() - INTERVAL '${interval}' ${roleFilter}
      GROUP BY category
      ORDER BY file_count DESC
    `);

    // Daily upload trends
    const dailyUploads = await prisma.$queryRawUnsafe(`
      SELECT 
        DATE(uploaded_at) as upload_date,
        COUNT(*) as files_uploaded,
        SUM(file_size) as bytes_uploaded,
        COUNT(*) FILTER (WHERE is_hipaa_protected = true) as hipaa_uploads,
        COUNT(*) FILTER (WHERE urgency_level = 'urgent') as urgent_uploads
      FROM file_metadata 
      WHERE uploaded_at > NOW() - INTERVAL '${interval}' ${roleFilter}
      GROUP BY DATE(uploaded_at)
      ORDER BY upload_date DESC
      LIMIT 30
    `);

    // Format results
    const formattedStats = {
      ...stats[0],
      total_size_mb: (stats[0].total_size_bytes / 1024 / 1024).toFixed(2),
      total_size_gb: (stats[0].total_size_bytes / 1024 / 1024 / 1024).toFixed(2),
      avg_file_size_mb: (stats[0].avg_file_size / 1024 / 1024).toFixed(2),
      total_savings_mb: (stats[0].total_savings_bytes / 1024 / 1024).toFixed(2),
      hipaa_percentage: stats[0].total_files > 0 
        ? ((stats[0].hipaa_files / stats[0].total_files) * 100).toFixed(1)
        : '0.0',
      infection_rate: stats[0].total_files > 0
        ? ((stats[0].infected_files / stats[0].total_files) * 100).toFixed(3)
        : '0.000'
    };

    const formattedDaily = dailyUploads.map(day => ({
      ...day,
      upload_date_formatted: new Date(day.upload_date).toLocaleDateString('en-GB'),
      bytes_uploaded_mb: (day.bytes_uploaded / 1024 / 1024).toFixed(2)
    }));

    success(res, {
      timeframe,
      interval,
      overallStats: formattedStats,
      categoryBreakdown: categoryStats,
      dailyTrend: formattedDaily,
      generatedAt: new Date().toISOString(),
      generatedAtFormatted: new Date().toLocaleDateString('en-GB'),
      userAccess: {
        role: userRole,
        canViewDetailed: ['ADMIN', 'DOCTOR'].includes(userRole),
        canViewAll: ['ADMIN', 'DOCTOR'].includes(userRole)
      },
      requestedBy: userId
    }, 'Hospital file statistics retrieved successfully');

  } catch (err) {
    logger.error('Hospital File Stats Error:', err);
    error(res, 'Failed to fetch hospital file statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function rescanFile(req, res) {
  try {
    const { fileId } = req.params;
    const adminUid = req.user?.uid;

    const fileResult = await prisma.$queryRawUnsafe(
      'SELECT storage_url, file_name, is_hipaa_protected FROM file_metadata WHERE id = $1', fileId);

    if (fileResult.length === 0) {
      return error(res, 'Hospital file not found', HTTP_STATUS.NOT_FOUND);
    }

    const file = fileResult[0];

    // Update scan status to pending
    await prisma.$queryRawUnsafe(
      'UPDATE file_metadata SET scan_status = $1, scan_result = NULL, scanned_at = NULL WHERE id = $2', 'pending', fileId);

    // Log admin rescan action
    await auditService.logFileAccess(fileId, 'admin_rescan', adminUid, 
      req.headers['x-forwarded-for'], req.headers['user-agent'], 
      'Admin initiated security rescan');

    // Trigger rescan with high priority
    setTimeout(async () => {
      try {
        const scanStartTime = Date.now();
        const scanResult = await scanFileWithClamAV(file.storage_url);
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

        await prisma.$queryRawUnsafe(`
          UPDATE file_metadata SET 
            scan_status = $1, scan_result = $2, scanned_at = NOW(),
            scan_duration_ms = $3
          WHERE id = $4
        `, [status, resultText, scanDuration, fileId]);

        // Auto-quarantine if infected
        if (status === 'infected') {
          await prisma.$queryRawUnsafe(`
            UPDATE file_metadata SET 
              is_quarantined = true, quarantined_at = NOW(), 
              quarantine_reason = $1, quarantined_by = $2
            WHERE id = $3
          `, [resultText, adminUid, fileId]);
        }

        // Log scan completion
        await auditService.logFileAccess(fileId, 'rescan_completed', 'system', 
          req.headers['x-forwarded-for'], null, 
          `Admin rescan completed: ${status}${resultText ? ` (${resultText})` : ''}`);

      } catch (scanError) {
        await prisma.$queryRawUnsafe(
          'UPDATE file_metadata SET scan_status = $1, scan_result = $2, scanned_at = NOW() WHERE id = $3',
          ['failed', scanError.message, fileId]
        );
      }
    }, 50); // High priority scan

    logger.info(`🔄 Admin ${adminUid} triggered rescan for hospital file: ${file.file_name}${file.is_hipaa_protected ? ' (HIPAA)' : ''}`);

    success(res, {
      fileId,
      fileName: file.file_name,
      scanStatus: 'pending',
      isHipaaProtected: file.is_hipaa_protected,
      rescannedBy: adminUid,
      rescannedAt: new Date().toISOString(),
      rescannedAtFormatted: new Date().toLocaleDateString('en-GB'),
      requestedBy: adminUid
    }, 'Hospital file security rescan initiated successfully');

  } catch (err) {
    logger.error('Rescan Hospital File Error:', err);
    error(res, 'Failed to rescan hospital file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function cleanupExpiredFiles(req, res) {
  try {
    const { dryRun = true, category, olderThanDays } = req.body;
    const adminUid = req.user?.uid;

    let whereClause = 'WHERE retention_date < CURRENT_DATE';
    const params = [];
    let paramIndex = 1;

    if (category) {
      whereClause += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (olderThanDays) {
      whereClause += ` AND uploaded_at < NOW() - INTERVAL '${olderThanDays} days'`;
    }

    // Find expired files
    const expiredFiles = await prisma.$queryRawUnsafe(`
      SELECT 
        id, storage_key, file_name, file_size, category, 
        is_hipaa_protected, uploaded_by, retention_date
      FROM file_metadata 
      ${whereClause}
      ORDER BY retention_date ASC
    `, params);

    if (dryRun) {
      const totalSize = expiredFiles.reduce((sum, f) => sum + f.file_size, 0);
      const hipaaCount = expiredFiles.filter(f => f.is_hipaa_protected).length;

      return success(res, {
        dryRun: true,
        expiredFiles: expiredFiles.map(formatFileResponse),
        summary: {
          totalFiles: expiredFiles.length,
          totalSizeBytes: totalSize,
          totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
          hipaaFiles: hipaaCount,
          regularFiles: expiredFiles.length - hipaaCount
        },
        requestedBy: adminUid
      }, 'Dry run completed - no files deleted. Review expired files list.');
    }

    let deletedCount = 0;
    let freedBytes = 0;
    let hipaaDeleted = 0;
    const deletionErrors = [];

    for (const file of expiredFiles) {
      try {
        // Delete from R2 storage
        await deleteFileFromR2(file.storage_key);
        
        // Remove from database
        await prisma.$queryRawUnsafe('DELETE FROM file_metadata WHERE id = $1', file.id);

        // Log deletion
        await auditService.logFileDeletion(
          file,
          adminUid,
          'Automated cleanup - retention expired',
          'expired_cleanup',
          req.headers['x-forwarded-for']
        );

        deletedCount++;
        freedBytes += file.file_size;
        if (file.is_hipaa_protected) {hipaaDeleted++;}

      } catch (deleteError) {
        logger.error(`Failed to delete expired file ${file.id}:`, deleteError);
        deletionErrors.push({
          fileId: file.id,
          fileName: file.file_name,
          error: deleteError.message
        });
      }
    }

    logger.info(`🧹 Admin ${adminUid} cleaned up ${deletedCount} expired hospital files, freed ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);

    success(res, {
      deletedCount,
      freedBytes,
      freedMB: (freedBytes / 1024 / 1024).toFixed(2),
      hipaaDeleted,
      regularDeleted: deletedCount - hipaaDeleted,
      deletionErrors,
      summary: {
        successRate: expiredFiles.length > 0 
          ? `${((deletedCount / expiredFiles.length) * 100).toFixed(1)}%`
          : '100%',
        totalProcessed: expiredFiles.length,
        successful: deletedCount,
        failed: deletionErrors.length
      },
      cleanedBy: adminUid,
      cleanedAt: new Date().toISOString(),
      cleanedAtFormatted: new Date().toLocaleDateString('en-GB'),
      requestedBy: adminUid
    }, `Hospital cleanup completed: ${deletedCount} expired files removed, ${(freedBytes / 1024 / 1024).toFixed(2)} MB freed`);

  } catch (err) {
    logger.error('Cleanup Expired Hospital Files Error:', err);
    error(res, 'Failed to cleanup expired hospital files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function updateHipaaProtection(req, res) {
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
    const { fileIds, setHipaaProtected, reason } = req.body;
    const adminUid = req.user?.uid;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const results = [];
    const errors_list = [];

    for (const fileId of fileIds) {
      try {
        // Get current file info
        const fileResult = await prisma.$queryRawUnsafe(
          'SELECT file_name, is_hipaa_protected, category FROM file_metadata WHERE id = $1', fileId);

        if (fileResult.length === 0) {
          errors_list.push({ fileId, error: 'File not found' });
          continue;
        }

        const file = fileResult[0];

        // Update HIPAA protection status
        await prisma.$queryRawUnsafe(
          'UPDATE file_metadata SET is_hipaa_protected = $1 WHERE id = $2', setHipaaProtected, fileId);

        // Log the change
        await auditService.logFileAccess(fileId, 'hipaa_protection_changed', adminUid, ipAddress, 
          req.headers['user-agent'], 
          `HIPAA protection ${setHipaaProtected ? 'enabled' : 'disabled'}: ${reason}`);

        results.push({
          fileId,
          fileName: file.file_name,
          category: file.category,
          previousHipaaStatus: file.is_hipaa_protected,
          newHipaaStatus: setHipaaProtected,
          changed: file.is_hipaa_protected !== setHipaaProtected
        });

      } catch (fileError) {
        errors_list.push({ fileId, error: fileError.message });
      }
    }

    // Log bulk operation
    await auditService.logBulkOperation(
      'hipaa_protection_update', adminUid, fileIds.length, results.length,
      errors_list.length, { setHipaaProtected, reason }
    );

    logger.info(`🔒 Admin ${adminUid} bulk updated HIPAA protection for ${results.length}/${fileIds.length} files`);

    success(res, {
      processedFiles: results,
      failedFiles: errors_list,
      summary: {
        totalRequested: fileIds.length,
        successful: results.length,
        failed: errors_list.length,
        actuallyChanged: results.filter(r => r.changed).length,
        hipaaProtectionEnabled: setHipaaProtected,
        reason
      },
      performedBy: adminUid,
      performedAt: new Date().toISOString(),
      performedAtFormatted: new Date().toLocaleDateString('en-GB'),
      requestedBy: adminUid
    }, `Bulk HIPAA protection update completed: ${results.length}/${fileIds.length} files processed successfully`);

  } catch (err) {
    logger.error('Bulk HIPAA Protection Update Error:', err);
    error(res, 'Failed to update HIPAA protection status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getQuarantinedFiles(req, res) {
  try {
    const quarantinedFiles = await prisma.$queryRawUnsafe(`
      SELECT 
        fm.id, fm.file_name, fm.file_type, fm.file_size, fm.storage_key,
        fm.scan_status, fm.scan_result, fm.quarantine_reason, fm.category,
        fm.uploaded_by, fm.uploaded_at, fm.quarantined_at, fm.is_hipaa_protected,
        u.name as uploaded_by_name, u.phone as uploaded_by_phone
      FROM file_metadata fm
      LEFT JOIN users u ON fm.uploaded_by = u.uid
      WHERE fm.is_quarantined = true OR fm.scan_status = 'infected'
      ORDER BY fm.quarantined_at DESC NULLS LAST, fm.uploaded_at DESC
    `);

    const formattedFiles = quarantinedFiles.map(formatFileResponse);

    success(res, {
      quarantinedFiles: formattedFiles,
      summary: {
        total: formattedFiles.length,
        hipaaFiles: formattedFiles.filter(f => f.is_hipaa_protected).length,
        infectedFiles: formattedFiles.filter(f => f.scan_status === 'infected').length,
        totalSizeMB: formattedFiles.reduce((sum, f) => sum + parseFloat(f.fileSizeMB), 0).toFixed(2)
      },
      requestedBy: req.user?.uid
    }, 'Quarantined hospital files retrieved successfully');

  } catch (err) {
    logger.error('Quarantined Files Error:', err);
    error(res, 'Failed to fetch quarantined files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function purgeQuarantinedFiles(req, res) {
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
    const { olderThanDays = 30, confirmPurge } = req.body;
    const adminUid = req.user?.uid;

    if (!confirmPurge) {
      return error(res, 'Purge confirmation required', HTTP_STATUS.BAD_REQUEST);
    }

    // Find quarantined files older than specified days
    const quarantinedFiles = await prisma.$queryRawUnsafe(`
      SELECT 
        id, storage_key, file_name, file_size, is_hipaa_protected,
        quarantined_at, scan_result
      FROM file_metadata 
      WHERE is_quarantined = true 
        AND quarantined_at < NOW() - INTERVAL '${olderThanDays} days'
      ORDER BY quarantined_at ASC
    `);

    let purgedCount = 0;
    let freedBytes = 0;
    let hipaaCount = 0;
    const purgeErrors = [];

    for (const file of quarantinedFiles) {
      try {
        // Delete from R2 storage
        await deleteFileFromR2(file.storage_key);
        
        // Remove from database
        await prisma.$queryRawUnsafe('DELETE FROM file_metadata WHERE id = $1', file.id);

        // Log purge
        await auditService.logFileDeletion(
          file,
          adminUid,
          `Quarantined file purge - infected with: ${file.scan_result}`,
          'quarantine_purge',
          req.headers['x-forwarded-for']
        );

        purgedCount++;
        freedBytes += file.file_size;
        if (file.is_hipaa_protected) {hipaaCount++;}

      } catch (purgeError) {
        logger.error(`Failed to purge quarantined file ${file.id}:`, purgeError);
        purgeErrors.push({
          fileId: file.id,
          fileName: file.file_name,
          error: purgeError.message
        });
      }
    }

    logger.warn(`🗑️ Admin ${adminUid} purged ${purgedCount} quarantined files (${hipaaCount} HIPAA), freed ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);

    success(res, {
      purgedCount,
      freedBytes,
      freedMB: (freedBytes / 1024 / 1024).toFixed(2),
      hipaaFilesPurged: hipaaCount,
      purgeErrors,
      criteria: {
        olderThanDays,
        totalFound: quarantinedFiles.length
      },
      purgedBy: adminUid,
      purgedAt: new Date().toISOString(),
      purgedAtFormatted: new Date().toLocaleDateString('en-GB'),
      requestedBy: adminUid
    }, `Quarantine purge completed: ${purgedCount} infected files permanently removed`);

  } catch (err) {
    logger.error('Purge Quarantined Files Error:', err);
    error(res, 'Failed to purge quarantined files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getHipaaAuditReport(req, res) {
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
    const { days = 30 } = req.query;
    const report = await auditService.getHipaaAuditReport(days);

    const formattedAccess = report.accessAudit.map(log => ({
      ...log,
      accessedAt: log.accessed_at?.toISOString(),
      accessedAtFormatted: log.accessed_at?.toLocaleDateString('en-GB')
    }));

    const formattedModifications = report.modifications.map(mod => ({
      ...mod,
      uploadedAt: mod.uploaded_at?.toISOString(),
      uploadedAtFormatted: mod.uploaded_at?.toLocaleDateString('en-GB'),
      deletedAt: mod.deleted_at?.toISOString(),
      deletedAtFormatted: mod.deleted_at?.toLocaleDateString('en-GB')
    }));

    const formattedUnauthorized = report.unauthorizedAttempts.map(attempt => ({
      ...attempt,
      accessedAt: attempt.accessed_at?.toISOString(),
      accessedAtFormatted: attempt.accessed_at?.toLocaleDateString('en-GB')
    }));

    const formattedPatterns = report.userPatterns.map(pattern => ({
      ...pattern,
      firstAccess: pattern.first_access?.toISOString(),
      firstAccessFormatted: pattern.first_access?.toLocaleDateString('en-GB'),
      lastAccess: pattern.last_access?.toISOString(),
      lastAccessFormatted: pattern.last_access?.toLocaleDateString('en-GB')
    }));

    success(res, {
      auditPeriod: `${days} days`,
      accessAudit: formattedAccess,
      fileModifications: formattedModifications,
      unauthorizedAttempts: formattedUnauthorized,
      userAccessPatterns: formattedPatterns,
      summary: report.summary,
      complianceNotes: [
        'All HIPAA protected file access is logged and monitored',
        'Unauthorized access attempts are tracked and reported',
        'File retention policies are automatically enforced',
        'Regular audit reports are generated for compliance review'
      ],
      auditGenerated: new Date().toISOString(),
      auditGeneratedFormatted: new Date().toLocaleDateString('en-GB'),
      requestedBy: req.user?.uid
    }, 'HIPAA audit report generated successfully');

  } catch (err) {
    logger.error('HIPAA Audit Error:', err);
    error(res, 'Failed to generate HIPAA audit report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}