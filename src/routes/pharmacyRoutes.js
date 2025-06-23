// src/routes/pharmacyRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ pharmacyRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Pharmacy routes working!' });
});

router.get('/medications', (req, res) => {
  res.json({ 
    message: 'Get medications list - DB disabled for debugging',
    medications: []
  });
});

router.get('/prescriptions', (req, res) => {
  res.json({ 
    message: 'Get prescriptions - DB disabled for debugging',
    prescriptions: []
  });
});

router.post('/dispense', (req, res) => {
  res.json({ 
    message: 'Dispense medication - DB disabled for debugging',
    data: req.body 
  });
});

export default router;