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

  // Setup files run after the test framework is installed
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],

  // Only look for tests in src/__tests__
  testMatch: ["<rootDir>/src/__tests__/**/*.test.ts", "<rootDir>/src/__tests__/**/*.test.tsx"],

  // TypeScript transform is handled by next/jest (uses SWC)
  // Ignore transforming node_modules except specific ESM packages if needed
  transformIgnorePatterns: ["/node_modules/(?!(lucide-react|recharts)/)"],

  // Coverage configuration
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!src/**/index.ts",
    "!src/app/**/layout.tsx",
    "!src/app/**/loading.tsx",
  ],
};

export default createJestConfig(config);
