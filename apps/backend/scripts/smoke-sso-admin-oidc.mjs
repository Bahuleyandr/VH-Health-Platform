#!/usr/bin/env node

import assert from 'node:assert/strict';

const BACKEND_URL = stripTrailingSlash(process.env.ADMIN_OIDC_BACKEND_URL || 'http://127.0.0.1:5206');
const ADMIN_HOST = process.env.ADMIN_OIDC_ADMIN_HOST || 'smoke-admin.localhost:3001';
const PROVIDER = process.env.ADMIN_OIDC_PROVIDER || 'keycloak';
const USERNAME = process.env.ADMIN_OIDC_USERNAME || 'admin.sso@example.com';
const PASSWORD = process.env.ADMIN_OIDC_PASSWORD || 'admin-sso-dev-password';
const API_KEY = process.env.ADMIN_OIDC_API_KEY || process.env.API_KEY || '';

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(response) {
    for (const header of getSetCookies(response.headers)) {
      const pair = header.split(';', 1)[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('set-cookie');
  if (!value) return [];
  return value.split(/,(?=[^;,]+=)/);
}

function fail(message, details) {
  const suffix = details ? `\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}` : '';
  throw new Error(`[smoke-sso-admin-oidc] ${message}${suffix}`);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function findLoginAction(html, baseUrl) {
  const preferred = html.match(/<form[^>]+id=["']kc-form-login["'][^>]+action=["']([^"']+)["']/i);
  const fallback = html.match(/<form[^>]+action=["']([^"']+)["']/i);
  const action = decodeHtmlEntities(preferred?.[1] || fallback?.[1] || '');
  if (!action) fail('Keycloak login form action not found');
  return new URL(action, baseUrl).toString();
}

async function request(jar, url, options = {}) {
  const headers = {
    ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    ...(jar.header() ? { Cookie: jar.header() } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(url, {
    ...options,
    headers,
    redirect: 'manual',
  });
  jar.store(response);
  return response;
}

function redirectLocation(response, baseUrl, label) {
  const location = response.headers.get('location');
  if (!location) fail(`${label} did not return a redirect location`, { status: response.status });
  return new URL(location, baseUrl).toString();
}

async function main() {
  const jar = new CookieJar();
  const startUrl = new URL(`/api/v1/auth/admin/sso/oidc/${encodeURIComponent(PROVIDER)}/start`, BACKEND_URL);
  startUrl.searchParams.set('admin_host', ADMIN_HOST);
  startUrl.searchParams.set('returnTo', '/dashboard');
  startUrl.searchParams.set('deviceType', 'smoke');

  const start = await request(jar, startUrl.toString(), {
    headers: { Accept: 'text/html' },
  });
  if (start.status !== 302) fail(`start endpoint returned HTTP ${start.status}`, await start.text());
  const authUrl = redirectLocation(start, startUrl.toString(), 'start endpoint');

  const loginPage = await request(jar, authUrl, { headers: { Accept: 'text/html' } });
  if (!loginPage.ok) fail(`Keycloak login page returned HTTP ${loginPage.status}`, await loginPage.text());
  const loginHtml = await loginPage.text();
  const loginAction = findLoginAction(loginHtml, authUrl);

  const login = await request(jar, loginAction, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    body: new URLSearchParams({
      username: USERNAME,
      password: PASSWORD,
      credentialId: '',
    }).toString(),
  });

  let current = login;
  let currentUrl = loginAction;
  for (let i = 0; i < 8; i += 1) {
    if (current.status !== 302 && current.status !== 303) {
      fail(`OIDC redirect chain stopped at HTTP ${current.status}`, await current.text());
    }
    const nextUrl = redirectLocation(current, currentUrl, 'OIDC redirect');
    if (nextUrl.includes('/api/v1/auth/admin/sso/oidc/') && nextUrl.includes('/callback')) {
      currentUrl = nextUrl;
      break;
    }
    currentUrl = nextUrl;
    current = await request(jar, currentUrl, { headers: { Accept: 'text/html' } });
  }

  if (!currentUrl.includes('/callback')) {
    fail('OIDC flow did not reach the backend callback');
  }

  const callback = await request(jar, currentUrl, {
    headers: { Accept: 'application/json' },
  });
  const text = await callback.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!callback.ok) fail(`callback returned HTTP ${callback.status}`, body);

  const payload = body?.data ?? body;
  assert.ok(payload?.token, 'callback response must include a VH access token');
  assert.equal(payload?.admin?.role, 'ADMIN');
  console.log(`[smoke-sso-admin-oidc] accepted ${payload.admin.email} via ${PROVIDER}; token length=${payload.token.length}`);
}

await main();
