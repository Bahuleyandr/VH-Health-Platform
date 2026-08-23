// infra/kubernetes/base/monitoring/validate-monitoring.mjs
// Validates the monitoring assets WITHOUT a cluster: promtool check/test rules,
// metadata-only team-label parity, CNPG metric parity against the custom-query
// definitions in infra/kubernetes/base/cnpg/cluster.yaml, and JSON.parse over
// every dashboard. Deploy is HELD, so this remains preparation evidence, NOT
// live delivery proof.
//
// This is the entry point CI runs (.github/workflows/_reusable-kubernetes-
// manifests.yml, "Validate monitoring rules + dashboards"), so a new monitoring
// guard belongs in the script list below rather than as its own CI step.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const promtool = process.env.PROMTOOL_BIN || 'promtool';
const ruleFiles = [
  'backend-reliability-alerts.yaml',
  'backend-slo.yaml',
  'backend-red-alerts.yaml',
  'alert-rules.yaml',
  'device-gateway-alerts.yaml',
  'continuity-edge-alerts.yaml',
  'proof/synthetic-rules.yaml',
  'proof/synthetic-live-drill.yaml.example',
];

let failed = false;
for (const f of ruleFiles) {
  const tempDir = mkdtempSync(join(tmpdir(), 'vhhealth-prom-rules-'));
  try {
    const promtoolFile = extractPrometheusRuleGroups(join(here, f), tempDir);
    const out = execFileSync(promtool, ['check', 'rules', promtoolFile], { encoding: 'utf8' });
    console.log(`✓ ${f}\n${out.trim()}`);
  } catch (e) {
    failed = true;
    console.error(`✗ promtool check rules ${f}\n${e.stdout || ''}${e.stderr || e.message}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// check-cnpg-metric-parity.mjs needs no promtool: it reads the alert
// expressions and the CNPG custom-query definitions and refuses to let them
// disagree. It runs before the promtool suite because a rule that selects a
// series nothing exports still passes promtool — the fixture author supplies
// both halves — so the parity failure is the more useful first message.
for (const script of [
  'verify-rule-metadata.mjs',
  'check-cnpg-metric-parity.mjs',
  'run-promtool-rule-tests.mjs',
]) {
  try {
    const out = execFileSync(process.execPath, [join(here, script)], {
      encoding: 'utf8',
      env: { ...process.env, PROMTOOL_BIN: promtool },
    });
    console.log(`✓ ${script}\n${out.trim()}`);
  } catch (e) {
    failed = true;
    console.error(`✗ ${script}\n${e.stdout || ''}${e.stderr || e.message}`);
  }
}

const dashDir = join(here, 'dashboards');
for (const f of readdirSync(dashDir).filter((n) => n.endsWith('.json'))) {
  try {
    JSON.parse(readFileSync(join(dashDir, f), 'utf8'));
    console.log(`✓ dashboard JSON valid: ${f}`);
  } catch (e) {
    failed = true;
    console.error(`✗ invalid dashboard JSON ${f}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);

function extractPrometheusRuleGroups(filePath, tempDir) {
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const groupsIndex = lines.findIndex((line) => /^  groups:\s*$/.test(line));
  if (groupsIndex === -1) {
    return filePath;
  }

  const extracted = [];
  for (let i = groupsIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > groupsIndex && line.trim() !== '' && !line.startsWith('    ')) {
      break;
    }
    extracted.push(line.startsWith('  ') ? line.slice(2) : line);
  }

  const promtoolPath = join(tempDir, 'rules.yaml');
  writeFileSync(promtoolPath, `${extracted.join('\n')}\n`, 'utf8');
  return promtoolPath;
}
