// src/routes/recordRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ recordRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'Record routes working!' });
});

// Simple routes with minimal logic (no DB calls)
router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get medical records list - DB disabled for debugging',
    records: []
  });
});

router.get('/patient/:patientId', (req, res) => {
  res.json({ 
    message: 'Get records by patient ID - DB disabled for debugging',
    patientId: req.params.patientId,
    records: []
  });
});

router.get('/:id', (req, res) => {
  res.json({ 
    message: 'Get record by ID - DB disabled for debugging',
    id: req.params.id
  });
});

router.post('/create', (req, res) => {
  res.json({ 
    message: 'Create medical record - DB disabled for debugging',
    data: req.body 
  });
});

router.put('/:id', (req, res) => {
  res.json({ 
    message: 'Update medical record - DB disabled for debugging',
    id: req.params.id,
    data: req.body
  });
});

router.delete('/:id', (req, res) => {
  res.json({ 
    message: 'Delete medical record - DB disabled for debugging',
    id: req.params.id
  });
});

router.get('/search/:query', (req, res) => {
  res.json({ 
    message: 'Search medical records - DB disabled for debugging',
    query: req.params.query,
    results: []
  });
});

export default router;