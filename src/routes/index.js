// src/routes/index.js - EMERGENCY MINIMAL VERSION
import express from 'express';

// ✅ ONLY import the fixed routes (no wrappers)
import userRoutes from './userRoutes.js';
import firebaseAuthRoutes from './firebaseAuthRoutes.js';
import rbacRoutes from './rbacRoutes.js';  // Make sure you use the simple version
import healthRoutes from './healthRoutes.js';  // Usually safe
import deviceRoutes from './deviceRoutes.js';  // Usually safe

// 🚨 TEMPORARILY COMMENT OUT ALL WRAPPER-USING ROUTES
// import adminDepartmentRoutes from './adminDepartmentRoutes.js';
// import adminDoctorRoutes from './adminDoctorRoutes.js';
// import adminNotificationRoutes from './adminNotificationRoutes.js';
// import adminRoutes from './adminRoutes.js';
// import analyticsRoutes from './analyticsRoutes.js';
// import appointmentRoutes from './appointmentRoutes.js';
// import authRoutes from './authRoutes.js';
// import debugRoutes from './debugRoutes.js';
// import departmentRoutes from './departmentRoutes.js';
// import doctorRoutes from './doctorRoutes.js';
// import feedbackRoutes from './feedbackRoutes.js';
// import investigationRoutes from './investigationRoutes.js';
// import lookupRoutes from './lookupRoutes.js';
// import notificationRoutes from './notificationRoutes.js';
// import otpRoutes from './otpRoutes.js';
// import pharmacyRoutes from './pharmacyRoutes.js';
// import recordRoutes from './recordRoutes.js';
// import sosRoutes from './sosRoutes.js';
// import staffRoutes from './staffRoutes.js';
// import swaggerRoutes from './swaggerRoutes.js';
// import uploadRoutes from './uploadRoutes.js';
// import versionRoutes from './versionRoutes.js';

const router = express.Router();

// ✅ ONLY register the working routes
router.use('/users', userRoutes);
router.use('/auth', firebaseAuthRoutes);
router.use('/rbac', rbacRoutes);

// Only include these if they don't use wrappers
try {
  router.use('/health', healthRoutes);
} catch (e) {
  console.log('⚠️ Health routes disabled due to wrapper issues');
}

try {
  router.use('/device', deviceRoutes);
} catch (e) {
  console.log('⚠️ Device routes disabled due to wrapper issues');
}

// 🚨 TEMPORARILY DISABLED - Will re-enable after fixing wrappers
// router.use('/admin/departments', adminDepartmentRoutes);
// router.use('/admin/doctors', adminDoctorRoutes);
// router.use('/admin/notifications', adminNotificationRoutes);
// router.use('/admin', adminRoutes);
// router.use('/analytics', analyticsRoutes);
// router.use('/appointments', appointmentRoutes);
// router.use('/auth-legacy', authRoutes);
// router.use('/debug', debugRoutes);
// router.use('/departments', departmentRoutes);
// router.use('/doctors', doctorRoutes);
// router.use('/feedback', feedbackRoutes);
// router.use('/investigations', investigationRoutes);
// router.use('/lookup', lookupRoutes);
// router.use('/notifications', notificationRoutes);
// router.use('/otp', otpRoutes);
// router.use('/pharmacy', pharmacyRoutes);
// router.use('/records', recordRoutes);
// router.use('/sos', sosRoutes);
// router.use('/staff', staffRoutes);
// router.use('/swagger', swaggerRoutes);
// router.use('/uploads', uploadRoutes);
// router.use('/version', versionRoutes);

// Test route to verify the API is working
router.get('/test', (req, res) => {
  res.json({ 
    message: 'API is running with minimal routes',
    availableRoutes: [
      '/api/v1/users/*',
      '/api/v1/auth/*',
      '/api/v1/rbac/*',
      '/api/v1/health/*',
      '/api/v1/device/*'
    ],
    note: 'Other routes temporarily disabled while fixing wrapper system'
  });
});

export default router;