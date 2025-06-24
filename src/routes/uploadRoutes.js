// src/routes/uploadRoutes.js - Enhanced Hospital-Grade File Management System

import express from 'express';
import multer from 'multer';
import { FILE_UPLOAD_RULES } from '../config/fileUploadConfig.js';
import { 
  uploadFileToR2, 
  deleteObject as deleteFileFromR2, 
  getSignedFileUrl,
  copyObject
} from '../utils/r2Storage.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { scanFileWithClamAV } from '../utils/clamavScanHelper.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import { validationResult, body, query, param } from 'express-validator';
import sharp from 'sharp';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

// ✅ Enhanced upload configuration for hospital environment
const HOSPITAL_UPLOAD_CONFIG = {
  allowedMimeTypes: [
    // Images - Medical imaging and documents
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/tiff',
    'image/bmp', 'image/svg+xml',
    // Documents - Medical records and reports
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv', 'text/rtf',
    // Medical specific formats
    'application/dicom', // DICOM medical imaging
    'application/hl7-v2+er7', // HL7 medical data exchange
    'application/fhir+json', // FHIR healthcare data
    // Audio/Video for telemedicine
    'audio/mpeg', 'audio/wav', 'audio/mp4',
    'video/mp4', 'video/avi', 'video/quicktime'
  ],
  maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB for medical files
  imageMaxWidth: 4096, // High resolution for medical imaging
  imageMaxHeight: 4096,
  imageQuality: 95, // High quality for medical images
  allowedCategories: [
    'medical_record', 'prescription', 'lab_report', 'xray', 'mri', 'ct_scan',
    'ultrasound', 'ecg', 'eeg', 'pathology_report', 'discharge_summary',
    'consent_form', 'insurance_document', 'id_document', 'profile_picture',
    'surgery_notes', 'progress_notes', 'referral_letter', 'vaccination_record',
    'allergy_record', 'medication_list', 'treatment_plan', 'consultation_notes',
    'telemedicine_recording', 'rehabilitation_plan', 'mental_health_assessment'
  ],
  hipaaCategories: [
    'medical_record', 'lab_report', 'pathology_report', 'surgery_notes',
    'progress_notes', 'mental_health_assessment', 'treatment_plan'
  ],
  retentionPeriods: {
    'medical_record': 7 * 365, // 7 years
    'lab_report': 7 * 365,
    'xray': 5 * 365, // 5 years
    'prescription': 2 * 365, // 2 years
    'profile_picture': 1 * 365, // 1 year
    'consultation_notes': 7 * 365,
    'default': 3 * 365 // 3 years default
  }
};

// ✅ Enhanced multer setup with security
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { 
    fileSize: HOSPITAL_UPLOAD_CONFIG.maxFileSizeBytes,
    files: 10, // Max 10 files per request
    fieldNameSize: 200,
    fieldSize: 1024
  },
  fileFilter: (req, file, cb) => {
    if (!HOSPITAL_UPLOAD_CONFIG.allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error(`File type ${file.mimetype} not allowed in hospital system. Allowed types: ${HOSPITAL_UPLOAD_CONFIG.allowedMimeTypes.join(', ')}`));
    }
    
    // Check file name for malicious patterns
    const dangerousPatterns = /[<>:"/\\|?*\x00-\x1f]/;
    if (dangerousPatterns.test(file.originalname)) {
      return cb(new Error('File name contains invalid characters'));
    }
    
    cb(null, true);
  }
});

// ✅ Validation schemas
const uploadValidation = [
  body('category')
    .optional()
    .isIn(HOSPITAL_UPLOAD_CONFIG.allowedCategories)
    .withMessage(`Category must be one of: ${HOSPITAL_UPLOAD_CONFIG.allowedCategories.join(', ')}`),
  body('patientPhone')
    .optional()
    .isMobilePhone('any')
    .withMessage('Invalid patient phone number format'),
  body('description')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Description must be less than 1000 characters'),
  body('isPrivate')
    .optional()
    .isBoolean()
    .withMessage('isPrivate must be boolean'),
  body('relatedId')
    .optional()
    .isUUID()
    .withMessage('relatedId must be valid UUID'),
  body('hipaaProtected')
    .optional()
    .isBoolean()
    .withMessage('hipaaProtected must be boolean')
];

const fileIdValidation = [
  param('fileId').isUUID().withMessage('File ID must be valid UUID')
];

// ✅ Utility functions
function generateSecureFileKey(originalName, category = 'general', patientPhone = null) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(16).toString('hex');
  const ext = path.extname(originalName).toLowerCase();
  const sanitizedCategory = category.replace(/[^a-zA-Z0-9_-]/g, '');
  
  let keyPath = `hospital/${sanitizedCategory}/${timestamp}_${random}${ext}`;
  
  // Add patient identifier for medical records (hashed for privacy)
  if (patientPhone && HOSPITAL_UPLOAD_CONFIG.hipaaCategories.includes(category)) {
    const patientHash = crypto.createHash('sha256').update(patientPhone).digest('hex').substring(0, 8);
    keyPath = `hospital/${sanitizedCategory}/patient_${patientHash}/${timestamp}_${random}${ext}`;
  }
  
  return keyPath;
}

async function optimizeImage(buffer, mimetype, isHipaaProtected = false) {
  try {
    let processor = sharp(buffer);
    const metadata = await processor.metadata();
    
    // Higher quality for HIPAA protected medical images
    const quality = isHipaaProtected ? 98 : HOSPITAL_UPLOAD_CONFIG.imageQuality;
    const maxWidth = isHipaaProtected ? 8192 : HOSPITAL_UPLOAD_CONFIG.imageMaxWidth;
    const maxHeight = isHipaaProtected ? 8192 : HOSPITAL_UPLOAD_CONFIG.imageMaxHeight;
    
    // Resize if too large
    if (metadata.width > maxWidth || metadata.height > maxHeight) {
      processor = processor.resize(maxWidth, maxHeight, { 
        fit: 'inside', 
        withoutEnlargement: false 
      });
    }
    
    // Format-specific optimization
    if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') {
      return await processor.jpeg({ quality, progressive: true }).toBuffer();
    } else if (mimetype === 'image/png') {
      return await processor.png({ 
        compressionLevel: isHipaaProtected ? 6 : 8,
        quality
      }).toBuffer();
    } else if (mimetype === 'image/webp') {
      return await processor.webp({ quality }).toBuffer();
    }
    
    return buffer;
  } catch (err) {
    logger.warn('Image optimization failed, using original:', err.message);
    return buffer;
  }
}

