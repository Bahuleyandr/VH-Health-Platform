// src/server.js - EMERGENCY DEBUG VERSION
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { connectDB } from './db.js';
import logger from './logging/logger.js';
import { success } from './utils/responseHelper.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Basic middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Test route first
app.get('/', (req, res) => {
  success(res, { message: 'VH Health Backend API is running' }, 'Welcome');
});

app.get('/api/v1', (req, res) => {
  success(res, { message: 'API v1 is working' }, 'API Status');
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

// Test endpoint to verify what's working
app.get('/api/v1/test', (req, res) => {
  success(res, { 
    message: 'Emergency server is running',
    timestamp: new Date().toISOString(),
    availableRoutes: [
      'GET /',
      'GET /api/v1',
      'GET /api/v1/test',
      '/api/v1/users/* (if loaded)',
      '/api/v1/auth/* (if loaded)', 
      '/api/v1/rbac/* (if loaded)'
    ]
  }, 'Test endpoint');
});

// Global error handler
app.use((error, req, res, next) => {
  logger.error(error.stack || error.toString());
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
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

// Start server
async function startServer() {
  try {
    await connectDB();
    logger.info('Database connected successfully');
    
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      console.log(`🌐 Server URL: http://localhost:${PORT}`);
      console.log(`🔍 Test endpoint: http://localhost:${PORT}/api/v1/test`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();