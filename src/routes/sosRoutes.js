// src/routes/sosRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ sosRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'SOS routes working!' });
});

router.post('/emergency', (req, res) => {
  res.json({ 
    message: 'Emergency alert - Notification service disabled for debugging',
    location: req.body.location,
    alert_id: 'SOS-123456'
  });
});

router.get('/alerts', (req, res) => {
  res.json({ 
    message: 'Get SOS alerts - DB disabled for debugging',
    alerts: []
  });
});

router.put('/:alertId/respond', (req, res) => {
  res.json({ 
    message: 'Respond to SOS alert - DB disabled for debugging',
    alertId: req.params.alertId
  });
});

export default router;