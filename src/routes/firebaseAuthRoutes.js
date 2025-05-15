// src/routes/firebaseAuthRoutes.js

const express = require('express');
const router = express.Router();
const firebaseAuthController = require('../controllers/firebaseAuthController');

router.post('/firebase-login', firebaseAuthController.firebaseLogin);
router.post('/register', firebaseAuthController.registerUser);


module.exports = router;
