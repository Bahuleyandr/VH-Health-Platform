import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAffectedBackendInputs } from './run-affected-backend-tests.mjs';

test('selects changed tests and runtime sources without duplicating them', () => {
  const result = selectAffectedBackendInputs([
    'apps/backend/src/services/example.js',
    'apps/backend/src/tests/unit/example.test.js',
    'apps/admin/src/example.ts',
  ]);

  assert.deepEqual(result.relatedSources, ['src/services/example.js']);
  assert.deepEqual(result.changedTests, ['src/tests/unit/example.test.js']);
  assert.deepEqual(result.mandatoryTests, []);
});

test('schema and migration changes add fail-closed migration canaries', () => {
  const result = selectAffectedBackendInputs([
    'apps/backend/prisma/schema.prisma',
    'apps/backend/src/migrations/663_example.sql',
  ]);

  assert.deepEqual(result.mandatoryTests, [
    'src/tests/unit/audit3MigrationSafety.test.js',
    'src/tests/unit/ciMigrationExecutor.test.js',
    'src/tests/unit/prismaHardening.test.js',
    'src/tests/unit/runMigrations.test.js',
  ]);
});

test('route and OpenAPI changes add contract canaries', () => {
  const result = selectAffectedBackendInputs([
    'apps/backend/src/routes/exampleRoutes.js',
    'apps/backend/src/docs/openapi.json',
  ]);

  assert.deepEqual(result.mandatoryTests, [
    'src/tests/unit/openapiBuildSpec.test.js',
    'src/tests/unit/openapiContracts.test.js',
    'src/tests/unit/openapiTagInvariants.test.js',
  ]);
});
