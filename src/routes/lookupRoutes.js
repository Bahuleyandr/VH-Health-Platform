// src/routes/lookupRoutes.js

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// ✅ Lookup user by phone, name, or UID via query parameters
// Example: /api/v1/lookup?phone=9876543210
// Example: /api/v1/lookup?uid=505929da-13c9-4132-9140-5f63e8f6d300
// Example: /api/v1/lookup?name=John
router.get('/', userController.lookupUser);

module.exports = router;
