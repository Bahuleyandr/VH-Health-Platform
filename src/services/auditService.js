// src/services/auditService.js - Hospital File Audit Service

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

export async function logFileAccess(fileId, accessType, userId, ipAddress, userAgent = null, notes = null) {
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO file_access_logs (
        file_id, user_id, access_type, ip_address, user_agent, 
        accessed_at, notes
      ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
    `, fileId, userId, accessType, ipAddress, userAgent, notes);
  } catch (err) {
    logger.error('Failed to log file access:', err);
  }
}

export async function logBulkOperation(operationType, performedBy, affectedCount, successCount, errorCount, operationDetails) {
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO bulk_operation_logs (
        operation_type, performed_by, affected_count, success_count, 
        error_count, operation_details, performed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, 
      operationType, performedBy, affectedCount, successCount,
      errorCount, JSON.stringify(operationDetails)
    );
  } catch (err) {
    logger.error('Failed to log bulk operation:', err);
  }
}

export async function logFileDeletion(fileInfo, deletedBy, deletionReason, deletionType, ipAddress) {
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO file_deletion_log (
        file_id, file_name, storage_key, category, file_size,
        is_hipaa_protected, uploaded_by, deleted_by, deletion_reason,
        deletion_type, deleted_at, ip_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
    `, 
      fileInfo.id, fileInfo.file_name, fileInfo.storage_key, fileInfo.category, fileInfo.file_size,
      fileInfo.is_hipaa_protected, fileInfo.uploaded_by, deletedBy, deletionReason,
      deletionType, ipAddress
    );
  } catch (err) {
    logger.error('Failed to log file deletion:', err);
  }
}

export async function createSystemAlert(alertType, severity, message, relatedFileId = null) {
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO system_alerts (
        alert_type, severity, message, related_file_id, created_at
      ) VALUES ($1, $2, $3, $4, NOW())
    `, alertType, severity, message, relatedFileId);
  } catch (err) {
    logger.error('Failed to create system alert:', err);
  }
}

export async function getFileAccessLogs(fileId, limit = 10) {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        fal.access_type, fal.accessed_at, fal.ip_address, fal.notes,
        u.name as user_name, u.phone as user_phone, fal.user_id
      FROM file_access_logs fal
      LEFT JOIN users u ON fal.user_id = u.uid
      WHERE fal.file_id = $1
      ORDER BY fal.accessed_at DESC
      LIMIT $2
    `, fileId, limit);
    
    return result.map(log => ({
      ...log,
      accessedAt: log.accessed_at?.toISOString(),
      accessedAtFormatted: log.accessed_at?.toLocaleDateString('en-GB')
    }));
  } catch (err) {
    logger.error('Failed to get file access logs:', err);
    return [];
  }
}

export async function getHipaaAuditReport(days = 30) {
  try {
    // HIPAA file access audit
    const accessAudit = await prisma.$queryRawUnsafe(`
      SELECT 
        fal.file_id, fm.file_name, fm.category, fal.access_type,
        fal.accessed_at, fal.user_id, u.name as user_name, u.phone as user_phone,
        fal.ip_address, fal.notes
      FROM file_access_logs fal
      JOIN file_metadata fm ON fal.file_id = fm.id
      LEFT JOIN users u ON fal.user_id = u.uid
      WHERE fm.is_hipaa_protected = true 
        AND fal.accessed_at > NOW() - INTERVAL '${days} days'
      ORDER BY fal.accessed_at DESC
      LIMIT 1000
    `);

    // HIPAA file modifications
    const modifications = await prisma.$queryRawUnsafe(`
      SELECT 
        id, file_name, category, uploaded_by, uploaded_at,
        is_deleted, deleted_at, deleted_by, deletion_reason
      FROM file_metadata
      WHERE is_hipaa_protected = true 
        AND (uploaded_at > NOW() - INTERVAL '${days} days' 
             OR deleted_at > NOW() - INTERVAL '${days} days')
      ORDER BY COALESCE(deleted_at, uploaded_at) DESC
    `);

    // Unauthorized access attempts
    const unauthorizedAttempts = await prisma.$queryRawUnsafe(`
      SELECT 
        fal.accessed_at, fal.user_id, u.name as user_name, fal.access_type,
        fal.ip_address, COUNT(*) as attempt_count
      FROM file_access_logs fal
      JOIN file_metadata fm ON fal.file_id = fm.id
      LEFT JOIN users u ON fal.user_id = u.uid
      WHERE fm.is_hipaa_protected = true 
        AND fal.accessed_at > NOW() - INTERVAL '${days} days'
        AND fal.notes LIKE '%denied%'
      GROUP BY fal.accessed_at, fal.user_id, u.name, fal.access_type, fal.ip_address
      ORDER BY fal.accessed_at DESC
    `);

    // User access patterns
    const userPatterns = await prisma.$queryRawUnsafe(`
      SELECT 
        fal.user_id, u.name as user_name, u.phone as user_phone,
        COUNT(*) as total_accesses,
        COUNT(DISTINCT fal.file_id) as unique_files_accessed,
        MIN(fal.accessed_at) as first_access,
        MAX(fal.accessed_at) as last_access,
        COUNT(DISTINCT fal.ip_address) as unique_ips
      FROM file_access_logs fal
      JOIN file_metadata fm ON fal.file_id = fm.id
      LEFT JOIN users u ON fal.user_id = u.uid
      WHERE fm.is_hipaa_protected = true 
        AND fal.accessed_at > NOW() - INTERVAL '${days} days'
      GROUP BY fal.user_id, u.name, u.phone
      ORDER BY total_accesses DESC
      LIMIT 50
    `);

    return {
      accessAudit: accessAudit,
      modifications: modifications,
      unauthorizedAttempts: unauthorizedAttempts,
      userPatterns: userPatterns,
      summary: {
        totalHipaaAccesses: accessAudit.length,
        uniqueHipaaFiles: new Set(accessAudit.map(a => a.file_id)).size,
        uniqueUsers: new Set(accessAudit.map(a => a.user_id)).size,
        totalModifications: modifications.length,
        unauthorizedAttemptCount: unauthorizedAttempts.length,
        mostActiveUser: userPatterns[0]?.user_name || 'None'
      }
    };
  } catch (err) {
    logger.error('Failed to generate HIPAA audit report:', err);
    throw err;
  }
}