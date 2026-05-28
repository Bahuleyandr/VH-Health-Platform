import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as rosterBoardController from '../../controllers/staff/rosterBoardController.js';

const router = express.Router();

wrapAutoRBAC(router, 'staffRosterBoardRoutes', {
  get: [
    ['/requests/my', rosterBoardController.getMyDutyPreferenceRequests],
    ['/departments/:department/requests', rosterBoardController.getDepartmentDutyPreferenceRequests],
    ['/departments/:department', rosterBoardController.getDepartmentRoster]
  ],
  post: [
    ['/requests', rosterBoardController.createDutyPreferenceRequest],
    ['/requests/:id/review', rosterBoardController.reviewDutyPreferenceRequest],
    ['/departments/:department/day-boards', rosterBoardController.saveDepartmentRosterDay],
    ['/departments/:department/boards', rosterBoardController.saveDepartmentRoster],
    ['/departments/:department/copy-previous', rosterBoardController.copyPreviousDepartmentRoster],
    ['/boards/:id/publish', rosterBoardController.publishDepartmentRoster]
  ]
});

export default router;
