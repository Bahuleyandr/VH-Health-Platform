// src/scripts/check-backend.ts
// Run with:
//   Linux/macOS: API_BASE_URL=... API_KEY=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx src/scripts/check-backend.ts
//   Windows (PowerShell):
//     $env:API_BASE_URL="https://vh-health-backend.onrender.com"
//     $env:API_KEY="vhhealth123"
//     $env:ADMIN_EMAIL="admin@vhhealth.local"
//     $env:ADMIN_PASSWORD="vhhealth123"
//     npx tsx src/scripts/check-backend.ts

const API_BASE = process.env.API_BASE_URL ?? 'https://vh-health-backend.onrender.com';
const API_KEY = process.env.API_KEY ?? 'vhhealth123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@vhhealth.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'vhhealth123';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type HeadersMap = Record<string, string>;

type BasicResult = { ok: boolean; status: number; data: unknown };

function url(path: string) {
  return path.startsWith('http') ? path : `${API_BASE}${path}`;
}

async function jsonOrText(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json();
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function hasKey<K extends string>(v: unknown, key: K): v is Record<K, unknown> {
  return isRecord(v) && key in v;
}

function extractToken(data: unknown): string | undefined {
  // Accept both { token } and { data: { token } }
  if (hasKey(data, 'token') && typeof data.token === 'string') return data.token;
  if (hasKey(data, 'data') && isRecord(data.data) && typeof data.data.token === 'string') {
    return String(data.data.token);
  }
  return undefined;
}

function getDoctorId(x: unknown): string | undefined {
  if (!isRecord(x)) return undefined;
  const idVal = (x.id ?? x.user_id) as unknown;
  if (typeof idVal === 'string' || typeof idVal === 'number') return String(idVal);
  return undefined;
}

async function call(
  path: string,
  method: Method = 'GET',
  body?: unknown,
  token?: string
): Promise<BasicResult> {
  const headers: HeadersMap = {
    'Content-Type': 'application/json',
    // many routes require these:
    Origin: 'http://localhost:3000',
  };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await jsonOrText(res);
  return { ok: res.ok, status: res.status, data };
}

function logResult(label: string, r: BasicResult) {
  const status = `${r.status}${r.ok ? ' ✅' : ' ❌'}`;
  console.log(`${label}: ${status}`);
  if (!r.ok) {
    // keep output readable in all environments
    try {
      console.log(typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2));
    } catch {
      console.log(r.data);
    }
  }
}

(async () => {
  console.log('--- VH Backend Route Probe ---');
  console.log('Base:', API_BASE, '\n');

  // 1) Seed/admin create (idempotent route name varies by backend)
  const createAdmin = await call('/auth/admin/create-admin', 'POST', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: 'superadmin',
  });
  logResult('Create admin', createAdmin);

  // 2) Login (try canonical path first; fallback to alt path)
  let login = await call('/api/v1/auth/admin/login', 'POST', {
    username: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (!login.ok || !extractToken(login.data)) {
    login = await call('/auth/admin/login', 'POST', {
      username: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
  }
  logResult('Login', login);

  const token = extractToken(login.data);

  // 3) Me
  logResult('Auth: /admin/auth/me', await call('/admin/auth/me', 'GET', undefined, token));

  // 4) Settings
  const settingsList = await call('/system/settings', 'GET', undefined, token);
  logResult('Settings: GET /system/settings', settingsList);

  // try to update one key if present
  let firstSettingKey: string | undefined;
  if (isRecord(settingsList.data) && Array.isArray(settingsList.data.settings)) {
    const first = settingsList.data.settings[0];
    if (isRecord(first) && typeof first.key === 'string') firstSettingKey = first.key;
  }
  if (firstSettingKey) {
    const updateSetting = await call(
      `/settings/${encodeURIComponent(firstSettingKey)}`,
      'PUT',
      { value: 'Updated via probe' },
      token
    );
    logResult(`Settings: PUT /settings/${firstSettingKey}`, updateSetting);
  }

  // 5) Users
  logResult('Users: GET /users', await call('/users?limit=5', 'GET', undefined, token));
  logResult('Users: GET /users/inactive', await call('/users/inactive', 'GET', undefined, token));

  // 6) Departments
  logResult(
    'Departments: GET /departments/manage',
    await call('/departments/manage', 'GET', undefined, token)
  );
  logResult(
    'Departments: POST /departments/create',
    await call('/departments/create', 'POST', { name: 'Test Dept' }, token)
  );

  // 7) Doctors
  const doctors = await call('/doctors', 'GET', undefined, token);
  logResult('Doctors: GET /doctors', doctors);

  let firstDoctorId: string | undefined;
  if (Array.isArray(doctors.data) && doctors.data.length > 0) {
    firstDoctorId = getDoctorId(doctors.data[0]);
  }
  if (firstDoctorId !== undefined) {
    logResult(
      `Doctors: DELETE /doctors/${firstDoctorId}`,
      await call(`/doctors/${firstDoctorId}`, 'DELETE', undefined, token)
    );
  }

  // 8) Logs
  logResult('Logs: GET /logs/audit', await call('/logs/audit?limit=5', 'GET', undefined, token));
  logResult('Logs: GET /logs/system', await call('/logs/system?limit=5', 'GET', undefined, token));
  logResult('Logs: Export audit', await call('/logs/audit/export?format=json', 'GET', undefined, token));
  logResult('Logs: Export system', await call('/logs/system/export?format=json', 'GET', undefined, token));

  // 9) Pharmacy
  logResult(
    'Pharmacy: GET /pharmacy/analytics',
    await call('/pharmacy/analytics', 'GET', undefined, token)
  );
  logResult(
    'Pharmacy: GET /pharmacy/orders',
    await call('/pharmacy/orders?limit=5', 'GET', undefined, token)
  );

  // 10) Reports
  const today = new Date();
  const from = new Date(today.getTime() - 30 * 24 * 3600 * 1000);
  const qs = new URLSearchParams({
    date_from: from.toISOString().slice(0, 10),
    date_to: today.toISOString().slice(0, 10),
  });
  logResult(
    'Reports: GET /reports/overview',
    await call(`/reports/overview?${qs.toString()}`, 'GET', undefined, token)
  );

  console.log('\nDone.');
})().catch((e) => {
  console.error('Probe failed fatally:', e);
  process.exit(1);
});
