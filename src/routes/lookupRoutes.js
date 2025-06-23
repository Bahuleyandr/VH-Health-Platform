// src/routes/lookupRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ lookupRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Lookup routes working!' });
});

router.get('/countries', (req, res) => {
  res.json({ 
    message: 'Get countries - Static data',
    countries: ['India', 'USA', 'UK']
  });
});

export default router;