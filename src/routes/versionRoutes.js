// src/routes/versionRoutes.js
const express = require('express');
const router = express.Router();

router.get('/app-version', (req, res) => {
  res.json({
    version: '1.0.0',
    updated_at: '2025-05-12'
  });
});

module.exports = router;
