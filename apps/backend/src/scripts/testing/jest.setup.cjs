// jest.setup.cjs — CommonJS setup file, runs before ESM test modules
// Using .cjs so Jest can load it before --experimental-vm-modules is fully active
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
} catch (err) {
  void err;
  // .env.local is optional — fall through to .env
}

try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
} catch (err) {
  void err;
  // .env also optional in test environments
}

// Ensure test bootstrap satisfies runtime env validation even when CI injects
// minimal placeholder secrets.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (!process.env.API_KEY) process.env.API_KEY = 'test-api-key';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgresql://<user>:<password>@localhost:5432/vhhealth_test';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars';
}

// Keep Jest output small enough to avoid CI heap blowups from repeated app bootstrap logs.
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.debug = () => {};
