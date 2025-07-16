// src/routes/uploadRoutes.js - Modularized Hospital File Upload Routes

import express from 'express';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';

// Import controllers
import * as adminController from '../controllers/adminUploadController.js';
import * as uploadController from '../controllers/uploadController.js';

// Import middleware
import { 
  singleUpload, 
  batchUpload, 
  extractRequestMetadata, 
  checkHipaaPermissions,
  validateFileSize 
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
      checkHipaaPermissions,
      validateFileSize,
      uploadValidation,
      uploadController.uploadSingleFile
    ],

    // 📤 Batch Upload for Medical Records
    [
      '/batch',
      batchUpload,
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

export default router;