#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  findKustomize,
  parseImageReference,
  verifyRegistryPin,
} from './check-prod-digests-pinned.mjs';

const thisFile = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(thisFile), '..');
const heldTarget = 'infra/kubernetes/held/operator-lifecycle';

export const OPERATOR_APPLICATIONS = Object.freeze([
  {
    name: 'vhhealth-cert-manager-operator',
    repository: 'https://charts.jetstack.io',
    chart: 'cert-manager',
    revision: 'v1.16.1',
    releaseName: 'cert-manager',
    namespace: 'cert-manager',
    chartDigest: 'e6bf08ee8834e6a727e38991978607ea9b729825150a20d7d10be1eb284106e6',
    chartUrl: 'https://charts.jetstack.io/charts/cert-manager-v1.16.1.tgz',
    valueFragments: [
      'crds:\nenabled: true',
      'digest: sha256:ae5e14401cde4dec8bccce7594f829cd491044aa66944272e1d4fccc941ec77c',
      'digest: sha256:6edf44244b2a711be737c4ab8e54e68d9112cc4e87da2ef97a7f76b768f4fde7',
      'digest: sha256:3c49185718cf454bac559f71c4453b33f1086db48084604247d9acb7a4de2973',
      'digest: sha256:14304826ab1a1184e185f952ef7e0bf8e620568b5c17939179efe6f4c6049d8e',
      'digest: sha256:b4a5e42f6dbfb0d7dbb9366b4cb437a59a7616f6c5e67c76fa3641cadbe0c958',
    ],
  },
  {
    name: 'vhhealth-cnpg-operator',
    repository: 'https://cloudnative-pg.github.io/charts',
    chart: 'cloudnative-pg',
    revision: '0.29.0',
    releaseName: 'vhhealth-cnpg-operator',
    namespace: 'cnpg-system',
    chartDigest: '668e065ff53508d58238788fd35b355a925060843629a951df0e6a9362e6d32f',
    chartUrl:
      'https://github.com/cloudnative-pg/charts/releases/download/cloudnative-pg-v0.29.0/cloudnative-pg-0.29.0.tgz',
    valueFragments: [
      'fullnameOverride: cnpg-controller-manager',
      'crds:\ncreate: true',
      'tag: 1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb',
    ],
  },
  {
    name: 'vhhealth-barman-cloud',
    repository: 'https://cloudnative-pg.github.io/charts',
    chart: 'plugin-barman-cloud',
    revision: '0.7.0',
    releaseName: 'vhhealth-barman-cloud',
    namespace: 'cnpg-system',
    chartDigest: '683494c04cc94f7d33c4ac5f3d8d64c209634b48bd0e84da31d7d1fad22cdcdb',
    chartUrl:
      'https://github.com/cloudnative-pg/charts/releases/download/plugin-barman-cloud-v0.7.0/plugin-barman-cloud-0.7.0.tgz',
    valueFragments: [
      'fullnameOverride: barman-cloud',
      'tag: v0.13.0@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96',
      'tag: v0.13.0@sha256:990361af3319f9e23aafa0f6d7981f99bf1f69b4e6a85cf1bc7d71d6f09bb288',
    ],
  },
  {
    name: 'vhhealth-minio-operator',
    repository: 'https://operator.min.io',
    chart: 'operator',
    revision: '5.0.15',
    releaseName: 'minio-operator',
    namespace: 'minio-operator',
    chartDigest: '8c174de0947acf39c4482def9249730db7f44a9ed57e0b2207c8cf6cc794c51f',
    chartUrl: 'https://operator.min.io/helm-releases/operator-5.0.15.tgz',
    valueFragments: [
      'repository: quay.io/minio/operator@sha256',
      'digest: 811d71f9d41ce275946a50cc564b6fab3d3268b3af5969e45c0278d711a60ac2',
    ],
    valueOccurrences: [
      { value: 'repository: quay.io/minio/operator@sha256', count: 2 },
      {
        value: 'digest: 811d71f9d41ce275946a50cc564b6fab3d3268b3af5969e45c0278d711a60ac2',
        count: 2,
      },
    ],
  },
]);

