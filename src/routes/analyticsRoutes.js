// src/routes/analyticsRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ analyticsRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Analytics routes working!' });
});

router.get('/dashboard', (req, res) => {
  res.json({ 
    message: 'Analytics dashboard - DB disabled for debugging',
    data: {}
  });
});

export default router;