// src/server.js - ABSOLUTE MINIMAL (TEST ONE ROUTE AT A TIME)
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Minimal server working' });
});

app.get('/api/v1/test', (req, res) => {
  res.json({ message: 'API test working' });
});

// 🚨 TEST ONLY ONE ROUTE FILE AT A TIME
console.log('🔍 Testing ONLY userRoutes...');

try {
  const userRoutes = await import('./routes/userRoutes.js');
  console.log('✅ userRoutes imported:', typeof userRoutes.default);
  
  if (typeof userRoutes.default === 'function') {
    console.log('🔧 Registering userRoutes...');
    app.use('/api/v1/users', userRoutes.default);
    console.log('✅ userRoutes registered successfully');
  }
} catch (error) {
  console.log('❌ Error with userRoutes:', error.message);
  console.log('❌ Stack:', error.stack);
}

// 🚨 COMMENT OUT OTHER ROUTES FOR NOW
// try {
//   const firebaseAuthRoutes = await import('./routes/firebaseAuthRoutes.js');
//   app.use('/api/v1/auth', firebaseAuthRoutes.default);
// } catch (error) {
//   console.log('❌ Error with firebaseAuthRoutes:', error.message);
// }

// try {
//   const rbacRoutes = await import('./routes/rbacRoutes.js');
//   app.use('/api/v1/rbac', rbacRoutes.default);
// } catch (error) {
//   console.log('❌ Error with rbacRoutes:', error.message);
// }

// Global error handler
app.use((error, req, res, next) => {
  console.error('🚨 Global error:', error);
  res.status(500).json({
    success: false,
    message: 'Server error',
    error: error.message
  });
});

console.log('🚀 Starting server...');

app.listen(PORT, () => {
  console.log(`✅ MINIMAL SERVER running on port ${PORT}`);
  console.log(`🌐 Test: http://localhost:${PORT}/api/v1/test`);
  console.log(`👤 Users: http://localhost:${PORT}/api/v1/users/test`);
});