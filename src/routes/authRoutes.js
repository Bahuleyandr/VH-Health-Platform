// src/routes/authRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ authRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'Auth routes working!' });
});

// Simple routes with minimal logic (no JWT dependencies)
router.post('/login', (req, res) => {
  res.json({ 
    message: 'Login endpoint - JWT disabled for debugging',
    email: req.body.email,
    token: 'dummy-token-for-debugging'
  });
});

router.post('/register', (req, res) => {
  res.json({ 
    message: 'Register endpoint - DB disabled for debugging',
    user: {
      email: req.body.email,
      name: req.body.name
    }
  });
});

router.post('/forgot-password', (req, res) => {
  res.json({ 
    message: 'Forgot password endpoint - Email service disabled for debugging',
    email: req.body.email
  });
});

router.post('/reset-password', (req, res) => {
  res.json({ 
    message: 'Reset password endpoint - DB disabled for debugging',
    token: req.body.token
  });
});

router.post('/verify-email', (req, res) => {
  res.json({ 
    message: 'Verify email endpoint - Email service disabled for debugging',
    token: req.body.token
  });
});

router.post('/refresh-token', (req, res) => {
  res.json({ 
    message: 'Refresh token endpoint - JWT disabled for debugging',
    newToken: 'dummy-refresh-token-for-debugging'
  });
});

router.post('/logout', (req, res) => {
  res.json({ 
    message: 'Logout successful - Session handling disabled for debugging'
  });
});

export default router;