// src/scripts/build.js
#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const buildWithSourceMaps = () => {
  console.log('🔨 Building VH-health-backend with source maps...');
  
  const env = process.env.NODE_ENV || 'development';
  console.log(`📦 Building for ${env} environment`);
  
  // Clean dist directory
  // PATH UPDATED
  const distPath = path.join(__dirname, '../../dist'); 
  if (fs.existsSync(distPath)) {
    fs.rmSync(distPath, { recursive: true });
  }
  
  // Build with Babel
  const buildCommand = env === 'production' 
    ? 'babel src -d dist --source-maps' 
    : 'babel src -d dist --source-maps inline';
    
  execSync(buildCommand, { stdio: 'inherit' });
  
  // Copy non-JS files
  const assetsToCopy = ['views', 'public', 'templates'];
  assetsToCopy.forEach(asset => {
    // PATH UPDATED
    const srcPath = path.join(__dirname, '../../src', asset); 
    if (fs.existsSync(srcPath)) {
      execSync(`cp -r ${srcPath} dist/${asset}`, { stdio: 'inherit' });
      console.log(`📁 Copied ${asset} folder`);
    }
  });
  
  // Copy .env files if needed
  if (env === 'development') {
    // PATH UPDATED
    const envPath = path.join(__dirname, '../../.env'); 
    if (fs.existsSync(envPath)) {
      execSync(`cp ${envPath} dist/.env`, { stdio: 'inherit' });
    }
  }
  
  console.log('✅ Build complete with source maps!');
  console.log(`📍 Output directory: ${distPath}`);
};

buildWithSourceMaps();