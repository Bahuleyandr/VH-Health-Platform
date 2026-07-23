import { jest } from '@jest/globals';

import {
  createPathwayReconciliationRegistry,
  isPathwayReconciliationRegistry,
  pathwayReconciliationRegistry,
} from '../../services/pathways/pathwayReconciliationRegistry.js';
import {
  CANONICAL_PATHWAY_KEYS,
  CARE_PATHWAY_KEYS,
} from '../../services/pathways/pathwayMode.js';

const CHECKSUM = 'a'.repeat(64);

function commonChecks(version = 'test.common.v1') {
  return [{ id: 'common_integrity', handlerVersion: version, run: jest.fn() }];
}

function profiles(overrides = {}) {
  return CANONICAL_PATHWAY_KEYS.map((pathwayKey, index) => ({
    pathwayKey,
    profileVersion: 1,
    commonCheckIds: ['common_integrity'],
    domainAdapters: [],
    repairDescriptors: [],
    excludedClocks: [],
    blockingReason: 'domain_adapter_pending',
    ...(overrides[pathwayKey] || {}),
    __index: index,
  })).map(({ __index: _index, ...profile }) => profile);
}

function registryInput(overrides = {}) {
  return {
    version: 7,
    commonChecks: commonChecks(),
    profiles: profiles(),
    ...overrides,
  };
}

function repairDescriptor(overrides = {}) {
  return {
    ruleCode: 'critical_result_ack',
    sourceTable: 'lab_result',
    handlerVersion: 'test.repair.v1',
    enabled: false,
    findCandidates: jest.fn(),
    validateSource: jest.fn(),
    resolveOwner: jest.fn(),
    materializeTask: jest.fn(),
    ...overrides,
  };
}

