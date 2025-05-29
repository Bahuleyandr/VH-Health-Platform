import express from 'express';
import multer from 'multer';
import { FILE_UPLOAD_RULES } from '../config/fileUploadConfig.js';
import { uploadFileToR2, deleteObject as deleteFileFromR2 } from '../utils/r2Storage.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { scanFileWithClamAV } from '../utils/clamavScanHelper.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import sharp from 'sharp';           // for JPG/JPEG compression
import { exec } from 'child_process'; // for PDF compression
import fs from 'fs/promises';        // for reading/writing temp files
import path from 'path';             // optional, for file paths

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
    [
      '/',
      upload.single('file'),
      async (req, res) => {
        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded.' });
        }

        const uploadedBy = req.body.uploaded_by || req.user?.uid || 'system';

        try {
          let processedBuffer = req.file.buffer;

if (req.file.mimetype === 'image/jpeg' || req.file.mimetype === 'image/jpg') {
  // Compress JPG to ~70% quality
  processedBuffer = await sharp(req.file.buffer)
    .resize({ width: 1024 }) // optional resize
    .jpeg({ quality: 70 })
    .toBuffer();
}

if (req.file.mimetype === 'application/pdf') {
  const tempIn = `/tmp/${Date.now()}_in.pdf`;
  const tempOut = `/tmp/${Date.now()}_out.pdf`;

  await fs.writeFile(tempIn, req.file.buffer);

  await new Promise((resolve, reject) => {
   exec(
  `gswin64c -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${tempOut} ${tempIn}`,
      err => (err ? reject(err) : resolve())
    );
  });

  processedBuffer = await fs.readFile(tempOut);
  await fs.unlink(tempIn);
  await fs.unlink(tempOut);
}

const key = `uploads/${Date.now()}_${req.file.originalname}`;
const url = await uploadFileToR2(processedBuffer, key, req.file.mimetype);

          // 🔄 Insert metadata and return ID
          const insertResult = await pool.query(
            `INSERT INTO file_metadata 
           (file_name, file_type, file_size, storage_key, storage_url, uploaded_at, uploaded_by, scan_status, scan_result) 
           VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
           RETURNING id`,
            [
              req.file.originalname,
              req.file.mimetype,
              processedBuffer.length,
              key,
              url,
              uploadedBy,
              'pending',
              null
            ]
          );

          const fileId = insertResult.rows[0].id;

          // 🔍 Immediately scan the file
          const scanResult = await scanFileWithClamAV(url);

          let status = 'failed';
          let resultText = 'Unknown error';

          if (scanResult.status === 'clean') {
            status = 'clean';
            resultText = null;
          } else if (scanResult.status === 'infected') {
            status = 'infected';
            resultText = scanResult.virus;
          } else if (scanResult.status === 'error') {
            status = 'failed';
            resultText = scanResult.error;
          }

          // 🔄 Update scan result
          await pool.query(
            `UPDATE file_metadata SET scan_status = $1, scan_result = $2 WHERE id = $3`,
            [status, resultText, fileId]
          );

          // 📝 Audit log
          await pool.query(
            `INSERT INTO audit_logs (event_type, description, created_at, related_id, created_by)
           VALUES ($1, $2, NOW(), $3, $4)`,
            [
              'FILE_SCAN',
              `Scan result: ${status}${resultText ? ` (${resultText})` : ''}`,
              fileId,
              uploadedBy
            ]
          );

          logger.info(
            `✅ Uploaded: ${req.file.originalname} | UID: ${req.user?.uid} | Role: ${req.user?.role}`
          );
          success(res, { url }, 'File uploaded and scanned successfully');
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, 'Upload failed.');
        }
      }
    ]
  ],
  get: [
    [
      '/',
      async (req, res) => {
        const safeOnly = req.query.safeOnly === 'true';

        try {
          const query = safeOnly
            ? `SELECT * FROM file_metadata WHERE scan_status = 'clean' ORDER BY uploaded_at DESC`
            : `SELECT * FROM file_metadata ORDER BY uploaded_at DESC`;

          const result = await pool.query(query);

          // ✅ Add `quarantined` flag to each result
          const files = result.rows.map(file => ({
            ...file,
            quarantined: ['infected', 'failed'].includes(file.scan_status)
          }));

          success(res, files, `Files fetched${safeOnly ? ' (clean only)' : ''} successfully`);
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, 'Failed to fetch files.');
        }
      }
    ],
    [
      '/:key',
      async (req, res) => {
        try {
          const result = await pool.query('SELECT * FROM file_metadata WHERE storage_key = $1', [
            req.params.key
          ]);

          if (result.rows.length === 0) {
            return error(res, 'File not found', 404);
          }

          const file = result.rows[0];

          // ✅ Add `quarantined` flag based on scan status
          const quarantined = ['infected', 'failed'].includes(file.scan_status);
          const response = {
            ...file,
            quarantined
          };

          success(res, response, 'File metadata found');
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, 'Failed to fetch file metadata.');
        }
      }
    ]
  ],
  delete: [
    [
      '/:key',
      async (req, res) => {
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
      }
    ]
  ]
});

export default router;
