require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const logger = require('./src/logging/logger');

const rateLimit = require('./src/middleware/rateLimitMiddleware');
const validateApiKey = require('./src/middleware/validateApiKey');
const swaggerLoader = require('./src/utils/swaggerLoader');
const errorHandler = require('./src/middleware/errorHandlerMiddleware');
const corsConfig = require('./src/middleware/corsMiddleware');

require('./src/utils/validateEnv'); // Ensure env vars are loaded correctly

const app = express();
const PORT = process.env.PORT || 5000;

// Log all HTTP requests using Morgan + Winston
app.use(logger.morganMiddleware);

// Apply global middlewares
app.use(cors(corsConfig));
app.use(express.json());
app.use(helmet());
app.use(rateLimit);
app.use(validateApiKey);

// Load Swagger documentation if available
swaggerLoader(app);

// Mount Routes
app.use('/api/v1', require('./src/routes/healthRoutes'));
app.use('/api/v1', require('./src/routes/userRoutes'));
app.use('/api/v1', require('./src/routes/appointmentRoutes'));
app.use('/api/v1', require('./src/routes/recordRoutes'));
app.use('/api/v1', require('./src/routes/doctorRoutes'));
app.use('/api/v1', require('./src/routes/departmentRoutes'));
app.use('/api/v1', require('./src/routes/pharmacyRoutes'));
app.use('/api/v1', require('./src/routes/investigationRoutes'));
app.use('/api/v1', require('./src/routes/feedbackRoutes'));
app.use('/api/v1', require('./src/routes/otpRoutes'));
app.use('/api/v1', require('./src/routes/versionRoutes'));

// Fallback error handler
app.use(errorHandler);

// Start the server
app.listen(PORT, () => logger.info(`VH Health Backend running on port ${PORT}`));
