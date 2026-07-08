import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import { GatewayRuntime, startGateway } from '../src/gateway.js';

const message = (id = 'CTRL-1') => [
  `MSH|^~\\&|MON-ICU-01|ICU||VHHEALTH|20260707090000||ORU^R01|${id}|P|2.5`,
  'PID|1||aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa||NL7^Patient',
  'PV1|1|I|BED-01',
  'OBR|1|||VITALS',
  'OBX|1|NM|8867-4^Heart rate||118|/min|||||F',
].join('\r');

async function tempRuntime(backendClient, maxSpoolBytes = 1024 * 1024) {
  const dir = await mkdtemp(join(tmpdir(), 'vh-gw-test-'));
  const runtime = new GatewayRuntime({ spoolDir: dir, backendClient, maxSpoolBytes });
  return { dir, runtime };
}

describe('GatewayRuntime', () => {
  it('ACKs AA only after durable spool append', async () => {
    const backend = {
      resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' }, patient_uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
      ingest: jest.fn(),
    };
    const { dir, runtime } = await tempRuntime(backend);
    try {
      const result = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-A') });
      expect(result.ackCode).toBe('AA');
      const raw = await readFile(join(dir, 'MON-ICU-01.ndjson'), 'utf8');
      expect(raw).toContain('CTRL-A');
      expect(result.ack).toContain('MSA|AA|CTRL-A');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns AR and does not append when spool is full', async () => {
    const backend = { resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' } })) };
    const { dir, runtime } = await tempRuntime(backend, 10);
    try {
      const result = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-FULL') });
      expect(result.ackCode).toBe('AR');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops duplicate MSH-10 control IDs with AA and no second spool row', async () => {
    const backend = {
      resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' }, patient_uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
    };
    const { dir, runtime } = await tempRuntime(backend);
    try {
      await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-DUP') });
      const second = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-DUP') });
      expect(second).toMatchObject({ ackCode: 'AA', duplicate: true });
      const entries = await runtime.spool('MON-ICU-01').entries();
      expect(entries).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drains in order and dead-letters 4xx failures', async () => {
    const seen = [];
    const backend = {
      resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' } })),
      ingest: jest.fn(async (payload) => {
        seen.push(payload.message.match(/CTRL-[0-9]/)[0]);
        if (payload.message.includes('CTRL-2')) {
          throw Object.assign(new Error('bad'), { status: 400, body: { message: 'bad payload' } });
        }
        return { ok: true };
      }),
    };
    const { dir, runtime } = await tempRuntime(backend);
    try {
      for (const id of ['CTRL-1', 'CTRL-2', 'CTRL-3']) {
        await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message(id) });
      }
      await runtime.drainSource('MON-ICU-01');
      expect(seen).toEqual(['CTRL-1', 'CTRL-2', 'CTRL-3']);
      const remaining = await runtime.spool('MON-ICU-01').entries();
      expect(remaining).toHaveLength(0);
      const dead = await readFile(join(dir, 'MON-ICU-01.dead.ndjson'), 'utf8');
      expect(dead).toContain('CTRL-2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers spool after restart without loss or duplicate drain', async () => {
    const drained = [];
    const backend = {
      resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' } })),
      ingest: jest.fn(async (payload) => {
        drained.push(payload.message.match(/CRASH-[0-9]/)[0]);
        return { ok: true };
      }),
    };
    const { dir, runtime } = await tempRuntime(backend);
    try {
      await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CRASH-1') });
      await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CRASH-2') });
      const restarted = new GatewayRuntime({ spoolDir: dir, backendClient: backend });
      await restarted.drainSource('MON-ICU-01');
      await restarted.drainSource('MON-ICU-01');
      expect(drained).toEqual(['CRASH-1', 'CRASH-2']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forwards cold-chain HTTP readings with the sensor bearer token', async () => {
    const backend = {
      ingestColdChain: jest.fn(async () => ({ action: 'reading_recorded' })),
    };
    const { dir, runtime } = await tempRuntime(backend);
    let started;
    try {
      started = await startGateway({
        listeners: [],
        runtime,
        metricsPort: 0,
        coldChainIngestPort: 0,
      });
      const address = started.coldChainServer.address();
      const res = await fetch(`http://127.0.0.1:${address.port}/ingest/cold-chain`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sensor-token',
          'content-type': 'application/json',
          'x-tenant-id': '00000000-0000-4000-8000-000000000001',
        },
        body: JSON.stringify({ unit_code: 'FRIDGE-1', temp_c: 4.2 }),
      });
      expect(res.status).toBe(202);
      expect(backend.ingestColdChain).toHaveBeenCalledWith(
        expect.objectContaining({
          unit_code: 'FRIDGE-1',
          temp_c: 4.2,
          source_ip: '127.0.0.1',
        }),
        {
          deviceToken: 'sensor-token',
          tenantId: '00000000-0000-4000-8000-000000000001',
        },
      );
    } finally {
      await new Promise((resolve) => started?.coldChainServer?.close(resolve));
      await new Promise((resolve) => started?.metricsServer?.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
