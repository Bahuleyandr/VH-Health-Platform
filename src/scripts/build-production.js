#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Correctly load .env file from the project root, two levels up from src/scripts/
dotenv.config({ path: path.join(__dirname, '../../.env') });

const buildForProduction = () => {
  console.log('🚀 Building VH-health-backend for production...');

  // 1. Check for required Sentry environment variables
  if (!process.env.SENTRY_AUTH_TOKEN || !process.env.SENTRY_ORG || !process.env.SENTRY_PROJECT) {
    console.error('❌ Error: SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT must be set in your environment variables.');
    process.exit(1);
  }

  // 2. Set production environment and build with source maps using the npm script.
  // This command runs from the project root, so it doesn't need path changes.
  process.env.NODE_ENV = 'production';
  execSync('npm run build:prod', { stdio: 'inherit' });
  console.log('✅ Babel build complete.');

  // 3. Create a unique Sentry release name (using the latest git commit hash)
  const release = execSync('git rev-parse HEAD').toString().trim();
  console.log(`📦 Creating Sentry release: ${release}`);

  // 4. Create the new release in Sentry
  execSync(`npx sentry-cli releases new "${release}"`, { stdio: 'inherit' });

  // 5. Upload source maps from the root 'dist' directory to the Sentry release.
  // The --url-prefix tells Sentry how to match files in the stack trace to the source maps.
  // '~/dist' is a common convention for Node.js apps where the app root is considered '~'.
  console.log('🗺️  Uploading source maps to Sentry...');
  execSync(
    `npx sentry-cli releases files "${release}" upload-sourcemaps ./dist --url-prefix "~/dist"`,
    { stdio: 'inherit' }
  );

  // 6. Finalize the release, marking it as complete
  execSync(`npx sentry-cli releases finalize "${release}"`, { stdio: 'inherit' });
  console.log('✅ Sentry release finalized.');

  // 7. Securely move source maps to a non-public directory
  // Paths are updated to reflect the script's new location inside src/scripts/
  const distPath = path.join(__dirname, '../../dist');
  const mapsPath = path.join(__dirname, '../../.sourcemaps');
  if (!fs.existsSync(mapsPath)) {
    fs.mkdirSync(mapsPath);
  }

  fs.readdirSync(distPath)
    .filter(file => file.endsWith('.map'))
    .forEach(mapFile => {
      const sourcePath = path.join(distPath, mapFile);
      const destPath = path.join(mapsPath, mapFile);
      fs.renameSync(sourcePath, destPath);
      console.log(`🔐 Moved ${mapFile} to secure location: ${mapsPath}`);
    });

  console.log('\n🎉 Production build and Sentry upload complete!');
};

buildForProduction();