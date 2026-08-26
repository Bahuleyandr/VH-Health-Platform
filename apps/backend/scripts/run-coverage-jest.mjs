#!/usr/bin/env node
//
// run-coverage-jest.mjs — enforced coverage gate for roadmap B3.2.
//
// WHY THIS EXISTS / INTENT
// ------------------------
// The `jest` block in package.json carries a per-file `coverageThreshold` for
// the 5 B3.2 domains (auth / RLS / prescription / billing / cds) plus a scoped
// `collectCoverageFrom`. Two existing runners cannot enforce that gate:
//   - `npm test` / `run-ci-jest.mjs` (the chunked CI runner) deliberately do
//     NOT collect coverage — chunking splits the suite across many jest
//     invocations, so no single run has the whole picture, and `--coverage`
//     over all ~538 test files at once OOMs the V8 heap.
//   - a naive `jest --coverage` over the full suite OOMs for the same reason.
//
// So this runner scopes the coverage pass to ONLY the deterministic, fully
// (or DB-free) test files needed to exercise every source in
// `collectCoverageFrom` to its floor. It runs them in a single in-band jest
// invocation with `--coverage`, which makes jest read `coverageThreshold` from
// package.json and FAIL (exit 1) if any collected file misses its floor.
//
// Keep this list deterministic and reasonably fast: prefer the mocked
// `*Coverage.test.js` suites; only add a deeper/integration test when a source
// line genuinely needs it. When you raise a floor or add a collected source,
// add the suite(s) that cover it here and re-run `npm run test:coverage`.
//
// Determinism note: every suite below is either fully mocked or hits the
// jest.setup DATABASE_URL default; none depends on seeded DB state, so the gate
// is stable in CI and locally. Wall time is ~18s on the dev box.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const jestBin = path.join(backendRoot, 'node_modules', 'jest', 'bin', 'jest.js');

if (!existsSync(jestBin)) {
  console.error(`Jest binary not found at ${jestBin}. Run npm ci first.`);
  process.exit(1);
}

