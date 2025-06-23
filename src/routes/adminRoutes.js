// src/routes/adminRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ adminRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'Admin routes working!' });
});

// Simple routes with minimal logic (no R2/cloud storage dependencies)
router.get('/dashboard', (req, res) => {
  res.json({ 
    message: 'Admin dashboard data - Cloud storage disabled for debugging',
    stats: {
      totalUsers: 0,
      totalDoctors: 0,
      totalAppointments: 0
    }
  });
});

router.get('/users', (req, res) => {
  res.json({ 
    message: 'Get all users - DB disabled for debugging',
    users: []
  });
});

router.get('/doctors', (req, res) => {
  res.json({ 
    message: 'Get all doctors - DB disabled for debugging',
    doctors: []
  });
});

router.post('/user/:id/approve', (req, res) => {
  res.json({ 
    message: 'Approve user - DB disabled for debugging',
    userId: req.params.id
  });
});

router.post('/doctor/:id/verify', (req, res) => {
  res.json({ 
    message: 'Verify doctor - DB disabled for debugging',
    doctorId: req.params.id
  });
});

router.get('/reports', (req, res) => {
  res.json({ 
    message: 'Admin reports - Cloud storage disabled for debugging',
    reports: []
  });
});

router.post('/settings', (req, res) => {
  res.json({ 
    message: 'Update admin settings - DB disabled for debugging',
    settings: req.body
  });
});

export default router;