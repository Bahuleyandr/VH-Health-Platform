// src/routes/firebaseAuthRoutes.js

const express = require('express');
const router = express.Router();
const firebaseAuthController = require('../controllers/firebaseAuthController');

// ✅ Firebase Phone Number Login
// POST /api/v1/auth/firebase-login
router.post('/firebase-login', firebaseAuthController.firebaseLogin);

// ✅ Register New User (or return existing user if already registered)
// POST /api/v1/auth/register
router.post('/register', firebaseAuthController.registerUser);

module.exports = router;
