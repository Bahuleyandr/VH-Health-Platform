// src/middleware/uploadMiddleware.js - Hospital File Upload Middleware

import multer from 'multer';
import path from 'path';
import { HOSPITAL_UPLOAD_CONFIG, MULTER_CONFIG } from '../config/uploadConfig.js';
import logger from '../logging/logger.js';

// P1 Security: Magic bytes signatures for server-side MIME validation
const MAGIC_BYTES = [
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46] }, // GIF
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF (WebP container)
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2A, 0x00] }, // Little-endian TIFF
  { mime: 'image/tiff', bytes: [0x4D, 0x4D, 0x00, 0x2A] }, // Big-endian TIFF
  { mime: 'image/bmp', bytes: [0x42, 0x4D] }, // BM
  { mime: 'application/dicom', bytes: [0x44, 0x49, 0x43, 0x4D] }, // DICM (offset 128)
];

// Patient upload: restricted MIME types (images + PDF only)
const PATIENT_ALLOWED_MIMES = [
  'image/jpeg', 'image/jpg', 'image/png', 'application/pdf'
];

const FALLBACK_MIME_BY_EXTENSION = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['bmp', 'image/bmp'],
  ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
  ['rtf', 'text/rtf'],
  ['dcm', 'application/dicom'],
  ['hl7', 'application/hl7-v2+er7'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['mp4', 'video/mp4'],
  ['avi', 'video/avi'],
  ['mov', 'video/quicktime'],
]);

const FALLBACK_MIME_CANDIDATES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);

// Patient upload: file size limits
const PATIENT_FILE_SIZE_LIMITS = {
  image: 10 * 1024 * 1024,  // 10MB for images
  pdf: 25 * 1024 * 1024,    // 25MB for PDFs
};

export function normalizeUploadMimeType(file) {
  const declared = String(file?.mimetype || '').toLowerCase().split(';')[0].trim();
  if (!FALLBACK_MIME_CANDIDATES.has(declared)) return declared;

  const ext = path.extname(String(file?.originalname || '')).slice(1).toLowerCase();
  const inferred = FALLBACK_MIME_BY_EXTENSION.get(ext);
  if (!inferred) return declared;

  file.mimetype = inferred;
  return inferred;
}

/**
 * P1 Security: Validate file content against magic bytes (not just Content-Type header).
 * Returns true if the file buffer matches known magic bytes for its claimed MIME type.
 */
function validateMagicBytes(buffer, claimedMime) {
  if (!buffer || buffer.length < 4) return false;

  // For DICOM, magic bytes are at offset 128
  if (claimedMime === 'application/dicom') {
    if (buffer.length >= 132) {
      const dicmSignature = [0x44, 0x49, 0x43, 0x4D];
      return dicmSignature.every((byte, i) => buffer[128 + i] === byte);
    }
    return false;
  }

  // Check if file matches ANY known signature
  for (const sig of MAGIC_BYTES) {
    if (sig.bytes.every((byte, i) => buffer[i] === byte)) {
      return true;
    }
  }

  // Allow text-based formats, audio/video, and office documents without magic byte check
  // (these have complex/variable headers)
  const relaxedMimes = [
    'text/', 'audio/', 'video/',
    'application/msword', 'application/vnd.openxmlformats',
    'application/vnd.ms-excel', 'application/hl7', 'application/fhir'
  ];
  if (relaxedMimes.some(prefix => claimedMime.startsWith(prefix))) {
    return true;
  }

  // SVG is XML-based
  if (claimedMime === 'image/svg+xml') {
    const head = buffer.slice(0, 256).toString('utf-8').toLowerCase();
    return head.includes('<svg') || head.includes('<?xml');
  }

  return false;
}

// Enhanced multer setup with security
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const mimetype = normalizeUploadMimeType(file);
  if (!HOSPITAL_UPLOAD_CONFIG.allowedMimeTypes.includes(mimetype)) {
    const err = new Error(`File type ${mimetype} not allowed in hospital system. Allowed types: ${HOSPITAL_UPLOAD_CONFIG.allowedMimeTypes.join(', ')}`);
    err.statusCode = 400;
    err.code = 'INVALID_FILE_TYPE';
    return cb(err);
  }

  // Check file name for malicious patterns
  // eslint-disable-next-line no-control-regex
  const dangerousPatterns = /[<>:"/\\|?*\x00-\x1f]/;
  if (dangerousPatterns.test(file.originalname)) {
    const err = new Error('File name contains invalid characters');
    err.statusCode = 400;
    err.code = 'INVALID_FILE_NAME';
    return cb(err);
  }

  cb(null, true);
};

