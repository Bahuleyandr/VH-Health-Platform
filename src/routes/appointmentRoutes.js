// src/routes/appointmentRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ appointmentRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'Appointment routes working!' });
});

// Simple routes with minimal logic (no DB calls)
router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get appointments list - DB disabled for debugging',
    appointments: []
  });
});

router.post('/create', (req, res) => {
  res.json({ 
    message: 'Create appointment - DB disabled for debugging',
    data: req.body 
  });
});

router.get('/:id', (req, res) => {
  res.json({ 
    message: 'Get appointment by ID - DB disabled for debugging',
    id: req.params.id
  });
});

router.put('/:id', (req, res) => {
  res.json({ 
    message: 'Update appointment - DB disabled for debugging',
    id: req.params.id,
    data: req.body
  });
});

router.delete('/:id', (req, res) => {
  res.json({ 
    message: 'Delete appointment - DB disabled for debugging',
    id: req.params.id
  });
});

export default router;