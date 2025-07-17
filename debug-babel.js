// debug-babel.js
// Run this to check Babel configuration

const fs = require('fs');
const path = require('path');

console.log('🔍 Debugging Babel Build Environment\n');

// Check Node version
console.log('Node Version:', process.version);
console.log('NPM Version:', process.env.npm_version || 'Not available');

// Check environment
console.log('\n📦 Environment:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Current Directory:', process.cwd());

// Check if Babel plugins are installed
console.log('\n🔌 Checking Babel Plugins:');
const pluginsToCheck = [
  '@babel/core',
  '@babel/preset-env',
  '@babel/plugin-transform-optional-chaining',
  '@babel/plugin-transform-nullish-coalescing-operator',
  '@babel/plugin-syntax-import-meta'
];

pluginsToCheck.forEach(plugin => {
  try {
    const pluginPath = require.resolve(plugin);
    console.log(`✅ ${plugin} - Found at: ${pluginPath}`);
  } catch (e) {
    console.log(`❌ ${plugin} - NOT FOUND`);
  }
});

// Check babel config
console.log('\n📄 Babel Config:');
try {
  const babelConfig = require('./babel.config.js');
  console.log(JSON.stringify(babelConfig, null, 2));
} catch (e) {
  console.log('❌ Could not load babel.config.js:', e.message);
}

// Check if node_modules exists
console.log('\n📁 node_modules Check:');
const nodeModulesExists = fs.existsSync(path.join(process.cwd(), 'node_modules'));
console.log('node_modules exists:', nodeModulesExists);

if (nodeModulesExists) {
  const babelPath = path.join(process.cwd(), 'node_modules', '@babel');
  if (fs.existsSync(babelPath)) {
    const babelPackages = fs.readdirSync(babelPath);
    console.log('\n@babel packages installed:', babelPackages.length);
    console.log('Packages:', babelPackages.slice(0, 10).join(', '), '...');
  }
}

// Test Babel transpilation
console.log('\n🧪 Testing Babel Transpilation:');
const testCode = `const obj = { a: { b: 1 } }; const val = obj?.a?.b ?? 0;`;
console.log('Test code:', testCode);

try {
  const babel = require('@babel/core');
  const result = babel.transformSync(testCode, {
    presets: [['@babel/preset-env', { targets: { node: '18' } }]],
    plugins: [
      '@babel/plugin-transform-optional-chaining',
      '@babel/plugin-transform-nullish-coalescing-operator'
    ]
  });
  console.log('✅ Transpiled successfully:');
  console.log(result.code);
} catch (e) {
  console.log('❌ Transpilation failed:', e.message);
}