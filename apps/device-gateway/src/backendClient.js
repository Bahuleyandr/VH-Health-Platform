export class BackendClient {
  constructor({ baseUrl, token, apiKey, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.token = token;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  headers() {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
    };
  }

  async resolveDevice(payload) {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/devices/vitals/resolve`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    const body = await readJson(res);
    if (!res.ok) throw Object.assign(new Error(body?.message || `resolve failed ${res.status}`), { status: res.status, body });
    return body.data || body;
  }

  async ingest(payload) {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/devices/vitals/ingest`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    const body = await readJson(res);
    if (!res.ok) throw Object.assign(new Error(body?.message || `ingest failed ${res.status}`), { status: res.status, body });
    return body.data || body;
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
