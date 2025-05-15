// utils/validateEnv.js

const Joi = require('joi');

// Define the expected environment variables schema
const envSchema = Joi.object({
  API_KEY: Joi.string().required().label('API_KEY'),
  DATABASE_URL: Joi.string().uri().required().label('DATABASE_URL'),
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000').label('ALLOWED_ORIGINS'),
  PORT: Joi.number().default(5000).label('PORT'),
  RATE_LIMIT_WINDOW_MS: Joi.number().optional().label('RATE_LIMIT_WINDOW_MS'),
  RATE_LIMIT_MAX: Joi.number().optional().label('RATE_LIMIT_MAX'),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development').label('NODE_ENV'),
}).unknown(true);

// Validate the current environment variables
const { error, value: envVars } = envSchema.validate(process.env);

// Handle validation errors by terminating the application
if (error) {
  console.error('❌ Environment validation error:', error.details.map(d => d.message).join(', '));
  process.exit(1);
}

// Export validated environment variables for safe usage elsewhere
module.exports = envVars;
