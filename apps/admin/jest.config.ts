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
  testMatch: ["<rootDir>/src/__tests__/**/*.test.ts", "<rootDir>/src/__tests__/**/*.test.tsx"],

  // TypeScript transform is handled by next/jest (uses SWC)
  // Ignore transforming node_modules except specific ESM packages if needed
  transformIgnorePatterns: ["/node_modules/(?!(lucide-react|recharts)/)"],

  // Coverage configuration
  coverageProvider: "v8",
  collectCoverageFrom: [
    // Start narrow: enforce coverage on high-risk request/auth surfaces first.
    "src/lib/install-api-fetch-guard.ts",
    "src/lib/api/investigations.ts",
    "src/lib/api/core.ts",
  ],
  coverageThreshold: {
    global: {
      branches: 40,
      functions: 30,
      lines: 70,
      statements: 70,
    },
    "./src/lib/install-api-fetch-guard.ts": {
      branches: 55,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    "./src/lib/api/investigations.ts": {
      branches: 80,
      functions: 30,
      lines: 80,
      statements: 80,
    },
    "./src/lib/api/core.ts": {
      branches: 80,
      functions: 10,
      lines: 25,
      statements: 25,
    },
  },
};

export default createJestConfig(config);
