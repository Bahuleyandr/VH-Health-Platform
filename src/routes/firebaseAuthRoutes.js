// src/routes/firebaseAuthRoutes.js - ULTRA CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ firebaseAuthRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'Firebase auth routes working!' });
});

// Simple routes with minimal logic
router.post('/firebase-login', (req, res) => {
  res.json({ message: 'Firebase login - DB disabled for debugging' });
});

router.post('/register', (req, res) => {
  res.json({ message: 'Register user - DB disabled for debugging' });
});

export default router;