// src/server.js - COMPLETE LOCAL VERSION WITH BATCH 2 ROUTES
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Test route
app.get('/', (req, res) => {
  res.json({ 
    message: 'VH Health Backend - Local Development',
    environment: 'local',
    port: PORT
  });
});

app.get('/api/v1/test', (req, res) => {
  res.json({ 
    message: 'API test working locally',
    timestamp: new Date().toISOString()
  });
});

// Test database connection (optional - will fail without DB)
app.get('/api/v1/db-test', async (req, res) => {
  try {
    const pool = (await import('./db.js')).default;
    const result = await pool.query('SELECT NOW() as current_time');
    res.json({ 
      message: 'Database connection successful',
      currentTime: result.rows[0].current_time
    });
  } catch (error) {
    res.status(500).json({ 
      message: 'Database connection failed (expected in local dev)',
      error: error.message
    });
  }
});

// 🚨 BATCH 1 ROUTES (WORKING)
console.log('🔍 Testing userRoutes...');
try {
  const userRoutes = await import('./routes/userRoutes.js');
  console.log('✅ userRoutes imported:', typeof userRoutes.default);
  app.use('/api/v1/users', userRoutes.default);
  console.log('✅ userRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with userRoutes:', error.message);
}

console.log('🔍 Testing firebaseAuthRoutes...');
try {
  const firebaseAuthRoutes = await import('./routes/firebaseAuthRoutes.js');
  console.log('✅ firebaseAuthRoutes imported:', typeof firebaseAuthRoutes.default);
  app.use('/api/v1/auth', firebaseAuthRoutes.default);
  console.log('✅ firebaseAuthRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with firebaseAuthRoutes:', error.message);
}

console.log('🔍 Testing rbacRoutes...');
try {
  const rbacRoutes = await import('./routes/rbacRoutes.js');
  console.log('✅ rbacRoutes imported:', typeof rbacRoutes.default);
  app.use('/api/v1/rbac', rbacRoutes.default);
  console.log('✅ rbacRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with rbacRoutes:', error.message);
}

console.log('🔍 Testing appointmentRoutes...');
try {
  const appointmentRoutes = await import('./routes/appointmentRoutes.js');
  console.log('✅ appointmentRoutes imported:', typeof appointmentRoutes.default);
  app.use('/api/v1/appointments', appointmentRoutes.default);
  console.log('✅ appointmentRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with appointmentRoutes:', error.message);
}

console.log('🔍 Testing doctorRoutes...');
try {
  const doctorRoutes = await import('./routes/doctorRoutes.js');
  console.log('✅ doctorRoutes imported:', typeof doctorRoutes.default);
  app.use('/api/v1/doctors', doctorRoutes.default);
  console.log('✅ doctorRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with doctorRoutes:', error.message);
}

console.log('🔍 Testing recordRoutes...');
try {
  const recordRoutes = await import('./routes/recordRoutes.js');
  console.log('✅ recordRoutes imported:', typeof recordRoutes.default);
  app.use('/api/v1/records', recordRoutes.default);
  console.log('✅ recordRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with recordRoutes:', error.message);
}

console.log('🔍 Testing adminRoutes...');
try {
  const adminRoutes = await import('./routes/adminRoutes.js');
  console.log('✅ adminRoutes imported:', typeof adminRoutes.default);
  app.use('/api/v1/admin', adminRoutes.default);
  console.log('✅ adminRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with adminRoutes:', error.message);
}

console.log('🔍 Testing authRoutes...');
try {
  const authRoutes = await import('./routes/authRoutes.js');
  console.log('✅ authRoutes imported:', typeof authRoutes.default);
  app.use('/api/v1/auth2', authRoutes.default);
  console.log('✅ authRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with authRoutes:', error.message);
}

// 🚨 BATCH 2 ROUTES (TESTING NOW)
console.log('🔍 Testing departmentRoutes...');
try {
  const departmentRoutes = await import('./routes/departmentRoutes.js');
  console.log('✅ departmentRoutes imported:', typeof departmentRoutes.default);
  app.use('/api/v1/departments', departmentRoutes.default);
  console.log('✅ departmentRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with departmentRoutes:', error.message);
}

console.log('🔍 Testing notificationRoutes...');
try {
  const notificationRoutes = await import('./routes/notificationRoutes.js');
  console.log('✅ notificationRoutes imported:', typeof notificationRoutes.default);
  app.use('/api/v1/notifications', notificationRoutes.default);
  console.log('✅ notificationRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with notificationRoutes:', error.message);
}

console.log('🔍 Testing healthRoutes...');
try {
  const healthRoutes = await import('./routes/healthRoutes.js');
  console.log('✅ healthRoutes imported:', typeof healthRoutes.default);
  app.use('/api/v1/health', healthRoutes.default);
  console.log('✅ healthRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with healthRoutes:', error.message);
}

