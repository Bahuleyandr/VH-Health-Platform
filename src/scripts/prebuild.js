// scripts/prebuild.js
console.log('='.repeat(50));
console.log('PRE-BUILD ENVIRONMENT CHECK');
console.log('='.repeat(50));
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('NODE_VERSION:', process.version);
console.log('NPM_VERSION:', process.env.npm_version);
console.log('PWD:', process.cwd());
console.log('='.repeat(50));

// List all environment variables (be careful with secrets)
console.log('\nEnvironment Variables:');
Object.keys(process.env).sort().forEach(key => {
  if (!key.includes('SECRET') && !key.includes('KEY') && !key.includes('TOKEN')) {
    console.log(`${key}: ${process.env[key]}`);
  }
});

// Check package.json
try {
  const pkg = require('../package.json');
  console.log('\nPackage.json dependencies:');
  console.log('- Total dependencies:', Object.keys(pkg.dependencies).length);
  console.log('- Total devDependencies:', Object.keys(pkg.devDependencies).length);
  
  // Check for Babel plugins
  const babelDeps = Object.keys(pkg.dependencies).filter(dep => dep.includes('babel'));
  console.log('\nBabel-related dependencies:', babelDeps);
} catch (e) {
  console.log('Could not read package.json:', e.message);
}

console.log('='.repeat(50));