// src/routes/upload/uploadRoutes.js
//
// Mounted at /api/v1/upload by app.js. Patient app consumes both:
//   GET  /upload/by-key/<storageKey>  — your_health_screen download flow
//   POST /upload                       — investigations_screen slip upload

import express from 'express';
import { getFileByKey, uploadFile, uploadMulter } from '../../controllers/upload/uploadController.js';
import { validateFileContent } from '../../middleware/uploadMiddleware.js';

const router = express.Router();

// Named wildcard (Express 5 / path-to-regexp v8): captures storage keys containing '/'
// (e.g. uploads/<uid>/123_x.pdf). Available in handler as req.params.splat
// (string in v8 of path-to-regexp, vs. an array in older Express).
router.get('/by-key/*splat', getFileByKey);

router.post('/', uploadMulter.single('file'), validateFileContent, uploadFile);

export default router;
