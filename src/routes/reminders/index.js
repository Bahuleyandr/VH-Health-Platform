import express from 'express';
import * as reminderController from '../../controllers/patient/medicationReminderController.js';

const router = express.Router();

// GET /medication/due must come before /:id to avoid matching "due" as an :id param
router.get('/medication/due', reminderController.getDueReminders);

// CRUD
router.post('/medication', reminderController.createReminder);
router.get('/medication', reminderController.getActiveReminders);
router.put('/medication/:id', reminderController.updateReminder);
router.delete('/medication/:id', reminderController.deactivateReminder);

export default router;