describe('pathwayReconciliationRegistry', () => {
  test('ships an exhaustive branded production registry with no live repair authority', () => {
    expect(isPathwayReconciliationRegistry(pathwayReconciliationRegistry)).toBe(true);
    expect(pathwayReconciliationRegistry.pathwayKeys).toEqual(CANONICAL_PATHWAY_KEYS);
    expect(pathwayReconciliationRegistry.checksum).toMatch(/^[0-9a-f]{64}$/);
    for (const pathwayKey of CANONICAL_PATHWAY_KEYS) {
      const profile = pathwayReconciliationRegistry.resolveProfile(pathwayKey);
      expect(profile.pathwayKey).toBe(pathwayKey);
      expect(profile.repairDescriptors).toEqual([]);
      if ([CARE_PATHWAY_KEYS.DIAGNOSTICS, CARE_PATHWAY_KEYS.REFERRAL].includes(pathwayKey)) {
        expect(profile.blockingReason).toBeNull();
        expect(profile.domainAdapters).toHaveLength(1);
        expect(profile.domainAdapters[0]).toMatchObject(pathwayKey === CARE_PATHWAY_KEYS.DIAGNOSTICS
          ? {
            adapterId: 'diagnostics_order_to_action_v1',
            workflowKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
            definitionVersion: 1,
          }
          : {
            adapterId: 'referral_request_to_closure_v1',
            workflowKey: CARE_PATHWAY_KEYS.REFERRAL,
            definitionVersion: 1,
          });
      } else {
        expect(profile).toMatchObject({
          blockingReason: 'vertical_domain_adapter_not_registered',
          domainAdapters: [],
        });
      }
    }
  });

  test('constructs immutable registries and does not accept lookalike objects', () => {
    const registry = createPathwayReconciliationRegistry(registryInput());
    expect(isPathwayReconciliationRegistry(registry)).toBe(true);
    expect(isPathwayReconciliationRegistry({ ...registry })).toBe(false);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.manifest)).toBe(true);
    expect(Object.isFrozen(registry.resolveProfile(CANONICAL_PATHWAY_KEYS[0]))).toBe(true);
    expect(() => registry.pathwayKeys.push('other')).toThrow();
    expect(() => registry.manifest.profiles.push({})).toThrow();
  });

  test('uses only normalized descriptor data for deterministic checksums', () => {
    const first = createPathwayReconciliationRegistry(registryInput());
    const sameVersionDifferentFunction = createPathwayReconciliationRegistry(registryInput({
      commonChecks: [{
        id: 'common_integrity',
        handlerVersion: 'test.common.v1',
        run: async () => ({ code: 'CHANGED_BODY', finding_count: 0 }),
      }],
    }));
    const bumped = createPathwayReconciliationRegistry(registryInput({
      commonChecks: commonChecks('test.common.v2'),
    }));
    expect(first.checksum).toBe(sameVersionDifferentFunction.checksum);
    expect(bumped.checksum).not.toBe(first.checksum);
  });

  test('rejects missing, duplicate, and unknown pathway profiles', () => {
    const complete = profiles();
    expect(() => createPathwayReconciliationRegistry(registryInput({
      profiles: complete.slice(1),
    }))).toThrow(/all six canonical/i);
    expect(() => createPathwayReconciliationRegistry(registryInput({
      profiles: [...complete, complete[0]],
    }))).toThrow(/duplicate pathway/i);
    expect(() => createPathwayReconciliationRegistry(registryInput({
      profiles: complete.map((profile, index) => (
        index === 0 ? { ...profile, pathwayKey: 'unknown_pathway' } : profile
      )),
    }))).toThrow(/unknown canonical pathway/i);
  });

  test('rejects duplicate checks, unversioned handlers, and unknown check references', () => {
    expect(() => createPathwayReconciliationRegistry(registryInput({
      commonChecks: [...commonChecks(), ...commonChecks()],
    }))).toThrow(/duplicate reconciliation check/i);
    expect(() => createPathwayReconciliationRegistry(registryInput({
      commonChecks: commonChecks('test.common'),
    }))).toThrow(/version/i);
    const unknown = profiles({
      [CANONICAL_PATHWAY_KEYS[0]]: { commonCheckIds: ['not_registered'] },
    });
    expect(() => createPathwayReconciliationRegistry(registryInput({ profiles: unknown })))
      .toThrow(/unknown check/i);
  });

  test('requires exact adapters and blocks an empty profile without a reason', () => {
    const emptyWithoutReason = profiles({
      [CANONICAL_PATHWAY_KEYS[0]]: { blockingReason: null },
    });
    expect(() => createPathwayReconciliationRegistry(registryInput({
      profiles: emptyWithoutReason,
    }))).toThrow(/blockingReason/i);

    const adapterProfiles = profiles({
      [CANONICAL_PATHWAY_KEYS[0]]: {
        blockingReason: null,
        domainAdapters: [{
          adapterId: 'diagnostics_v1',
          adapterVersion: 'test.diagnostics.v1',
          workflowKey: CANONICAL_PATHWAY_KEYS[0],
          definitionVersion: 1,
          definitionChecksum: CHECKSUM,
          checks: [{
            id: 'diagnostics_closure',
            handlerVersion: 'test.diagnostics_closure.v1',
            run: jest.fn(),
          }],
        }],
      },
    });
    const registry = createPathwayReconciliationRegistry(registryInput({
      profiles: adapterProfiles,
    }));
    expect(registry.matchDomainAdapter(CANONICAL_PATHWAY_KEYS[0], {
      definitionVersion: 1,
      definitionChecksum: CHECKSUM,
    })).toMatchObject({ adapterId: 'diagnostics_v1' });
    expect(registry.matchDomainAdapter(CANONICAL_PATHWAY_KEYS[0], {
      definitionVersion: 2,
      definitionChecksum: CHECKSUM,
    })).toBeUndefined();
  });

  test('rejects wildcard and duplicate rule/source authority', () => {
    const wildcard = profiles({
      [CANONICAL_PATHWAY_KEYS[0]]: {
        repairDescriptors: [repairDescriptor({ sourceTable: '*' })],
      },
    });
    expect(() => createPathwayReconciliationRegistry(registryInput({ profiles: wildcard })))
      .toThrow(/canonical identifier/i);

    const duplicate = profiles({
      [CANONICAL_PATHWAY_KEYS[0]]: {
        repairDescriptors: [repairDescriptor()],
        excludedClocks: [{
          ruleCode: 'critical_result_ack',
          sourceTable: 'lab_result',
          ownerEvidenceRef: 'domain_owned_clock',
        }],
      },
    });
    expect(() => createPathwayReconciliationRegistry(registryInput({ profiles: duplicate })))
      .toThrow(/duplicate rule\/source/i);

    const duplicateAcrossProfiles = profiles({
      [CANONICAL_PATHWAY_KEYS[0]]: {
        repairDescriptors: [repairDescriptor()],
      },
      [CANONICAL_PATHWAY_KEYS[1]]: {
        excludedClocks: [{
          ruleCode: 'critical_result_ack',
          sourceTable: 'lab_result',
          ownerEvidenceRef: 'domain_owned_clock',
        }],
      },
    });
    expect(() => createPathwayReconciliationRegistry(registryInput({
      profiles: duplicateAcrossProfiles,
    }))).toThrow(/duplicate rule\/source/i);
  });
});
