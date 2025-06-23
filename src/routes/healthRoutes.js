// src/routes/healthRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ healthRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Health routes working!' });
});

router.get('/vitals', (req, res) => {
  res.json({ 
    message: 'Get health vitals - DB disabled for debugging',
    vitals: []
  });
});

router.post('/vitals', (req, res) => {
  res.json({ 
    message: 'Record health vitals - DB disabled for debugging',
    data: req.body 
  });
});

router.get('/metrics', (req, res) => {
  res.json({ 
    message: 'Get health metrics - DB disabled for debugging',
    metrics: {}
  });
});

export default router;