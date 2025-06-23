// src/routes/versionRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ versionRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Version routes working!' });
});

router.get('/info', (req, res) => {
  res.json({ 
    message: 'Version info',
    version: '1.0.0',
    build: 'local-debug'
  });
});

export default router;