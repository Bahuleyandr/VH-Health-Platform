// server.js
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import logger from './logging/logger.js';
import { dynamicRoleRateLimiter } from './middleware/rateLimitMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import swaggerUi from 'swagger-ui-express';
import loadSwaggerDocument from './utils/swaggerLoader.js';
import errorHandler from './middleware/errorHandlerMiddleware.js';
import corsConfig from './middleware/corsMiddleware.js';
import routes from './routes/index.js'; 
import './utils/validateEnv.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ Log all HTTP requests using Morgan + Winston
app.use(logger.morganMiddleware);

// ✅ Apply Global Middlewares
app.use(cors(corsConfig));
app.use(express.json());
app.use(helmet());

// ✅ Health Check routes (before any middleware)
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'VH Health Backend is running.',
    timestamp: new Date().toISOString()
  });
});

app.head('/', (req, res) => {
  res.status(200).end();
});

// ✅ PUBLIC ROUTES (No rate limiting or API key validation)
app.use('/api/v1/firebaseAuth', routes.firebaseAuth);  // 🔓 Public auth routes
app.use('/api/v1/health', routes.health);             // 🔓 Health checks  
app.use('/api/v1/version', routes.version);           // 🔓 Version info
app.use('/api/v1/sos', routes.sos);                   // 🔓 Emergency routes

// ✅ Apply rate limiting and API key validation to PROTECTED routes only
app.use('/api', dynamicRoleRateLimiter);
app.use('/api', validateApiKey);

// ✅ PROTECTED ROUTES (After rate limiting and API key validation)
app.use('/api/v1/auth', routes.auth);
app.use('/api/v1/upload', routes.upload);
app.use('/api/v1/debug', routes.debug);
app.use('/api/v1/users', routes.users);
app.use('/api/v1/lookup', routes.lookup);
app.use('/api/v1/departments', routes.departments);
app.use('/api/v1/doctors', routes.doctors);
app.use('/api/v1/appointments', routes.appointments);
app.use('/api/v1/healthRecords', routes.healthRecords);
app.use('/api/v1/investigations', routes.investigations);
app.use('/api/v1/pharmacy', routes.pharmacy);
app.use('/api/v1/feedback', routes.feedback);
app.use('/api/v1/otp', routes.otp);
app.use('/api/v1/devices', routes.devices);
app.use('/api/v1/notifications', routes.notifications);
app.use('/api/v1/admin/notifications', routes.adminNotifications);

// ✅ Load Swagger Documentation if available
const swaggerDocument = loadSwaggerDocument();
if (swaggerDocument) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

// ✅ 404 handler for unmatched routes
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// ✅ Fallback Error Handler
app.use(errorHandler);

// ✅ Start Server
app.listen(PORT, () => logger.info(`VH Health Backend running on port ${PORT}`));