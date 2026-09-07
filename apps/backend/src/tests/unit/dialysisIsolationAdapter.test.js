import fs from 'node:fs';
import { jest } from '@jest/globals';

import {
  SUPPORTED_CONTRACT_VERSION,
  _internal,
} from '../../services/clinical/dialysisIsolationAdapter.js';
import { CONTRACT_VERSION } from '../../services/clinical/dialysisIsolationResolver.js';

const TENANT = '76700000-0000-4000-8000-000000000002';
const PATIENT = '76700000-0000-4000-8000-00000000000a';
const ADAPTER_SOURCE = new URL('../../services/clinical/dialysisIsolationAdapter.js', import.meta.url);

function decision(overrides = {}) {
  return {
    contract_version: 2,
    status: 'unknown',
    asOf: '2026-09-07T08:00:00.000Z',
    reasons: [],
    evidence: 'none',
    evidence_dated_on: null,
    ...overrides,
  };
}

function adapterFor(moduleShape) {
  return _internal.createAdapter(async () => moduleShape);
}

function call(adapter) {
  return adapter({
    tenantId: TENANT,
    patientUids: [PATIENT],
    db: { $queryRawUnsafe: jest.fn() },
  });
}

describe('dialysis isolation adapter fail-closed boundary', () => {
  it('pins the independently hard-coded consumer version to the resolver version today', () => {
    expect(SUPPORTED_CONTRACT_VERSION).toBe(2);
    expect(SUPPORTED_CONTRACT_VERSION).toBe(CONTRACT_VERSION);

    const source = fs.readFileSync(ADAPTER_SOURCE, 'utf8');
    expect(source).toMatch(/export const SUPPORTED_CONTRACT_VERSION = 2;/);
    expect(source).not.toMatch(/import\s*\{[^}]*CONTRACT_VERSION[^}]*\}\s*from\s*['"]\.\/dialysisIsolationResolver\.js['"]/s);
  });

  it('refuses an absent resolver without falling back to legacy columns', async () => {
    const adapter = _internal.createAdapter(async () => { throw new Error('module absent'); });
    await expect(call(adapter)).rejects.toMatchObject({
      statusCode: 503,
      code: 'RPD_ISOLATION_RESOLVER_UNAVAILABLE',
    });
  });

  it('refuses a present resolver whose exported contract is incompatible without a tautological import', async () => {
    const source = fs.readFileSync(ADAPTER_SOURCE, 'utf8');
    expect(source).not.toMatch(/import\s*\{[^}]*CONTRACT_VERSION[^}]*\}\s*from\s*['"]\.\/dialysisIsolationResolver\.js['"]/s);

    const resolve = jest.fn();
    const adapter = adapterFor({ CONTRACT_VERSION: 3, resolveDialysisIsolation: resolve });
    await expect(call(adapter)).rejects.toMatchObject({
      statusCode: 503,
      code: 'RPD_ISOLATION_CONTRACT_VERSION_UNSUPPORTED',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a mismatched Decision version even when the module export matches', async () => {
    const adapter = adapterFor({
      CONTRACT_VERSION: 2,
      resolveDialysisIsolation: jest.fn().mockResolvedValue(new Map([
        [PATIENT, decision({ contract_version: 3 })],
      ])),
    });
    await expect(call(adapter)).rejects.toMatchObject({
      statusCode: 503,
      code: 'RPD_ISOLATION_CONTRACT_VERSION_UNSUPPORTED',
    });
  });

  it('rejects marker detail or class that was not requested', async () => {
    const withMarkers = adapterFor({
      CONTRACT_VERSION: 2,
      resolveDialysisIsolation: jest.fn().mockResolvedValue(new Map([
        [PATIENT, decision({ markers: [] })],
      ])),
    });
    await expect(call(withMarkers)).rejects.toMatchObject({ code: 'RPD_ISOLATION_DECISION_INVALID' });

    const withClass = adapterFor({
      CONTRACT_VERSION: 2,
      resolveDialysisIsolation: jest.fn().mockResolvedValue(new Map([
        [PATIENT, decision({ isolation_class: null })],
      ])),
    });
    await expect(call(withClass)).rejects.toMatchObject({ code: 'RPD_ISOLATION_DECISION_INVALID' });
  });

  it('accepts the exact opted-in marker and restricted-class shapes', async () => {
    const resolve = jest.fn().mockResolvedValue(new Map([[
      PATIENT,
      decision({
        status: 'restricted',
        reasons: ['DIALYSIS_HBSAG_POSITIVE'],
        evidence: 'marker',
        evidence_dated_on: '2026-09-07',
        markers: [{
          marker: 'hbsag',
          result: 'reactive',
          tested_on: '2026-09-07',
          marker_row_id: 7,
          source: 'lab_result',
        }],
        isolation_class: 'hbsag',
      }),
    ]]));
    const adapter = adapterFor({ CONTRACT_VERSION: 2, resolveDialysisIsolation: resolve });
    const decisions = await adapter({
      tenantId: TENANT,
      patientUids: [PATIENT],
      db: { $queryRawUnsafe: jest.fn() },
      includeMarkers: true,
      includeIsolationClass: true,
    });
    expect(decisions.get(PATIENT).markers).toHaveLength(1);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 2,
      includeMarkers: true,
      includeIsolationClass: true,
    }));
  });

  it('rejects a second door onto marker or policy detail', async () => {
    for (const extra of [
      { surveillance_overdue: false },
      { evidence_refs: [] },
      { isolation_profile: {} },
    ]) {
      const adapter = adapterFor({
        CONTRACT_VERSION: 2,
        resolveDialysisIsolation: jest.fn().mockResolvedValue(new Map([
          [PATIENT, decision(extra)],
        ])),
      });
      await expect(call(adapter)).rejects.toMatchObject({ code: 'RPD_ISOLATION_DECISION_INVALID' });
    }
  });
});
