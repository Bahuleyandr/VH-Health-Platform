# Code Audit: VHHealth Admin Portal

**Audit Date**: 2026-03-25
**Scope**: `/home/bahuleyan/vhhealth-admin/src`
**Framework**: Next.js 15 (App Router), React 19, TypeScript 5, TanStack Query v5

> **⚠️ HISTORICAL DOCUMENT — many findings already resolved.** This is a
> point-in-time audit from 2026-03-25, preserved as a baseline. Major
> items resolved since:
> - `DashboardClient.tsx` (899L) — **deleted** in batch 20 (2026-04-24);
>   replaced by `Dashboard.tsx` thin orchestrator + per-section
>   components.
> - `CleanDashboard.tsx` (528L) — **renamed** to `Dashboard.tsx` in
>   batch 32 (2026-04-24); the two-file confusion this audit flagged
>   is gone.
> - Further god-page splits: ComplianceTab (batch 33), system-logs
>   (batch 39), audit (batch 40).
> - Testing: 21 Jest suites / 247 tests + 10 Playwright tests
>   (batches 41–42).
>
> Treat the recommendations below as context, not a live to-do list.
> The current roadmap is [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## STRENGTHS

### 1. **Well-Structured Directory Layout** ✅
- Clear separation of concerns: `app/`, `lib/`, `contexts/`, `components/`, `hooks/`, `providers/`
- Dashboard features grouped logically: `appointments/`, `doctors/`, `departments/`, `pharmacy/`, etc.
- API layer nicely organized into domain modules: `api/appointments.ts`, `api/doctors.ts`, etc.
- Barrel exports (`lib/api/index.ts`) maintain backward compatibility while organizing code into domain functions

### 2. **Strong TypeScript Coverage** ✅
- `tsconfig.json` with `"strict": true` — catches null, undefined, and type safety issues
- Comprehensive type definitions in `lib/types.ts` using Zod schemas
- Proper generic types: `APIResponse<T>`, `QueryParams`, `ApiList<T>`
- No widespread `any` types; uses `unknown` where necessary (e.g., in error handling, API responses)
- Good use of discriminated unions for permissions and statuses

### 3. **Modern State Management** ✅
- **TanStack Query v5** for server state (appointments, doctors, departments, etc.)
- **React Context** for auth state (`AuthContext.tsx`) — minimal, focused, appropriate use
- Proper cache invalidation patterns: `queryClient.invalidateQueries()`
- Query key design is predictable: `["doctors"]`, `["departments"]`, etc.
- No Redux boilerplate; complexity is justified

### 4. **Auth Architecture is Sound** ✅
- JWT stored in both `localStorage` (client) and `adminToken` cookie (SSR middleware)
- `AuthContext` manages login/logout/checkAuth lifecycle cleanly
- Middleware guards protected routes (`/dashboard/*`)
- `api-client.ts` centralizes token retrieval and persistence
- Cookie sync ensures SSR pages can access auth state
- Proper 401 handling with auto-redirect in `requestJSON`

### 5. **Error Handling & Resilience** ✅
- `APIError` class with `status` and `data` properties for structured error info
- `PageErrorBoundary` wraps pages to catch React errors gracefully
- Toast notifications for user feedback (via `react-hot-toast`)
- `try/catch` patterns in API calls with fallback behavior (e.g., cached user in `checkAuth`)
- Proper error propagation through async chains

### 6. **API Client Architecture** ✅
- Clean 3-layer abstraction:
  1. `apiFetch()` — low-level fetch with headers
  2. `requestJSON()` — parsing, error handling, 401 redirect
  3. `getJSON/postJSON/putJSON/deleteJSON` — convenience wrappers
- `fetchAdminAPI()` auto-prepends `/api/v1` for consistency
- Headers auto-injected: `Origin`, `x-api-key`, `Authorization: Bearer <token>`
- Configurable via `api-config.ts` (API_BASE_URL, API_KEY, endpoints)

### 7. **Good Component Patterns** ✅
- `DataTable<T>` generic component for reusable table rendering
- Proper use of React hooks: `useState`, `useEffect`, `useCallback`, `useMemo`, `useRef`
- Form handling with `react-hook-form` + `@hookform/resolvers` + Zod validation
- Controlled inputs; no uncontrolled form anti-patterns observed

### 8. **Performance Optimizations Present** ✅
- **Memoization**: 55+ instances of `React.memo`, `useMemo`, `useCallback`
- **TanStack Query**: automatic caching, deduping, background refetches
- **Debouncing**: `use-debounce` library for search/filter inputs
- **Virtual scrolling**: `@tanstack/react-virtual` for large lists (staff roster, logs)
- **Lazy loading**: Next.js code-splitting on route boundaries
- CSS Modules for scoped styling (e.g., `Dashboard.module.css`)

### 9. **Middleware & SSR Integration** ✅
- Next.js middleware checks `adminToken` cookie before serving `/dashboard/*`
- Proper redirect to `/login` for unauthenticated users
- Server-side auth state sync (cookie ← → localStorage)

### 10. **Developer Experience** ✅
- `CLAUDE.md` documents architecture, conventions, tech stack, and API client layers clearly
- README explains running, building, and deploying
- Well-named functions: `fetchAdminAPI`, `normalizeResponse`, `getAuthToken`
- Consistent import patterns using `@/*` path alias

---

## WEAKNESSES

### 1. **Giant Monolithic Components** ⚠️
- **`DashboardClient.tsx`**: 899 lines (state, API calls, rendering all in one file)
- **`CleanDashboard.tsx`**: 528 lines
- **`PermissionsMatrix.tsx`**: 416 lines (permission logic + UI + auditing)
- **`system-logs/page.tsx`**: 456 lines

**Impact**: Difficult to test, reuse, reason about. Multiple responsibilities per component.

**Recommendation**: Break into smaller, focused components.
- Extract dashboard stats fetching logic into a custom hook
- Split `PermissionsMatrix` into: `PermissionGrid`, `RoleTemplateSelector`, `AuditLog` sub-components
- Move business logic (auditing, filtering) into utils or hooks

### 2. **Limited Test Coverage** ⚠️
- **No `.test.tsx` or `.spec.ts` files found in `src/`** (only node_modules have tests from dependencies)
- Critical flows untested:
  - Auth flow (login/logout/token refresh)
  - Permission checking (RequirePermissions, ProtectedRoute)
  - API error handling and 401 redirect
  - Form validation and submission
  - Query cache invalidation

**Impact**: Bugs in critical flows slip to production. Refactoring is risky.

**Recommendation**: 
- Set up Jest + React Testing Library
- Write integration tests for auth flow
- Add snapshot tests for forms
- Test error boundary fallbacks
- Aim for 60%+ coverage on `lib/` and `contexts/`

### 3. **DashboardClient Hook Count & Dependency Churn** ⚠️
- Single component has 15+ `useState` calls
- Heavy reliance on raw API calls inside components instead of custom hooks
- Example: filtering logic (search, department, date range) should be in a `useDashboardFilters()` hook

**Impact**: 
- Hard to debug state mutations
- Filters logic scattered; difficult to reuse
- Performance: unnecessary re-renders when state changes

**Recommendation**:
- Consolidate filters into single state object
- Extract filter logic into `useDashboardFilters()` hook
- Use `useCallback` for filter handlers to memoize them

### 4. **Performance: DashboardClient Re-renders** ⚠️
- No memoization on dashboard components themselves (only internal hooks)
- `useState` for `showNotifications`, `showCommandPalette` etc. triggers full re-render
- Long-running `setInterval` for WebSocket checks not cleaned up properly in dependency arrays

**Impact**: Dashboard becomes sluggish when toggling features frequently.

**Recommendation**:
- Wrap sub-components in `React.memo()` to prevent parent re-renders
- Split dashboard state: move UI toggles (modals) to separate context if shared
- Ensure all `setInterval` cleanup in `useEffect` return statements

### 5. **Missing Input Validation & Sanitization** ⚠️
- Forms rely on Zod schemas but no explicit server-side validation confirmation
- User-provided input (search queries, filters) passed directly to API without pre-validation
- No CSRF token handling visible (relies on SameSite cookie)

**Impact**: XSS risk if backend doesn't validate. SQL injection risk if backend is weak.

**Recommendation**:
- Log input validation at API layer (e.g., `validateSearchQuery()` util)
- Add explicit CSRF token to mutating requests if needed
- Sanitize rich text inputs (if any) with `DOMPurify`
- Document backend validation contract in API comments

### 6. **Cookie Security** ⚠️
- Token stored in plain `localStorage` (XSS vector if site is compromised)
- Cookie set with `SameSite=Lax` (good) but no `Secure` flag visible in code
- 7-day expiration may be too long for sensitive healthcare data

**Impact**: Session hijacking if XSS occurs. Exposed tokens in localStorage.

**Recommendation**:
- Add `Secure` flag: `adminToken=...; Secure; SameSite=Strict`
- Consider shorter expiration (3-4 hours) with silent refresh
- Add HTTPS-only enforcement at Next.js config
- Consider moving auth to `httpOnly` cookie (backend reads, client doesn't see)

### 7. **Error Messages Leak Information** ⚠️
- API errors displayed directly to users: `error.message`
- Backend error details shown in toast notifications
- Console errors logged without sanitization

**Impact**: Information disclosure; attackers learn about backend structure from error messages.

**Recommendation**:
- Map backend error codes to generic user-facing messages
- Log detailed errors server-side only (via Sentry)
- Example: "Invalid credentials" instead of "User not found"

### 8. **API Response Normalization Not Standardized** ⚠️
- `normalizeList`, `normalizeResponse` used inconsistently
- Some components fetch raw API data, others normalize it
- Backend response envelope varies (`{ data, admins, users }`)

**Impact**: Bugs when API response shape changes. Hard to maintain consistency.

**Recommendation**:
- Always use `normalizeResponse()` wrapper for API calls
- Standardize backend to always return `{ success, message, data }` envelope
- Add type guards / discriminated unions for response shapes

### 9. **No Offline Support** ⚠️
- PWA manifest exists but no service worker logic for offline/sync
- Network failures immediately fail — no retry mechanism
- Cached data shown but no "offline mode" indicator

**Impact**: Poor UX on flaky networks. Data loss risk if user closes tab during API call.

**Recommendation**:
- Implement retry-on-fail in API layer (exponential backoff)
- Add offline indicator in UI
- Use TanStack Query's `networkMode: 'always'` or implement custom offline sync

### 10. **Documentation Gaps** ⚠️
- No inline comments in complex functions (e.g., permission matrix logic)
- API endpoint structure not documented (which endpoints need auth? which are read-only?)
- Custom hook signatures not commented (what does `useDashboardFilters` return?)

**Impact**: New devs slow to onboard. Refactoring risky without understanding intent.

**Recommendation**:
- Add JSDoc to public API functions
- Document permission matrix algorithm
- Add README for each feature (doctors, pharmacy, etc.)

---

## TECHNICAL DEBT

### 1. **Duplicate Query Client Setup**
- `QueryClient` created in both `app/providers.tsx` AND `providers/query-provider.tsx`
- One is used; the other is dead code
- **Fix**: Use one, remove the duplicate

### 2. **Inconsistent API Function Naming**
- `fetchAdminAPI()` vs `getJSON()` vs `postJSON()` — unclear when to use which
- Some domain functions call `fetchAdminAPI`, others use `postJSON` directly
- **Fix**: Pick one pattern (recommend `getJSON/postJSON`) and remove `fetchAdminAPI`

### 3. **Orphaned/Legacy Code**
- `DashboardClient.tsx` (899 lines) — seems to be replaced by `CleanDashboard.tsx`
- Both exist; unclear which is the source of truth
- Legacy query keys might not be used
- **Fix**: Delete `DashboardClient.tsx` or clearly document why both exist

### 4. **Hard-Coded Magic Numbers**
- Stale time: `60 * 1000` (1 minute) — no explanation
- Refetch interval: `30000` (30 seconds) — different from stale time
- Session timeout not documented
- Cookie expiry: `7 * 24 * 60 * 60` — no constant
- **Fix**: Extract to config constants with comments

### 5. **Missing Error Recovery**
- API calls fail → user sees error → no retry option visible
- `logout()` in AuthContext catches errors but doesn't show user feedback
- **Fix**: Add "Retry" button in error toast; log logout failures to Sentry

### 6. **Untyped API Responses in Some Places**
- `getAdminProfile()` returns `AdminUser | undefined` but callers don't always check
- `getJSON<unknown>()` used with cast later: `normalizeAdmins(data as any)`
- **Fix**: Type all API calls explicitly; avoid `unknown` where possible

### 7. **WebSocket Subscription Cleanup**
- `useAdminWebSocket` hook exists but not clear if listeners are cleaned up
- Could cause memory leaks if component unmounts mid-subscription
- **Fix**: Audit all socket handlers; ensure cleanup in `useEffect` return

### 8. **Permissions Not Cached**
- `RequirePermissions` re-evaluates on every render
- Permissions fetched from `useAuth()` context but not memoized
- **Fix**: Memoize permission checks; use `useMemo`

### 9. **Performance: Inline Objects in Render**
- Query keys created inline: `{ queryKey: ["doctors"] }`
- Filter objects passed without memoization
- **Fix**: Extract to constants; memoize filter objects with `useMemo`

### 10. **Missing Loading States**
- Some components show spinners; others don't
- Inconsistent UX: "pending" vs "loading" vs no feedback
- **Fix**: Create `<LoadingSpinner>` component; use uniformly

---

## REFACTOR OPPORTUNITIES

### High Priority

#### 1. **Extract Dashboard Logic into Hooks** (Effort: High | Impact: High)
```typescript
// src/hooks/useDashboardFilters.ts
export function useDashboardFilters() {
  const [filters, setFilters] = useState({
    search: '',
    department: 'all',
    dateRange: { start: null, end: null },
  });

  const updateFilter = useCallback((key: string, value: unknown) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  return { filters, updateFilter };
}

// src/hooks/useDashboardStats.ts
export function useDashboardStats() {
  return useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: api.getDashboardData,
    refetchInterval: 30000,
  });
}
```
**Before**: 899-line `DashboardClient.tsx`  
**After**: 300-line component + 3 focused hooks

---

#### 2. **Break PermissionsMatrix into Sub-components** (Effort: Medium | Impact: Medium)
```typescript
// src/app/(with-auth)/dashboard/admin-management/components/PermissionGrid.tsx
export function PermissionGrid({ admin, permissions, onToggle }: Props) {
  // Just the grid UI
}

// src/app/(with-auth)/dashboard/admin-management/components/RoleTemplates.tsx
export function RoleTemplates({ onApply }: Props) {
  // Role template selector
}

// src/app/(with-auth)/dashboard/admin-management/components/PermissionAuditLog.tsx
export function PermissionAuditLog({ entries }: Props) {
  // Audit log display only
}
```
**Before**: 416-line monolith  
**After**: 3 focused 120-line components

---

#### 3. **Add Jest + React Testing Library** (Effort: High | Impact: Critical)
```bash
npm install --save-dev jest @testing-library/react @testing-library/jest-dom jest-environment-jsdom
```
**Coverage targets**:
- `lib/api/core.ts` — 100% (error handling, retry logic)
- `contexts/AuthContext.tsx` — 100% (login/logout flow)
- `components/RequirePermissions.tsx` — 100% (permission checks)
- All custom hooks — 80%+
- Form components — 70%+

---

#### 4. **Implement API Response Normalization Standard** (Effort: Medium | Impact: Medium)
```typescript
// src/lib/api/normalize.ts
export function normalizeApiResponse<T>(
  raw: unknown,
  schema: ZodSchema,
): T {
  return schema.parse(raw);
}

// src/lib/api/admin.ts — always use this
export async function getAdmins(): Promise<AdminUser[]> {
  const raw = await getJSON(API_ENDPOINTS.auth.adminManagement);
  return normalizeApiResponse(raw, AdminUsersSchema);
}
```
**Before**: Inconsistent normalization, type casting issues  
**After**: Single source of truth, type-safe

---

### Medium Priority

#### 5. **Extract Filter Logic into URL Search Params** (Effort: Medium | Impact: Medium)
```typescript
// Filters persist in URL: /dashboard/doctors?search=smith&dept=cardio
import { useSearchParams } from 'next/navigation';

export function useDoctorFilters() {
  const searchParams = useSearchParams();
  const filters = {
    search: searchParams.get('search') || '',
    department: searchParams.get('dept') || 'all',
  };
  return filters;
}
```
**Benefit**: Shareable URLs, browser back button works, no state loss on refresh

---

#### 6. **Add Input Validation Util Layer** (Effort: Low | Impact: Medium)
```typescript
// src/lib/validation.ts
export function validateSearchQuery(query: string): string {
  // Max 100 chars, no special SQL chars
  if (query.length > 100) throw new Error('Search too long');
  return query.trim();
}

export function validateDateRange(start: Date, end: Date): boolean {
  // End must be after start
  return end > start;
}
```

---

#### 7. **Implement Retry Logic in API Layer** (Effort: Medium | Impact: High)
```typescript
// src/lib/api/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options = { maxRetries: 3, backoff: 1000 },
): Promise<T> {
  for (let i = 0; i < options.maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === options.maxRetries - 1) throw e;
      await sleep(options.backoff * Math.pow(2, i));
    }
  }
  throw new Error('Retries exhausted');
}
```

---

#### 8. **Upgrade to Secure Cookie Handling** (Effort: Low | Impact: High)
```typescript
// src/lib/api-client.ts
function setAuthCookie(token: string) {
  document.cookie = 
    `adminToken=${token}; ` +
    'path=/; ' +
    'Secure; ' + // HTTPS only
    'SameSite=Strict; ' + // Strict CSRF protection
    `max-age=${3 * 60 * 60}`; // 3 hours
}
```

---

### Low Priority

#### 9. **Extract Magic Numbers to Config**
```typescript
// src/lib/constants.ts
export const AUTH_CONFIG = {
  TOKEN_EXPIRY_SECONDS: 3 * 60 * 60, // 3 hours
  STALE_TIME_MS: 60 * 1000, // 1 minute
  REFETCH_INTERVAL_MS: 30 * 1000, // 30 seconds
};
```

---

#### 10. **Add JSDoc to Public Functions**
```typescript
/**
 * Fetch admin profile from backend and cache in localStorage.
 * Returns cached value if available; fetches fresh copy async.
 * @throws {APIError} if fetch fails and no cache exists
 */
export async function getAdminProfile(): Promise<AdminUser> {
  // ...
}
```

---

## SUMMARY SCORECARD

| Category | Score | Notes |
|----------|-------|-------|
| **Code Organization** | 8/10 | Good structure; some monolithic components |
| **TypeScript Coverage** | 9/10 | Strict mode enabled; minimal `any` types |
| **State Management** | 8/10 | TanStack Query + Context; well balanced |
| **Error Handling** | 7/10 | Error boundaries exist; some info leakage |
| **Testing** | 3/10 | **Critical gap** — no unit/integration tests |
| **Performance** | 7/10 | Memoization present; could optimize filters |
| **Security** | 6/10 | Auth solid; cookie security needs upgrade |
| **Documentation** | 7/10 | CLAUDE.md good; code comments sparse |
| **Maintainability** | 6/10 | Duplicates and tech debt present |
| **Overall** | **6.8/10** | **Solid foundation; needs testing & refactoring** |

---

## ACTION ITEMS (Priority Order)

### **CRITICAL (Do First)**
- [ ] Add Jest + React Testing Library; write auth tests
- [ ] Remove duplicate QueryClient setup
- [ ] Delete `DashboardClient.tsx` or clarify why both exist
- [ ] Add `Secure; SameSite=Strict` to auth cookies
- [ ] Add "Retry" button to error toasts

### **HIGH (Do Soon)**
- [ ] Split `DashboardClient.tsx` into focused hooks + smaller components
- [ ] Break `PermissionsMatrix.tsx` into 3 sub-components
- [ ] Standardize API response normalization
- [ ] Implement retry logic with exponential backoff
- [ ] Extract filters to URL search params

### **MEDIUM (Do Next Sprint)**
- [ ] Add input validation util layer
- [ ] Memoize permission checks
- [ ] Add performance monitoring (Sentry)
- [ ] Document API endpoints and permission matrix algorithm
- [ ] Audit WebSocket cleanup in hooks

### **LOW (Backlog)**
- [ ] Extract magic numbers to constants
- [ ] Add JSDoc to all public functions
- [ ] Improve offline support
- [ ] Implement global loading state management

---

**Next Steps**: Start with critical items. Testing framework will uncover more issues. Report back after first sprint.
