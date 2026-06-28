// src/routes/user/userSelfRoutes.js
//
// Self-service user routes — a caller acting on their OWN account only.
// Split out of userRoutes.js (CAN-055) so the broad user *directory* can drop
// PATIENT without also blocking patients from their own profile / `/me`.
import express from 'express';
import { UserController } from '../../controllers/user/userController.js';
import { sanitizeProfileFields } from '../../middleware/sanitizeMiddleware.js';
import { userValidation } from '../../validators/user/userValidator.js';

const router = express.Router();

// Create/Update the caller's OWN profile. Identity is bound from the verified
// token in the controller (see CAN-001/CAN-002); the body cannot retarget
// another user or set a privileged role.
router.post('/profile', userValidation, sanitizeProfileFields, UserController.createOrUpdateProfile);

// The authenticated user's own profile. Distinct from `getUserById('me')`
// which would slam 'me' into a UUID cast and 500.
router.get('/me', UserController.getMe);

export default router;
