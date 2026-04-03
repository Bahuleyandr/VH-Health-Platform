// src/routes/uploadRoutes.js - Modularized Hospital File Upload Routes

import express from 'express';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

// Import controllers
import * as adminController from '../controllers/adminUploadController.js';
import * as uploadController from '../controllers/uploadController.js';

// Import middleware
import {
  singleUpload,
  batchUpload,
  extractRequestMetadata,
  checkHipaaPermissions,
  validateFileSize,
  validateFileContent
} from '../middleware/uploadMiddleware.js';

// Import validators
import {
  uploadValidation,
  fileIdValidation,
  listFilesValidation,
  downloadUrlValidation,
  statsValidation,
  deleteFileValidation,
  hipaaProtectionValidation,
  cleanupValidation,
  purgeValidation
} from '../validators/uploadValidators.js';

const router = express.Router();

// Apply request metadata extraction to all routes
router.use(extractRequestMetadata);

// ✅ RBAC Protected Routes
wrapAutoRBAC(router, 'uploadRoutes', {
  post: [
    // 📤 Single File Upload with HIPAA Compliance
    [
      '/',
      singleUpload,
      validateFileContent,
      checkHipaaPermissions,
      validateFileSize,
      uploadValidation,
      uploadController.uploadSingleFile
    ],

    // 📤 Batch Upload for Medical Records
    [
      '/batch',
      batchUpload,
      validateFileContent,
      checkHipaaPermissions,
      validateFileSize,
      uploadValidation,
      uploadController.uploadBatchFiles
    ]
  ],

  get: [
    // 📋 List Files with Advanced Filtering
    [
      '/',
      listFilesValidation,
      uploadController.listFiles
    ],

    // 📄 Get Detailed File Metadata
    [
      '/:fileId/metadata',
      fileIdValidation,
      uploadController.getFileMetadata
    ],

    // 🔗 Generate Secure Download URL
    [
      '/:fileId/download-url',
      downloadUrlValidation,
      uploadController.generateDownloadUrl
    ],

    // 📊 Hospital File Statistics
    [
      '/stats',
      statsValidation,
      adminController.getFileStats
    ]
  ],

  delete: [
    // 🗑️ Delete File with Audit Trail
    [
      '/:fileId',
      deleteFileValidation,
      uploadController.deleteFile
    ]
  ]
},
{
  requireUID: true,
  requirePhone: false
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
        adminController.getQuarantinedFiles
      ],

      // 📋 HIPAA Audit Report
      [
        '/admin/hipaa-audit',
        [
          (req, res, next) => {
            req.query.days = req.query.days || 30;
            next();
          }
        ],
        adminController.getHipaaAuditReport
      ]
    ],

    post: [
      // 🔄 Rescan File for Security
      [
        '/admin/rescan/:fileId',
        fileIdValidation,
        adminController.rescanFile
      ],

      // 🧹 Cleanup Expired Files
      [
        '/admin/cleanup-expired',
        cleanupValidation,
        adminController.cleanupExpiredFiles
      ],

      // 🔒 Bulk HIPAA Protection Update
      [
        '/admin/hipaa-protection',
        hipaaProtectionValidation,
        adminController.updateHipaaProtection
      ]
    ],

    delete: [
      // 🗑️ Purge Quarantined Files
      [
        '/admin/purge-quarantined',
        purgeValidation,
        adminController.purgeQuarantinedFiles
      ]
    ]
  }
);

// 🔗 Convenience: Get download info by storage key (for patient app)
// Requires authentication. Staff can access any file; patients only their own uploads.
router.get('/by-key/:storageKey', async (req, res) => {
  try {
    const { storageKey } = req.params;
    const userRole = (req.user?.role || '').toUpperCase();
    const userUid = req.user?.uid;

    if (!userUid) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, storage_key, file_name, is_quarantined, scan_status, uploaded_by
       FROM file_metadata WHERE storage_key = $1`,
      [storageKey]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    const file = result[0];

    // IDOR check: patients can only download their own files
    if (userRole === 'PATIENT' && file.uploaded_by && String(file.uploaded_by) !== String(userUid)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (file.is_quarantined || file.scan_status === 'INFECTED') {
      return res.json({ success: true, data: { quarantined: true, storage_url: null } });
    }

    // Generate presigned URL from R2
    const { getSignedUrl } = await import('../utils/r2Storage.js');
    const url = await getSignedUrl(file.storage_key);

    return res.json({
      success: true,
      data: { quarantined: false, storage_url: url, file_name: file.file_name }
    });
  } catch (err) {
    logger.error('Download by key error:', err);
    return res.status(500).json({ success: false, message: 'Download failed' });
  }
});

export default router;
