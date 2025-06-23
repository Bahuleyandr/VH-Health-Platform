// src/routes/adminNotificationRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ adminNotificationRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Admin notification routes working!' });
});

router.post('/broadcast', (req, res) => {
  res.json({ 
    message: 'Broadcast notification - Notification service disabled for debugging',
    data: req.body 
  });
});

export default router;