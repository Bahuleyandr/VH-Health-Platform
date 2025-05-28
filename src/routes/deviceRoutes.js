import express from 'express';
import { registerDevice } from '../controllers/deviceController.js';
import validateApiKey from '../middleware/validateApiKey.js';
import jwtMiddleware from '../middleware/jwtMiddleware.js';

const router = express.Router();

router.post('/register', validateApiKey, jwtMiddleware, registerDevice);

export default router;
