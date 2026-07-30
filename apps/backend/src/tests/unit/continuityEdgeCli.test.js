import { parseArgs as parseAccessArgs } from '../../../scripts/continuity-edge-access.mjs';
import { parseArgs as parseLogArgs } from '../../../scripts/ingest-continuity-edge-logs.mjs';

describe('continuity edge operator CLI parsing', () => {
  it('keeps grant and renew inputs explicit and command-scoped', () => {
    const args = [
      '--tenant', '52e31913-c846-4458-a21b-31cd2f457e9b',
      '--facility', '41',
      '--location-type', 'ward',
      '--location', 'ward-10',
      '--staff', '22222222-2222-4222-8222-222222222222',
      '--device', 'edge-device-01',
      '--certificate', 'client.pem',
      '--valid-from', '2026-07-30T01:00:00.000Z',
      '--valid-until', '2026-07-30T04:00:00.000Z',
      '--policy-id', '55555555-5555-4555-8555-555555555555',
      '--policy-version', '12',
      '--actor', '33333333-3333-4333-8333-333333333333',
    ];

    expect(parseAccessArgs(['grant', ...args])).toMatchObject({
      command: 'grant',
      certificate: 'client.pem',
      device: 'edge-device-01',
    });
    expect(parseAccessArgs(['renew', ...args])).toMatchObject({
      command: 'renew',
    });
    expect(() => parseAccessArgs(['export', '--certificate', 'client.pem']))
      .toThrow('not supported by export');
    expect(() => parseAccessArgs([
      'revoke',
      '--grant', '44444444-4444-4444-8444-444444444444',
      '--grant', '77777777-7777-4777-8777-777777777777',
    ])).toThrow('duplicate flag');
  });

  it('accepts only one explicit actor, batch, and public certificate for log import', () => {
    expect(parseLogArgs([
      '--actor', '33333333-3333-4333-8333-333333333333',
      '--batch', 'batch.json',
      '--certificate', 'client.pem',
    ])).toEqual({
      actor: '33333333-3333-4333-8333-333333333333',
      batch: 'batch.json',
      certificate: 'client.pem',
    });
    expect(() => parseLogArgs([
      '--batch', 'one.json',
      '--batch', 'two.json',
    ])).toThrow('duplicate flag');
    expect(() => parseLogArgs(['--private-key', 'client.key']))
      .toThrow('unsupported flag');
  });
});
