// src/routes/swaggerRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ swaggerRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Swagger routes working!' });
});

router.get('/docs', (req, res) => {
  res.json({ 
    message: 'API documentation - Swagger disabled for debugging'
  });
});

export default router;