// src/routes/deviceRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ deviceRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Device routes working!' });
});

router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get devices - DB disabled for debugging',
    devices: []
  });
});

export default router;