# Hospital User Management Module Structure

## Overview

The hospital user management system has been modularized from a single 96,357-character file into a clean, maintainable architecture. This documentation outlines the organization and responsibilities of each module.

## Directory Structure

```
src/
├── config/
│   └── userConfig.js            # User roles, departments, and configuration
├── controllers/
│   ├── userController.js        # Main user operations
│   └── adminUserController.js   # Admin-specific operations
├── routes/
│   └── userRoutes.js           # Route definitions (now modularized)
├── services/
│   ├── userService.js          # Core user business logic
│   ├── userAuditService.js     # Audit logging service
│   ├── userAnalyticsService.js # Analytics and reporting
│   └── userQueries.js          # Centralized database queries
├── utils/
│   └── userUtils.js            # User utility functions
└── validators/
    └── userValidators.js       # Request validation schemas
```

## Module Responsibilities

### 1. **config/userConfig.js**
Centralizes all user management configuration:
- Hospital role definitions with hierarchy levels
- Department list
- Medical specialties
- User status types
- Access control matrix
- Risk level classifications

### 2. **controllers/userController.js**
Handles main user operations:
- `createOrUpdateProfile` - Create or update user profiles
- `bulkImportUsers` - Bulk user import
- `listUsers` - List users with filtering
- `getUserById` - Get user by identifier
- `getUsersByRole` - Get users by role
- `getUsersByDepartment` - Get users by department
- `searchUsers` - Advanced user search
- `updateUser` - Update user profile
- `changeUserStatus` - Change user status
- `deactivateUser` - Deactivate user account

### 3. **controllers/adminUserController.js**
Admin-only operations:
- `getUserAnalytics` - User analytics dashboard
- `getActivityAudit` - Activity audit logs
- `getInactiveUsersReport` - Inactive users report
- `reactivateUser` - Reactivate deactivated users
- `generateReport` - Generate various reports
- `getSystemInfo` - System configuration info

### 4. **services/userService.js**
Core business logic:
- User creation and updates
- User retrieval by various identifiers
- Status management
- Deactivation and reactivation
- Bulk operations

### 5. **services/userAuditService.js**
Audit and logging operations:
- Action logging
- Activity tracking
- Audit report generation
- Suspicious activity detection
- Log cleanup

### 6. **services/userAnalyticsService.js**
Analytics and reporting:
- User statistics
- Department analytics
- Activity metrics
- Inactive user analysis
- Custom report generation

### 7. **services/userQueries.js**
Centralized database queries:
- CRUD operations
- Complex search queries
- Aggregation queries
- Status management queries
- Audit log queries

### 8. **utils/userUtils.js**
Utility functions:
- Employee ID generation
- Access control checks
- User data formatting
- Risk level assessment
- Activity scoring

### 9. **validators/userValidators.js**
Request validation schemas:
- User data validation
- Search parameter validation
- Status change validation
- Bulk operation validation

## Key Features

### Role-Based Access Control (RBAC)
```javascript
// Access hierarchy
ADMIN > HR_MANAGER > CHIEF_DOCTOR/HEAD_NURSE > DOCTOR/NURSING_STAFF > SUPPORT_STAFF > PATIENT

// Example access check
if (!userUtils.canUserAccessOtherUser(requestingRole, targetRole, requestingId, targetId)) {
  throw new Error('Access denied');
}
```

### Hospital Role Hierarchy
```javascript
HOSPITAL_ROLES = {
  'ADMIN': { level: 1, department: 'Administration' },
  'CHIEF_DOCTOR': { level: 2, department: 'Medical' },
  'DOCTOR': { level: 3, department: 'Medical' },
  'NURSING_STAFF': { level: 4, department: 'Nursing' },
  'PATIENT': { level: 7, department: 'Patient Care' }
  // ... more roles
}
```

### Audit Trail
Every action is logged:
```javascript
await auditService.logUserAction(
  userId,        // Who performed the action
  action,        // What action was performed
  targetUserId,  // Who was affected
  details,       // Additional details
  ipAddress      // Where from
);
```

## API Endpoints

### User Management
- `POST /api/users/profile` - Create/update profile
- `GET /api/users` - List users
- `GET /api/users/:identifier` - Get user details
- `PUT /api/users/:identifier` - Update user
- `DELETE /api/users/:identifier` - Deactivate user

### Role/Department Based
- `GET /api/users/role/:role` - Get users by role
- `GET /api/users/department/:department` - Get users by department
- `GET /api/users/search` - Search users

### Admin Operations
- `GET /api/users/admin/analytics` - User analytics
- `GET /api/users/admin/activity-audit` - Activity audit
- `GET /api/users/admin/inactive-users` - Inactive users
- `POST /api/users/admin/reactivate/:userId` - Reactivate user
- `POST /api/users/admin/generate-report` - Generate reports

## Usage Examples

### Creating a User
```javascript
import { userService } from './modules/userModule/index.js';

const newUser = await userService.createOrUpdateUser({
  phone: '+1234567890',
  name: 'Dr. John Smith',
  role: 'DOCTOR',
  department: 'Cardiology',
  specialty: 'Cardiology'
}, requestingUser);
```

### Checking Access
```javascript
import { userUtils } from './modules/userModule/index.js';

const canAccess = userUtils.canUserAccessOtherUser(
  'DOCTOR',      // requesting user role
  'PATIENT',     // target user role
  'user-123',    // requesting user ID
  'user-456'     // target user ID
);
```

### Logging Actions
```javascript
import { auditService } from './modules/userModule/index.js';

await auditService.logUserAction(
  'user-123',
  'profile_updated',
  'user-456',
  'Updated emergency contact',
  '192.168.1.1'
);
```

## Security Features

1. **Role-Based Access**: Hierarchical access control
2. **Audit Logging**: Every action is logged
3. **Data Masking**: Sensitive data hidden based on permissions
4. **IP Tracking**: Track access locations
5. **Activity Monitoring**: Detect suspicious patterns
6. **Inactive User Management**: Automatic detection and reporting

## Migration Notes

### From Monolithic to Modular
1. All routes remain the same - no API changes
2. Internal functions now in services/utils
3. Configuration extracted to userConfig.js
4. Database queries centralized in userQueries.js

### Breaking Changes
- Direct access to internal functions no longer possible
- Must import from appropriate modules
- Configuration constants moved to userConfig.js

## Performance Considerations

1. **Database Queries**: Optimized with proper indexes
2. **Pagination**: Default 50 records per page
3. **Caching**: Consider adding Redis for frequently accessed data
4. **Audit Logs**: Automatic cleanup of old logs

## Future Enhancements

1. **Two-Factor Authentication**: For sensitive roles
2. **Session Management**: Track active sessions
3. **Password Policies**: Enforce strong passwords
4. **Email Notifications**: For important events
5. **API Rate Limiting**: Prevent abuse
6. **Export Functionality**: Export user data