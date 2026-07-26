import { jest } from '@jest/globals';

import {
  createPathwayReconciliationRegistry,
  isPathwayReconciliationRegistry,
  pathwayReconciliationRegistry,
  pathwayReconciliationRegistryV4,
  pathwayReconciliationRegistryV5,
} from '../../services/pathways/pathwayReconciliationRegistry.js';
import { compileDiagnosticsOrderToActionDefinition } from '../../services/pathways/diagnosticsPathwayDefinition.js';
import { compileInpatientAdmissionToRecoveryDefinition } from '../../services/pathways/inpatientPathwayDefinition.js';
import { compileOpContactToRecoveryDefinition } from '../../services/pathways/opPathwayDefinition.js';
import { compileReferralRequestToClosureDefinition } from '../../services/pathways/referralPathwayDefinition.js';
import {
  CANONICAL_PATHWAY_KEYS,
  CARE_PATHWAY_KEYS,
} from '../../services/pathways/pathwayMode.js';
import {
  workflowRuntimeRegistryV2,
  workflowRuntimeRegistryV3,
  workflowRuntimeRegistryV4,
} from '../../services/workflow/workflowRuntimeRegistry.js';

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
    expect(pathwayReconciliationRegistry).toBe(pathwayReconciliationRegistryV5);
    expect(pathwayReconciliationRegistry.version).toBe(5);
    expect(pathwayReconciliationRegistryV4.version).toBe(4);
    expect(isPathwayReconciliationRegistry(pathwayReconciliationRegistryV4)).toBe(true);
    expect(isPathwayReconciliationRegistry(pathwayReconciliationRegistry)).toBe(true);
    expect(pathwayReconciliationRegistry.pathwayKeys).toEqual(CANONICAL_PATHWAY_KEYS);
    expect(pathwayReconciliationRegistry.checksum)
      .toBe('cea7cbd09234bf85657444e9f6eae6358e549ea1798ef756fe12045a5ccf2929');
    expect(pathwayReconciliationRegistryV4.checksum)
      .toBe('e28608a8430d6518b0b61d2ceaa4154a9d669f0da7cee033caae75544e22e0c4');
    expect(pathwayReconciliationRegistry.checksum)
      .not.toBe(pathwayReconciliationRegistryV4.checksum);
    const expectedAdapters = {
      [CARE_PATHWAY_KEYS.DIAGNOSTICS]: {
        adapterId: 'diagnostics_order_to_action_v1',
        checksum: compileDiagnosticsOrderToActionDefinition({
          registry: workflowRuntimeRegistryV2,
        }).checksum,
      },
      [CARE_PATHWAY_KEYS.REFERRAL]: {
        adapterId: 'referral_request_to_closure_v1',
        checksum: compileReferralRequestToClosureDefinition({
          registry: workflowRuntimeRegistryV3,
        }).checksum,
      },
      [CARE_PATHWAY_KEYS.OP]: {
        adapterId: 'op_contact_to_recovery_v1',
        checksum: compileOpContactToRecoveryDefinition({
          registry: workflowRuntimeRegistryV4,
        }).checksum,
      },
      [CARE_PATHWAY_KEYS.INPATIENT]: {
        adapterId: 'inpatient_admission_to_recovery_v1',
        checksum: compileInpatientAdmissionToRecoveryDefinition({
          registry: workflowRuntimeRegistryV4,
        }).checksum,
      },
    };
    for (const pathwayKey of CANONICAL_PATHWAY_KEYS) {
      const profile = pathwayReconciliationRegistry.resolveProfile(pathwayKey);
      expect(profile.pathwayKey).toBe(pathwayKey);
      expect(profile.repairDescriptors).toEqual([]);
      if (expectedAdapters[pathwayKey]) {
        expect(profile.blockingReason).toBeNull();
        expect(profile.domainAdapters).toHaveLength(1);
        expect(profile.profileVersion).toBe(2);
        expect(profile.domainAdapters[0]).toMatchObject({
          adapterId: expectedAdapters[pathwayKey].adapterId,
          workflowKey: pathwayKey,
          definitionVersion: 1,
          definitionChecksum: expectedAdapters[pathwayKey].checksum,
        });
      } else {
        expect(profile).toMatchObject({
          profileVersion: 1,
          blockingReason: 'vertical_domain_adapter_not_registered',
          domainAdapters: [],
        });
      }
    }
    expect(pathwayReconciliationRegistryV4.resolveProfile(CARE_PATHWAY_KEYS.OP))
      .toMatchObject({
        blockingReason: 'vertical_domain_adapter_not_registered',
        domainAdapters: [],
      });
    expect(pathwayReconciliationRegistryV4.resolveProfile(CARE_PATHWAY_KEYS.INPATIENT))
      .toMatchObject({
        blockingReason: 'vertical_domain_adapter_not_registered',
        domainAdapters: [],
      });
    expect(
      pathwayReconciliationRegistryV4
        .resolveProfile(CARE_PATHWAY_KEYS.DIAGNOSTICS)
        .domainAdapters[0]
        .definitionChecksum,
    ).toBe(compileDiagnosticsOrderToActionDefinition({
      registry: workflowRuntimeRegistryV3,
    }).checksum);
  });

  test.each([
    [
      CARE_PATHWAY_KEYS.OP,
      'op_child_reference_completeness',
      'appointment.child_resource_linked',
    ],
    [
      CARE_PATHWAY_KEYS.INPATIENT,
      'inpatient_diagnostic_reference_completeness',
      'admission.diagnostic_resource_linked',
    ],
  ])(
    'reconciles %s child references through exact link events and current-reference ancestry',
    async (pathwayKey, checkId, eventType) => {
      const tx = {
        $queryRawUnsafe: jest.fn(async () => [{ finding_count: 0 }]),
      };
      const profile = pathwayReconciliationRegistry.resolveProfile(pathwayKey);
      const check = profile.domainAdapters[0].checks.find(({ id }) => id === checkId);

      await expect(check.run({
        tx,
        tenantId: '10000000-0000-4000-8000-000000000001',
        pathwayKey,
      })).resolves.toMatchObject({ finding_count: 0 });

      const sql = tx.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain(`event.event_type = '${eventType}'`);
      expect(sql).toContain('WITH RECURSIVE known_sources');
      expect(sql).toContain('current_reference_ancestry');
      expect(sql.match(/relationship_kind = 'child_action'/g)).toHaveLength(2);
      expect(sql).toContain('ancestor_source_outbox_event_id = event.id');
    },
  );

  test('V5 exposes OP source coverage and stale-reaper debt without changing V4', async () => {
    const tenantId = '10000000-0000-4000-8000-000000000001';
    const capturedAt = new Date('2026-07-23T10:00:00.000Z');
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ finding_count: 2 }])
        .mockResolvedValueOnce([{ finding_count: 3 }]),
    };
    const checks = pathwayReconciliationRegistry
      .resolveProfile(CARE_PATHWAY_KEYS.OP)
      .domainAdapters[0]
      .checks;
    const sourceCoverage = checks.find(
      ({ id }) => id === 'op_live_appointment_source_coverage',
    );
    const staleReaperDebt = checks.find(
      ({ id }) => id === 'op_stale_scheduled_reaper_debt',
    );

    expect(sourceCoverage).toMatchObject({
      handlerVersion: 'care_pathway.op_live_appointment_source_coverage.v1',
    });
    expect(staleReaperDebt).toMatchObject({
      handlerVersion: 'care_pathway.op_stale_scheduled_reaper_debt.v1',
    });
    await expect(sourceCoverage.run({
      tx,
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.OP,
      capturedAt,
    })).resolves.toEqual({
      code: 'OP_LIVE_APPOINTMENT_SOURCE_COVERAGE_DRIFT',
      finding_count: 2,
    });
    await expect(staleReaperDebt.run({
      tx,
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.OP,
      capturedAt,
    })).resolves.toEqual({
      code: 'OP_STALE_SCHEDULED_REAPER_DEBT',
      finding_count: 3,
    });

    const coverageSql = tx.$queryRawUnsafe.mock.calls[0][0];
    expect(coverageSql).toContain('LEFT JOIN users AS patient');
    expect(coverageSql).toContain("event.event_type = 'appointment.created'");
    expect(coverageSql).toContain(
      "event.payload ->> 'patient_uid' = patient.uid::text",
    );
    expect(coverageSql).toContain("'MISSED'");
    expect(tx.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual([
      tenantId,
      capturedAt,
    ]);

    const reaperSql = tx.$queryRawUnsafe.mock.calls[1][0];
    expect(reaperSql).toContain("appointment.status = 'SCHEDULED'");
    expect(reaperSql).toContain('appointment.admin_override = false');
    expect(reaperSql).toContain(
      "pathway.clinical_status IN ('planned', 'active', 'on_hold')",
    );
    expect(reaperSql).toContain(
      "NULLIF(appointment.appointment_time, '')::interval",
    );
    expect(tx.$queryRawUnsafe.mock.calls[1].slice(1)).toEqual([
      tenantId,
      capturedAt,
      '60',
    ]);

    expect(pathwayReconciliationRegistryV4.checksum)
      .toBe('e28608a8430d6518b0b61d2ceaa4154a9d669f0da7cee033caae75544e22e0c4');
    expect(pathwayReconciliationRegistryV4.resolveProfile(CARE_PATHWAY_KEYS.OP))
      .toMatchObject({
        blockingReason: 'vertical_domain_adapter_not_registered',
        domainAdapters: [],
      });
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
