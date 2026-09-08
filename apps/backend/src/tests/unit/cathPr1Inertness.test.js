import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerCensus, inspectSignerSource } from '../../../scripts/cath-pr1-caller-census.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const EXPECTED = [
  { path: 'routes/clinical/encounterRoutes.js', function: 'signDocument', documentType: 'encounter' },
  { path: 'routes/clinical/integrityRoutes.js', function: 'signDocument', documentType: '<dynamic>' },
  { path: 'services/clinical/cathMigrationApprovalService.js', function: 'signDocumentTx', documentType: 'cath_migration_approval' },
  { path: 'services/clinical/documentIntegrityService.js', function: 'signDocumentTx', documentType: '<dynamic>' },
  { path: 'services/diagnostics/diagnosticResultActionService.js', function: 'signDocumentTx', documentType: 'diagnostic_result_action' },
  { path: 'services/emr/inpatientPathwayDomainService.js', function: 'signDocumentTx', documentType: 'diagnostic_result_action' },
  { path: 'services/referral/referralClosedLoopService.js', function: 'signDocumentTx', documentType: 'referral_response' },
];

test('PR1 caller census isolates the widened signer from all existing callers', () => {
  expect(callerCensus()).toEqual(EXPECTED);
  expect(callerCensus()).toHaveLength(7);
  expect(JSON.parse(readFileSync(new URL('../../../scripts/cath-pr1-caller-census.json', import.meta.url), 'utf8')))
    .toEqual({ schema: 'cath-pr1-signer-census/v1', count: 7, calls: EXPECTED });
  const wrapper = readFileSync(join(root, 'services/clinical/documentIntegrityService.js'), 'utf8');
  const publicSigner = wrapper.slice(wrapper.indexOf('export async function signDocument({'), wrapper.indexOf('async function verifyDocumentSignatureFrom'));
  expect(publicSigner.indexOf("documentType === 'cath_migration_approval'")).toBeGreaterThanOrEqual(0);
  expect(publicSigner.indexOf("documentType === 'cath_migration_approval'")).toBeLessThan(publicSigner.indexOf('fetchDocumentFrom('));
  for (const source of [
    "import integrity from './documentIntegrityService.js'; integrity.signDocumentTx(input)",
    "import { signDocumentTx as sign } from './documentIntegrityService.js'; sign({...input})",
    "export { signDocumentTx } from './documentIntegrityService.js'",
    "const integrity = await import('./documentIntegrityService.js')",
  ]) expect(() => inspectSignerSource(source, 'synthetic.mjs')).toThrow(/Unsupported/);
});

test('PR1 production registry has no approval or v2 routes', () => {
  // Independent flat directory traversal and text search, not the census parser.
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  const importers = entries.filter((entry) => entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !relative(root, path).split(/[\\/]/).includes('tests'))
    .filter((path) => readFileSync(path, 'utf8').includes('cathMigrationApprovalRoutes'));
  expect(importers).toEqual([]);
  const spec = JSON.parse(readFileSync(join(root, 'docs/openapi.json'), 'utf8'));
  expect(Object.keys(spec.paths).filter((path) => /cath.*(dispositions|consent-policy|start-receipts|attempts)/.test(path))).toEqual([]);
  expect(Object.keys(spec.paths)).toContain('/api/v1/cath-lab/cases');
});
