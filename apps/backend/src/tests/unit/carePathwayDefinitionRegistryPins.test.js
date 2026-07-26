import { readFileSync } from 'node:fs';

import { compileDiagnosticsOrderToActionDefinition } from '../../services/pathways/diagnosticsPathwayDefinition.js';
import { compileInpatientAdmissionToRecoveryDefinition } from '../../services/pathways/inpatientPathwayDefinition.js';
import { compileOpContactToRecoveryDefinition } from '../../services/pathways/opPathwayDefinition.js';
import { compileReferralRequestToClosureDefinition } from '../../services/pathways/referralPathwayDefinition.js';

const EXPECTED_PINS = Object.freeze({
  diagnostics: Object.freeze({
    version: 2,
    checksum: '2bbbdf4bb123ad97db6aa03f842ad3d433086fe9c800d80943a910ed2dc97d5a',
    compile: compileDiagnosticsOrderToActionDefinition,
  }),
  referral: Object.freeze({
    version: 3,
    checksum: 'aa5b3cd9b3db9fb341fa3d0259a1cc361f4f5cba716bcec48062e5ad61597627',
    compile: compileReferralRequestToClosureDefinition,
  }),
  op: Object.freeze({
    version: 4,
    checksum: '599fc60ee040fb59694c6d3fcc751ec5ae01a6b1ffbebd63a3d86ca3d6521956',
    compile: compileOpContactToRecoveryDefinition,
  }),
  inpatient: Object.freeze({
    version: 4,
    checksum: '01154dedf41dc19c73f2c5b788978cc8d9edd7791f2dcb6c5ee7632afcd1d75d',
    compile: compileInpatientAdmissionToRecoveryDefinition,
  }),
});

describe('care pathway definition registry pins', () => {
  it.each(Object.entries(EXPECTED_PINS))(
    'keeps %s on its reviewed immutable runtime registry checksum',
    (_name, expected) => {
      expect(expected.compile()).toMatchObject({
        registry_version: expected.version,
        checksum: expected.checksum,
      });
    },
  );

  it.each([
    ['diagnosticPathwayProjector.js', 'workflowRuntimeRegistryV2'],
    ['referralPathwayProjector.js', 'workflowRuntimeRegistryV3'],
    ['opPathwayProjector.js', 'workflowRuntimeRegistryV4'],
    ['inpatientPathwayProjector.js', 'workflowRuntimeRegistryV4'],
  ])('does not let %s reinterpret persisted definitions through caller context', (file, pin) => {
    const source = readFileSync(
      new URL(`../../services/pathways/${file}`, import.meta.url),
      'utf8',
    );
    expect(source).toContain(`const runtimeRegistry = ${pin};`);
    expect(source).not.toMatch(/const runtimeRegistry = registry \?\?/);
  });

  it.each([
    ['register-diagnostics-pathway-definition.mjs', 'workflowRuntimeRegistryV2'],
    ['register-referral-pathway-definition.mjs', 'workflowRuntimeRegistryV3'],
    ['register-op-pathway-definition.mjs', 'workflowRuntimeRegistryV4'],
    ['register-inpatient-pathway-definition.mjs', 'workflowRuntimeRegistryV4'],
  ])('registers %s through its exact named runtime registry', (file, pin) => {
    const source = readFileSync(
      new URL(`../../../scripts/${file}`, import.meta.url),
      'utf8',
    );
    expect(source).toContain(`registry: ${pin}`);
  });
});