console.log('🔍 Testing investigationRoutes...');
try {
  const investigationRoutes = await import('./routes/investigationRoutes.js');
  console.log('✅ investigationRoutes imported:', typeof investigationRoutes.default);
  app.use('/api/v1/investigations', investigationRoutes.default);
  console.log('✅ investigationRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with investigationRoutes:', error.message);
}

console.log('🔍 Testing pharmacyRoutes...');
try {
  const pharmacyRoutes = await import('./routes/pharmacyRoutes.js');
  console.log('✅ pharmacyRoutes imported:', typeof pharmacyRoutes.default);
  app.use('/api/v1/pharmacy', pharmacyRoutes.default);
  console.log('✅ pharmacyRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with pharmacyRoutes:', error.message);
}

// 🚨 BATCH 3 ROUTES (TESTING NOW)
console.log('🔍 Testing staffRoutes...');
try {
  const staffRoutes = await import('./routes/staffRoutes.js');
  console.log('✅ staffRoutes imported:', typeof staffRoutes.default);
  app.use('/api/v1/staff', staffRoutes.default);
  console.log('✅ staffRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with staffRoutes:', error.message);
}

console.log('🔍 Testing uploadRoutes...');
try {
  const uploadRoutes = await import('./routes/uploadRoutes.js');
  console.log('✅ uploadRoutes imported:', typeof uploadRoutes.default);
  app.use('/api/v1/upload', uploadRoutes.default);
  console.log('✅ uploadRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with uploadRoutes:', error.message);
}

console.log('🔍 Testing feedbackRoutes...');
try {
  const feedbackRoutes = await import('./routes/feedbackRoutes.js');
  console.log('✅ feedbackRoutes imported:', typeof feedbackRoutes.default);
  app.use('/api/v1/feedback', feedbackRoutes.default);
  console.log('✅ feedbackRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with feedbackRoutes:', error.message);
}

console.log('🔍 Testing otpRoutes...');
try {
  const otpRoutes = await import('./routes/otpRoutes.js');
  console.log('✅ otpRoutes imported:', typeof otpRoutes.default);
  app.use('/api/v1/otp', otpRoutes.default);
  console.log('✅ otpRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with otpRoutes:', error.message);
}

console.log('🔍 Testing sosRoutes...');
try {
  const sosRoutes = await import('./routes/sosRoutes.js');
  console.log('✅ sosRoutes imported:', typeof sosRoutes.default);
  app.use('/api/v1/sos', sosRoutes.default);
  console.log('✅ sosRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with sosRoutes:', error.message);
}

// 🚨 BATCH 4 - FINAL 9 ROUTES
console.log('🔍 Testing adminDepartmentRoutes...');
try {
  const adminDepartmentRoutes = await import('./routes/adminDepartmentRoutes.js');
  console.log('✅ adminDepartmentRoutes imported:', typeof adminDepartmentRoutes.default);
  app.use('/api/v1/admin/departments', adminDepartmentRoutes.default);
  console.log('✅ adminDepartmentRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with adminDepartmentRoutes:', error.message);
}

console.log('🔍 Testing adminDoctorRoutes...');
try {
  const adminDoctorRoutes = await import('./routes/adminDoctorRoutes.js');
  console.log('✅ adminDoctorRoutes imported:', typeof adminDoctorRoutes.default);
  app.use('/api/v1/admin/doctors', adminDoctorRoutes.default);
  console.log('✅ adminDoctorRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with adminDoctorRoutes:', error.message);
}

console.log('🔍 Testing adminNotificationRoutes...');
try {
  const adminNotificationRoutes = await import('./routes/adminNotificationRoutes.js');
  console.log('✅ adminNotificationRoutes imported:', typeof adminNotificationRoutes.default);
  app.use('/api/v1/admin/notifications', adminNotificationRoutes.default);
  console.log('✅ adminNotificationRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with adminNotificationRoutes:', error.message);
}

console.log('🔍 Testing analyticsRoutes...');
try {
  const analyticsRoutes = await import('./routes/analyticsRoutes.js');
  console.log('✅ analyticsRoutes imported:', typeof analyticsRoutes.default);
  app.use('/api/v1/analytics', analyticsRoutes.default);
  console.log('✅ analyticsRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with analyticsRoutes:', error.message);
}

console.log('🔍 Testing debugRoutes...');
try {
  const debugRoutes = await import('./routes/debugRoutes.js');
  console.log('✅ debugRoutes imported:', typeof debugRoutes.default);
  app.use('/api/v1/debug', debugRoutes.default);
  console.log('✅ debugRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with debugRoutes:', error.message);
}

