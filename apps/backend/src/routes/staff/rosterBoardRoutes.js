import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as rosterBoardController from '../../controllers/staff/rosterBoardController.js';

const router = express.Router();

wrapAutoRBAC(router, 'staffRosterBoardRoutes', {
  get: [['/departments/:department', rosterBoardController.getDepartmentRoster]],
  post: [
    ['/departments/:department/boards', rosterBoardController.saveDepartmentRoster],
    ['/departments/:department/copy-previous', rosterBoardController.copyPreviousDepartmentRoster],
    ['/boards/:id/publish', rosterBoardController.publishDepartmentRoster]
  ]
});

export default router;
