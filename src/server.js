// server.js

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import logger from './logging/logger.js';
import { rateLimit } from './middleware/rateLimitMiddleware.js';
import { validateApiKey } from './middleware/validateApiKey.js';
import { swaggerLoader } from './utils/swaggerLoader.js'; // Assuming named export
import { errorHandler } from './middleware/errorHandlerMiddleware.js';
import corsConfig from './middleware/corsMiddleware.js'; // Assuming named export

// ✅ STEP 1: Use a default import to get the routes object
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

// ✅ STEP 2: Loop through the routes object and mount each router
// The old line `app.use('/', routes);` will not work. Replace it with this loop.
for (const routeName in routes) {
  // This will mount each router with a base path, e.g., /api/v1/auth, /api/v1/users
  app.use('/api/v1', routes[routeName]);
}


// ✅ Load Swagger Documentation if available
swaggerLoader(app);

// ✅ Fallback Error Handler
app.use(errorHandler);

// ✅ Start Server
app.listen(PORT, () => logger.info(`VH Health Backend running on port ${PORT}`));