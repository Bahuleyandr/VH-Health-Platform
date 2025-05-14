require('dotenv').config();
require('./utils/validateEnv');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimitMiddleware = require('./middleware/rateLimitMiddleware');
const loggingMiddleware = require('./middleware/loggingMiddleware');
const errorHandlerMiddleware = require('./middleware/errorHandlerMiddleware');
const validateApiKey = require('./middleware/validateApiKey');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const swaggerLoader = require('./utils/swaggerLoader');
const swaggerDocument = swaggerLoader();
const app = express();
app.use(rateLimitMiddleware());


// Security Headers
app.use(helmet());

// JSON Parser
app.use(express.json());

// CORS Setup
const corsMiddleware = require('./middleware/corsMiddleware');
app.use(corsMiddleware);

// Logging Middleware
app.use(loggingMiddleware);

// API Key Validation
app.use(validateApiKey);

// API Documentation (Swagger)
if (swaggerDocument) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

// API Routes
app.use('/api/v1', routes);

// Health Check
app.get('/', (req, res) => {
  res.json({ message: 'VH Health API is running.' });
});

// Error Handler Middleware
app.use(errorHandlerMiddleware);

module.exports = app;
