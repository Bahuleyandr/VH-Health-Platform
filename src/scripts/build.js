#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const buildWithSourceMaps = () => {
  console.log('🔨 Building VH-health-backend with source maps...');

  const env = process.env.NODE_ENV || 'development';
  console.log(`📦 Building for ${env} environment`);

  // Clean dist directory
  const distPath = path.join(__dirname, '../../dist');
  if (fs.existsSync(distPath)) {
    fs.rmSync(distPath, { recursive: true, force: true });
    console.log('🧹 Cleaned dist directory.');
  }

  // Determine the correct build command based on environment
  const buildCommand = env === 'production'
    ? 'npm run build:prod' // Uses separate source maps for production
    : 'npm run build:dev'; // Uses inline source maps for development

  execSync(buildCommand, { stdio: 'inherit' });

  // Copy non-JS asset files to the dist folder
  const assetsToCopy = ['views', 'public', 'templates'];
  assetsToCopy.forEach(asset => {
    const srcPath = path.join(__dirname, '../../src', asset);
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(distPath, asset);
      execSync(`cp -r ${srcPath} ${destPath}`, { stdio: 'inherit' });
      console.log(`📁 Copied ${asset} folder to dist.`);
    }
  });

  // Copy .env file in development for convenience
  if (env === 'development') {
    const envPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(envPath)) {
      fs.copyFileSync(envPath, path.join(distPath, '.env'));
      console.log('📋 Copied .env file to dist for development.');
    }
  }

  console.log('✅ Build complete with source maps!');
  console.log(`📍 Output directory: ${distPath}`);
};

buildWithSourceMaps();
