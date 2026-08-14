import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedCanonicalJobs,
  validateCanonicalResults,
} from './assert-canonical-results.mjs';

const nothingSelected = {
  backend: false,
  fhir: false,
  admin: false,
  flutter: false,
  contracts: false,
  gateway: false,
  infra: false,
};

test('quick gate requires only selected affected jobs', () => {
  const selected = { ...nothingSelected, backend: true, contracts: true };
  assert.deepEqual(expectedCanonicalJobs({ tier: 'quick', selected }), [
    'plan',
    'security',
    'quick_backend',
    'quick_contracts',
  ]);
});

test('quick gate requires the device-gateway job when selected', () => {
  const selected = { ...nothingSelected, gateway: true, contracts: true };
  assert.deepEqual(expectedCanonicalJobs({ tier: 'quick', selected }), [
    'plan',
    'security',
    'quick_contracts',
    'quick_gateway',
  ]);
});

test('full gate requires every parallel stack', () => {
  assert.deepEqual(expectedCanonicalJobs({ tier: 'full', selected: nothingSelected }), [
    'plan',
    'security',
    'lint-and-test',
    'fhir-conformance',
    'full_admin',
    'full_flutter',
    'full_contracts',
    'full_gateway',
    'full_infra',
  ]);
});

test('skipped selected job fails closed', () => {
  const selected = { ...nothingSelected, backend: true };
  const { failures } = validateCanonicalResults({
    tier: 'quick',
    selected,
    results: {
      plan: { result: 'success' },
      security: { result: 'success' },
      quick_backend: { result: 'skipped' },
    },
  });

  assert.deepEqual(failures, ['quick_backend=skipped']);
});

test('unselected skipped jobs do not block the aggregate', () => {
  const { failures } = validateCanonicalResults({
    tier: 'quick',
    selected: nothingSelected,
    results: {
      plan: { result: 'success' },
      security: { result: 'success' },
      quick_backend: { result: 'skipped' },
    },
  });

  assert.deepEqual(failures, []);
});
