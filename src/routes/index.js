const express = require('express');
const router = express.Router();
const firebaseAuthRoutes = require('./firebaseAuthRoutes');
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
const userRoutes = require('./userRoutes');
const sosRoutes = require('./sosRoutes');
const adminDepartmentRoutes = require('./adminDepartmentRoutes');
const adminDoctorRoutes = require('./adminDoctorRoutes');
const staffRoutes = require('./staffRoutes');


// Mount all routes
router.use('/api/v1/auth', firebaseAuthRoutes);
router.use('/api/v1', departmentRoutes);
router.use('/api/v1', doctorRoutes);
router.use('/api/v1', appointmentRoutes);
router.use('/api/v1', recordRoutes);
router.use('/api/v1', investigationRoutes);
router.use('/api/v1', pharmacyRoutes);
router.use('/api/v1', feedbackRoutes);
router.use('/api/v1', otpRoutes);
router.use('/api/v1', versionRoutes);
router.use('/api/v1', healthRoutes);
router.use('/api/v1', userRoutes);
router.use('/api/v1', sosRoutes);
router.use('/api/v1', adminDepartmentRoutes);
router.use('/api/v1', adminDoctorRoutes);
router.use('/api/v1', staffRoutes);

module.exports = router;
