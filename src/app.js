// ✅ Prefer .env.local if it exists, otherwise fallback to .env.render or default .env
const fs = require('fs');
if (fs.existsSync('.env.local')) {
  require('dotenv').config({ path: '.env.local' });
} else if (fs.existsSync('.env.render')) {
  require('dotenv').config({ path: '.env.render' });
} else {
  require('dotenv').config();
}

require('./utils/validateEnv');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const loggingMiddleware = require('./middleware/loggingMiddleware');
const errorHandlerMiddleware = require('./middleware/errorHandlerMiddleware');
const validateApiKey = require('./middleware/validateApiKey');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const swaggerLoader = require('./utils/swaggerLoader');
const logger = require('./logging/logger');

const app = express();

// ✅ Validate and Load Swagger Documentation on Startup
let swaggerDocument;
try {
  swaggerDocument = swaggerLoader();
  if (!swaggerDocument) {
    throw new Error('Failed to load Swagger documentation.');
  }
  console.log('✅ Swagger documentation validated and loaded.');
} catch (err) {
  console.error('❌ Failed to load or validate Swagger documentation:', err.message);
  process.exit(1);
}

// ✅ Load Authentication Middlewares
const apiKeyAuth = require('./middleware/authMiddleware');
const jwtAuth = require('./middleware/jwtMiddleware');

// ✅ Middleware Stack
app.use(helmet());
app.use(express.json());
app.use(logger.morganMiddleware);

const corsMiddleware = require('./middleware/corsMiddleware');
app.use(corsMiddleware);

app.use(loggingMiddleware);
app.use(validateApiKey);

// ✅ Swagger API Docs Route
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ✅ Protect Admin and Staff Routes with API Key + JWT
const adminRoutes = require('./routes/adminRoutes');
app.use('/api/v1/admin', apiKeyAuth, jwtAuth, adminRoutes);

const staffRoutes = require('./routes/staffRoutes');
app.use('/api/v1/staff', apiKeyAuth, jwtAuth, staffRoutes);

// ✅ Import Rate Limiters
const { patientRateLimiter, noRateLimiter, genericLimiter } = require('./middleware/rateLimitMiddleware');

// ✅ Rate Limiting Per Route
app.use('/api/v1/auth', patientRateLimiter);
app.use('/api/v1/users', patientRateLimiter);
app.use('/api/v1/appointments', patientRateLimiter);
app.use('/api/v1/records', patientRateLimiter);
app.use('/api/v1/investigations', patientRateLimiter);
app.use('/api/v1/pharmacy-orders', patientRateLimiter);
app.use('/api/v1/feedback', patientRateLimiter);
app.use('/api/v1/otp', patientRateLimiter);
app.use('/api/v1/sos', patientRateLimiter);

// ✅ Apply Generic Limiter to Remaining Routes
app.use(genericLimiter);

// ✅ API Routes
app.use('/', routes);

// ✅ Root Health Check
app.get('/', (req, res) => {
  res.json({ message: 'VH Health API is running.' });
});

// ✅ Global Error Handler
app.use(errorHandlerMiddleware);

module.exports = app;
