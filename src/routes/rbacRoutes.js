// src/routes/rbacRoutes.js - EMERGENCY SIMPLE VERSION (NO WRAPPER)
import express from 'express';
import * as rbacController from '../controllers/rbacController.js';

const router = express.Router();
console.log('✅ rbacRoutes loaded');

// ✅ SIMPLE ROUTES - No wrapper system
router.get('/roles', (req, res) => {
  console.log('Get all roles route hit');
  return rbacController.getAllRoles(req, res);
});

router.get('/users', (req, res) => {
  console.log('Get users by role route hit');
  return rbacController.getUsersByRole(req, res);
});

router.post('/assign-role', (req, res) => {
  console.log('Assign user role route hit');
  return rbacController.assignUserRole(req, res);
});

// Test route
router.get('/test', (req, res) => {
  res.json({ message: 'RBAC routes are working!' });
});

export default router;