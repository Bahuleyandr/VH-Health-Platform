const express = require('express');
const router = express.Router();

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

// Mount all routes
router.use('/departments', departmentRoutes);
router.use('/doctors', doctorRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/health-records', recordRoutes);
router.use('/investigations', investigationRoutes);
router.use('/pharmacy-orders', pharmacyRoutes);
router.use('/feedback', feedbackRoutes);
router.use('/otp', otpRoutes);
router.use('/version', versionRoutes);
router.use('/health', healthRoutes);
router.use('/users', userRoutes);

module.exports = router;