export const OPERATOR_IMAGE_PINS = Object.freeze([
  'ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb',
  'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96',
  'ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.13.0@sha256:990361af3319f9e23aafa0f6d7981f99bf1f69b4e6a85cf1bc7d71d6f09bb288',
  'quay.io/minio/operator:v5.0.15@sha256:811d71f9d41ce275946a50cc564b6fab3d3268b3af5969e45c0278d711a60ac2',
  'quay.io/jetstack/cert-manager-controller:v1.16.1@sha256:ae5e14401cde4dec8bccce7594f829cd491044aa66944272e1d4fccc941ec77c',
  'quay.io/jetstack/cert-manager-webhook:v1.16.1@sha256:6edf44244b2a711be737c4ab8e54e68d9112cc4e87da2ef97a7f76b768f4fde7',
  'quay.io/jetstack/cert-manager-cainjector:v1.16.1@sha256:3c49185718cf454bac559f71c4453b33f1086db48084604247d9acb7a4de2973',
  'quay.io/jetstack/cert-manager-acmesolver:v1.16.1@sha256:14304826ab1a1184e185f952ef7e0bf8e620568b5c17939179efe6f4c6049d8e',
  'quay.io/jetstack/cert-manager-startupapicheck:v1.16.1@sha256:b4a5e42f6dbfb0d7dbb9366b4cb437a59a7616f6c5e67c76fa3641cadbe0c958',
]);

export const REQUIRED_CRDS = Object.freeze([
  'certificates.cert-manager.io',
  'certificaterequests.cert-manager.io',
  'issuers.cert-manager.io',
  'clusterissuers.cert-manager.io',
  'challenges.acme.cert-manager.io',
  'orders.acme.cert-manager.io',
  'clusters.postgresql.cnpg.io',
  'backups.postgresql.cnpg.io',
  'poolers.postgresql.cnpg.io',
  'scheduledbackups.postgresql.cnpg.io',
  'objectstores.barmancloud.cnpg.io',
  'tenants.minio.min.io',
  'policybindings.sts.min.io',
  'miniojobs.job.min.io',
]);

export const REQUIRED_DEPLOYMENTS = Object.freeze([
  {
    namespace: 'cert-manager',
    name: 'cert-manager',
    images: [
      'quay.io/jetstack/cert-manager-controller@sha256:ae5e14401cde4dec8bccce7594f829cd491044aa66944272e1d4fccc941ec77c',
    ],
  },
  {
    namespace: 'cert-manager',
    name: 'cert-manager-webhook',
    images: [
      'quay.io/jetstack/cert-manager-webhook@sha256:6edf44244b2a711be737c4ab8e54e68d9112cc4e87da2ef97a7f76b768f4fde7',
    ],
  },
  {
    namespace: 'cert-manager',
    name: 'cert-manager-cainjector',
    images: [
      'quay.io/jetstack/cert-manager-cainjector@sha256:3c49185718cf454bac559f71c4453b33f1086db48084604247d9acb7a4de2973',
    ],
  },
  {
    namespace: 'cnpg-system',
    name: 'cnpg-controller-manager',
    images: [
      'ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb',
    ],
  },
  {
    namespace: 'cnpg-system',
    name: 'barman-cloud',
    images: [
      'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96',
    ],
  },
  {
    namespace: 'minio-operator',
    name: 'minio-operator',
    images: [
      'quay.io/minio/operator@sha256:811d71f9d41ce275946a50cc564b6fab3d3268b3af5969e45c0278d711a60ac2',
    ],
  },
]);

function renderedDocuments(rendered) {
  return rendered
    .split(/^---\s*$/m)
    .map(document => document.trim())
    .filter(Boolean);
}

