const buildForProduction = () => {
  console.log('🚀 Building VH-health-backend for production...');

  // 1. Load and verify environment variables
  const envPath = path.join(__dirname, '../../.env');
  const envLoaded = dotenv.config({ path: envPath });

  if (envLoaded.error) {
    console.warn(`⚠️ Failed to load .env file at ${envPath}: ${envLoaded.error}`);
  }

  if (!process.env.SENTRY_AUTH_TOKEN || !process.env.SENTRY_ORG || !process.env.SENTRY_PROJECT) {
    console.error('❌ Missing required Sentry env vars (SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT).');
    process.exit(1);
  }

  // 2. Run production build with source maps
  process.env.NODE_ENV = 'production';
  execSync('npm run build:prod', { stdio: 'inherit' });
  console.log('✅ Babel build complete.');

  // 3. Get git commit hash as release ID
  const release = execSync('git rev-parse HEAD').toString().trim();
  console.log(`📦 Creating Sentry release: ${release}`);

  // 4. Create release
  execSync(`npx sentry-cli releases new ${release}`, { stdio: 'inherit' });

  // 5. Upload sourcemaps using recommended syntax
  console.log('🗺️  Uploading source maps to Sentry using `sourcemaps upload`...');
  execSync(
    `npx sentry-cli sourcemaps upload --release ${release} ./dist ` +
    `--url-prefix "~/dist" --validate --rewrite --ext js --ext map`,
    { stdio: 'inherit' }
  );

  // 6. Finalize the release
  execSync(`npx sentry-cli releases finalize ${release}`, { stdio: 'inherit' });
  console.log('✅ Sentry release finalized.');

  // 7. Move sourcemaps to secure location
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
