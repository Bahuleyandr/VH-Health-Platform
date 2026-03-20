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
  bin/www.js          # HTTP server entrypoint (port 5000)
  config/             # Database, rate limits, RBAC, validation schemas
  controllers/        # Thin controllers grouped by domain
  middleware/          # Auth, CORS, rate limiting, RBAC, audit
  routes/             # Express routers grouped by domain
  services/           # Business logic layer
  utils/              # Helpers (JWT, phone normalization, R2 storage)
  validators/         # express-validator chains
  tests/              # Jest integration tests
  logging/            # Winston logger config
prisma/schema.prisma  # DB documentation (58 models, NOT used for queries)
```

## Key Architecture Decisions
- **Raw pg over Prisma**: All DB queries use `db.query()` from `DatabaseManager`. Prisma schema is documentation only.
- **Domain grouping**: Controllers, routes, services, validators are grouped by domain (auth/, appointment/, staff/, etc.)
- **wrapAutoRBAC**: Routes use `wrapAutoRBAC(router, configKey, routeMap)` from `src/config/routeWrapper.js` for role-based access control.
- **Response format**: All responses use `success(res, data, message)` or `error(res, message)` from `src/utils/responseHelper.js`. Envelope: `{ success: true, message: "...", data: {...} }`

## Auth Architecture
- **Patient login**: Firebase OTP → `POST /api/v1/auth/firebase/firebase-login` (idToken) → JWT
- **Staff login**: Employee ID + password → `POST /api/v1/auth/staff/login` → accessToken + refreshToken
- **Admin login**: Username + password → `POST /api/v1/auth/admin/login` → JWT
- **Middleware chain**: `validateApiKey` (x-api-key header) → `authMiddleware` (JWT Bearer) → route handlers
- **JWT generation**: `src/utils/jwtUtils.js` — `generateToken(payload, expiresIn?)`, accepts extra claims

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
node --experimental-vm-modules node_modules/jest/bin/jest.js critical-paths --forceExit
```

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
- Use `success(res, data, message)` / `error(res, message)` for responses
- Use `normalizePhone()` from `src/utils/phoneUtils.js` for all phone inputs
- Always use explicit column names in SELECT (no `SELECT *`)
- Add `@@index` to Prisma schema when adding new query patterns
- Controllers are thin — business logic goes in services
- Validate inputs with express-validator in `src/validators/`
