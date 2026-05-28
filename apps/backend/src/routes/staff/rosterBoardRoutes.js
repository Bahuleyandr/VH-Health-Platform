import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as rosterBoardController from '../../controllers/staff/rosterBoardController.js';
import * as rosterForecastController from '../../controllers/staff/rosterForecastController.js';

const router = express.Router();

wrapAutoRBAC(router, 'staffRosterBoardRoutes', {
  get: [
    ['/requests/my', rosterBoardController.getMyDutyPreferenceRequests],
    ['/forecast/calendar-events', rosterForecastController.listCalendarEvents],
    ['/forecast/commute-profiles', rosterForecastController.listCommuteProfiles],
    ['/forecast/weather-signals', rosterForecastController.listWeatherSignals],
    ['/forecast/runs/:id/audit', rosterForecastController.getForecastAudit],
    ['/departments/:department/forecast/latest', rosterForecastController.getDepartmentForecast],
    ['/departments/:department/requests', rosterBoardController.getDepartmentDutyPreferenceRequests],
    ['/departments/:department', rosterBoardController.getDepartmentRoster]
  ],
  post: [
    ['/requests', rosterBoardController.createDutyPreferenceRequest],
    ['/requests/:id/review', rosterBoardController.reviewDutyPreferenceRequest],
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
