// src/scripts/build-production.js
import * as SentryCli from '@sentry/cli';

const release = `vh-health-backend@${process.env.npm_package_version}`;
const cli = new SentryCli();

async function main() {
  console.log(`📦 Creating Sentry release: ${release}`);
  await cli.releases.new(release);

  console.log(`📤 Uploading source maps...`);
  await cli.releases.uploadSourceMaps(release, {
    include: ['./src'], 
    ignore: ['node_modules'],
    urlPrefix: '~/src',
  });

  await cli.releases.finalize(release);
  console.log(`✅ Sentry release complete.`);
}

main().catch((err) => {
  console.error('❌ Sentry release failed:', err);
  process.exit(1);
});
