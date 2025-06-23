// src/server.js - ULTRA SIMPLE VERSION (NO DB CONNECTION)
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Basic middleware
app.use(cors());
app.use(express.json());

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'VH Health Backend API is running - Emergency Mode' });
});

app.get('/api/v1', (req, res) => {
  res.json({ message: 'API v1 is working - Emergency Mode' });
});

// 🚨 DEBUG: Test each route import individually
console.log('🔍 Testing route imports...');

try {
  console.log('📦 Importing userRoutes...');
  const userRoutes = await import('./routes/userRoutes.js');
  console.log('✅ userRoutes imported:', typeof userRoutes.default);
  
  if (typeof userRoutes.default === 'function') {
    app.use('/api/v1/users', userRoutes.default);
    console.log('✅ userRoutes registered');
  } else {
    console.log('❌ userRoutes.default is not a function:', userRoutes.default);
  }
} catch (error) {
  console.log('❌ Error importing userRoutes:', error.message);
}

try {
  console.log('📦 Importing firebaseAuthRoutes...');
  const firebaseAuthRoutes = await import('./routes/firebaseAuthRoutes.js');
  console.log('✅ firebaseAuthRoutes imported:', typeof firebaseAuthRoutes.default);
  
  if (typeof firebaseAuthRoutes.default === 'function') {
    app.use('/api/v1/auth', firebaseAuthRoutes.default);
    console.log('✅ firebaseAuthRoutes registered');
  } else {
    console.log('❌ firebaseAuthRoutes.default is not a function:', firebaseAuthRoutes.default);
  }
} catch (error) {
  console.log('❌ Error importing firebaseAuthRoutes:', error.message);
}

try {
  console.log('📦 Importing rbacRoutes...');
  const rbacRoutes = await import('./routes/rbacRoutes.js');
  console.log('✅ rbacRoutes imported:', typeof rbacRoutes.default);
  
  if (typeof rbacRoutes.default === 'function') {
    app.use('/api/v1/rbac', rbacRoutes.default);
    console.log('✅ rbacRoutes registered');
  } else {
    console.log('❌ rbacRoutes.default is not a function:', rbacRoutes.default);
  }
} catch (error) {
  console.log('❌ Error importing rbacRoutes:', error.message);
}

// Test endpoint
app.get('/api/v1/test', (req, res) => {
  res.json({ 
    message: 'Emergency server is running - NO DATABASE',
    timestamp: new Date().toISOString(),
    warning: 'Database connections disabled for debugging',
    availableRoutes: [
      'GET /',
      'GET /api/v1',
      'GET /api/v1/test',
      '/api/v1/users/* (if loaded)',
      '/api/v1/auth/* (if loaded)', 
      '/api/v1/rbac/* (if loaded)'
    ]
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error(error.stack || error.toString());
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: error.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl
  });
});

// Start server immediately - no DB connection
app.listen(PORT, () => {
  console.log(`🚀 EMERGENCY SERVER running on port ${PORT}`);
  console.log(`🌐 Server URL: http://localhost:${PORT}`);
  console.log(`🔍 Test endpoint: http://localhost:${PORT}/api/v1/test`);
  console.log(`⚠️  Database connections disabled for debugging`);
});