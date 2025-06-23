// src/routes/firebaseAuthRoutes.js - EMERGENCY SIMPLE VERSION
import express from 'express';
import * as firebaseAuthController from '../controllers/firebaseAuthController.js';

const router = express.Router();

// ✅ ULTRA SIMPLE - No validation for now, just get it working
router.post('/firebase-login', (req, res) => {
  console.log('Firebase login route hit');
  return firebaseAuthController.firebaseLogin(req, res);
});

router.post('/register', (req, res) => {
  console.log('Register route hit');
  return firebaseAuthController.registerUser(req, res);
});

// Test route to verify the router is working
router.get('/test', (req, res) => {
  res.json({ message: 'Firebase auth routes are working!' });
});

export default router;