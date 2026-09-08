import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = 'check-cnpg-metric-parity.mjs';

function runFixture(t, expression, { control = true, annotation } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'vhhealth-cnpg-parity-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const monitoring = join(fixtureRoot, 'infra', 'kubernetes', 'base', 'monitoring');
  const cnpg = join(monitoring, '..', 'cnpg');
  mkdirSync(monitoring, { recursive: true });
  mkdirSync(cnpg, { recursive: true });
  copyFileSync(join(here, checker), join(monitoring, checker));
  copyFileSync(join(here, '..', 'cnpg', 'cluster.yaml'), join(cnpg, 'cluster.yaml'));
  writeFileSync(join(monitoring, 'rules.yaml'), [
    'groups:',
    '  - name: parity-regression',
    '    rules:',
    ...(control ? [
      '      - alert: PositiveControl',
      '        expr: cnpg_vhhealth_connections_total > 0',
    ] : []),
    '      - alert: Candidate',
    `        expr: ${expression}`,
    ...(annotation ? ['        annotations:', `          description: ${JSON.stringify(annotation)}`] : []),
    '',
  ].join('\n'));
  if (process.env.PROMTOOL_BIN) {
    const syntax = spawnSync(process.env.PROMTOOL_BIN,
      ['check', 'rules', join(monitoring, 'rules.yaml')], { encoding: 'utf8', timeout: 10_000 });
    assert.ifError(syntax.error);
    assert.equal(syntax.status, 0, `fixture is not valid PromQL/YAML:\n${syntax.stdout}${syntax.stderr}`);
  }
  const result = spawnSync(process.execPath, [join(monitoring, checker)], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test('current monitoring references satisfy the live CNPG contract', () => {
  const result = spawnSync(process.execPath, [join(here, checker)], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /[1-9][0-9]* cnpg_vhhealth_\* reference/);
});

for (const scalar of ['', '|', '>', '|-', '>+', '| # folded across lines']) {
  test(`rejects a misspelled CNPG prefix in ${scalar || 'inline'} expressions`, (t) => {
    const expression = scalar
      ? `${scalar}\n          cnpg_vhealth_connections_total > 0`
      : 'cnpg_vhealth_connections_total > 0';
    const result = runFixture(t, expression);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /cnpg_vhealth_connections_total.*misspelled/);
  });
}

for (const whitespace of ['', ' ', '\t', '\n          ']) {
  test(`rejects an undeclared label with separator ${JSON.stringify(whitespace)}`, (t) => {
    const result = runFixture(t,
      `|\n          cnpg_vhhealth_connections_total${whitespace}{nonexistent_label="x"} > 0`);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /nonexistent_label.*neither a.*LABEL/);
  });
}

test('accepts declared query labels, target labels, and CNPG built-ins in block expressions', (t) => {
  const result = runFixture(t, [
    '|',
    '          cnpg_vhhealth_replication_replay_lag_seconds {application_name=~".*dr.*", namespace="vhhealth"}',
    '          or cnpg_pg_replication_lag',
    '          or cnpg_collector_up',
  ].join('\n'));
  assert.equal(result.status, 0, result.output);
});

test('CNPG built-ins alone cannot satisfy the custom-query reference population', (t) => {
  const result = runFixture(t, '|\n          cnpg_pg_replication_lag > 0', { control: false });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /no cnpg_vhhealth_\* references/);
});

test('query-local spelling is still rejected in block expressions', (t) => {
  const result = runFixture(t, '|\n          vhhealth_connections_total > 0');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /query-local spelling.*cnpg_vhhealth_connections_total/);
});

test('executable references exclude comments, label values, and other metric namespaces', (t) => {
  const result = runFixture(t, [
    '|',
    '          # Previous spelling: cnpg_vhealth_connections_total',
    '          cnpg_vhhealth_connections_total {job="cnpg_vhealth_previous"} > 0',
    '          # Query-local spelling: vhhealth_connections_total',
    '          or foo_cnpg_vhealth_connections_total',
    '          or recording:cnpg_vhealth_connections_total # cnpg_vhealth_comment',
  ].join('\n'));
  assert.equal(result.status, 0, result.output);
});

for (const quoted of [
  "'cnpg_vhealth_connections_total > 0'",
  '"cnpg_vhealth_connections_total > 0"',
]) {
  test(`YAML quoting does not hide an executable metric: ${quoted}`, (t) => {
    const result = runFixture(t, quoted);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /cnpg_vhealth_connections_total.*misspelled/);
  });
}

test('exact metric-name selectors are executable references', (t) => {
  const result = runFixture(t, '|\n          {__name__="cnpg_vhealth_connections_total"} > 0');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /cnpg_vhealth_connections_total.*misspelled/);
});

test('metric-name selectors validate their other labels', (t) => {
  const result = runFixture(t,
    '|\n          {__name__="cnpg_vhhealth_connections_total", nonexistent_label="x"} > 0');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /nonexistent_label.*neither a.*LABEL/);
});

test('metric-name selectors can provide the positive custom-query population', (t) => {
  const result = runFixture(t,
    '|\n          {__name__="cnpg_vhhealth_connections_total", namespace="vhhealth"} > 0',
    { control: false });
  assert.equal(result.status, 0, result.output);
});

test('annotation punctuation is not part of a metric identifier', (t) => {
  const result = runFixture(t, 'cnpg_vhhealth_connections_total > 0', {
    annotation: 'Inspect cnpg_vhhealth_connections_total: the connection count.',
  });
  assert.equal(result.status, 0, result.output);
});

test('monitoring CI executes the parity guard and its regression suite', () => {
  const source = readFileSync(join(here, 'validate-monitoring.mjs'), 'utf8');
  assert.match(source, /'check-cnpg-metric-parity\.mjs'/);
  assert.match(source, /'check-cnpg-metric-parity\.test\.mjs'/);
});
