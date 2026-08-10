// Every gateway->backend HTTP call carries a hard timeout. Without one, a
// wedged backend connection (half-open TCP, stalled proxy, unresponsive pod)
// pins acceptLegacy/drain passes forever instead of failing fast into the
// spool/retry path. Timeouts are normalized to code ETIMEDOUT with NO status
// so every classifier (legacyDeliveryFailureReason, observeBackendError, the
// legacy accept outage fallback) treats them as retriable/spool-worthy —
// never as a 4xx dead-letter.
export const DEFAULT_BACKEND_TIMEOUT_MS = 10_000;

function isAbortLike(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
    || err?.code === 'UND_ERR_CONNECT_TIMEOUT' || err?.code === 'UND_ERR_HEADERS_TIMEOUT'
    || err?.code === 'UND_ERR_BODY_TIMEOUT';
}

export class BackendClient {
  constructor({
    baseUrl, token, apiKey, fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_BACKEND_TIMEOUT_MS,
  }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.token = token;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  headers(extra = {}) {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      ...extra,
    };
  }

  async fetchWithTimeout(url, options, operation) {
    try {
      return await this.fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (isAbortLike(err)) {
        const timeout = new Error(`${operation} timed out after ${this.timeoutMs}ms`);
        timeout.code = 'ETIMEDOUT';
        timeout.cause = err;
        throw timeout;
      }
      throw err;
    }
  }

  async resolveDevice(payload) {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/v1/devices/vitals/resolve`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    }, 'device resolve');
    return readResponse(res, 'device resolve');
  }

  async ingest(payload) {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/v1/devices/vitals/ingest`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    }, 'device ingest');
    return readResponse(res, 'device ingest');
  }

  async readI09ResumeState({ gatewayRegistryId, deviceRegistryId }) {
    const query = new URLSearchParams({
      gateway_registry_id: String(gatewayRegistryId),
      device_registry_id: String(deviceRegistryId),
    });
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/devices/vitals/recovery/resume-state?${query}`,
      { method: 'GET', headers: this.headers() },
      'resume-state read',
    );
    return readResponse(res, 'resume-state read');
  }

  async ingestI09Recovery(payload) {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/v1/devices/vitals/ingest`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    }, 'I09 recovery ingest');
    return readResponse(res, 'I09 recovery ingest');
  }

  async ingestColdChain(payload, { deviceToken, tenantId = null } = {}) {
    const headers = {};
    if (deviceToken) {
      headers.authorization = `Bearer ${deviceToken}`;
      headers['x-device-token'] = deviceToken;
    }
    if (tenantId) headers['x-tenant-id'] = tenantId;
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/v1/ingest/cold-chain`, {
      method: 'POST',
      headers: this.headers(headers),
      body: JSON.stringify(payload),
    }, 'cold-chain ingest');
    const body = await readJson(res);
    if (!res.ok) throw Object.assign(new Error(body?.message || `cold-chain ingest failed ${res.status}`), { status: res.status, body });
    return body.data || body;
  }
}

export function backendTimeoutMsFromEnv(env = process.env) {
  const raw = env.DEVICE_GATEWAY_BACKEND_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_BACKEND_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('DEVICE_GATEWAY_BACKEND_TIMEOUT_MS must be a positive integer');
  }
  return parsed;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function readResponse(res, operation) {
  const body = await readJson(res);
  if (!res.ok) {
    const err = new Error(body?.message || `${operation} failed ${res.status}`);
    err.status = res.status;
    err.code = body?.code || 'BACKEND_REQUEST_FAILED';
    err.body = body;
    err.ambiguous = res.status >= 500;
    throw err;
  }
  return body?.data ?? body;
}
