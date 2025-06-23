// server.js

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import logger from './logging/logger.js';
import rateLimit from './middleware/rateLimitMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import swaggerLoader from './utils/swaggerLoader.js';
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
app.use(rateLimit);
app.use(validateApiKey);

// ✅ Mount API Routes
app.use('/', routes);

// ✅ Load Swagger Documentation if available
swaggerLoader(app);

// ✅ Fallback Error Handler
app.use(errorHandler);

// ✅ Start Server
app.listen(PORT, () => logger.info(`VH Health Backend running on port ${PORT}`));
