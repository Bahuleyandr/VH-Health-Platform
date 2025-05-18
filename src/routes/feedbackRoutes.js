// src/routes/feedbackRoutes.js

const express = require('express');
const router = express.Router();
const feedbackController = require('../controllers/feedbackController');

// ✅ Get feedback by UID
router.get('/uid/:uid', feedbackController.getFeedbackByUID);

// ✅ Submit new feedback
router.post('/', feedbackController.submitFeedback);

module.exports = router;
