// src/routes/uploadRoutes.js - Enhanced File Upload System

import express from 'express';
import multer from 'multer';
import { FILE_UPLOAD_RULES } from '../config/fileUploadConfig.js';
import { uploadFileToR2, deleteObject as deleteFileFromR2, getSignedFileUrl } from '../utils/r2Storage.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { scanFileWithClamAV } from '../utils/clamavScanHelper.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import sharp from 'sharp';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { HTTP_STATUS } from '../config/responseCodes.js';

const router = express.Router();

// ✅ Enhanced file upload configuration
const UPLOAD_CONFIG = {
  allowedMimeTypes: [
    'application/pdf',
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/csv'
  ],
  maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
  imageMaxWidth: 2048,
  imageMaxHeight: 2048,
  imageQuality: 80,
  allowedCategories: [
    'medical_record', 'prescription', 'lab_report', 'xray', 
    'profile_picture', 'insurance_document', 'id_document'
  ]
};

// ✅ Multer setup for enhanced file handling
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { 
    fileSize: UPLOAD_CONFIG.maxFileSizeBytes,
    files: 5 // Max 5 files per request
  },
  fileFilter: (req, file, cb) => {
    if (!UPLOAD_CONFIG.allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error(`File type ${file.mimetype} not allowed. Allowed types: ${UPLOAD_CONFIG.allowedMimeTypes.join(', ')}`));
    }
    cb(null, true);
  }
});

// ✅ Generate secure file key
function generateFileKey(originalName, category = 'general') {
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  const ext = path.extname(originalName);
  return `${category}/${timestamp}_${random}${ext}`;
}

// ✅ Optimize image files
async function optimizeImage(buffer, mimetype) {
  try {
    let processor = sharp(buffer);
    
    // Get image metadata
    const metadata = await processor.metadata();
    
    // Resize if too large
    if (metadata.width > UPLOAD_CONFIG.imageMaxWidth || metadata.height > UPLOAD_CONFIG.imageMaxHeight) {
      processor = processor.resize(
        UPLOAD_CONFIG.imageMaxWidth, 
        UPLOAD_CONFIG.imageMaxHeight, 
        { fit: 'inside', withoutEnlargement: false }
      );
    }
    
    // Convert and compress based on format
    if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') {
      return await processor.jpeg({ quality: UPLOAD_CONFIG.imageQuality }).toBuffer();
    } else if (mimetype === 'image/png') {
      return await processor.png({ compressionLevel: 8 }).toBuffer();
    } else if (mimetype === 'image/webp') {
      return await processor.webp({ quality: UPLOAD_CONFIG.imageQuality }).toBuffer();
    }
    
    return buffer; // Return original if no optimization needed
  } catch (err) {
    logger.warn('Image optimization failed, using original:', err.message);
    return buffer;
  }
}

// ✅ Compress PDF files
async function compressPDF(buffer) {
  try {
    const tempIn = `/tmp/${Date.now()}_in.pdf`;
    const tempOut = `/tmp/${Date.now()}_out.pdf`;

    await fs.writeFile(tempIn, buffer);

    await new Promise((resolve, reject) => {
      exec(
        `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${tempOut} ${tempIn}`,
        (err) => (err ? reject(err) : resolve())
      );
    });

    const compressedBuffer = await fs.readFile(tempOut);
    
    // Cleanup temp files
    await fs.unlink(tempIn).catch(() => {});
    await fs.unlink(tempOut).catch(() => {});

    // Only return compressed version if it's actually smaller
    return compressedBuffer.length < buffer.length ? compressedBuffer : buffer;
  } catch (err) {
    logger.warn('PDF compression failed, using original:', err.message);
    return buffer;
  }
}

