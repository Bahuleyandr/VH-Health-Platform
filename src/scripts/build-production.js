// src/scripts/build-production.js
import { execSync } from 'node:child_process';

console.log('📦 Creating Sentry release...');

try {
  // 1. Get git commit hash as the release identifier
  const release = execSync('git rev-parse HEAD').toString().trim();
  console.log(`   Release version: ${release}`);

  // 2. Create the new release in Sentry
  // This command requires SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT
  // to be set as environment variables in your Render service.
  console.log('   Creating new release...');
  execSync(`npx sentry-cli releases new ${release}`, { stdio: 'inherit' });

  // 3. Finalize the release
  console.log('   Finalizing release...');
  execSync(`npx sentry-cli releases finalize ${release}`, { stdio: 'inherit' });

  console.log('\n✅ Sentry release created successfully!');

} catch (error) {
  console.error('\n❌ Failed to create Sentry release.');
  console.error('   Please ensure SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT environment variables are set correctly in Render.');
  process.exit(1);
}