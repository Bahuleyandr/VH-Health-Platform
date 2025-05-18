// src/routes/index.js
const express = require('express');
const router = express.Router();

// Load route modules
const uploadRoutes = require('./uploadRoutes');
const debugRoutes = require('./debugRoutes');
const userRoutes = require('./userRoutes');
const lookupRoutes = require('./lookupRoutes');
const firebaseAuthRoutes = require('./firebaseAuthRoutes');
const authRoutes = require('./authRoutes');
const departmentRoutes = require('./departmentRoutes');
const doctorRoutes = require('./doctorRoutes');
const appointmentRoutes = require('./appointmentRoutes');
const recordRoutes = require('./recordRoutes');
const investigationRoutes = require('./investigationRoutes');
const pharmacyRoutes = require('./pharmacyRoutes');
const feedbackRoutes = require('./feedbackRoutes');
const otpRoutes = require('./otpRoutes');
const versionRoutes = require('./versionRoutes');
const healthRoutes = require('./healthRoutes');
const sosRoutes = require('./sosRoutes');
const adminDepartmentRoutes = require('./adminDepartmentRoutes');
const adminDoctorRoutes = require('./adminDoctorRoutes');
const staffRoutes = require('./staffRoutes');

// ✅ API Version 1 Route Mounts (NO trailing slashes)
router.use('/api/v1/auth', firebaseAuthRoutes);
router.use('/api/v1', debugRoutes);
router.use('/api/v1/auth', authRoutes);
router.use('/api/v1/upload', uploadRoutes);
router.use('/api/v1/users', userRoutes);
router.use('/api/v1/lookup', lookupRoutes);
router.use('/api/v1/departments', departmentRoutes);
router.use('/api/v1/doctors', doctorRoutes);
router.use('/api/v1/appointments', appointmentRoutes);
router.use('/api/v1/records', recordRoutes);
router.use('/api/v1/investigations', investigationRoutes);
router.use('/api/v1/pharmacy-orders', pharmacyRoutes);
router.use('/api/v1/feedback', feedbackRoutes);
router.use('/api/v1/otp', otpRoutes);
router.use('/api/v1/version', versionRoutes);
router.use('/api/v1/health', healthRoutes);
router.use('/api/v1/sos', sosRoutes);
router.use('/api/v1/admin/departments', adminDepartmentRoutes);
router.use('/api/v1/admin/doctors', adminDoctorRoutes);
router.use('/api/v1/staff', staffRoutes);

// ✅ Safe 404 Logger for unmatched routes (no wildcard)
router.use((req, res) => {
  console.warn(`⚠️  Unmatched Route: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'API endpoint not found' });
});

module.exports = router;