async function compressPDF(buffer, isHipaaProtected = false) {
  try {
    const tempIn = `/tmp/${Date.now()}_${crypto.randomBytes(8).toString('hex')}_in.pdf`;
    const tempOut = `/tmp/${Date.now()}_${crypto.randomBytes(8).toString('hex')}_out.pdf`;

    await fs.writeFile(tempIn, buffer);

    // Higher quality settings for HIPAA protected documents
    const pdfSettings = isHipaaProtected ? '/prepress' : '/ebook';

    await new Promise((resolve, reject) => {
      exec(
        `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${pdfSettings} -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${tempOut} ${tempIn}`,
        { timeout: 30000 }, // 30 second timeout
        (err) => (err ? reject(err) : resolve())
      );
    });

    const compressedBuffer = await fs.readFile(tempOut);
    
    // Cleanup temp files
    await Promise.all([
      fs.unlink(tempIn).catch(() => {}),
      fs.unlink(tempOut).catch(() => {})
    ]);

    // Only return compressed if it's actually smaller or same quality needed
    return compressedBuffer.length < buffer.length || isHipaaProtected 
      ? compressedBuffer 
      : buffer;
  } catch (err) {
    logger.warn('PDF compression failed, using original:', err.message);
    return buffer;
  }
}

function calculateRetentionDate(category) {
  const retentionDays = HOSPITAL_UPLOAD_CONFIG.retentionPeriods[category] || 
                       HOSPITAL_UPLOAD_CONFIG.retentionPeriods.default;
  const retentionDate = new Date();
  retentionDate.setDate(retentionDate.getDate() + retentionDays);
  return retentionDate;
}

async function logFileAccess(fileId, accessType, userId, ipAddress, userAgent = null, notes = null) {
  try {
    await pool.query(`
      INSERT INTO file_access_logs (
        file_id, user_id, access_type, ip_address, user_agent, 
        accessed_at, notes
      ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
    `, [fileId, userId, accessType, ipAddress, userAgent, notes]);
  } catch (err) {
    logger.error('Failed to log file access:', err);
  }
}

