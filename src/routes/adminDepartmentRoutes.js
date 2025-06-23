// src/routes/adminDepartmentRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ adminDepartmentRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Admin department routes working!' });
});

router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get admin departments - DB disabled for debugging',
    departments: []
  });
});

router.post('/create', (req, res) => {
  res.json({ 
    message: 'Create department - DB disabled for debugging',
    data: req.body 
  });
});

export default router;