# CLAUDE.md — VHHealth Backend

## Project Overview
Node.js/Express REST API backend for the VHHealth hospital management system. Serves three clients: patient Flutter app, staff Flutter app, and Next.js admin portal.

## Tech Stack
- **Runtime**: Node.js 22, Express 5
- **Database**: PostgreSQL (Docker container `vhhealth-db`, port 5433, user: vhhealth, db: vhhealth)
- **ORM**: Prisma schema exists for documentation, but **all queries use raw `pg` Pool** via `src/config/database.js`
- **Auth**: JWT (jsonwebtoken) + Firebase Admin SDK + bcrypt
- **Storage**: Cloudflare R2 (vh-health-records bucket)
- **Logging**: Winston (`src/logging/logger.js`)
- **Monitoring**: Sentry
- **Testing**: Jest + supertest

## Repository Layout
```
src/
  app.js              # Express app setup, route mounting, middleware chain
  bin/www.js          # HTTP server entrypoint (port 5000), graceful shutdown
  config/             # Database, rate limits, RBAC, validation schemas, upload config
  controllers/        # Thin controllers grouped by domain
  middleware/          # Auth, CORS, rate limiting, RBAC, audit, sanitization, file validation
  routes/             # Express routers grouped by domain
  services/           # Business logic layer
  utils/              # Helpers (JWT, phone, R2, sanitization)
  validators/         # express-validator chains
  tests/              # Jest integration tests (authorization, critical paths)
  logging/            # Winston logger config
prisma/schema.prisma  # DB documentation (58 models, NOT used for queries)
```

## Key Architecture Decisions
- **Raw pg over Prisma**: All DB queries use `db.query()` from `DatabaseManager`. Prisma schema is documentation only.
- **Domain grouping**: Controllers, routes, services, validators are grouped by domain (auth/, appointment/, staff/, etc.)
- **wrapAutoRBAC**: Routes use `wrapAutoRBAC(router, configKey, routeMap)` from `src/config/routeWrapper.js` for role-based access control.
- **Response format**: All responses use `success(res, data, message)` or `error(res, message)` from `src/utils/responseHelper.js`. Envelope: `{ success: true, message: "...", data: {...} }`
- **Unified req.user shape**: Both `authMiddleware` and `jwtMiddleware` normalize to `{ uid, id, role, phone, email }`. `uid` is the string UID, `id` is the DB integer PK. Use `String()` comparison for IDOR checks.
- **Input sanitization**: All user-facing text fields go through `stripHtml()` from `src/utils/sanitize.js` via middleware in `src/middleware/sanitizeMiddleware.js`.
- **File upload validation**: Multer + magic bytes verification (`validateFileContent`) + patient-specific restrictions (`validatePatientUpload`) in `src/middleware/uploadMiddleware.js`.

## Auth Architecture
- **Patient login**: Firebase OTP → `POST /api/v1/auth/firebase/firebase-login` (idToken) → JWT
- **Staff login**: Employee ID + password → `POST /api/v1/auth/staff/login` → accessToken + refreshToken
- **Admin login**: Username + password → `POST /api/v1/auth/admin/login` → JWT
- **Middleware chain**: `requestIdMiddleware` → `validateApiKey` (timing-safe) → `authMiddleware` (JWT + normalized req.user) → route handlers
- **JWT**: HS256 signed, 7d default expiry. App crashes on startup if `JWT_SECRET` missing. Token expiry differentiated: `TOKEN_EXPIRED` vs `TOKEN_INVALID` error codes.
- **API key**: Compared using `crypto.timingSafeEqual()` to prevent timing attacks.

## Security Architecture

