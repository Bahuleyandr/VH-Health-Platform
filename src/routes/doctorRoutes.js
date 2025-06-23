// src/routes/doctorRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ doctorRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'Doctor routes working!' });
});

// Simple routes with minimal logic (no DB calls)
router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get doctors list - DB disabled for debugging',
    doctors: []
  });
});

router.get('/specializations', (req, res) => {
  res.json({ 
    message: 'Get specializations - DB disabled for debugging',
    specializations: ['Cardiology', 'Neurology', 'Orthopedics']
  });
});

router.get('/:id', (req, res) => {
  res.json({ 
    message: 'Get doctor by ID - DB disabled for debugging',
    id: req.params.id
  });
});

router.post('/create', (req, res) => {
  res.json({ 
    message: 'Create doctor - DB disabled for debugging',
    data: req.body 
  });
});

router.put('/:id', (req, res) => {
  res.json({ 
    message: 'Update doctor - DB disabled for debugging',
    id: req.params.id,
    data: req.body
  });
});

router.delete('/:id', (req, res) => {
  res.json({ 
    message: 'Delete doctor - DB disabled for debugging',
    id: req.params.id
  });
});

export default router;