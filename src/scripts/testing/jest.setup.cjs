// jest.setup.cjs — CommonJS setup file, runs before ESM test modules
// Using .cjs so Jest can load it before --experimental-vm-modules is fully active
const path = require('path');
try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
} catch (e) {
  // .env.local is optional — fall through to .env
}
try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
} catch (e) {
  // .env also optional in test environments
}
