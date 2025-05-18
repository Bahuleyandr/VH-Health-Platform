// src/routes/authRoutes.js

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// ✅ User Login Route
router.post('/login', authController.login);

// Optional Future Enhancements
// router.post('/register', authController.register);
// router.post('/refresh', authController.refreshToken);
// router.post('/logout', authController.logout);

module.exports = router;