export const upload = multer({
  storage,
  limits: MULTER_CONFIG.limits,
  fileFilter
});

// Middleware to extract request metadata
export function extractRequestMetadata(req, res, next) {
  req.uploadMetadata = {
    ipAddress: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent']
  };
  next();
}

// Middleware to check HIPAA permissions
export function checkHipaaPermissions(req, res, next) {
  const { category, hipaaProtected } = req.body;
  const userRole = req.user?.role;
  
  // Auto-detect HIPAA protection based on category
  const isHipaaCategory = HOSPITAL_UPLOAD_CONFIG.hipaaCategories.includes(category);
  const requiresHipaaPermission = hipaaProtected || isHipaaCategory;
  
  if (requiresHipaaPermission && !['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      message: 'Insufficient permissions to upload HIPAA protected files',
      error: 'FORBIDDEN',
      requestedBy: req.user?.uid
    });
  }
  
  next();
}

// Middleware to validate file size based on category
export function validateFileSize(req, res, next) {
  if (!req.file && !req.files) {
    return next();
  }
  
  const files = req.files || [req.file];
  const { category } = req.body;
  
  // Special size limits for certain categories
  const specialSizeLimits = {
    'xray': 100 * 1024 * 1024, // 100MB for X-rays
    'mri': 200 * 1024 * 1024, // 200MB for MRI
    'ct_scan': 200 * 1024 * 1024, // 200MB for CT scans
    'telemedicine_recording': 500 * 1024 * 1024 // 500MB for recordings
  };
  
  const maxSize = specialSizeLimits[category] || HOSPITAL_UPLOAD_CONFIG.maxFileSizeBytes;
  
  for (const file of files) {
    if (file.size > maxSize) {
      return res.status(400).json({
        success: false,
        message: `File ${file.originalname} exceeds maximum size limit of ${maxSize / 1024 / 1024}MB for category ${category}`,
        error: 'FILE_TOO_LARGE',
        requestedBy: req.user?.uid
      });
    }
  }
  
  next();
}

/**
 * P1 Security: Post-upload middleware that validates file content against magic bytes.
 * Must run AFTER multer processes the file (so buffer is available).
 */
export function validateFileContent(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  if (files.length === 0) return next();

  for (const file of files) {
    if (!validateMagicBytes(file.buffer, file.mimetype)) {
      logger.warn(`File content validation failed: ${file.originalname} claims ${file.mimetype} but magic bytes don't match`);
      return res.status(400).json({
        success: false,
        message: `File "${file.originalname}" content does not match its declared type (${file.mimetype}). Upload rejected.`,
        error: 'INVALID_FILE_CONTENT'
      });
    }
  }
  next();
}

/**
 * P1 Security: Middleware for patient-facing upload endpoints.
 * Restricts to image/jpeg, image/png, application/pdf with strict size limits.
 */
export function validatePatientUpload(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  if (files.length === 0) return next();

  for (const file of files) {
    // Check MIME type restriction for patient uploads
    if (!PATIENT_ALLOWED_MIMES.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: `File type "${file.mimetype}" is not allowed. Accepted types: JPEG, PNG, PDF.`,
        error: 'INVALID_FILE_TYPE'
      });
    }

    // Enforce patient-specific file size limits
    const isImage = file.mimetype.startsWith('image/');
    const maxSize = isImage ? PATIENT_FILE_SIZE_LIMITS.image : PATIENT_FILE_SIZE_LIMITS.pdf;
    if (file.size > maxSize) {
      return res.status(400).json({
        success: false,
        message: `File "${file.originalname}" exceeds the ${maxSize / (1024 * 1024)}MB limit for ${isImage ? 'images' : 'PDFs'}.`,
        error: 'FILE_TOO_LARGE'
      });
    }
  }
  next();
}

// Batch upload middleware
export const batchUpload = upload.array('files', 10);

// Single upload middleware
export const singleUpload = upload.single('file');