console.log('🔍 Testing deviceRoutes...');
try {
  const deviceRoutes = await import('./routes/deviceRoutes.js');
  console.log('✅ deviceRoutes imported:', typeof deviceRoutes.default);
  app.use('/api/v1/devices', deviceRoutes.default);
  console.log('✅ deviceRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with deviceRoutes:', error.message);
}

console.log('🔍 Testing lookupRoutes...');
try {
  const lookupRoutes = await import('./routes/lookupRoutes.js');
  console.log('✅ lookupRoutes imported:', typeof lookupRoutes.default);
  app.use('/api/v1/lookup', lookupRoutes.default);
  console.log('✅ lookupRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with lookupRoutes:', error.message);
}

console.log('🔍 Testing swaggerRoutes...');
try {
  const swaggerRoutes = await import('./routes/swaggerRoutes.js');
  console.log('✅ swaggerRoutes imported:', typeof swaggerRoutes.default);
  app.use('/api/v1/swagger', swaggerRoutes.default);
  console.log('✅ swaggerRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with swaggerRoutes:', error.message);
}

console.log('🔍 Testing versionRoutes...');
try {
  const versionRoutes = await import('./routes/versionRoutes.js');
  console.log('✅ versionRoutes imported:', typeof versionRoutes.default);
  app.use('/api/v1/version', versionRoutes.default);
  console.log('✅ versionRoutes registered successfully');
} catch (error) {
  console.log('❌ Error with versionRoutes:', error.message);
}

// Global error handler
app.use((error, req, res, next) => {
  console.error('🚨 Global error:', error);
  res.status(500).json({
    success: false,
    message: 'Server error',
    error: error.message
  });
});

console.log('🚀 Starting LOCAL server...');

app.listen(PORT, () => {
  console.log(`✅ LOCAL SERVER running on port ${PORT}`);
  console.log(`🌐 Main: http://localhost:${PORT}`);
  console.log(`🔍 Test: http://localhost:${PORT}/api/v1/test`);
  console.log(`👤 Users: http://localhost:${PORT}/api/v1/users/test`);
  console.log(`🔐 Auth: http://localhost:${PORT}/api/v1/auth/test`);
  console.log(`🛡️ RBAC: http://localhost:${PORT}/api/v1/rbac/test`);
  console.log(`📅 Appointments: http://localhost:${PORT}/api/v1/appointments/test`);
  console.log(`👨‍⚕️ Doctors: http://localhost:${PORT}/api/v1/doctors/test`);
  console.log(`📋 Records: http://localhost:${PORT}/api/v1/records/test`);
  console.log(`👑 Admin: http://localhost:${PORT}/api/v1/admin/test`);
  console.log(`🔑 Auth2: http://localhost:${PORT}/api/v1/auth2/test`);
  console.log(`🏢 Departments: http://localhost:${PORT}/api/v1/departments/test`);
  console.log(`🔔 Notifications: http://localhost:${PORT}/api/v1/notifications/test`);
  console.log(`💊 Health: http://localhost:${PORT}/api/v1/health/test`);
  console.log(`🔬 Investigations: http://localhost:${PORT}/api/v1/investigations/test`);
  console.log(`💉 Pharmacy: http://localhost:${PORT}/api/v1/pharmacy/test`);
  console.log(`👥 Staff: http://localhost:${PORT}/api/v1/staff/test`);
  console.log(`📤 Upload: http://localhost:${PORT}/api/v1/upload/test`);
  console.log(`💬 Feedback: http://localhost:${PORT}/api/v1/feedback/test`);
  console.log(`📱 OTP: http://localhost:${PORT}/api/v1/otp/test`);
  console.log(`🚨 SOS: http://localhost:${PORT}/api/v1/sos/test`);
  console.log(`🏢🔧 Admin Depts: http://localhost:${PORT}/api/v1/admin/departments/test`);
  console.log(`👨‍⚕️🔧 Admin Doctors: http://localhost:${PORT}/api/v1/admin/doctors/test`);
  console.log(`🔔🔧 Admin Notifications: http://localhost:${PORT}/api/v1/admin/notifications/test`);
  console.log(`📊 Analytics: http://localhost:${PORT}/api/v1/analytics/test`);
  console.log(`🐛 Debug: http://localhost:${PORT}/api/v1/debug/test`);
  console.log(`📱 Devices: http://localhost:${PORT}/api/v1/devices/test`);
  console.log(`🔍 Lookup: http://localhost:${PORT}/api/v1/lookup/test`);
  console.log(`📚 Swagger: http://localhost:${PORT}/api/v1/swagger/test`);
  console.log(`🏷️ Version: http://localhost:${PORT}/api/v1/version/test`);
});