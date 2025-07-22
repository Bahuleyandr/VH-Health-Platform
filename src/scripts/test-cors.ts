// src/scripts/test-cors.ts
const API_BASE_URL = 'https://vh-health-backend.onrender.com';
const API_KEY = 'vhhealth123';

async function testCORS() {
  console.log('🧪 Testing CORS Configuration\n');

  // Test different origins
  const originsToTest = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://vh-health-portal.vercel.app',
    'https://vh-health-adminportal.vercel.app',
    'https://vh-health-admin.vercel.app',
  ];

  for (const origin of originsToTest) {
    console.log(`Testing origin: ${origin}`);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/health-check`, {
        method: 'GET',
        headers: {
          'x-api-key': API_KEY,
          'Origin': origin,
        },
      });

      const data = await response.json();
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${JSON.stringify(data).substring(0, 100)}...`);
      
      if (response.ok) {
        console.log(`  ✅ Origin allowed!\n`);
      } else {
        console.log(`  ❌ Origin blocked: ${data.message}\n`);
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}\n`);
    }
  }
}

testCORS();