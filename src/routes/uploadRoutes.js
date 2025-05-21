import express from 'express';
import multer from 'multer';
import { FILE_UPLOAD_RULES } from '../config/fileUploadConfig.js';
import { uploadFileToR2, deleteObject as deleteFileFromR2 } from '../utils/r2Storage.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { scanBuffer } from '../utils/virusScanner.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

// ✅ Multer setup for in-memory file handling
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: FILE_UPLOAD_RULES.maxFileSizeBytes },
  fileFilter: (req, file, cb) => {
    if (!FILE_UPLOAD_RULES.allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error(FILE_UPLOAD_RULES.description));
    }
    cb(null, true);
  }
});

// ✅ Upload Routes with centralized RBAC + audit
wrapAutoRBAC(router, 'uploadRoutes', {
  post: [
    ['/', upload.single('file'), async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      const uploadedBy = req.body.uploaded_by || req.user?.uid || 'system';

      try {
        try {
          await scanBuffer(req.file.buffer);
        } catch (scanErr) {
          logger.warn(`⚠️ Virus scan skipped or failed: ${scanErr.message}`);
          // Optionally block uploads in production:
          // return res.status(503).json({ error: 'Virus scanner unavailable. Try again later.' });
        }

        const key = `uploads/${Date.now()}_${req.file.originalname}`;
        const url = await uploadFileToR2(req.file.buffer, key, req.file.mimetype);

        await pool.query(
  'INSERT INTO file_metadata (file_name, file_type, file_size, storage_key, storage_url, uploaded_at, uploaded_by) VALUES ($1, $2, $3, $4, $5, NOW(), $6)',
  [req.file.originalname, req.file.mimetype, req.file.size, key, url, uploadedBy]
);

        logger.info(`✅ Uploaded: ${req.file.originalname} | UID: ${req.user?.uid} | Role: ${req.user?.role}`);
        success(res, { url }, 'File uploaded successfully');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, 'Upload failed.');
      }
    }]
  ],
  get: [
    ['/', async (req, res) => {
      try {
        const result = await pool.query('SELECT * FROM file_metadata ORDER BY uploaded_at DESC');
        success(res, result.rows, 'Files fetched successfully');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, 'Failed to fetch files.');
      }
    }],
    ['/:key', async (req, res) => {
      try {
        const result = await pool.query('SELECT * FROM file_metadata WHERE storage_key = $1', [req.params.key]);
        if (result.rows.length === 0) {
          return error(res, 'File not found', 404);
        }
        success(res, result.rows[0], 'File metadata found');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, 'Failed to fetch file metadata.');
      }
    }]
  ],
  delete: [
    ['/:key', async (req, res) => {
      const { key } = req.params;
      try {
        await deleteFileFromR2(key);
        await pool.query('DELETE FROM file_metadata WHERE storage_key = $1', [key]);

        logger.info(`🗑️ Deleted: ${key} | UID: ${req.user?.uid} | Role: ${req.user?.role}`);
        success(res, null, 'File deleted successfully');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, 'Failed to delete file.');
      }
    }]
  ]
});

export default router;