// ✅ File Upload Routes
wrapAutoRBAC(router, 'uploadRoutes', {
  post: [
    // 📤 Single File Upload
    [
      '/',
      upload.single('file'),
      async (req, res) => {
        if (!req.file) {
          return error(res, 'No file uploaded', HTTP_STATUS.BAD_REQUEST);
        }

        const { 
          category = 'general', 
          description, 
          isPrivate = false,
          patientPhone,
          relatedId,
          relatedType 
        } = req.body;
        
        const uploadedBy = req.user?.uid || 'system';

        try {
          let processedBuffer = req.file.buffer;
          let compressionApplied = false;

          // Apply file optimization based on type
          if (req.file.mimetype.startsWith('image/')) {
            processedBuffer = await optimizeImage(req.file.buffer, req.file.mimetype);
            compressionApplied = processedBuffer.length < req.file.buffer.length;
          } else if (req.file.mimetype === 'application/pdf') {
            processedBuffer = await compressPDF(req.file.buffer);
            compressionApplied = processedBuffer.length < req.file.buffer.length;
          }

          // Generate storage key
          const key = generateFileKey(req.file.originalname, category);
          
          // Upload to R2
          const url = await uploadFileToR2(processedBuffer, key, req.file.mimetype);

          // Store metadata in database
          const result = await pool.query(
            `INSERT INTO file_metadata (
              file_name, file_type, file_size, original_size, storage_key, storage_url,
              category, description, is_private, uploaded_by, patient_phone,
              related_id, related_type, compression_applied, scan_status,
              uploaded_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
            RETURNING id, storage_key, scan_status`,
            [
              req.file.originalname,
              req.file.mimetype,
              processedBuffer.length,
              req.file.buffer.length,
              key,
              url,
              category,
              description,
              isPrivate,
              uploadedBy,
              patientPhone,
              relatedId,
              relatedType,
              compressionApplied,
              'pending'
            ]
          );

          const fileId = result.rows[0].id;

          // Perform virus scan (async)
          setTimeout(async () => {
            try {
              const scanResult = await scanFileWithClamAV(url);
              
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
              await pool.query(
                `UPDATE file_metadata SET 
                  scan_status = $1, scan_result = $2, scanned_at = NOW() 
                 WHERE id = $3`,
                [status, resultText, fileId]
              );

              // Quarantine infected files
              if (status === 'infected') {
                await pool.query(
                  `UPDATE file_metadata SET 
                    is_quarantined = true, quarantined_at = NOW(), 
                    quarantine_reason = $1 
                   WHERE id = $2`,
                  [resultText, fileId]
                );
                
                logger.warn(`🦠 File quarantined: ${key} - ${resultText}`);
              }

            } catch (scanError) {
              logger.error('File scanning error:', scanError);
              await pool.query(
                'UPDATE file_metadata SET scan_status = $1, scan_result = $2 WHERE id = $3',
                ['failed', scanError.message, fileId]
              );
            }
          }, 100); // Small delay to return response quickly

          logger.info(`📤 File uploaded: ${req.file.originalname} | Category: ${category} | User: ${uploadedBy}`);

          success(res, {
            fileId,
            fileName: req.file.originalname,
            fileSize: processedBuffer.length,
            originalSize: req.file.buffer.length,
            compressionApplied,
            compressionRatio: compressionApplied 
              ? ((1 - (processedBuffer.length / req.file.buffer.length)) * 100).toFixed(1) + '%'
              : null,
            category,
            storageKey: key,
            url: isPrivate ? null : url, // Don't return URL for private files
            scanStatus: 'pending'
          }, 'File uploaded successfully');

        } catch (err) {
          logger.error('File Upload Error:', err.stack || err.toString());
          error(res, 'Upload failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📤 Multiple Files Upload
    [
      '/batch',
      upload.array('files', 5),
      async (req, res) => {
        if (!req.files || req.files.length === 0) {
          return error(res, 'No files uploaded', HTTP_STATUS.BAD_REQUEST);
        }

        const { category = 'general', description, isPrivate = false } = req.body;
        const uploadedBy = req.user?.uid || 'system';
        const results = [];
        const errors = [];

        try {
          for (const file of req.files) {
            try {
              let processedBuffer = file.buffer;

              // Apply optimization
              if (file.mimetype.startsWith('image/')) {
                processedBuffer = await optimizeImage(file.buffer, file.mimetype);
              } else if (file.mimetype === 'application/pdf') {
                processedBuffer = await compressPDF(file.buffer);
              }

              const key = generateFileKey(file.originalname, category);
              const url = await uploadFileToR2(processedBuffer, key, file.mimetype);

              const result = await pool.query(
                `INSERT INTO file_metadata (
                  file_name, file_type, file_size, storage_key, storage_url,
                  category, description, is_private, uploaded_by, scan_status, uploaded_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                RETURNING id, storage_key`,
                [
                  file.originalname, file.mimetype, processedBuffer.length,
                  key, url, category, description, isPrivate, uploadedBy, 'pending'
                ]
              );

              results.push({
                fileId: result.rows[0].id,
                fileName: file.originalname,
                fileSize: processedBuffer.length,
                storageKey: key,
                status: 'uploaded'
              });

            } catch (fileError) {
              errors.push({
                fileName: file.originalname,
                error: fileError.message
              });
            }
          }

          success(res, {
            uploadedFiles: results,
            failedFiles: errors,
            summary: {
              total: req.files.length,
              successful: results.length,
              failed: errors.length
            }
          }, `Batch upload completed: ${results.length}/${req.files.length} successful`);

        } catch (err) {
          logger.error('Batch Upload Error:', err);
          error(res, 'Batch upload failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  get: [
    // 📋 List Uploaded Files
    [
      '/',
      async (req, res) => {
        try {
          const { 
            page = 1, limit = 50, category, scanStatus = 'all',
            isPrivate, uploadedBy, patientPhone 
          } = req.query;
          
          const offset = (page - 1) * limit;
          let whereClause = 'WHERE 1=1';
          const params = [limit, offset];
          let paramIndex = 3;

          if (category) {
            whereClause += ` AND category = ${paramIndex}`;
            params.push(category);
            paramIndex++;
          }

          if (scanStatus !== 'all') {
            whereClause += ` AND scan_status = ${paramIndex}`;
            params.push(scanStatus);
            paramIndex++;
          }

          if (isPrivate !== undefined) {
            whereClause += ` AND is_private = ${paramIndex}`;
            params.push(isPrivate === 'true');
            paramIndex++;
          }

          if (uploadedBy) {
            whereClause += ` AND uploaded_by = ${paramIndex}`;
            params.push(uploadedBy);
            paramIndex++;
          }

          if (patientPhone) {
            whereClause += ` AND patient_phone = ${paramIndex}`;
            params.push(patientPhone);
            paramIndex++;
          }

          const files = await pool.query(`
            SELECT 
              id, file_name, file_type, file_size, category, description,
              is_private, scan_status, scan_result, is_quarantined,
              uploaded_at, scanned_at, storage_key,
              CASE 
                WHEN is_quarantined = true THEN true
                WHEN scan_status IN ('infected', 'failed') THEN true
                ELSE false
              END as quarantined
            FROM file_metadata 
            ${whereClause}
            ORDER BY uploaded_at DESC
            LIMIT $1 OFFSET $2
          `, params);

          const total = await pool.query(
            `SELECT COUNT(*) FROM file_metadata ${whereClause}`,
            params.slice(2)
          );

          success(res, {
            files: files.rows,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: parseInt(total.rows[0].count),
              totalPages: Math.ceil(total.rows[0].count / limit)
            },
            filters: { category, scanStatus, isPrivate, uploadedBy, patientPhone }
          }, 'Files retrieved successfully');

        } catch (err) {
          logger.error('List Files Error:', err);
          error(res, 'Failed to fetch files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📄 Get File Metadata
    [
      '/:fileId/metadata',
      async (req, res) => {
        try {
          const { fileId } = req.params;

          const result = await pool.query(`
            SELECT 
              fm.*,
              u.name as uploaded_by_name,
              CASE 
                WHEN fm.is_quarantined = true THEN true
                WHEN fm.scan_status IN ('infected', 'failed') THEN true
                ELSE false
              END as quarantined
            FROM file_metadata fm
            LEFT JOIN users u ON fm.uploaded_by = u.uid
            WHERE fm.id = $1
          `, [fileId]);

          if (result.rows.length === 0) {
            return error(res, 'File not found', HTTP_STATUS.NOT_FOUND);
          }

          const file = result.rows[0];

          // Check access permissions
          const userRole = req.user?.role;
          const userUid = req.user?.uid;

          if (file.is_private && file.uploaded_by !== userUid && userRole !== 'ADMIN') {
            return error(res, 'Access denied to private file', HTTP_STATUS.FORBIDDEN);
          }

          success(res, file, 'File metadata retrieved');

        } catch (err) {
          logger.error('Get File Metadata Error:', err);
          error(res, 'Failed to fetch file metadata', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🔗 Get Secure Download URL
    [
      '/:fileId/download-url',
      async (req, res) => {
        try {
          const { fileId } = req.params;
          const { expiresIn = 3600 } = req.query; // 1 hour default

          const result = await pool.query(
            'SELECT storage_key, file_name, is_private, is_quarantined, scan_status, uploaded_by FROM file_metadata WHERE id = $1',
            [fileId]
          );

          if (result.rows.length === 0) {
            return error(res, 'File not found', HTTP_STATUS.NOT_FOUND);
          }

          const file = result.rows[0];

          // Security checks
          if (file.is_quarantined) {
            return error(res, 'File is quarantined and cannot be downloaded', HTTP_STATUS.FORBIDDEN);
          }

          if (file.scan_status === 'infected') {
            return error(res, 'File is infected and cannot be downloaded', HTTP_STATUS.FORBIDDEN);
          }

          // Access control
          const userRole = req.user?.role;
          const userUid = req.user?.uid;

          if (file.is_private && file.uploaded_by !== userUid && userRole !== 'ADMIN') {
            return error(res, 'Access denied to private file', HTTP_STATUS.FORBIDDEN);
          }

          // Generate signed URL
          const signedUrl = await getSignedFileUrl(file.storage_key, parseInt(expiresIn));

          // Log download access
          await pool.query(
            `INSERT INTO file_access_logs (
              file_id, accessed_by, access_type, ip_address, accessed_at
            ) VALUES ($1, $2, $3, $4, NOW())`,
            [fileId, userUid, 'download_url', req.headers['x-forwarded-for']]
          );

          success(res, {
            downloadUrl: signedUrl,
            fileName: file.file_name,
            expiresInSeconds: parseInt(expiresIn),
            expiresAt: new Date(Date.now() + (parseInt(expiresIn) * 1000)).toISOString()
          }, 'Secure download URL generated');

        } catch (err) {
          logger.error('Generate Download URL Error:', err);
          error(res, 'Failed to generate download URL', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 Upload Statistics
    [
      '/stats',
      async (req, res) => {
        try {
          const { timeframe = '30d' } = req.query;
          
          let interval;
          switch (timeframe) {
            case '7d': interval = '7 days'; break;
            case '30d': interval = '30 days'; break;
            case '90d': interval = '90 days'; break;
            default: interval = '30 days';
          }

          const stats = await pool.query(`
            SELECT 
              COUNT(*) as total_files,
              SUM(file_size) as total_size_bytes,
              AVG(file_size) as avg_file_size,
              COUNT(DISTINCT uploaded_by) as unique_uploaders,
              COUNT(*) FILTER (WHERE scan_status = 'clean') as clean_files,
              COUNT(*) FILTER (WHERE scan_status = 'infected') as infected_files,
              COUNT(*) FILTER (WHERE is_quarantined = true) as quarantined_files,
              COUNT(*) FILTER (WHERE compression_applied = true) as compressed_files
            FROM file_metadata 
            WHERE uploaded_at > NOW() - INTERVAL '${interval}'
          `);

          const categoryStats = await pool.query(`
            SELECT 
              category,
              COUNT(*) as file_count,
              SUM(file_size) as total_size
            FROM file_metadata 
            WHERE uploaded_at > NOW() - INTERVAL '${interval}'
            GROUP BY category
            ORDER BY file_count DESC
          `);

          const dailyUploads = await pool.query(`
            SELECT 
              DATE(uploaded_at) as upload_date,
              COUNT(*) as files_uploaded,
              SUM(file_size) as bytes_uploaded
            FROM file_metadata 
            WHERE uploaded_at > NOW() - INTERVAL '${interval}'
            GROUP BY DATE(uploaded_at)
            ORDER BY upload_date DESC
          `);

          success(res, {
            timeframe,
            overallStats: stats.rows[0],
            categoryBreakdown: categoryStats.rows,
            dailyTrend: dailyUploads.rows,
            generatedAt: new Date().toISOString()
          }, 'Upload statistics retrieved');

        } catch (err) {
          logger.error('Upload Stats Error:', err);
          error(res, 'Failed to fetch upload statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  delete: [
    // 🗑️ Delete File
    [
      '/:fileId',
      async (req, res) => {
        try {
          const { fileId } = req.params;
          const { reason = 'User deletion' } = req.body;
          const userUid = req.user?.uid;
          const userRole = req.user?.role;

          // Get file info
          const fileResult = await pool.query(
            'SELECT storage_key, file_name, uploaded_by, is_private FROM file_metadata WHERE id = $1',
            [fileId]
          );

          if (fileResult.rows.length === 0) {
            return error(res, 'File not found', HTTP_STATUS.NOT_FOUND);
          }

          const file = fileResult.rows[0];

          // Check permissions
          if (file.uploaded_by !== userUid && userRole !== 'ADMIN') {
            return error(res, 'Permission denied. You can only delete your own files.', HTTP_STATUS.FORBIDDEN);
          }

          // Delete from R2 storage
          await deleteFileFromR2(file.storage_key);

          // Delete from database
          await pool.query('DELETE FROM file_metadata WHERE id = $1', [fileId]);

          // Log deletion
          await pool.query(
            `INSERT INTO file_access_logs (
              file_id, accessed_by, access_type, ip_address, accessed_at, notes
            ) VALUES ($1, $2, $3, $4, NOW(), $5)`,
            [fileId, userUid, 'delete', req.headers['x-forwarded-for'], reason]
          );

          logger.info(`🗑️ File deleted: ${file.file_name} (ID: ${fileId}) by ${userUid}`);

          success(res, {
            fileId,
            fileName: file.file_name,
            deletedBy: userUid,
            reason
          }, 'File deleted successfully');

        } catch (err) {
          logger.error('Delete File Error:', err);
          error(res, 'Failed to delete file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// ✅ Admin Routes for File Management
wrapRoutes(
  router,
  ['ADMIN'], // Admin only
  {
    get: [
      // 🦠 Quarantined Files Management
      [
        '/admin/quarantined',
        async (req, res) => {
          try {
            const quarantinedFiles = await pool.query(`
              SELECT 
                id, file_name, file_type, file_size, storage_key,
                scan_status, scan_result, quarantine_reason,
                uploaded_by, uploaded_at, quarantined_at,
                u.name as uploaded_by_name
              FROM file_metadata fm
              LEFT JOIN users u ON fm.uploaded_by = u.uid
              WHERE is_quarantined = true OR scan_status = 'infected'
              ORDER BY quarantined_at DESC
            `);

            success(res, {
              quarantinedFiles: quarantinedFiles.rows,
              totalQuarantined: quarantinedFiles.rows.length
            }, 'Quarantined files retrieved');

          } catch (err) {
            logger.error('Quarantined Files Error:', err);
            error(res, 'Failed to fetch quarantined files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 File System Health Report
      [
        '/admin/health-report',
        async (req, res) => {
          try {
            const healthStats = await pool.query(`
              SELECT 
                COUNT(*) as total_files,
                SUM(file_size) as total_storage_bytes,
                COUNT(*) FILTER (WHERE scan_status = 'pending') as pending_scans,
                COUNT(*) FILTER (WHERE scan_status = 'failed') as failed_scans,
                COUNT(*) FILTER (WHERE is_quarantined = true) as quarantined_count,
                COUNT(*) FILTER (WHERE uploaded_at > NOW() - INTERVAL '24 hours') as uploads_24h,
                AVG(file_size) as avg_file_size
              FROM file_metadata
            `);

            const storageByCategory = await pool.query(`
              SELECT 
                category,
                COUNT(*) as file_count,
                SUM(file_size) as storage_bytes,
                AVG(file_size) as avg_size
              FROM file_metadata
              GROUP BY category
              ORDER BY storage_bytes DESC
            `);

            const recentErrors = await pool.query(`
              SELECT 
                id, file_name, scan_result, uploaded_at
              FROM file_metadata
              WHERE scan_status = 'failed' OR scan_status = 'infected'
              ORDER BY uploaded_at DESC
              LIMIT 10
            `);

            success(res, {
              healthOverview: healthStats.rows[0],
              storageBreakdown: storageByCategory.rows,
              recentErrors: recentErrors.rows,
              reportGenerated: new Date().toISOString()
            }, 'File system health report generated');

          } catch (err) {
            logger.error('Health Report Error:', err);
            error(res, 'Failed to generate health report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // 🔄 Rescan File
      [
        '/admin/rescan/:fileId',
        async (req, res) => {
          try {
            const { fileId } = req.params;
            const adminUid = req.user?.uid;

            const fileResult = await pool.query(
              'SELECT storage_url, file_name FROM file_metadata WHERE id = $1',
              [fileId]
            );

            if (fileResult.rows.length === 0) {
              return error(res, 'File not found', HTTP_STATUS.NOT_FOUND);
            }

            const file = fileResult.rows[0];

            // Update scan status to pending
            await pool.query(
              'UPDATE file_metadata SET scan_status = $1, scan_result = NULL WHERE id = $2',
              ['pending', fileId]
            );

            // Trigger rescan
            setTimeout(async () => {
              try {
                const scanResult = await scanFileWithClamAV(file.storage_url);
                
                let status = 'failed';
                let resultText = 'Unknown error';

                if (scanResult.status === 'clean') {
                  status = 'clean';
                  resultText = null;
                } else if (scanResult.status === 'infected') {
                  status = 'infected';
                  resultText = scanResult.virus;
                }

                await pool.query(
                  'UPDATE file_metadata SET scan_status = $1, scan_result = $2, scanned_at = NOW() WHERE id = $3',
                  [status, resultText, fileId]
                );

              } catch (scanError) {
                await pool.query(
                  'UPDATE file_metadata SET scan_status = $1, scan_result = $2 WHERE id = $3',
                  ['failed', scanError.message, fileId]
                );
              }
            }, 100);

            logger.info(`🔄 Admin ${adminUid} triggered rescan for file: ${file.file_name}`);

            success(res, {
              fileId,
              fileName: file.file_name,
              scanStatus: 'pending',
              rescannedBy: adminUid
            }, 'File rescan initiated');

          } catch (err) {
            logger.error('Rescan File Error:', err);
            error(res, 'Failed to rescan file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🧹 Cleanup Orphaned Files
      [
        '/admin/cleanup-orphaned',
        async (req, res) => {
          try {
            const { dryRun = true } = req.body;
            const adminUid = req.user?.uid;

            // Find files that might be orphaned (older than 30 days, no related records)
            const orphanedFiles = await pool.query(`
              SELECT id, storage_key, file_name, file_size
              FROM file_metadata 
              WHERE uploaded_at < NOW() - INTERVAL '30 days'
                AND related_id IS NULL
                AND category NOT IN ('profile_picture', 'insurance_document')
            `);

            if (dryRun) {
              return success(res, {
                dryRun: true,
                orphanedFiles: orphanedFiles.rows,
                totalFiles: orphanedFiles.rows.length,
                totalSizeBytes: orphanedFiles.rows.reduce((sum, f) => sum + f.file_size, 0)
              }, 'Dry run completed - no files deleted');
            }

            let deletedCount = 0;
            let freedBytes = 0;

            for (const file of orphanedFiles.rows) {
              try {
                await deleteFileFromR2(file.storage_key);
                await pool.query('DELETE FROM file_metadata WHERE id = $1', [file.id]);
                deletedCount++;
                freedBytes += file.file_size;
              } catch (deleteError) {
                logger.error(`Failed to delete orphaned file ${file.id}:`, deleteError);
              }
            }

            logger.info(`🧹 Admin ${adminUid} cleaned up ${deletedCount} orphaned files, freed ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);

            success(res, {
              deletedCount,
              freedBytes,
              freedMB: (freedBytes / 1024 / 1024).toFixed(2),
              cleanedBy: adminUid
            }, `Cleanup completed: ${deletedCount} orphaned files removed`);

          } catch (err) {
            logger.error('Cleanup Orphaned Files Error:', err);
            error(res, 'Failed to cleanup orphaned files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

export default router;