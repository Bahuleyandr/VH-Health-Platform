// src/routes/notificationRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ notificationRoutes loaded');

// Test route first
router.get('/test', (req, res) => {
  res.json({ message: 'Notification routes working!' });
});

// Simple routes with minimal logic (no DB calls)
router.get('/list', (req, res) => {
  res.json({ 
    message: 'Get notifications list - DB disabled for debugging',
    notifications: [
      { id: 1, type: 'appointment', message: 'Appointment reminder', read: false },
      { id: 2, type: 'result', message: 'Lab results available', read: true },
      { id: 3, type: 'prescription', message: 'Prescription ready', read: false }
    ]
  });
});

router.get('/unread', (req, res) => {
  res.json({ 
    message: 'Get unread notifications - DB disabled for debugging',
    count: 2,
    notifications: []
  });
});

router.get('/:id', (req, res) => {
  res.json({ 
    message: 'Get notification by ID - DB disabled for debugging',
    id: req.params.id,
    notification: {
      id: req.params.id,
      type: 'sample',
      message: 'Sample notification',
      read: false
    }
  });
});

router.post('/create', (req, res) => {
  res.json({ 
    message: 'Create notification - DB disabled for debugging',
    data: req.body 
  });
});

router.put('/:id/read', (req, res) => {
  res.json({ 
    message: 'Mark notification as read - DB disabled for debugging',
    id: req.params.id,
    read: true
  });
});

router.put('/:id/unread', (req, res) => {
  res.json({ 
    message: 'Mark notification as unread - DB disabled for debugging',
    id: req.params.id,
    read: false
  });
});

router.delete('/:id', (req, res) => {
  res.json({ 
    message: 'Delete notification - DB disabled for debugging',
    id: req.params.id
  });
});

router.post('/send', (req, res) => {
  res.json({ 
    message: 'Send notification - Email service disabled for debugging',
    recipient: req.body.recipient,
    message: req.body.message
  });
});

export default router;