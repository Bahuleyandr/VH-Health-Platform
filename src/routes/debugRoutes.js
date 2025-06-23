// src/routes/debugRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ debugRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Debug routes working!' });
});

router.get('/info', (req, res) => {
  res.json({ 
    message: 'Debug info',
    environment: 'local',
    timestamp: new Date().toISOString()
  });
});

export default router;