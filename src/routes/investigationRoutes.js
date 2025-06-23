// src/routes/investigationRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ investigationRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Investigation routes working!' });
});

router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get investigations list - DB disabled for debugging',
    investigations: []
  });
});

router.post('/create', (req, res) => {
  res.json({ 
    message: 'Create investigation - DB disabled for debugging',
    data: req.body 
  });
});

router.get('/:id/results', (req, res) => {
  res.json({ 
    message: 'Get investigation results - DB disabled for debugging',
    id: req.params.id,
    results: []
  });
});

export default router;