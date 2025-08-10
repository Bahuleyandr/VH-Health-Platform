/* eslint-disable no-console */
// Run with: npx tsx src/scripts/check-backend.ts
// Env you can set: API_BASE_URL, API_KEY, ADMIN_EMAIL, ADMIN_PASSWORD

const API_BASE = process.env.API_BASE_URL ?? 'https://vh-health-backend.onrender.com';
const API_KEY = process.env.API_KEY ?? 'vhhealth123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@vhhealth.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'vhhealth123';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type HeadersMap = Record<string, string>;

function url(path: string) {
  return path.startsWith('http') ? path : `${API_BASE}${path}`;
}

async function jsonOrText(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json();
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
}

async function call(
  path: string,
  method: Method = 'GET',
  body?: unknown,
  token?: string
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: HeadersMap = { 'Content-Type': 'application/json' };
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

function logResult(label: string, r: { ok: boolean; status: number; data: unknown }) {
  const status = `${r.status}${r.ok ? ' ✅' : ' ❌'}`;
  console.log(`${label}: ${status}`);
  if (!r.ok) console.dir(r.data, { depth: 5, colors: true });
}

(async () => {
  console.log('--- VH Backend Route Probe ---');
  console.log('Base:', API_BASE, '\n');

  // 1) Seed/admin create (idempotent)
  const createAdmin = await call('/auth/admin/create-admin', 'POST', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: 'superadmin',
  });
  logResult('Create admin', createAdmin);

  // 2) Login (try /admin/auth/login first; fallback /auth/admin/login)
  let login = await call('/admin/auth/login', 'POST', { username: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (!login.ok || (typeof login.data === 'object' && login.data !== null && !(login as any).data?.token)) {
    login = await call('/auth/admin/login', 'POST', { username: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  }
  logResult('Login', login);

  const token =
    typeof login.data === 'object' && login.data !== null && 'token' in (login.data as Record<string, unknown>)
      ? String((login.data as Record<string, unknown>).token)
      : undefined;

  // 3) Me
  const me = await call('/admin/auth/me', 'GET', undefined, token);
  logResult('Auth: /admin/auth/me', me);

  // 4) Settings
  const settingsList = await call('/system/settings', 'GET', undefined, token);
  logResult('Settings: GET /system/settings', settingsList);

  // try to update one key if any present
  if (Array.isArray((settingsList.data as any)?.settings) && (settingsList.data as any).settings.length > 0) {
    const firstKey = (settingsList.data as any).settings[0]?.key ?? 'site_name';
    const updateSetting = await call(`/settings/${encodeURIComponent(firstKey)}`, 'PUT', { value: 'Updated via probe' }, token);
    logResult(`Settings: PUT /settings/${firstKey}`, updateSetting);
  }

  // 5) Users
  logResult('Users: GET /users', await call('/users?limit=5', 'GET', undefined, token));
  logResult('Users: GET /users/inactive', await call('/users/inactive', 'GET', undefined, token));

  // 6) Departments
  logResult('Departments: GET /departments/manage', await call('/departments/manage', 'GET', undefined, token));
  logResult('Departments: POST /departments/create', await call('/departments/create', 'POST', { name: 'Test Dept' }, token));

  // 7) Doctors
  const doctors = await call('/doctors', 'GET', undefined, token);
  logResult('Doctors: GET /doctors', doctors);
  const firstDoctorId =
    Array.isArray(doctors.data) && doctors.data.length
      ? (doctors.data[0] as any).id ?? (doctors.data[0] as any).user_id
      : undefined;
  if (firstDoctorId !== undefined) {
    logResult(`Doctors: DELETE /doctors/${firstDoctorId}`, await call(`/doctors/${firstDoctorId}`, 'DELETE', undefined, token));
  }

  // 8) Logs
  logResult('Logs: GET /logs/audit', await call('/logs/audit?limit=5', 'GET', undefined, token));
  logResult('Logs: GET /logs/system', await call('/logs/system?limit=5', 'GET', undefined, token));
  logResult('Logs: Export audit', await call('/logs/audit/export?format=json', 'GET', undefined, token));
  logResult('Logs: Export system', await call('/logs/system/export?format=json', 'GET', undefined, token));

  // 9) Pharmacy
  logResult('Pharmacy: GET /pharmacy/analytics', await call('/pharmacy/analytics', 'GET', undefined, token));
  logResult('Pharmacy: GET /pharmacy/orders', await call('/pharmacy/orders?limit=5', 'GET', undefined, token));

  // 10) Reports
  const today = new Date();
  const from = new Date(today.getTime() - 30 * 24 * 3600 * 1000);
  const qs = new URLSearchParams({ date_from: from.toISOString().slice(0, 10), date_to: today.toISOString().slice(0, 10) });
  logResult('Reports: GET /reports/overview', await call(`/reports/overview?${qs.toString()}`, 'GET', undefined, token));

  console.log('\nDone.');
})().catch((e) => {
  console.error('Probe failed fatally:', e);
  process.exit(1);
});
