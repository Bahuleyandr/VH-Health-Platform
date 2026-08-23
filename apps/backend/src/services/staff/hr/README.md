\# HR Services



This directory contains modularized HR services for staff management. Each service handles a specific domain of HR functionality.



\## Structure



```

hr/

├── dashboardService.js      # HR dashboard data and analytics

├── performanceService.js    # Performance reviews and ratings

├── onboardingService.js     # Staff onboarding management

├── leaveService.js          # Leave applications and balances

├── departmentService.js     # Department-level analytics

├── reportingService.js      # Report generation (CSV, JSON)

├── constants.js             # Shared constants and configurations

└── index.js                 # Main export hub

```



\## Services Overview



\### dashboardService.js

\- `getHRDashboardData(timeframe)` - Get comprehensive HR dashboard metrics



\### performanceService.js

\- `generatePerformanceReport(queryParams)` - Generate performance reports

\- `createPerformanceReview(reviewData)` - Create new performance review



\### onboardingService.js

\- `getOnboardingChecklist(staffId)` - Get onboarding tasks and progress

\- `updateOnboardingTask(staffId, taskId, completed, completedBy)` - Update task status

\- `isUserViewingOwnOnboarding(staffId, userUid)` - Permission check



\### leaveService.js

\- `getStaffLeaveBalance(staffId, year)` - Get leave balance for a year

\- `applyForLeave(leaveData)` - Submit leave application

\- `isUserViewingOwnData(staffId, userUid)` - Permission check

\- `isUserApplyingOwnLeave(staffId, userUid)` - Permission check



\### departmentService.js

\- `getDepartmentStaffSummary(department)` - Get department statistics

\- `getAttendanceAnalytics(queryParams)` - Get attendance analytics



\### reportingService.js

\- `generateStaffReport(reportParams)` - Generate various HR reports



\## Usage Examples



\### Import Specific Functions

```javascript

import { getHRDashboardData } from './services/staff/hr/dashboardService.js';

import { createPerformanceReview } from './services/staff/hr/performanceService.js';

```



\### Import Everything from Index

```javascript

import \* as hrServices from './services/staff/hr/index.js';



// Use functions

const dashboard = await hrServices.getHRDashboardData('30days');

const review = await hrServices.createPerformanceReview(reviewData);

```



\### Import from Legacy Location (Removed 2026-08-23)

The `services/staff/hrService.js` compatibility shim was deleted once every
consumer had migrated to `services/staff/hr/index.js`. Import from the modular
location only.



\## Migration Guide



1\. \*\*Update imports\*\* in your routes/controllers:

&nbsp;  ```javascript

&nbsp;  // Old way

&nbsp;  import { getHRDashboardData } from '../../services/staff/hrService.js';

&nbsp;  

&nbsp;  // New way

&nbsp;  import { getHRDashboardData } from '../../services/staff/hr/dashboardService.js';

&nbsp;  ```



2\. \*\*Test thoroughly\*\* - Both import methods work during transition



3\. \*\*Remove legacy imports\*\* once all code is updated



\## Constants



Shared constants are available in `constants.js`:

\- Performance rating levels

\- Leave statuses

\- Default onboarding tasks

\- Punctuality thresholds

\- Report types

\- Date formats



\## Error Handling



All services throw standard errors:

\- `STAFF\_NOT\_FOUND` - Staff member doesn't exist

\- `INSUFFICIENT\_PERMISSIONS` - User lacks required permissions

\- `INVALID\_DATE\_RANGE` - Invalid date parameters

\- `INSUFFICIENT\_LEAVE\_BALANCE` - Not enough leave days available



\## Database Tables Used



\- `users` - User information

\- `staff` - Staff profiles and details

\- `staff\_attendance` - Attendance records

\- `staff\_performance\_reviews` - Performance reviews

\- `staff\_onboarding\_tasks` - Onboarding checklists

\- `leave\_applications` - Leave requests

\- `leave\_types` - Leave type configurations

\- `notifications` - System notifications

\- `hr\_activity\_logs` - HR action logs

