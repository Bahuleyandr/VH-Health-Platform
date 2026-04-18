// tests/testSourceMaps.js
require('source-map-support').install();

function testSourceMaps() {
  console.log('Testing source maps...\n');
  
  // Test 1: Simple error
  try {
    throw new Error('Test error - should show original line number');
  } catch (error) {
    console.log('Test 1 - Simple error:');
    console.log(error.stack);
    console.log('\n---\n');
  }
  
  // Test 2: Nested function error
  function level1() {
    level2();
  }
  
  function level2() {
    level3();
  }
  
  function level3() {
    throw new Error('Nested error - should show call stack');
  }
  
  try {
    level1();
  } catch (error) {
    console.log('Test 2 - Nested error:');
    console.log(error.stack);
    console.log('\n---\n');
  }
  
  // Test 3: Async error
  async function asyncError() {
    await new Promise(resolve => setTimeout(resolve, 10));
    throw new Error('Async error - should show async stack trace');
  }
  
  asyncError().catch(error => {
    console.log('Test 3 - Async error:');
    console.log(error.stack);
  });
}

// Run tests
if (require.main === module) {
  testSourceMaps();
}

module.exports = { testSourceMaps };