function metadataName(document) {
  return document.match(/^metadata:\s*$[\s\S]*?^  name:\s*([^\s#]+)\s*$/m)?.[1] || '';
}

function yamlScalar(document, field) {
  return document.match(new RegExp(`^\\s*${field}:\\s*["']?([^\\s"']+)["']?\\s*$`, 'm'))?.[1] || '';
}

function normalizedYamlLines(value) {
  return String(value)
    .split(/\r?\n/)
    .map(line => line.trim())
    .join('\n');
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function allKustomizations(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    if (statSync(fullPath).isDirectory()) files.push(...allKustomizations(fullPath));
    else if (entry === 'kustomization.yaml') files.push(fullPath);
  }
  return files;
}

export function checkStaticContract({ cwd = repoRoot, kustomize = findKustomize() } = {}) {
  const rendered = execFileSync(kustomize, ['build', heldTarget], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const applications = renderedDocuments(rendered).filter(document => /^kind:\s*Application\s*$/m.test(document));
  assert.equal(applications.length, OPERATOR_APPLICATIONS.length, 'held target must render exactly four Applications');

  const actualNames = applications.map(metadataName).sort();
  assert.deepEqual(
    actualNames,
    OPERATOR_APPLICATIONS.map(({ name }) => name).sort(),
    'held operator Application inventory drifted',
  );

  for (const expected of OPERATOR_APPLICATIONS) {
    const document = applications.find(candidate => metadataName(candidate) === expected.name);
    assert.ok(document, `Application/${expected.name} is missing`);
    assert.match(document, /^    vhhealth\.app\/deploy-state:\s*held\s*$/m);
    assert.match(document, new RegExp(`^    vhhealth\\.app/chart-sha256:\\s*${expected.chartDigest}\\s*$`, 'm'));
    assert.equal(yamlScalar(document, 'repoURL'), expected.repository, `Application/${expected.name} repoURL drifted`);
    assert.equal(yamlScalar(document, 'chart'), expected.chart, `Application/${expected.name} chart drifted`);
    assert.equal(yamlScalar(document, 'targetRevision'), expected.revision, `Application/${expected.name} revision drifted`);
    assert.equal(yamlScalar(document, 'releaseName'), expected.releaseName, `Application/${expected.name} release drifted`);
    assert.match(document, new RegExp(`^    namespace:\\s*${expected.namespace}\\s*$`, 'm'));
    assert.doesNotMatch(document, /^\s+automated:\s*$/m, `Application/${expected.name} must remain manual-sync`);
    const normalizedDocument = normalizedYamlLines(document);
    for (const fragment of expected.valueFragments) {
      assert.ok(
        normalizedDocument.includes(normalizedYamlLines(fragment)),
        `Application/${expected.name} is missing pinned value: ${fragment}`,
      );
    }
    for (const occurrence of expected.valueOccurrences || []) {
      assert.equal(
        countOccurrences(normalizedDocument, normalizedYamlLines(occurrence.value)),
        occurrence.count,
        `Application/${expected.name} must contain ${occurrence.count} occurrence(s) of ${occurrence.value}`,
      );
    }
  }

  const compositionRoots = [
    join(cwd, 'infra', 'kubernetes', 'base'),
    join(cwd, 'infra', 'kubernetes', 'overlays'),
  ];
  for (const root of compositionRoots) {
    for (const kustomization of allKustomizations(root)) {
      assert.doesNotMatch(
        readFileSync(kustomization, 'utf8'),
        /^\s*-\s*.*held[\\/]operator-lifecycle\s*$/m,
        `${kustomization} must not activate the held operator lifecycle target`,
      );
    }
  }

  const project = readFileSync(join(cwd, 'infra', 'kubernetes', 'base', 'argocd', 'project.yaml'), 'utf8');
  for (const repository of [...new Set(OPERATOR_APPLICATIONS.map(({ repository }) => repository))]) {
    assert.ok(project.includes(`- "${repository}"`), `AppProject must allow ${repository}`);
  }
  for (const namespace of [...new Set(OPERATOR_APPLICATIONS.map(({ namespace }) => namespace))]) {
    assert.ok(project.includes(`- namespace: "${namespace}"`), `AppProject must allow ${namespace}`);
  }

  const markers = [
    'infra/kubernetes/base/cert-manager/cert-manager.yaml',
    'infra/kubernetes/base/cnpg/operator.yaml',
    'infra/kubernetes/base/minio/operator.yaml',
  ].map(path => readFileSync(join(cwd, path), 'utf8')).join('\n');
  for (const expected of OPERATOR_APPLICATIONS) {
    for (const value of [expected.repository, expected.revision, expected.chartDigest]) {
      assert.ok(markers.includes(value), `operator marker inventory is missing ${value}`);
    }
  }
  for (const reference of OPERATOR_IMAGE_PINS) {
    assert.ok(markers.includes(reference), `operator marker inventory is missing ${reference}`);
  }

  return { applications: OPERATOR_APPLICATIONS.length };
}

async function verifyChartArchive(application, fetchImpl = fetch) {
  const response = await fetchImpl(application.chartUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Application/${application.name} chart fetch failed: HTTP ${response.status}`);
  }
  const digest = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  assert.equal(digest, application.chartDigest, `Application/${application.name} chart archive digest drifted`);
}

export async function verifyImmutableSources({ fetchImpl = fetch } = {}) {
  for (const application of OPERATOR_APPLICATIONS) {
    await verifyChartArchive(application, fetchImpl);
  }
  for (const reference of OPERATOR_IMAGE_PINS) {
    await verifyRegistryPin(parseImageReference(reference), { fetchImpl });
  }
  return {
    charts: OPERATOR_APPLICATIONS.length,
    images: OPERATOR_IMAGE_PINS.length,
  };
}

function applicationSource(application) {
  return application?.spec?.source || {};
}

export function validateLiveState({ applications, crds, deployments }) {
  for (const expected of OPERATOR_APPLICATIONS) {
    const application = applications[expected.name];
    assert.ok(application, `Application/${expected.name} is missing`);
    const source = applicationSource(application);
    assert.equal(application.spec?.project, 'vhhealth', `Application/${expected.name} project drifted`);
    assert.equal(source.repoURL, expected.repository, `Application/${expected.name} repoURL drifted`);
    assert.equal(source.chart, expected.chart, `Application/${expected.name} chart drifted`);
    assert.equal(source.targetRevision, expected.revision, `Application/${expected.name} revision drifted`);
    assert.equal(source.helm?.releaseName, expected.releaseName, `Application/${expected.name} release drifted`);
    assert.equal(application.spec?.destination?.namespace, expected.namespace, `Application/${expected.name} destination drifted`);
    assert.equal(application.metadata?.annotations?.['vhhealth.app/chart-sha256'], expected.chartDigest);
    assert.equal(application.metadata?.labels?.['vhhealth.app/deploy-state'], 'held');
    assert.equal(application.spec?.syncPolicy?.automated, undefined, `Application/${expected.name} must remain manual-sync`);
    const normalizedValues = normalizedYamlLines(source.helm?.values || '');
    for (const fragment of expected.valueFragments) {
      assert.ok(
        normalizedValues.includes(normalizedYamlLines(fragment)),
        `Application/${expected.name} live values lost ${fragment}`,
      );
    }
    for (const occurrence of expected.valueOccurrences || []) {
      assert.equal(
        countOccurrences(normalizedValues, normalizedYamlLines(occurrence.value)),
        occurrence.count,
        `Application/${expected.name} live values occurrence drifted for ${occurrence.value}`,
      );
    }
    assert.equal(application.status?.sync?.status, 'Synced', `Application/${expected.name} is not Synced`);
    assert.equal(application.status?.health?.status, 'Healthy', `Application/${expected.name} is not Healthy`);
  }

  for (const name of REQUIRED_CRDS) {
    const crd = crds[name];
    assert.ok(crd, `CustomResourceDefinition/${name} is missing`);
    assert.ok(
      crd.status?.conditions?.some(condition => condition.type === 'Established' && condition.status === 'True'),
      `CustomResourceDefinition/${name} is not Established`,
    );
  }

  for (const expected of REQUIRED_DEPLOYMENTS) {
    const key = `${expected.namespace}/${expected.name}`;
    const deployment = deployments[key];
    assert.ok(deployment, `Deployment/${key} is missing`);
    assert.ok(Number(deployment.spec?.replicas || 0) > 0, `Deployment/${key} has no desired replicas`);
    assert.ok(
      Number(deployment.status?.observedGeneration || 0) >= Number(deployment.metadata?.generation || 0),
      `Deployment/${key} has not observed its current generation`,
    );
    assert.ok(
      deployment.status?.conditions?.some(condition => condition.type === 'Available' && condition.status === 'True'),
      `Deployment/${key} is not Available`,
    );
    assert.ok(
      Number(deployment.status?.readyReplicas || 0) >= Number(deployment.spec?.replicas || 0),
      `Deployment/${key} does not have all desired replicas ready`,
    );
    const images = (deployment.spec?.template?.spec?.containers || []).map(container => container.image).sort();
    assert.deepEqual(images, [...expected.images].sort(), `Deployment/${key} image inventory drifted`);
  }
}

function kubectlJson(kubectl, args) {
  const result = spawnSync(kubectl, [...args, '-o', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${kubectl} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout);
}

export function readLiveState({ kubectl = process.env.KUBECTL_BIN || 'kubectl' } = {}) {
  const applications = {};
  const crds = {};
  const deployments = {};
  for (const expected of OPERATOR_APPLICATIONS) {
    applications[expected.name] = kubectlJson(kubectl, [
      '--namespace', 'argocd', 'get', 'application', expected.name,
    ]);
  }
  for (const name of REQUIRED_CRDS) {
    crds[name] = kubectlJson(kubectl, ['get', 'customresourcedefinition', name]);
  }
  for (const expected of REQUIRED_DEPLOYMENTS) {
    const key = `${expected.namespace}/${expected.name}`;
    deployments[key] = kubectlJson(kubectl, [
      '--namespace', expected.namespace, 'get', 'deployment', expected.name,
    ]);
  }
  return { applications, crds, deployments };
}

function usage() {
  console.error(
    'Usage: node scripts/operator-lifecycle-preflight.mjs ' +
      '[--static-only | --contract-only] [--kubectl <path>]',
  );
}

async function main() {
  const args = process.argv.slice(2);
  const staticOnly = args.includes('--static-only');
  const contractOnly = args.includes('--contract-only');
  const kubectlIndex = args.indexOf('--kubectl');
  const kubectl = kubectlIndex >= 0 ? args[kubectlIndex + 1] : undefined;
  const allowed = new Set(['--static-only', '--contract-only', '--kubectl', kubectl]);
  if (
    (staticOnly && contractOnly) ||
    (kubectlIndex >= 0 && !kubectl) ||
    args.some(argument => !allowed.has(argument))
  ) {
    usage();
    process.exitCode = 2;
    return;
  }

  const staticResult = checkStaticContract();
  if (staticOnly) {
    console.log(`[operator-lifecycle] STATIC OK: ${staticResult.applications} held manual-sync Applications`);
    return;
  }

  const sourceResult = await verifyImmutableSources();
  if (contractOnly) {
    console.log(
      `[operator-lifecycle] CONTRACT OK: ${staticResult.applications} held Applications, ` +
        `${sourceResult.charts} chart archives, ${sourceResult.images} image digests`,
    );
    return;
  }

  validateLiveState(readLiveState({ kubectl }));
  console.log(
    `[operator-lifecycle] READY: ${OPERATOR_APPLICATIONS.length} manual-sync Applications, ` +
      `${REQUIRED_CRDS.length} Established CRDs, ${REQUIRED_DEPLOYMENTS.length} Available controllers`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().catch(error => {
    console.error(`[operator-lifecycle] BLOCKED: ${error.message}`);
    process.exit(1);
  });
}
