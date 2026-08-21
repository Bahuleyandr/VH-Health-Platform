import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as rosterBoardController from '../../controllers/staff/rosterBoardController.js';
import * as rosterForecastController from '../../controllers/staff/rosterForecastController.js';
import * as shiftSwapController from '../../controllers/staff/shiftSwapController.js';
import * as onCallRosterController from '../../controllers/staff/onCallRosterController.js';

const router = express.Router();

wrapAutoRBAC(router, 'staffRosterBoardRoutes', {
  get: [
    ['/assignments/my', rosterBoardController.getMyRosterAssignments],
    ['/requests/my', rosterBoardController.getMyDutyPreferenceRequests],
    ['/swaps/my', shiftSwapController.getMyShiftSwaps],
    ['/swaps/candidates', shiftSwapController.getSwapCandidates],
    ['/on-call/my', onCallRosterController.getMyOnCall],
    ['/on-call/now', onCallRosterController.getOnCallNow],
    ['/forecast/calendar-events', rosterForecastController.listCalendarEvents],
    ['/forecast/commute-profiles', rosterForecastController.listCommuteProfiles],
    ['/forecast/weather-signals', rosterForecastController.listWeatherSignals],
    ['/forecast/runs/:id/audit', rosterForecastController.getForecastAudit],
    ['/departments/:department/forecast/latest', rosterForecastController.getDepartmentForecast],
    ['/departments/:department/requests', rosterBoardController.getDepartmentDutyPreferenceRequests],
    ['/departments/:department/swaps', shiftSwapController.getDepartmentShiftSwaps],
    ['/departments/:department/on-call', onCallRosterController.getDepartmentOnCall],
    ['/departments/:department', rosterBoardController.getDepartmentRoster]
  ],
  post: [
    ['/requests', rosterBoardController.createDutyPreferenceRequest],
    ['/requests/:id/review', rosterBoardController.reviewDutyPreferenceRequest],
    ['/swaps', shiftSwapController.createShiftSwap],
    ['/swaps/:id/respond', shiftSwapController.respondShiftSwap],
    ['/swaps/:id/cancel', shiftSwapController.cancelShiftSwapRequest],
    ['/swaps/:id/review', shiftSwapController.reviewShiftSwapRequest],
    ['/on-call/:id/end', onCallRosterController.endOnCall],
    ['/departments/:department/on-call', onCallRosterController.createDepartmentOnCall],
    ['/forecast/calendar-events', rosterForecastController.saveCalendarEvent],
    ['/forecast/calendar-events/:id', rosterForecastController.saveCalendarEvent],
    ['/forecast/commute-profiles', rosterForecastController.saveCommuteProfile],
    ['/forecast/weather-signals', rosterForecastController.saveWeatherSignal],
    ['/forecast/runs/:id/review', rosterForecastController.reviewForecast],
    ['/departments/:department/forecast', rosterForecastController.createDepartmentForecast],
    ['/departments/:department/day-boards', rosterBoardController.saveDepartmentRosterDay],
    ['/departments/:department/boards', rosterBoardController.saveDepartmentRoster],
    ['/departments/:department/copy-previous', rosterBoardController.copyPreviousDepartmentRoster],
    ['/boards/:id/publish', rosterBoardController.publishDepartmentRoster]
  ]
});

export default router;
