// src/routes/storage/storageRoutes.js
//
// Streams files from the local-disk fallback backend (when R2 is not
// configured). Mounted in app.js BEFORE jwtAuth so the patient client
// can fetch via a plain HTTP GET — semantics match Cloudflare R2 signed
// URLs. Authentication is via the HMAC token issued by `getSignedFileUrl`.
//
// Production with R2 doesn't hit these routes — `getSignedFileUrl`
// returns a `*.r2.cloudflarestorage.com` URL that the client downloads
// directly from Cloudflare. This file is purely the dev/CI fallback.

import express from 'express';
import fs from 'fs';
import path from 'path';
import logger from '../../logging/logger.js';
import { isLocalStorage, resolveLocalKey, verifyLocalToken } from '../../utils/r2Storage.js';

const router = express.Router();

// Patient + staff apps upload PDFs and images. Anything else falls back
// to octet-stream and the client's downloader handles the bytes raw.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json'
};

// GET /api/v1/storage/file/*splat?token=<sig>.<expiryMs>
router.get('/file/*splat', (req, res) => {
  if (!isLocalStorage) {
    return res.status(404).json({ success: false, message: 'Local storage backend disabled (R2 in use)' });
  }

  // Reconstruct the storage key. Express 5 / path-to-regexp v8 may give us
  // either an array (one entry per path segment) or a joined string.
  const splat = req.params.splat;
  let key = Array.isArray(splat) ? splat.join('/') : (splat || '');
  try {
    key = decodeURIComponent(key);
  } catch {
    return res.status(400).json({ success: false, message: 'Invalid key encoding' });
  }
  if (!key) {
    return res.status(400).json({ success: false, message: 'key is required' });
  }

  if (!verifyLocalToken(key, req.query.token)) {
    return res.status(403).json({ success: false, message: 'Invalid or expired token' });
  }

  let fullPath;
  try {
    fullPath = resolveLocalKey(key);
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }

  const ext = path.extname(fullPath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(fullPath)
    .on('error', err => {
      logger.error(`storage stream error for key=${key}: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
    })
    .pipe(res);
});

export default router;
