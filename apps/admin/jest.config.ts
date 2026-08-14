import type { Config } from "jest";
import nextJest from "next/jest.js";

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files
  dir: "./",
});

const config: Config = {
  displayName: "vh-health-adminportal",
  testEnvironment: "jsdom",

  // Module name mapping to mirror tsconfig paths
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },

  // Polyfills run BEFORE the test framework loads so undici + related
  // fetch-API modules find TextEncoder / TextDecoder / Blob on globalThis.
  setupFiles: ["<rootDir>/jest.polyfills.js"],

  // Setup files run after the test framework is installed
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],

  // Only look for tests in src/__tests__
  testMatch: [
    "<rootDir>/src/__tests__/**/*.test.ts",
    "<rootDir>/src/__tests__/**/*.test.tsx",
  ],

  // TypeScript transform is handled by next/jest (uses SWC)
  // Ignore transforming node_modules except specific ESM packages if needed
  transformIgnorePatterns: ["/node_modules/(?!(lucide-react)/)"],

  // Coverage configuration
  coverageProvider: "v8",
  collectCoverageFrom: [
    // Risk-first protected surface. This is intentionally explicit rather
    // than claiming coverage across all 637 TypeScript production files.
    "src/app/api/login/route.ts",
    "src/app/api/logout/route.ts",
    "src/app/api/proxy/[...path]/route.ts",
    "src/app/api/refresh/route.ts",
    "src/lib/csrfOrigin.ts",
    "src/lib/install-api-fetch-guard.ts",
    "src/lib/api/investigations.ts",
    "src/lib/api/core.ts",
    "src/lib/proxyPermissions.ts",
    "src/lib/routePolicy.ts",
    "src/middleware.ts",
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 85,
      statements: 85,
    },
    "./src/middleware.ts": {
      branches: 65,
      functions: 100,
      lines: 85,
      statements: 85,
    },
    "./src/app/api/login/route.ts": {
      branches: 20,
      functions: 100,
      lines: 75,
      statements: 75,
    },
    "./src/app/api/logout/route.ts": {
      branches: 50,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    "./src/app/api/proxy/[...path]/route.ts": {
      branches: 75,
      functions: 70,
      lines: 85,
      statements: 85,
    },
    "./src/app/api/refresh/route.ts": {
      branches: 10,
      functions: 50,
      lines: 60,
      statements: 60,
    },
    "./src/lib/csrfOrigin.ts": {
      branches: 90,
      functions: 100,
      lines: 90,
      statements: 90,
    },
    "./src/lib/install-api-fetch-guard.ts": {
      branches: 70,
      functions: 70,
      lines: 85,
      statements: 85,
    },
    "./src/lib/api/investigations.ts": {
      branches: 80,
      functions: 30,
      lines: 80,
      statements: 80,
    },
    "./src/lib/api/core.ts": {
      branches: 85,
      functions: 100,
      lines: 95,
      statements: 95,
    },
    "./src/lib/proxyPermissions.ts": {
      branches: 85,
      functions: 100,
      lines: 95,
      statements: 95,
    },
    "./src/lib/routePolicy.ts": {
      branches: 85,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};

export default createJestConfig(config);
