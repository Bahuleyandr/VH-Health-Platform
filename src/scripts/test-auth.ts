export {};
import { API_BASE_URL, API_KEY, ORIGIN } from './config';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

async function ping(path: string, init?: RequestInit) {
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-api-key': API_KEY,
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

async function run() {
  console.log('🧪 Testing VH Health Admin Authentication Endpoints\n');

  try {
    const health = await ping('/admin/health');
    console.log(`   /admin/health: ${health.status} ${health.statusText}`);
  } catch (e: unknown) {
    console.log('   ❌ Health check error:', getErrorMessage(e), '\n');
  }

  const endpoints = ['/admin/settings', '/admin/users', '/admin/appointments'];
  for (const endpoint of endpoints) {
    try {
      const res = await ping(endpoint);
      console.log(`   ${endpoint}: ${res.status} ${res.statusText}`);
    } catch (e: unknown) {
      console.log(`   ${endpoint}: Error - ${getErrorMessage(e)}`);
    }
  }
}

run().catch(e => {
  console.error('Fatal:', getErrorMessage(e));
  process.exitCode = 1;
});
