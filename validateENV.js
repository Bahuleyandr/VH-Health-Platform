const Joi = require('joi');

const envSchema = Joi.object({
  API_KEY: Joi.string().required(),
  DATABASE_URL: Joi.string().uri().required(),
  ALLOWED_ORIGINS: Joi.string().required(),
  PORT: Joi.number().default(5000),
}).unknown();

const { error, value: envVars } = envSchema.validate(process.env);

if (error) {
  console.error('Environment validation error:', error.details.map(d => d.message).join(', '));
  process.exit(1);
}

module.exports = envVars;
