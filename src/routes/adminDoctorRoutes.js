// src/routes/adminDoctorRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ adminDoctorRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Admin doctor routes working!' });
});

router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get admin doctors - DB disabled for debugging',
    doctors: []
  });
});

router.post('/approve/:id', (req, res) => {
  res.json({ 
    message: 'Approve doctor - DB disabled for debugging',
    doctorId: req.params.id
  });
});

export default router;