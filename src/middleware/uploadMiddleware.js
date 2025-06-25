// src/middleware/uploadMiddleware.js - Hospital File Upload Middleware

import multer from 'multer';
import { HOSPITAL_UPLOAD_CONFIG, MULTER_CONFIG } from '../config/uploadConfig.js';

// Enhanced multer setup with security
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (!HOSPITAL_UPLOAD_CONFIG.allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error(`File type ${file.mimetype} not allowed in hospital system. Allowed types: ${HOSPITAL_UPLOAD_CONFIG.allowedMimeTypes.join(', ')}`));
  }
  
  // Check file name for malicious patterns
  const dangerousPatterns = /[<>:"/\\|?*\x00-\x1f]/;
  if (dangerousPatterns.test(file.originalname)) {
    return cb(new Error('File name contains invalid characters'));
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

// Batch upload middleware
export const batchUpload = upload.array('files', 10);

// Single upload middleware
export const singleUpload = upload.single('file');