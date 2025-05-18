// src/routes/versionRoutes.js

const express = require('express');
const router = express.Router();

/**
 * @route GET /api/v1/version
 * @desc  Get app version
 */
router.get('/', (req, res) => {
  res.json({ version: '1.0.0', updated_at: '2025-05-12' });
});

module.exports = router;
