// src/scripts/test-auth.ts
// Run this with: npx tsx src/scripts/test-auth.ts

const API_BASE_URL = 'https://vh-health-backend.onrender.com';
const API_KEY = 'vhhealth123';
const ORIGIN = 'http://localhost:3000'; // Or your actual frontend URL

async function testAuthEndpoints() {
  console.log('🧪 Testing VH Health Admin Authentication Endpoints\n');

  // Test 1: Check if auth endpoint exists
  console.log('1️⃣ Testing admin login endpoint...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/auth/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'Origin': ORIGIN,
        'Referer': ORIGIN,
        'User-Agent': 'VH-Health-Admin-Portal/1.0'
      },
      body: JSON.stringify({
        username: 'test_admin',
        password: 'wrong_password'
      })
    });

    console.log(`   Status: ${response.status}`);
    const data = await response.json();
    console.log(`   Response:`, JSON.stringify(data, null, 2));
    
    if (response.status === 500 && data.message === 'No origin header present') {
      console.log('   ⚠️  Backend requires Origin header\n');
    } else if (response.status === 401 || response.status === 400) {
      console.log('   ✅ Endpoint is working correctly (auth failed as expected)\n');
    } else {
      console.log('   ✅ Endpoint is reachable\n');
    }
  } catch (error) {
    console.log('   ❌ Endpoint error:', error.message, '\n');
  }

  // Test 2: Check profile endpoint (will fail without token)
  console.log('2️⃣ Testing admin profile endpoint...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/auth/admin/profile`, {
      method: 'GET',
      headers: {
        'x-api-key': API_KEY,
        'Origin': ORIGIN,
        'Referer': ORIGIN,
        'User-Agent': 'VH-Health-Admin-Portal/1.0'
      }
    });

    console.log(`   Status: ${response.status}`);
    const data = await response.json();
    console.log(`   Response:`, JSON.stringify(data, null, 2));
    
    if (response.status === 401) {
      console.log('   ✅ Endpoint exists and requires authentication\n');
    } else {
      console.log('   ℹ️  Unexpected response\n');
    }
  } catch (error) {
    console.log('   ❌ Endpoint error:', error.message, '\n');
  }

  // Test 3: Check health endpoint
  console.log('3️⃣ Testing health check endpoint...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/health-check`, {
      headers: {
        'x-api-key': API_KEY,
        'Origin': ORIGIN,
        'Referer': ORIGIN,
        'User-Agent': 'VH-Health-Admin-Portal/1.0'
      }
    });

    console.log(`   Status: ${response.status}`);
    const data = await response.json();
    console.log(`   Response:`, JSON.stringify(data, null, 2));
    console.log('   ✅ Health check complete\n');
  } catch (error) {
    console.log('   ❌ Health check error:', error.message, '\n');
  }

  // Test 4: Try actual login with test credentials
  console.log('4️⃣ Testing login with common default credentials...');
  const testCredentials = [
    { username: 'admin', password: 'admin' },
    { username: 'admin', password: 'admin123' },
    { username: 'admin', password: 'Admin@123' },
    { username: 'admin', password: 'password' },
    { username: 'admin@vhhealth.com', password: 'admin123' },
  ];

  for (const creds of testCredentials) {
    console.log(`   Trying ${creds.username} / ${creds.password}...`);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/admin/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'Origin': ORIGIN,
          'Referer': ORIGIN,
          'User-Agent': 'VH-Health-Admin-Portal/1.0'
        },
        body: JSON.stringify(creds)
      });

      const data = await response.json();
      
      if (response.ok && data.success) {
        console.log(`   ✅ SUCCESS! Valid credentials found!`);
        console.log(`   Token: ${data.data?.token?.substring(0, 50)}...`);
        console.log(`   Admin:`, data.data?.admin);
        break;
      } else {
        console.log(`   ❌ Failed: ${data.message}`);
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
    }
  }
  console.log('');

  // Test 5: Check for alternative auth endpoints
  console.log('5️⃣ Checking for alternative auth endpoints...');
  const alternativeEndpoints = [
    '/api/v1/auth/login',
    '/api/v1/auth/admin-login',
    '/api/v1/admin/login',
    '/api/v1/auth/generate-test-otp',
    '/api/v1/auth/request-otp'
  ];

  for (const endpoint of alternativeEndpoints) {
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'Origin': ORIGIN,
          'Referer': ORIGIN,
          'User-Agent': 'VH-Health-Admin-Portal/1.0'
        },
        body: JSON.stringify({ username: 'test', password: 'test' })
      });

      console.log(`   ${endpoint}: ${response.status}`);
    } catch (error) {
      console.log(`   ${endpoint}: Error - ${error.message}`);
    }
  }
}

// Run the tests
testAuthEndpoints().then(() => {
  console.log('\n✅ Test complete!');
  console.log('\n📝 Next steps:');
  console.log('1. Update your frontend API calls to include Origin header');
  console.log('2. Configure Next.js to handle CORS properly');
  console.log('3. Check with backend team for admin credentials');
}).catch(console.error);