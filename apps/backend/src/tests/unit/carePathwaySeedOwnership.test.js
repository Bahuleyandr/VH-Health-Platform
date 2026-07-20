import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEEDER_PATH = path.resolve(
  __dirname,
  '../../../scripts/seed-comprehensive-test-data.mjs',
);

describe('comprehensive seed exclusive clinical ownership', () => {
  let pathwaySeed;
  let criticalResultSeed;

  beforeAll(() => {
    const seeder = fs.readFileSync(SEEDER_PATH, 'utf8');
    pathwaySeed = seeder.match(
      /async function seedCarePathwayWorkflowGraph\(\)[\s\S]*?(?=async function seedLabIngestCriticalAlertGraph)/,
    )?.[0];
    criticalResultSeed = seeder.match(
      /async function seedLabIngestCriticalAlertGraph\(\)[\s\S]*?(?=async function \w+)/,
    )?.[0];
  });

  it('seeds the named pathway task as UID-only', () => {
    expect(pathwaySeed).toMatch(
      /assigned_to_uid,\s*assigned_to_role[\s\S]*?\$5::uuid, NULL, \$6::uuid, 'none'/,
    );
    expect(pathwaySeed).not.toMatch(
      /assigned_to_uid,\s*assigned_to_role[\s\S]*?\$5::uuid, 'DOCTOR', \$6::uuid, 'none'/,
    );
  });

  it('seeds the terminal critical-result receipt as UID-only', () => {
    expect(criticalResultSeed).toMatch(
      /assigned_to_uid, assigned_to_role[\s\S]*?\$5::uuid, NULL, \$5::uuid, \$6::timestamptz, \$7::uuid/,
    );
    expect(criticalResultSeed).not.toMatch(
      /\$5::uuid, \$6::text, \$5::uuid, \$7::timestamptz, \$8::uuid/,
    );
  });
});