### Rate Limiting
| Profile | Window | Max | Applied To |
|---------|--------|-----|------------|
| patient | 15min | 100 | /users, /appointments, /records, /feedback |
| staff | 15min | 500 | /staff/* |
| admin | 15min | 100 | /admin/*, /system/*, /logs/* |
| otp | 10min | 3 per phone | /auth/firebase-login, /auth/request-otp |
| sos | 1hr | 3 per user | POST /sos/ |

### IDOR Protection
All patient-facing mutation endpoints verify resource ownership:
- `PUT /appointments/:id` — `checkAppointmentPermission()` with `String()` comparison
- `DELETE /appointments/:id` — same
- `DELETE /appointments/patient/records/:id` — `WHERE patient_id=$2` scoped query
- Pharmacy legacy endpoints — phone ownership check for PATIENT role

### Input Sanitization
Applied via middleware from `src/middleware/sanitizeMiddleware.js`:
- Profile: name, address, allergies, emergency_contact
- Feedback: comment, question
- Pharmacy: order_note, delivery_address, delivery_landmark
- Investigation: notes, custom_test_names, collection_address
- Appointment: reason, notes
- SOS: notes, description, address

### File Upload Security
1. **Multer filter**: MIME type allowlist from `uploadConfig.js`
2. **Magic bytes**: `validateFileContent()` checks file header bytes match claimed MIME
3. **Patient restrictions**: `validatePatientUpload()` — JPEG/PNG/PDF only, 10MB images / 25MB PDFs
4. **Filename sanitization**: Dangerous character patterns rejected

### Phone-in-URL Mitigation
Prefer `/my` endpoints that derive phone from JWT:
- `GET /notifications/my` instead of `GET /notifications/:phone`
- `PATCH /notifications/my/mark-all-read`
- `GET /records/health-records/my`

### Request ID Correlation
- `requestIdMiddleware` generates UUID per request (or reuses `X-Request-Id` header)
- Available as `req.id` in all middleware/controllers
- Echoed back in `X-Request-Id` response header for client-side correlation

### Graceful Shutdown
- `SIGTERM` and `SIGINT` handlers in `bin/www.js`
- Closes HTTP server, drains DB pool, force-exits after 10s timeout

### Error Handling
- Global error handler in `src/middleware/errorHandlerMiddleware.js` with Sentry integration
- **Never expose `err.message` to clients** — log server-side, return generic message
- Stack traces only in development mode
- Unimplemented endpoints return `501 Not Implemented` (not `200`)

### Environment Validation
- `src/utils/validateEnv.js` validates all critical env vars at startup via Joi
- App crashes if `JWT_SECRET`, `DATABASE_URL`, or `API_KEY` missing
- Warns (but continues) if `R2_*`, `FIREBASE_PROJECT_ID`, `SENTRY_DSN` are missing

## Route Structure
Public (API key only): `/api/v1/auth/*`, `/api/v1/health`, `/api/v1/dashboard`
Protected (API key + JWT): `/api/v1/users/*`, `/api/v1/appointments/*`, `/api/v1/staff/*`
Admin only: `/api/v1/admin/*`, `/api/v1/system/*`, `/api/v1/logs/*`

## Running
```bash
npm start                 # Production (systemd: vhhealth-backend.service)
npm run dev               # Development with nodemon
```
Public URL: `https://api.vhhealth.app` (via Cloudflare tunnel + nginx)

## Testing
```bash
# All tests
node --experimental-vm-modules node_modules/jest/bin/jest.js --forceExit

# Authorization tests only (IDOR, JWT validation, rate limiting)
node --experimental-vm-modules node_modules/jest/bin/jest.js authorization --forceExit

# Critical path tests only
node --experimental-vm-modules node_modules/jest/bin/jest.js critical-paths --forceExit
```

### Authorization Test Coverage (`src/tests/authorization.test.js`)
- Appointment IDOR (PUT/DELETE ownership checks)
- Patient record IDOR (DELETE scoped by patient_id)
- Pharmacy order authorization (RBAC gating)
- Notification authorization (role-based access)
- JWT validation (expired → `TOKEN_EXPIRED`, tampered → `TOKEN_INVALID`, missing → 401)
- Rate limiting (OTP: 3/phone/10min, SOS: 3/user/hour)

## Database Access
```bash
docker exec vhhealth-db psql -U vhhealth -d vhhealth
```

## Related Repos
- **Patient App** (Flutter): `../vhhealth-patient` — github.com/Bahuleyandr/VH-health
- **Staff App** (Flutter): `../vhhealth-staff` — github.com/Bahuleyandr/vhhealth-staff
- **Admin Portal** (Next.js): `../vhhealth-admin` — github.com/Bahuleyandr/VH-Health-Adminportal
- **Core Package** (Dart): `../vhhealth-core` — github.com/Bahuleyandr/vhhealth-core

## Conventions
- Use `logger.info/warn/error()` (Winston), never `console.log` in production code
- Use `success(res, data, message)` / `error(res, message, statusCode)` for ALL API responses — no raw `res.json()`
- Use `normalizePhone()` from `src/utils/phoneUtils.js` for all phone inputs
- Always use explicit column names in SELECT (no `SELECT *`) — never return `pwd`, `pin_hash` to clients
- Add `@@index` to Prisma schema when adding new query patterns
- Controllers are thin — business logic goes in services. No inline handlers in route files.
- Validate inputs with express-validator in `src/validators/`
- Sanitize user text inputs with `sanitizeBody()` / domain-specific middleware before DB writes
- Use `String()` comparison for ID equality checks (DB int vs JWT string)
- Use parameterized queries (`$1, $2`) — never template literals in SQL
- Never expose `err.message` to clients — log it server-side, return generic message
- All environment secrets must be set — app crashes on missing `JWT_SECRET`
- Request IDs propagated via `X-Request-Id` header for log correlation

## Security Checklist (for PRs)
- [ ] No `SELECT *` — explicit columns only, never return `pwd`/`pin_hash`
- [ ] No `err.message` in API responses — use generic messages, log real errors server-side
- [ ] IDOR check on any endpoint that mutates a specific resource — use `String()` comparison
- [ ] Input sanitization on any user-provided text field — use `sanitizeBody()` middleware
- [ ] File uploads validated with `validateFileContent` + `validatePatientUpload`
- [ ] Rate limiting on any endpoint that triggers external actions (OTP, SOS, email)
- [ ] Parameterized queries (`$1, $2`) — never template literals in SQL (including `INTERVAL`)
- [ ] New env vars added to `validateEnv.js`
- [ ] All API responses use `success()`/`error()` helpers — no raw `res.json()` or `res.status().json()`
- [ ] No `console.log` — use Winston `logger.info/warn/error()`
- [ ] API key compared with `crypto.timingSafeEqual()` — no `===`/`!==`
- [ ] No hardcoded secrets or OTPs — crash on missing env vars, never fallback
