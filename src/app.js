require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimitMiddleware = require('./middleware/rateLimitMiddleware');
const { loggingMiddleware } = require('./middleware/loggingMiddleware');
const { errorHandlerMiddleware } = require('./middleware/errorHandlerMiddleware');
const { validateApiKey } = require('./middleware/validateApiKey');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./utils/swaggerLoader');

const app = express();

// Security Headers
app.use(helmet());

// JSON Parser
app.use(express.json());

// CORS Setup
app.use(cors());

// Logging Middleware
app.use(loggingMiddleware);

// Rate Limiting Middleware
app.use(rateLimitMiddleware());

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
