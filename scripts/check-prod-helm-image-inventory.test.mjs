import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkProductionHelmImageInventory,
  extractHelmApplications,
  validateHelmApplicationInventory,
} from './check-prod-helm-image-inventory.mjs';

function application(name, body) {
  return [
    'apiVersion: argoproj.io/v1alpha1',
    'kind: Application',
    'metadata:',
    `  name: ${name}`,
    'spec:',
    body,
  ].join('\n');
}

function validFixture() {
  return {
    'infra/kubernetes/overlays/prod': [
      application('longhorn', [
        '  source:',
        '    chart: longhorn',
        '    repoURL: https://charts.longhorn.io',
        '    targetRevision: 1.7.2',
        '    helm:',
        '      values: |',
        '        persistence: {}',
      ].join('\n')),
      application('vhhealth-kube-prometheus', [
        '  sources:',
        '  - chart: kube-prometheus-stack',
        '    repoURL: https://prometheus-community.github.io/helm-charts',
        '    targetRevision: 65.2.0',
        '    helm:',
        '      valueFiles:',
        '      - $vhhealth-git/infra/kubernetes/base/monitoring/kube-prometheus-values.yaml',
      ].join('\n')),
      application('vhhealth-loki', [
        '  sources:',
        '  - chart: loki-stack',
        '    repoURL: https://grafana.github.io/helm-charts',
        '    targetRevision: 2.10.2',
        '    helm:',
        '      valueFiles:',
        '      - $vhhealth-git/infra/kubernetes/base/monitoring/loki-values.yaml',
      ].join('\n')),
    ].join('\n---\n'),
    'infra/kubernetes/apps': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: no-chart\n',
  };
}

test('accepts only the exact reviewed Helm Application chart inventory', () => {
  const applications = extractHelmApplications(validFixture());
  assert.equal(validateHelmApplicationInventory(applications).length, 3);
});

test('fails closed on a new chart or chart revision', () => {
  const fixture = validFixture();
  fixture['infra/kubernetes/overlays/prod'] += `\n---\n${application('new-chart', [
    '  source:',
    '    chart: surprise',
    '    repoURL: https://charts.example.invalid',
    '    targetRevision: 1.0.0',
  ].join('\n'))}`;
  assert.throws(
    () => validateHelmApplicationInventory(extractHelmApplications(fixture)),
    /exact reviewed set.*extra/,
  );

  const revisionDrift = validFixture();
  revisionDrift['infra/kubernetes/overlays/prod'] = revisionDrift[
    'infra/kubernetes/overlays/prod'
  ].replaceAll('65.2.0', '66.0.0');
  assert.throws(
    () => validateHelmApplicationInventory(extractHelmApplications(revisionDrift)),
    /Helm source drifted/,
  );
});

test('current production render keeps the exact bounded Helm image surface', () => {
  assert.equal(checkProductionHelmImageInventory().length, 3);
});
