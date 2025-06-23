// src/routes/otpRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ otpRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'OTP routes working!' });
});

router.post('/generate', (req, res) => {
  res.json({ 
    message: 'Generate OTP - SMS service disabled for debugging',
    phone: req.body.phone,
    otp: '123456'
  });
});

router.post('/verify', (req, res) => {
  res.json({ 
    message: 'Verify OTP - DB disabled for debugging',
    phone: req.body.phone,
    verified: true
  });
});

router.post('/resend', (req, res) => {
  res.json({ 
    message: 'Resend OTP - SMS service disabled for debugging',
    phone: req.body.phone
  });
});

export default router;