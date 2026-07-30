import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const promtool = process.env.PROMTOOL_BIN || 'promtool';
const ruleFiles = [
  'alert-rules.yaml',
  'backend-red-alerts.yaml',
  'backend-reliability-alerts.yaml',
  'backend-slo.yaml',
  'device-gateway-alerts.yaml',
  'continuity-edge-alerts.yaml',
];
const tempDir = mkdtempSync(join(tmpdir(), 'vhhealth-promtool-test-'));

try {
  const groups = ruleFiles.flatMap((file) => extractGroups(join(here, file)));
  const combinedRuleFile = join(tempDir, 'rules.yaml');
  writeFileSync(combinedRuleFile, `groups:\n${groups.join('\n')}\n`, 'utf8');

  const testBody = readFileSync(
    join(here, 'promtool-rule-parity.test.yaml'),
    'utf8',
  );
  const testFile = join(tempDir, 'rule-parity.test.yaml');
  writeFileSync(
    testFile,
    `rule_files:\n  - ${JSON.stringify(combinedRuleFile)}\n${testBody}`,
    'utf8',
  );

  const output = execFileSync(promtool, ['test', 'rules', testFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output);
} catch (error) {
  process.stdout.write(error.stdout || '');
  process.stderr.write(error.stderr || error.message);
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function extractGroups(filePath) {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const groupsIndex = lines.findIndex((line) => /^  groups:\s*$/.test(line));
  if (groupsIndex === -1) {
    throw new Error(`PrometheusRule has no spec.groups: ${filePath}`);
  }

  const groups = [];
  for (let index = groupsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '' && !line.startsWith('    ')) break;
    if (line.trim() !== '') groups.push(line.slice(2));
  }
  return groups;
}