// ✅ RBAC Protected Routes
wrapAutoRBAC(router, 'uploadRoutes', {
  post: [
    // 📤 Single File Upload with HIPAA Compliance
    [
      '/',
      upload.single('file'),
      uploadValidation,
      async (req, res) => {
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

        const { 
          category = 'general', 
          description, 
          isPrivate = false,
          hipaaProtected = false,
          patientPhone,
          relatedId,
          relatedType,
          urgencyLevel = 'normal'
        } = req.body;
        
        const uploadedBy = req.user?.uid || 'system';
        const uploadedByRole = req.user?.role || 'unknown';
        const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];

        try {
          // Auto-detect HIPAA protection based on category
          const isHipaaCategory = HOSPITAL_UPLOAD_CONFIG.hipaaCategories.includes(category);
          const finalHipaaProtected = hipaaProtected || isHipaaCategory;

          // Role-based access control for HIPAA files
          if (finalHipaaProtected && !['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(uploadedByRole)) {
            return error(res, 'Insufficient permissions to upload HIPAA protected files', HTTP_STATUS.FORBIDDEN);
          }

          let processedBuffer = req.file.buffer;
          let compressionApplied = false;
          let processingTime = Date.now();

          // Apply file optimization based on type and HIPAA requirements
          if (req.file.mimetype.startsWith('image/')) {
            processedBuffer = await optimizeImage(req.file.buffer, req.file.mimetype, finalHipaaProtected);
            compressionApplied = processedBuffer.length !== req.file.buffer.length;
          } else if (req.file.mimetype === 'application/pdf') {
            processedBuffer = await compressPDF(req.file.buffer, finalHipaaProtected);
            compressionApplied = processedBuffer.length !== req.file.buffer.length;
          }

          processingTime = Date.now() - processingTime;

          // Generate secure storage key
          const key = generateSecureFileKey(req.file.originalname, category, patientPhone);
          
          // Upload to R2 with encryption for HIPAA files
          const url = await uploadFileToR2(processedBuffer, key, req.file.mimetype);

          // Calculate retention date
          const retentionDate = calculateRetentionDate(category);

          // Store comprehensive metadata
          const result = await pool.query(`
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
              req.file.originalname, req.file.mimetype, processedBuffer.length, req.file.buffer.length,
              key, url, category, description, isPrivate, finalHipaaProtected, uploadedBy,
              uploadedByRole, normalizePhone(patientPhone), relatedId, relatedType,
              compressionApplied, processingTime, 'pending', retentionDate,
              urgencyLevel, ipAddress, userAgent
            ]
          );

          const fileId = result.rows[0].id;

          // Log file upload
          await logFileAccess(fileId, 'upload', uploadedBy, ipAddress, userAgent, 
            `File uploaded: ${req.file.originalname} (${category})`);

          // Async virus scan with priority for urgent files
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
              await pool.query(`
                UPDATE file_metadata SET 
                  scan_status = $1, scan_result = $2, scanned_at = NOW(),
                  scan_duration_ms = $3
                WHERE id = $4
              `, [status, resultText, scanDuration, fileId]);

              // Immediate quarantine for infected files
              if (status === 'infected') {
                await pool.query(`
                  UPDATE file_metadata SET 
                    is_quarantined = true, quarantined_at = NOW(), 
                    quarantine_reason = $1, quarantined_by = 'system'
                  WHERE id = $2
                `, [resultText, fileId]);
                
                // Alert admins for infected files
                await pool.query(`
                  INSERT INTO system_alerts (
                    alert_type, severity, message, related_file_id, created_at
                  ) VALUES ($1, $2, $3, $4, NOW())
                `, ['virus_detected', 'critical', `Infected file quarantined: ${req.file.originalname}`, fileId]);
                
                logger.error(`🦠 CRITICAL: Infected file quarantined - ${key} - ${resultText}`);
              }

              // Log scan completion
              await logFileAccess(fileId, 'virus_scan', 'system', ipAddress, null, 
                `Scan completed: ${status}${resultText ? ` (${resultText})` : ''}`);

            } catch (scanError) {
              logger.error('File scanning error:', scanError);
              await pool.query(`
                UPDATE file_metadata SET 
                  scan_status = $1, scan_result = $2, scanned_at = NOW()
                WHERE id = $3
              `, ['failed', scanError.message, fileId]);
            }
          }, scanDelay);

          logger.info(`📤 Hospital file uploaded: ${req.file.originalname} | Category: ${category} | HIPAA: ${finalHipaaProtected} | User: ${uploadedBy} (${uploadedByRole})`);

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
            isHipaaProtected: finalHipaaProtected,
            storageKey: key,
            retentionDate: result.rows[0].retention_date.toISOString().split('T')[0],
            retentionDateFormatted: result.rows[0].retention_date.toLocaleDateString('en-GB'),
            url: (isPrivate || finalHipaaProtected) ? null : url,
            scanStatus: 'pending',
            processingTimeMs: processingTime,
            urgencyLevel,
            uploadedBy: uploadedBy,
            requestedBy: uploadedBy
          }, 'Hospital file uploaded successfully and queued for security scan');

        } catch (err) {
          logger.error('Hospital File Upload Error:', err.stack || err.toString());
          error(res, 'Hospital file upload failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📤 Batch Upload for Medical Records
    [
      '/batch',
      upload.array('files', 10),
      uploadValidation,
      async (req, res) => {
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

        const { 
          category = 'general', 
          description, 
          isPrivate = false,
          hipaaProtected = false,
          patientPhone,
          batchId
        } = req.body;
        
        const uploadedBy = req.user?.uid || 'system';
        const uploadedByRole = req.user?.role || 'unknown';
        const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const generatedBatchId = batchId || crypto.randomUUID();

        const results = [];
        const errors_list = [];
        let totalProcessingTime = 0;

        try {
          // Auto-detect HIPAA protection
          const isHipaaCategory = HOSPITAL_UPLOAD_CONFIG.hipaaCategories.includes(category);
          const finalHipaaProtected = hipaaProtected || isHipaaCategory;

          if (finalHipaaProtected && !['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(uploadedByRole)) {
            return error(res, 'Insufficient permissions for HIPAA protected batch upload', HTTP_STATUS.FORBIDDEN);
          }

          // Process each file
          for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            
            try {
              const processingStart = Date.now();
              let processedBuffer = file.buffer;

              // Apply optimization
              if (file.mimetype.startsWith('image/')) {
                processedBuffer = await optimizeImage(file.buffer, file.mimetype, finalHipaaProtected);
              } else if (file.mimetype === 'application/pdf') {
                processedBuffer = await compressPDF(file.buffer, finalHipaaProtected);
              }

              const processingTime = Date.now() - processingStart;
              totalProcessingTime += processingTime;

              const key = generateSecureFileKey(file.originalname, category, patientPhone);
              const url = await uploadFileToR2(processedBuffer, key, file.mimetype);
              const retentionDate = calculateRetentionDate(category);

              const result = await pool.query(`
                INSERT INTO file_metadata (
                  file_name, file_type, file_size, original_size, storage_key, storage_url,
                  category, description, is_private, is_hipaa_protected, uploaded_by,
                  uploaded_by_role, patient_phone, batch_id, compression_applied,
                  processing_time_ms, scan_status, retention_date, upload_ip, uploaded_at
                ) VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                  $16, $17, $18, $19, NOW()
                ) RETURNING id, storage_key
              `, [
                file.originalname, file.mimetype, processedBuffer.length, file.buffer.length,
                key, url, category, description, isPrivate, finalHipaaProtected, uploadedBy,
                uploadedByRole, normalizePhone(patientPhone), generatedBatchId,
                processedBuffer.length !== file.buffer.length, processingTime, 'pending',
                retentionDate, ipAddress
              ]);

              results.push({
                fileId: result.rows[0].id,
                fileName: file.originalname,
                fileSize: processedBuffer.length,
                originalSize: file.buffer.length,
                storageKey: key,
                processingTimeMs: processingTime,
                status: 'uploaded',
                position: i + 1
              });

              // Log individual file upload
              await logFileAccess(result.rows[0].id, 'batch_upload', uploadedBy, ipAddress, 
                req.headers['user-agent'], `Batch upload ${generatedBatchId} - File ${i + 1}/${req.files.length}`);

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
          await pool.query(`
            INSERT INTO batch_upload_logs (
              batch_id, uploaded_by, total_files, successful_files, failed_files,
              total_processing_time_ms, category, is_hipaa_protected, completed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          `, [
            generatedBatchId, uploadedBy, req.files.length, results.length, 
            errors_list.length, totalProcessingTime, category, finalHipaaProtected
          ]);

          logger.info(`📤 Hospital batch upload completed: ${results.length}/${req.files.length} files | Batch: ${generatedBatchId} | User: ${uploadedBy}`);

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
              category,
              isHipaaProtected: finalHipaaProtected
            },
            requestedBy: uploadedBy
          }, `Hospital batch upload completed: ${results.length}/${req.files.length} files processed successfully`);

        } catch (err) {
          logger.error('Hospital Batch Upload Error:', err);
          error(res, 'Hospital batch upload failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  get: [
    // 📋 List Files with Advanced Filtering
    [
      '/',
      [
        query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
        query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100'),
        query('category').optional().isIn(HOSPITAL_UPLOAD_CONFIG.allowedCategories),
        query('scanStatus').optional().isIn(['pending', 'clean', 'infected', 'failed', 'all']),
        query('hipaaOnly').optional().isBoolean(),
        query('urgencyLevel').optional().isIn(['normal', 'high', 'urgent'])
      ],
      async (req, res) => {
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
          const files = await pool.query(`
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
          const total = await pool.query(totalQuery, params.slice(2));

          // Format dates
          const formattedFiles = files.rows.map(file => ({
            ...file,
            uploadedAt: file.uploaded_at?.toISOString(),
            uploadedAtFormatted: file.uploaded_at?.toLocaleDateString('en-GB'),
            scannedAt: file.scanned_at?.toISOString(),
            scannedAtFormatted: file.scanned_at?.toLocaleDateString('en-GB'),
            retentionDate: file.retention_date?.toISOString()?.split('T')[0],
            retentionDateFormatted: file.retention_date?.toLocaleDateString('en-GB'),
            fileSizeMB: (file.file_size / 1024 / 1024).toFixed(2),
            compressionSavings: file.compression_applied && file.original_size > file.file_size
              ? `${(((file.original_size - file.file_size) / file.original_size) * 100).toFixed(1)}%`
              : null
          }));

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
    ],

    // 📄 Get Detailed File Metadata
    [
      '/:fileId/metadata',
      fileIdValidation,
      async (req, res) => {
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
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          const result = await pool.query(`
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
            return error(res, 'Hospital file not found', HTTP_STATUS.NOT_FOUND);
          }

          const file = result.rows[0];

          // Access control checks
          const canAccess = 
            file.uploaded_by === userId ||
            ['ADMIN', 'DOCTOR'].includes(userRole) ||
            (!file.is_private && !file.is_hipaa_protected) ||
            (file.is_hipaa_protected && ['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole));

          if (!canAccess) {
            return error(res, 'Access denied to this hospital file', HTTP_STATUS.FORBIDDEN);
          }

          // Log metadata access for HIPAA files
          if (file.is_hipaa_protected) {
            await logFileAccess(fileId, 'metadata_view', userId, ipAddress, 
              req.headers['user-agent'], 'HIPAA file metadata accessed');
          }

          // Get recent access logs (admin/doctor only)
          let recentAccess = [];
          if (['ADMIN', 'DOCTOR'].includes(userRole)) {
            const accessLogs = await pool.query(`
              SELECT 
                fal.access_type, fal.accessed_at, fal.ip_address, fal.notes,
                u.name as user_name, u.phone as user_phone, fal.user_id
              FROM file_access_logs fal
              LEFT JOIN users u ON fal.user_id = u.uid
              WHERE fal.file_id = $1
              ORDER BY fal.accessed_at DESC
              LIMIT 10
            `, [fileId]);
            
            recentAccess = accessLogs.rows.map(log => ({
              ...log,
              accessedAt: log.accessed_at?.toISOString(),
              accessedAtFormatted: log.accessed_at?.toLocaleDateString('en-GB')
            }));
          }

          const formattedFile = {
            ...file,
            uploadedAt: file.uploaded_at?.toISOString(),
            uploadedAtFormatted: file.uploaded_at?.toLocaleDateString('en-GB'),
            scannedAt: file.scanned_at?.toISOString(),
            scannedAtFormatted: file.scanned_at?.toLocaleDateString('en-GB'),
            retentionDate: file.retention_date?.toISOString()?.split('T')[0],
            retentionDateFormatted: file.retention_date?.toLocaleDateString('en-GB'),
            quarantinedAt: file.quarantined_at?.toISOString(),
            quarantinedAtFormatted: file.quarantined_at?.toLocaleDateString('en-GB'),
            lastAccessed: file.last_accessed?.toISOString(),
            lastAccessedFormatted: file.last_accessed?.toLocaleDateString('en-GB'),
            fileSizeMB: (file.file_size / 1024 / 1024).toFixed(2),
            originalSizeMB: (file.original_size / 1024 / 1024).toFixed(2),
            compressionSavings: file.compression_applied && file.original_size > file.file_size
              ? `${(((file.original_size - file.file_size) / file.original_size) * 100).toFixed(1)}%`
              : null,
            recentAccess: recentAccess,
            daysUntilExpiry: file.retention_date 
              ? Math.ceil((new Date(file.retention_date) - new Date()) / (1000 * 60 * 60 * 24))
              : null
          };

          success(res, {
            file: formattedFile,
            userAccess: {
              role: userRole,
              canDownload: canAccess && !file.quarantined,
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
    ],

    // 🔗 Generate Secure Download URL
    [
      '/:fileId/download-url',
      fileIdValidation,
      [
        query('expiresIn').optional().isInt({ min: 60, max: 86400 }).withMessage('Expires must be 60-86400 seconds')
      ],
      async (req, res) => {
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
          const { expiresIn = 3600 } = req.query; // 1 hour default
          const userRole = req.user?.role;
          const userId = req.user?.uid;
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          const result = await pool.query(`
            SELECT 
              storage_key, file_name, is_private, is_hipaa_protected, 
              is_quarantined, scan_status, uploaded_by, urgency_level,
              retention_date, file_size
            FROM file_metadata 
            WHERE id = $1
          `, [fileId]);

          if (result.rows.length === 0) {
            return error(res, 'Hospital file not found', HTTP_STATUS.NOT_FOUND);
          }

          const file = result.rows[0];

          // Security checks
          if (file.is_quarantined) {
            return error(res, 'File is quarantined and cannot be downloaded', HTTP_STATUS.FORBIDDEN);
          }

          if (file.scan_status === 'infected') {
            return error(res, 'File is infected and cannot be downloaded', HTTP_STATUS.FORBIDDEN);
          }

          if (file.scan_status === 'pending') {
            return error(res, 'File is still being scanned, please try again later', HTTP_STATUS.TOO_EARLY);
          }

          // Check if file has expired
          if (file.retention_date && new Date(file.retention_date) < new Date()) {
            return error(res, 'File has expired and is no longer available for download', HTTP_STATUS.GONE);
          }

          // Access control
          const canAccess = 
            file.uploaded_by === userId ||
            ['ADMIN', 'DOCTOR'].includes(userRole) ||
            (!file.is_private && !file.is_hipaa_protected) ||
            (file.is_hipaa_protected && ['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole));

          if (!canAccess) {
            return error(res, 'Access denied to this hospital file', HTTP_STATUS.FORBIDDEN);
          }

          // Shorter expiry for HIPAA files
          const maxExpiry = file.is_hipaa_protected ? Math.min(expiresIn, 1800) : expiresIn; // 30 min max for HIPAA

          // Generate signed URL
          const signedUrl = await getSignedFileUrl(file.storage_key, parseInt(maxExpiry));
          const expiresAt = new Date(Date.now() + (parseInt(maxExpiry) * 1000));

          // Log download URL generation
          await logFileAccess(fileId, 'download_url_generated', userId, ipAddress, 
            req.headers['user-agent'], 
            `Download URL generated, expires: ${expiresAt.toISOString()}${file.is_hipaa_protected ? ' (HIPAA)' : ''}`);

          // Special logging for HIPAA files
          if (file.is_hipaa_protected) {
            logger.info(`🔒 HIPAA file download URL generated: ${file.file_name} | User: ${userId} (${userRole}) | IP: ${ipAddress}`);
          }

          success(res, {
            downloadUrl: signedUrl,
            fileName: file.file_name,
            fileSize: file.file_size,
            fileSizeMB: (file.file_size / 1024 / 1024).toFixed(2),
            expiresInSeconds: parseInt(maxExpiry),
            expiresAt: expiresAt.toISOString(),
            expiresAtFormatted: expiresAt.toLocaleDateString('en-GB'),
            isHipaaProtected: file.is_hipaa_protected,
            urgencyLevel: file.urgency_level,
            securityNotice: file.is_hipaa_protected 
              ? 'This is a HIPAA protected file. Unauthorized access or sharing is prohibited.'
              : null,
            requestedBy: userId
          }, 'Secure hospital file download URL generated successfully');

        } catch (err) {
          logger.error('Generate Hospital Download URL Error:', err);
          error(res, 'Failed to generate secure download URL', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 Hospital File Statistics
    [
      '/stats',
      [
        query('timeframe').optional().isIn(['7d', '30d', '90d', '1y']).withMessage('Invalid timeframe'),
        query('detailed').optional().isBoolean()
      ],
      async (req, res) => {
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
          const stats = await pool.query(`
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
          const categoryStats = await pool.query(`
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
          const dailyUploads = await pool.query(`
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

          let detailedStats = {};
          
          if (detailed === 'true' && ['ADMIN', 'DOCTOR'].includes(userRole)) {
            // Security statistics (admin/doctor only)
            const securityStats = await pool.query(`
              SELECT 
                COUNT(*) FILTER (WHERE scan_status = 'infected') as infected_count
              FROM file_metadata
              GROUP BY category
              ORDER BY storage_bytes DESC
            `);

            // Recent security incidents
            const securityIncidents = await pool.query(`
              SELECT 
                fm.id, fm.file_name, fm.scan_result, fm.uploaded_at, fm.quarantined_at,
                fm.category, fm.is_hipaa_protected, u.name as uploaded_by_name
              FROM file_metadata fm
              LEFT JOIN users u ON fm.uploaded_by = u.uid
              WHERE fm.scan_status = 'infected' OR fm.is_quarantined = true
              ORDER BY COALESCE(fm.quarantined_at, fm.uploaded_at) DESC
              LIMIT 20
            `);

            // System performance metrics
            const performanceMetrics = await pool.query(`
              SELECT 
                DATE(uploaded_at) as date,
                COUNT(*) as daily_uploads,
                AVG(processing_time_ms) as avg_processing_time,
                AVG(scan_duration_ms) as avg_scan_time,
                COUNT(*) FILTER (WHERE scan_status = 'failed') as scan_failures
              FROM file_metadata
              WHERE uploaded_at > NOW() - INTERVAL '7 days'
              GROUP BY DATE(uploaded_at)
              ORDER BY date DESC
            `);

            // HIPAA compliance metrics
            const hipaaMetrics = await pool.query(`
              SELECT 
                COUNT(*) as total_hipaa_files,
                COUNT(*) FILTER (WHERE is_deleted = true) as soft_deleted,
                COUNT(*) FILTER (WHERE retention_date < CURRENT_DATE) as expired,
                COUNT(DISTINCT uploaded_by) as hipaa_uploaders,
                SUM(file_size) as total_hipaa_bytes
              FROM file_metadata
              WHERE is_hipaa_protected = true
            `);

            const formattedStats = {
              ...healthStats.rows[0],
              total_storage_gb: (healthStats.rows[0].total_storage_bytes / 1024 / 1024 / 1024).toFixed(2),
              avg_file_size_mb: (healthStats.rows[0].avg_file_size / 1024 / 1024).toFixed(2),
              storage_efficiency: healthStats.rows[0].total_files > 0 
                ? ((1 - (healthStats.rows[0].quarantined_count / healthStats.rows[0].total_files)) * 100).toFixed(1)
                : '100.0'
            };

            const formattedIncidents = securityIncidents.rows.map(incident => ({
              ...incident,
              uploadedAt: incident.uploaded_at?.toISOString(),
              uploadedAtFormatted: incident.uploaded_at?.toLocaleDateString('en-GB'),
              quarantinedAt: incident.quarantined_at?.toISOString(),
              quarantinedAtFormatted: incident.quarantined_at?.toLocaleDateString('en-GB')
            }));

            const formattedPerformance = performanceMetrics.rows.map(metric => ({
              ...metric,
              dateFormatted: new Date(metric.date).toLocaleDateString('en-GB'),
              avg_processing_time_seconds: (metric.avg_processing_time / 1000).toFixed(2),
              avg_scan_time_seconds: (metric.avg_scan_time / 1000).toFixed(2)
            }));

            const formattedHipaa = {
              ...hipaaMetrics.rows[0],
              total_hipaa_gb: (hipaaMetrics.rows[0].total_hipaa_bytes / 1024 / 1024 / 1024).toFixed(2),
              compliance_rate: hipaaMetrics.rows[0].total_hipaa_files > 0
                ? (((hipaaMetrics.rows[0].total_hipaa_files - hipaaMetrics.rows[0].expired) / hipaaMetrics.rows[0].total_hipaa_files) * 100).toFixed(1)
                : '100.0'
            };

            success(res, {
              healthOverview: formattedStats,
              storageBreakdown: storageByCategory.rows,
              securityIncidents: formattedIncidents,
              performanceMetrics: formattedPerformance,
              hipaaCompliance: formattedHipaa,
              systemStatus: {
                overall: healthStats.rows[0].pending_scans === 0 && healthStats.rows[0].failed_scans === 0 ? 'healthy' : 'attention_needed',
                scanningBacklog: healthStats.rows[0].pending_scans,
                securityLevel: healthStats.rows[0].quarantined_count === 0 ? 'secure' : 'monitoring',
                hipaaCompliance: parseFloat(formattedHipaa.compliance_rate) > 95 ? 'compliant' : 'review_needed'
              },
              reportGenerated: new Date().toISOString(),
              reportGeneratedFormatted: new Date().toLocaleDateString('en-GB'),
              requestedBy: req.user?.uid
            }, 'Hospital file system health report generated successfully');

          } catch (err) {
            logger.error('Hospital Health Report Error:', err);
            error(res, 'Failed to generate hospital health report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📋 HIPAA Audit Report
      [
        '/admin/hipaa-audit',
        [
          query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be 1-365')
        ],
        async (req, res) => {
          try {
            const { days = 30 } = req.query;

            // HIPAA file access audit
            const accessAudit = await pool.query(`
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
            const modifications = await pool.query(`
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
            const unauthorizedAttempts = await pool.query(`
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
            const userPatterns = await pool.query(`
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

            const formattedAccess = accessAudit.rows.map(log => ({
              ...log,
              accessedAt: log.accessed_at?.toISOString(),
              accessedAtFormatted: log.accessed_at?.toLocaleDateString('en-GB')
            }));

            const formattedModifications = modifications.rows.map(mod => ({
              ...mod,
              uploadedAt: mod.uploaded_at?.toISOString(),
              uploadedAtFormatted: mod.uploaded_at?.toLocaleDateString('en-GB'),
              deletedAt: mod.deleted_at?.toISOString(),
              deletedAtFormatted: mod.deleted_at?.toLocaleDateString('en-GB')
            }));

            const formattedUnauthorized = unauthorizedAttempts.rows.map(attempt => ({
              ...attempt,
              accessedAt: attempt.accessed_at?.toISOString(),
              accessedAtFormatted: attempt.accessed_at?.toLocaleDateString('en-GB')
            }));

            const formattedPatterns = userPatterns.rows.map(pattern => ({
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
              summary: {
                totalHipaaAccesses: accessAudit.rows.length,
                uniqueHipaaFiles: new Set(accessAudit.rows.map(a => a.file_id)).size,
                uniqueUsers: new Set(accessAudit.rows.map(a => a.user_id)).size,
                totalModifications: modifications.rows.length,
                unauthorizedAttemptCount: unauthorizedAttempts.rows.length,
                mostActiveUser: userPatterns.rows[0]?.user_name || 'None'
              },
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
      ]
    ],

    post: [
      // 🔄 Rescan File for Security
      [
        '/admin/rescan/:fileId',
        fileIdValidation,
        async (req, res) => {
          try {
            const { fileId } = req.params;
            const adminUid = req.user?.uid;

            const fileResult = await pool.query(
              'SELECT storage_url, file_name, is_hipaa_protected FROM file_metadata WHERE id = $1',
              [fileId]
            );

            if (fileResult.rows.length === 0) {
              return error(res, 'Hospital file not found', HTTP_STATUS.NOT_FOUND);
            }

            const file = fileResult.rows[0];

            // Update scan status to pending
            await pool.query(
              'UPDATE file_metadata SET scan_status = $1, scan_result = NULL, scanned_at = NULL WHERE id = $2',
              ['pending', fileId]
            );

            // Log admin rescan action
            await logFileAccess(fileId, 'admin_rescan', adminUid, 
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

                await pool.query(`
                  UPDATE file_metadata SET 
                    scan_status = $1, scan_result = $2, scanned_at = NOW(),
                    scan_duration_ms = $3
                  WHERE id = $4
                `, [status, resultText, scanDuration, fileId]);

                // Auto-quarantine if infected
                if (status === 'infected') {
                  await pool.query(`
                    UPDATE file_metadata SET 
                      is_quarantined = true, quarantined_at = NOW(), 
                      quarantine_reason = $1, quarantined_by = $2
                    WHERE id = $3
                  `, [resultText, adminUid, fileId]);
                }

                // Log scan completion
                await logFileAccess(fileId, 'rescan_completed', 'system', 
                  req.headers['x-forwarded-for'], null, 
                  `Admin rescan completed: ${status}${resultText ? ` (${resultText})` : ''}`);

              } catch (scanError) {
                await pool.query(
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
      ],

      // 🧹 Cleanup Expired Files
      [
        '/admin/cleanup-expired',
        [
          body('dryRun').optional().isBoolean(),
          body('category').optional().isIn(HOSPITAL_UPLOAD_CONFIG.allowedCategories),
          body('olderThanDays').optional().isInt({ min: 1, max: 3650 })
        ],
        async (req, res) => {
          try {
            const { dryRun = true, category, olderThanDays } = req.body;
            const adminUid = req.user?.uid;

            let whereClause = 'WHERE retention_date < CURRENT_DATE';
            const params = [];
            let paramIndex = 1;

            if (category) {
              whereClause += ` AND category = ${paramIndex}`;
              params.push(category);
              paramIndex++;
            }

            if (olderThanDays) {
              whereClause += ` AND uploaded_at < NOW() - INTERVAL '${olderThanDays} days'`;
            }

            // Find expired files
            const expiredFiles = await pool.query(`
              SELECT 
                id, storage_key, file_name, file_size, category, 
                is_hipaa_protected, uploaded_by, retention_date
              FROM file_metadata 
              ${whereClause}
              ORDER BY retention_date ASC
            `, params);

            if (dryRun) {
              const totalSize = expiredFiles.rows.reduce((sum, f) => sum + f.file_size, 0);
              const hipaaCount = expiredFiles.rows.filter(f => f.is_hipaa_protected).length;

              return success(res, {
                dryRun: true,
                expiredFiles: expiredFiles.rows.map(file => ({
                  ...file,
                  retentionDate: file.retention_date?.toISOString()?.split('T')[0],
                  retentionDateFormatted: file.retention_date?.toLocaleDateString('en-GB'),
                  fileSizeMB: (file.file_size / 1024 / 1024).toFixed(2)
                })),
                summary: {
                  totalFiles: expiredFiles.rows.length,
                  totalSizeBytes: totalSize,
                  totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
                  hipaaFiles: hipaaCount,
                  regularFiles: expiredFiles.rows.length - hipaaCount
                },
                requestedBy: adminUid
              }, 'Dry run completed - no files deleted. Review expired files list.');
            }

            let deletedCount = 0;
            let freedBytes = 0;
            let hipaaDeleted = 0;
            const deletionErrors = [];

            for (const file of expiredFiles.rows) {
              try {
                // Delete from R2 storage
                await deleteFileFromR2(file.storage_key);
                
                // Remove from database
                await pool.query('DELETE FROM file_metadata WHERE id = $1', [file.id]);

                // Log deletion
                await pool.query(`
                  INSERT INTO file_deletion_log (
                    file_id, file_name, storage_key, category, file_size,
                    is_hipaa_protected, uploaded_by, deleted_by, deletion_reason,
                    deletion_type, deleted_at, ip_address
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
                `, [
                  file.id, file.file_name, file.storage_key, file.category, file.file_size,
                  file.is_hipaa_protected, file.uploaded_by, adminUid, 'Automated cleanup - retention expired',
                  'expired_cleanup', req.headers['x-forwarded-for']
                ]);

                deletedCount++;
                freedBytes += file.file_size;
                if (file.is_hipaa_protected) hipaaDeleted++;

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
                successRate: expiredFiles.rows.length > 0 
                  ? `${((deletedCount / expiredFiles.rows.length) * 100).toFixed(1)}%`
                  : '100%',
                totalProcessed: expiredFiles.rows.length,
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
      ],

      // 🔒 Bulk HIPAA Protection Update
      [
        '/admin/hipaa-protection',
        [
          body('fileIds').isArray({ min: 1, max: 100 }).withMessage('File IDs array required (1-100 items)'),
          body('fileIds.*').isUUID().withMessage('Each file ID must be valid UUID'),
          body('setHipaaProtected').isBoolean().withMessage('setHipaaProtected must be boolean'),
          body('reason').isLength({ min: 10, max: 500 }).withMessage('Reason required (10-500 characters)')
        ],
        async (req, res) => {
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
                const fileResult = await pool.query(
                  'SELECT file_name, is_hipaa_protected, category FROM file_metadata WHERE id = $1',
                  [fileId]
                );

                if (fileResult.rows.length === 0) {
                  errors_list.push({ fileId, error: 'File not found' });
                  continue;
                }

                const file = fileResult.rows[0];

                // Update HIPAA protection status
                await pool.query(
                  'UPDATE file_metadata SET is_hipaa_protected = $1 WHERE id = $2',
                  [setHipaaProtected, fileId]
                );

                // Log the change
                await logFileAccess(fileId, 'hipaa_protection_changed', adminUid, ipAddress, 
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
            await pool.query(`
              INSERT INTO bulk_operation_logs (
                operation_type, performed_by, affected_count, success_count, 
                error_count, operation_details, performed_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
            `, [
              'hipaa_protection_update', adminUid, fileIds.length, results.length,
              errors_list.length, JSON.stringify({ setHipaaProtected, reason })
            ]);

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
      ]
    ],

    delete: [
      // 🗑️ Purge Quarantined Files
      [
        '/admin/purge-quarantined',
        [
          body('olderThanDays').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be 1-365'),
          body('confirmPurge').isBoolean().withMessage('Confirmation required')
        ],
        async (req, res) => {
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
            const quarantinedFiles = await pool.query(`
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

            for (const file of quarantinedFiles.rows) {
              try {
                // Delete from R2 storage
                await deleteFileFromR2(file.storage_key);
                
                // Remove from database
                await pool.query('DELETE FROM file_metadata WHERE id = $1', [file.id]);

                // Log purge
                await pool.query(`
                  INSERT INTO file_deletion_log (
                    file_id, file_name, storage_key, file_size, is_hipaa_protected,
                    deleted_by, deletion_reason, deletion_type, deleted_at, ip_address
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
                `, [
                  file.id, file.file_name, file.storage_key, file.file_size, file.is_hipaa_protected,
                  adminUid, `Quarantined file purge - infected with: ${file.scan_result}`, 'quarantine_purge',
                  req.headers['x-forwarded-for']
                ]);

                purgedCount++;
                freedBytes += file.file_size;
                if (file.is_hipaa_protected) hipaaCount++;

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
                totalFound: quarantinedFiles.rows.length
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
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

export default router;infected') as total_infected,
                COUNT(DISTINCT upload_ip) as unique_ips,
                COUNT(*) FILTER (WHERE upload_ip NOT LIKE '10.%' AND upload_ip NOT LIKE '192.168.%' AND upload_ip NOT LIKE '172.%') as external_uploads,
                AVG(scan_duration_ms) as avg_scan_time
              FROM file_metadata 
              WHERE uploaded_at > NOW() - INTERVAL '${interval}'
            `);

            // Top uploaders (admin only)
            let topUploaders = [];
            if (userRole === 'ADMIN') {
              const uploaderStats = await pool.query(`
                SELECT 
                  fm.uploaded_by, u.name, u.phone, fm.uploaded_by_role,
                  COUNT(*) as upload_count,
                  SUM(fm.file_size) as total_bytes,
                  COUNT(*) FILTER (WHERE fm.is_hipaa_protected = true) as hipaa_uploads
                FROM file_metadata fm
                LEFT JOIN users u ON fm.uploaded_by = u.uid
                WHERE fm.uploaded_at > NOW() - INTERVAL '${interval}'
                GROUP BY fm.uploaded_by, u.name, u.phone, fm.uploaded_by_role
                ORDER BY upload_count DESC
                LIMIT 10
              `);
              topUploaders = uploaderStats.rows;
            }

            detailedStats = {
              security: securityStats.rows[0],
              topUploaders: topUploaders
            };
          }

          // Format results
          const formattedStats = {
            ...stats.rows[0],
            total_size_mb: (stats.rows[0].total_size_bytes / 1024 / 1024).toFixed(2),
            total_size_gb: (stats.rows[0].total_size_bytes / 1024 / 1024 / 1024).toFixed(2),
            avg_file_size_mb: (stats.rows[0].avg_file_size / 1024 / 1024).toFixed(2),
            total_savings_mb: (stats.rows[0].total_savings_bytes / 1024 / 1024).toFixed(2),
            hipaa_percentage: stats.rows[0].total_files > 0 
              ? ((stats.rows[0].hipaa_files / stats.rows[0].total_files) * 100).toFixed(1)
              : '0.0',
            infection_rate: stats.rows[0].total_files > 0
              ? ((stats.rows[0].infected_files / stats.rows[0].total_files) * 100).toFixed(3)
              : '0.000'
          };

          const formattedDaily = dailyUploads.rows.map(day => ({
            ...day,
            upload_date_formatted: new Date(day.upload_date).toLocaleDateString('en-GB'),
            bytes_uploaded_mb: (day.bytes_uploaded / 1024 / 1024).toFixed(2)
          }));

          success(res, {
            timeframe,
            interval,
            overallStats: formattedStats,
            categoryBreakdown: categoryStats.rows,
            dailyTrend: formattedDaily,
            detailedStats: detailedStats,
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
    ]
  ],

  delete: [
    // 🗑️ Delete File with Audit Trail
    [
      '/:fileId',
      fileIdValidation,
      [
        body('reason').optional().isLength({ max: 500 }).withMessage('Reason must be less than 500 characters'),
        body('permanentDelete').optional().isBoolean()
      ],
      async (req, res) => {
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
          const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

          // Get file info
          const fileResult = await pool.query(`
            SELECT 
              storage_key, file_name, uploaded_by, is_private, is_hipaa_protected,
              file_size, category, retention_date
            FROM file_metadata 
            WHERE id = $1
          `, [fileId]);

          if (fileResult.rows.length === 0) {
            return error(res, 'Hospital file not found', HTTP_STATUS.NOT_FOUND);
          }

          const file = fileResult.rows[0];

          // Permission checks
          const canDelete = 
            file.uploaded_by === userId || 
            userRole === 'ADMIN' ||
            (userRole === 'DOCTOR' && file.is_hipaa_protected);

          if (!canDelete) {
            return error(res, 'Permission denied. You can only delete your own files or have appropriate medical permissions.', HTTP_STATUS.FORBIDDEN);
          }

          // HIPAA files require admin approval for permanent deletion
          if (file.is_hipaa_protected && permanentDelete && userRole !== 'ADMIN') {
            return error(res, 'HIPAA protected files require admin approval for permanent deletion', HTTP_STATUS.FORBIDDEN);
          }

          // Check if file is within retention period and requires special handling
          const retentionDate = new Date(file.retention_date);
          const now = new Date();
          const isWithinRetention = retentionDate > now;

          if (file.is_hipaa_protected && isWithinRetention && !permanentDelete) {
            // Soft delete for HIPAA files within retention period
            await pool.query(`
              UPDATE file_metadata 
              SET is_deleted = true, deleted_at = NOW(), deleted_by = $1, deletion_reason = $2
              WHERE id = $3
            `, [userId, reason, fileId]);

            // Log soft deletion
            await logFileAccess(fileId, 'soft_delete', userId, ipAddress, 
              req.headers['user-agent'], `HIPAA file soft deleted: ${reason}`);

            logger.info(`🗃️ HIPAA file soft deleted: ${file.file_name} (ID: ${fileId}) by ${userId} (${userRole})`);

            success(res, {
              fileId,
              fileName: file.file_name,
              deletionType: 'soft_delete',
              reason,
              deletedBy: userId,
              retentionDate: retentionDate.toISOString().split('T')[0],
              note: 'HIPAA file soft deleted due to retention requirements. File will be permanently deleted after retention period.',
              requestedBy: userId
            }, 'HIPAA protected file soft deleted successfully');

          } else {
            // Permanent deletion
            if (permanentDelete || !isWithinRetention) {
              // Delete from R2 storage
              await deleteFileFromR2(file.storage_key);
            }

            // Remove from database
            await pool.query('DELETE FROM file_metadata WHERE id = $1', [fileId]);

            // Log permanent deletion
            await pool.query(`
              INSERT INTO file_deletion_log (
                file_id, file_name, storage_key, category, file_size,
                is_hipaa_protected, uploaded_by, deleted_by, deletion_reason,
                deletion_type, deleted_at, ip_address
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
            `, [
              fileId, file.file_name, file.storage_key, file.category, file.file_size,
              file.is_hipaa_protected, file.uploaded_by, userId, reason,
              permanentDelete ? 'permanent' : 'expired', ipAddress
            ]);

            logger.info(`🗑️ Hospital file permanently deleted: ${file.file_name} (ID: ${fileId}) by ${userId} (${userRole}) - Reason: ${reason}`);

            success(res, {
              fileId,
              fileName: file.file_name,
              deletionType: 'permanent',
              reason,
              deletedBy: userId,
              fileSizeMB: (file.file_size / 1024 / 1024).toFixed(2),
              wasHipaaProtected: file.is_hipaa_protected,
              requestedBy: userId
            }, 'Hospital file permanently deleted successfully');
          }

        } catch (err) {
          logger.error('Delete Hospital File Error:', err);
          error(res, 'Failed to delete hospital file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// ✅ Admin-Only Hospital File Management Routes
wrapRoutes(
  router,
  ['ADMIN'], // Admin only
  {
    get: [
      // 🦠 Quarantine Management
      [
        '/admin/quarantined',
        async (req, res) => {
          try {
            const quarantinedFiles = await pool.query(`
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

            const formattedFiles = quarantinedFiles.rows.map(file => ({
              ...file,
              uploadedAt: file.uploaded_at?.toISOString(),
              uploadedAtFormatted: file.uploaded_at?.toLocaleDateString('en-GB'),
              quarantinedAt: file.quarantined_at?.toISOString(),
              quarantinedAtFormatted: file.quarantined_at?.toLocaleDateString('en-GB'),
              fileSizeMB: (file.file_size / 1024 / 1024).toFixed(2)
            }));

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
      ],

      // 📊 Hospital File System Health Report
      [
        '/admin/health-report',
        async (req, res) => {
          try {
            // Overall system health
            const healthStats = await pool.query(`
              SELECT 
                COUNT(*) as total_files,
                SUM(file_size) as total_storage_bytes,
                COUNT(*) FILTER (WHERE scan_status = 'pending') as pending_scans,
                COUNT(*) FILTER (WHERE scan_status = 'failed') as failed_scans,
                COUNT(*) FILTER (WHERE is_quarantined = true) as quarantined_count,
                COUNT(*) FILTER (WHERE uploaded_at > NOW() - INTERVAL '24 hours') as uploads_24h,
                COUNT(*) FILTER (WHERE is_hipaa_protected = true) as hipaa_files,
                COUNT(*) FILTER (WHERE retention_date < CURRENT_DATE) as expired_files,
                COUNT(*) FILTER (WHERE is_deleted = true) as soft_deleted_files,
                AVG(file_size) as avg_file_size,
                AVG(processing_time_ms) as avg_processing_time,
                AVG(scan_duration_ms) as avg_scan_time
              FROM file_metadata
            `);

            // Storage breakdown by category
            const storageByCategory = await pool.query(`
              SELECT 
                category,
                COUNT(*) as file_count,
                SUM(file_size) as storage_bytes,
                AVG(file_size) as avg_size,
                COUNT(*) FILTER (WHERE is_hipaa_protected = true) as hipaa_count,
                COUNT(*) FILTER (WHERE scan_status = '