// The curated coverage test set. Grouped by the domain source(s) each block
// drives. Order is irrelevant (jest --runInBand merges coverage across all).
const COVERAGE_TESTS = [
  // ── auth: otpService ──
  'src/tests/unit/otpService.test.js',
  'src/tests/unit/otpServiceFailClosed.test.js',
  'src/tests/unit/otpServiceCrossSession.test.js',
  'src/tests/unit/otpServiceCoverage.test.js',
  // ── auth: apiClientService ──
  'src/tests/unit/apiClientService.test.js',
  'src/tests/unit/apiClientServiceCoverage.test.js',
  // ── auth: userActiveSession ──
  'src/tests/unit/userActiveSession.test.js',
  'src/tests/unit/userActiveSessionCoverage.test.js',
  // ── auth + middleware: jwtMiddleware ──
  'src/tests/unit/jwtMiddleware.test.js',
  'src/tests/unit/jwtMiddlewareCoverage.test.js',
  // ── auth: authService ──
  'src/tests/unit/authService.test.js',
  'src/tests/unit/authServiceCoverage.test.js',
  'src/tests/unit/adminPasswordResetOtp.test.js',
  'src/tests/unit/legacyPhoneAuthGate.test.js',
  // ── auth: adminOtpService ──
  'src/tests/unit/adminOtpServiceCoverage.test.js',
  // ── auth: firebaseAuthService ──
  'src/tests/unit/firebaseAuthService.test.js',
  'src/tests/unit/firebaseAuthServiceCoverage.test.js',
  // ── auth: loginSessionHelper ──
  'src/tests/unit/loginSessionHelperTenantClaim.test.js',
  // ── auth: staffAuthService ──
  'src/tests/unit/staffAuthServiceCoverage.test.js',
  'src/tests/unit/staffAuthRowGuards.test.js',
  'src/tests/unit/refreshStaffSession.test.js',
  'src/tests/unit/staffAuthServiceAttendanceTimezone.test.js',
  // ── billing: billingService ──
  'src/tests/unit/billingServiceCoverage.test.js',
  'src/tests/unit/billingHelpers.test.js',
  // ── billing: billingV2Service ──
  'src/tests/unit/billingV2ServiceCoverage.test.js',
  'src/tests/unit/billingV2IssueInvoice.test.js',
  'src/tests/unit/billingV2ListInvoices.test.js',
  'src/tests/unit/billingV2Payments.test.js',
  'src/tests/unit/billingV2AddItemSourceRef.test.js',
  'src/tests/unit/billingV2FrontOfficeAudit.test.js',
  // ── billing: cashDrawerService ──
  'src/tests/unit/cashDrawerService.test.js',
  'src/tests/unit/cash-payment-requires-shift.test.js',
  // ── billing: paymentLinkService ──
  'src/tests/unit/paymentLinkServiceCoverage.test.js',
  'src/tests/unit/paymentLinkService.test.js',
  // Covers the gateway-wave additions (public gateway view + checkout
  // wording): getPublicPaymentLinkView's resolvePublicGatewayView path.
  'src/tests/unit/publicPaymentPageView.test.js',
  // ── billing: ediGenerator ──
  'src/tests/unit/ediGenerator.test.js',
  // ── cds: cdsHooksAdapter / encounterCdsHelper + emr/cdsEngine ──
  'src/tests/unit/cdsHooksAdapter.test.js',
  'src/tests/unit/encounterCdsHelper.test.js',
  'src/tests/unit/cdsEngineCoverage.test.js',
  // ── prescription: prescriptionSafetyCheck ──
  'src/tests/unit/prescriptionSafetyCheckCoverage.test.js',
  // ── RLS: lib/prisma.js + lib/tenantContext.js ──
  'src/tests/unit/prismaCoverage.test.js',
  'src/tests/unit/prismaHardening.test.js',
  'src/tests/unit/prismaSessionTimeZone.test.js',
  'src/tests/unit/rlsDisabledLogLevel.test.js',
  'src/tests/unit/tenantRlsPosture.test.js',
  'src/tests/unit/tenantRlsConfig.test.js',
  'src/tests/unit/tenantContextCoverage.test.js',
  // ── RLS: middleware/tenantContextMiddleware.js + tenantRlsMiddleware.js ──
  'src/tests/unit/tenantContextMiddleware.test.js',
  'src/tests/unit/tenantContextMiddlewareCoverage.test.js',
  'src/tests/unit/tenantRlsMiddleware.test.js',
];

// 6144 (was 4096): the curated set grew past what a 4 GB heap survives in one
// in-band coverage pass (observed OOM 2026-08-10). GitHub-hosted ubuntu-latest
// runners have 16 GB, so 6 GB leaves ample headroom for the rest of the job.
// 8192 (was 6144): PR #926 (G1-G4) added src/services/billing/{gstEInvoice,tallyExport}Service.js
// to the instrumented collectCoverageFrom set, tipping the single in-band coverage pass past
// 6 GB (observed OOM 2026-08-26). ubuntu-latest has 16 GB, so 8 GB still leaves ample headroom.
const nodeFlags = ['--max-old-space-size=8192', '--experimental-vm-modules'];
const jestArgs = [
  '--runInBand',
  '--forceExit',
  '--coverage',
  '--coverageReporters=text',
  '--coverageReporters=text-summary',
  '--runTestsByPath',
  ...COVERAGE_TESTS,
];

// jest.setup.cjs defaults DATABASE_URL to the QA cluster when unset; honour any
// value already in the environment (CI / local override).
const result = spawnSync(process.execPath, [...nodeFlags, jestBin, ...jestArgs], {
  cwd: backendRoot,
  env: process.env,
  stdio: 'inherit',
});

process.exit(result.status === null ? 1 : result.status);
