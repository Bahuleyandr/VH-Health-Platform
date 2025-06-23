// src/routes/departmentRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ departmentRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'Department routes working!' });
});

// Simple routes with minimal logic (no DB calls)
router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get departments list - DB disabled for debugging',
    departments: [
      { id: 1, name: 'Cardiology' },
      { id: 2, name: 'Neurology' },
      { id: 3, name: 'Orthopedics' },
      { id: 4, name: 'Emergency' }
    ]
  });
});

router.get('/:id', (req, res) => {
  res.json({ 
    message: 'Get department by ID - DB disabled for debugging',
    id: req.params.id,
    department: {
      id: req.params.id,
      name: 'Sample Department',
      description: 'Department description'
    }
  });
});

router.post('/create', (req, res) => {
  res.json({ 
    message: 'Create department - DB disabled for debugging',
    data: req.body 
  });
});

router.put('/:id', (req, res) => {
  res.json({ 
    message: 'Update department - DB disabled for debugging',
    id: req.params.id,
    data: req.body
  });
});

router.delete('/:id', (req, res) => {
  res.json({ 
    message: 'Delete department - DB disabled for debugging',
    id: req.params.id
  });
});

router.get('/:id/doctors', (req, res) => {
  res.json({ 
    message: 'Get doctors by department - DB disabled for debugging',
    departmentId: req.params.id,
    doctors: []
  });
});

export default router;