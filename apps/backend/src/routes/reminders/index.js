import express from 'express';
import { validationResult } from 'express-validator';
import * as reminderController from '../../controllers/patient/medicationReminderController.js';
import { paramId, reminderValidator } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = express.Router();

// GET /medication/due must come before /:id to avoid matching "due" as an :id param
router.get('/medication/due', reminderController.getDueReminders);

// CRUD
router.post('/medication', ...reminderValidator, validate, reminderController.createReminder);
router.get('/medication', reminderController.getActiveReminders);
router.put('/medication/:id', paramId(), validate, reminderController.updateReminder);
router.delete('/medication/:id', paramId(), validate, reminderController.deactivateReminder);

export default router;
