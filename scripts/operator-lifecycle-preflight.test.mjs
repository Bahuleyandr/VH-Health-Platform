import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATOR_APPLICATIONS,
  REQUIRED_CRDS,
  REQUIRED_DEPLOYMENTS,
  checkStaticContract,
  validateLiveState,
} from './operator-lifecycle-preflight.mjs';

function validState() {
  const applications = Object.fromEntries(OPERATOR_APPLICATIONS.map(expected => [
    expected.name,
    {
      metadata: {
        labels: { 'vhhealth.app/deploy-state': 'held' },
        annotations: { 'vhhealth.app/chart-sha256': expected.chartDigest },
      },
      spec: {
        project: 'vhhealth',
        source: {
          repoURL: expected.repository,
          chart: expected.chart,
          targetRevision: expected.revision,
          helm: {
            releaseName: expected.releaseName,
            values: [
              ...expected.valueFragments,
              ...(expected.valueOccurrences || []).flatMap(({ value, count }) =>
                Array.from({ length: count - 1 }, () => value)),
            ].join('\n'),
          },
        },
        destination: { namespace: expected.namespace },
        syncPolicy: { syncOptions: ['ServerSideApply=true'] },
      },
      status: {
        sync: { status: 'Synced' },
        health: { status: 'Healthy' },
      },
    },
  ]));

  const crds = Object.fromEntries(REQUIRED_CRDS.map(name => [
    name,
    { status: { conditions: [{ type: 'Established', status: 'True' }] } },
  ]));

  const deployments = Object.fromEntries(REQUIRED_DEPLOYMENTS.map(expected => [
    `${expected.namespace}/${expected.name}`,
    {
      metadata: { generation: 3 },
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: expected.images.map((image, index) => ({ name: `controller-${index}`, image })),
          },
        },
      },
      status: {
        observedGeneration: 3,
        readyReplicas: 2,
        conditions: [{ type: 'Available', status: 'True' }],
      },
    },
  ]));

  return { applications, crds, deployments };
}

test('held Application render is immutable, manual-sync, and absent from active composition', () => {
  assert.deepEqual(checkStaticContract(), { applications: 4 });
});

test('live preflight accepts only fully synced Applications, Established CRDs, and ready pinned controllers', () => {
  assert.doesNotThrow(() => validateLiveState(validState()));
});

test('live preflight fails closed on automated sync or unhealthy Application state', () => {
  const automated = validState();
  automated.applications['vhhealth-cnpg-operator'].spec.syncPolicy.automated = { prune: true };
  assert.throws(() => validateLiveState(automated), /must remain manual-sync/);

  const unhealthy = validState();
  unhealthy.applications['vhhealth-barman-cloud'].status.health.status = 'Progressing';
  assert.throws(() => validateLiveState(unhealthy), /is not Healthy/);
});

test('live preflight fails closed on missing or unestablished CRDs', () => {
  const missing = validState();
  delete missing.crds['objectstores.barmancloud.cnpg.io'];
  assert.throws(() => validateLiveState(missing), /ObjectStore.* is missing/i);

  const unestablished = validState();
  unestablished.crds['tenants.minio.min.io'].status.conditions[0].status = 'False';
  assert.throws(() => validateLiveState(unestablished), /tenants\.minio\.min\.io is not Established/);
});

test('live preflight fails closed on stale, unavailable, or image-drifted controllers', () => {
  const stale = validState();
  stale.deployments['cnpg-system/cnpg-controller-manager'].status.observedGeneration = 2;
  assert.throws(() => validateLiveState(stale), /has not observed its current generation/);

  const unavailable = validState();
  unavailable.deployments['cert-manager/cert-manager-webhook'].status.conditions[0].status = 'False';
  assert.throws(() => validateLiveState(unavailable), /is not Available/);

  const drifted = validState();
  drifted.deployments['minio-operator/minio-operator'].spec.template.spec.containers[0].image =
    'quay.io/minio/operator:v5.0.15';
  assert.throws(() => validateLiveState(drifted), /image inventory drifted/);
});
