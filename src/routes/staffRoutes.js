// src/routes/staffRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ staffRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Staff routes working!' });
});

router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get staff list - DB disabled for debugging',
    staff: []
  });
});

router.post('/create', (req, res) => {
  res.json({ 
    message: 'Create staff member - DB disabled for debugging',
    data: req.body 
  });
});

router.get('/:id', (req, res) => {
  res.json({ 
    message: 'Get staff by ID - DB disabled for debugging',
    id: req.params.id
  });
});

export default router;