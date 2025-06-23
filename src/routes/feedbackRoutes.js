// src/routes/feedbackRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ feedbackRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Feedback routes working!' });
});

router.post('/submit', (req, res) => {
  res.json({ 
    message: 'Submit feedback - DB disabled for debugging',
    data: req.body
  });
});

router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get feedback list - DB disabled for debugging',
    feedback: []
  });
});

router.get('/:id', (req, res) => {
  res.json({ 
    message: 'Get feedback by ID - DB disabled for debugging',
    id: req.params.id
  });
});

export default router;