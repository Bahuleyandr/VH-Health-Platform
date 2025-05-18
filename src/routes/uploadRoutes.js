// src/routes/uploadRoutes.js
const express = require('express');
const multer = require('multer');
const { uploadFileToR2, deleteFileFromR2 } = require('../utils/r2Storage');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');
const { scanBuffer } = require('../utils/virusScanner');

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Only PDF, JPEG, and PNG are allowed.'));
    }
    cb(null, true);
  },
});

// ✅ Upload File
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const uploadedBy = req.body.uploaded_by || 'system'; // Optional field

  try {
    // Virus Scan
    await scanBuffer(req.file.buffer);

    // Proceed to Upload if clean
    const key = `uploads/${Date.now()}_${req.file.originalname}`;
    const url = await uploadFileToR2(req.file.buffer, key, req.file.mimetype);

    await pool.query(
      'INSERT INTO file_metadata (file_name, file_type, storage_key, storage_url, uploaded_at, uploaded_by) VALUES ($1, $2, $3, $4, NOW(), $5)',
      [req.file.originalname, req.file.mimetype, key, url, uploadedBy]
    );

    logger.info(`File uploaded: ${req.file.originalname} (${req.file.mimetype}) by ${uploadedBy}`);
    success(res, { url }, 'File uploaded successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Upload failed.');
  }
});

// ✅ List All Files with Metadata
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM file_metadata ORDER BY uploaded_at DESC');
    success(res, result.rows, 'Files fetched successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Failed to fetch files.');
  }
});

// ✅ Delete File by Storage Key
router.delete('/:key', async (req, res) => {
  const { key } = req.params;
  try {
    await deleteFileFromR2(key);
    await pool.query('DELETE FROM file_metadata WHERE storage_key = $1', [key]);
    logger.info(`File deleted: ${key}`);
    success(res, null, 'File deleted successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Failed to delete file.');
  }
});

module.exports = router;
