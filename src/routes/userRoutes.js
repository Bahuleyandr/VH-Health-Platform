// src/routes/userRoutes.js - ULTRA CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ userRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'User routes working!' });
});

// Simple routes with minimal logic
router.get('/list', (req, res) => {
  res.json({ message: 'Get users list - DB disabled for debugging' });
});

router.post('/profile', (req, res) => {
  res.json({ message: 'Create user profile - DB disabled for debugging' });
});

router.get('/uid/:uid', (req, res) => {
  res.json({ 
    message: 'Get user by UID - DB disabled for debugging',
    uid: req.params.uid
  });
});

export default router;