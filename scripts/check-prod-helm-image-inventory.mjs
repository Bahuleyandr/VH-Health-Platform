#!/usr/bin/env node
// Fail closed when the separately rendered Helm image surface changes. This
// check deliberately does not claim to render chart-generated workloads; it
// pins the exact known chart Applications that remain outside the Kustomize
// image verifier so a new chart or chart revision cannot evade review.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  PRODUCTION_ROOTS,
  findKustomize,
  repoRoot,
} from './check-prod-digests-pinned.mjs';

export const EXPECTED_HELM_APPLICATIONS = Object.freeze([
  {
    target: 'infra/kubernetes/overlays/prod',
    name: 'longhorn',
    chart: 'longhorn',
    repository: 'https://charts.longhorn.io',
    revision: '1.7.2',
    sourceOccurrences: 1,
    valueFile: '',
  },
  {
    target: 'infra/kubernetes/overlays/prod',
    name: 'vhhealth-kube-prometheus',
    chart: 'kube-prometheus-stack',
    repository: 'https://prometheus-community.github.io/helm-charts',
    revision: '65.2.0',
    sourceOccurrences: 1,
    valueFile: '$vhhealth-git/infra/kubernetes/base/monitoring/kube-prometheus-values.yaml',
  },
  {
    target: 'infra/kubernetes/overlays/prod',
    name: 'vhhealth-loki',
    chart: 'loki-stack',
    repository: 'https://grafana.github.io/helm-charts',
    revision: '2.10.2',
    sourceOccurrences: 1,
    valueFile: '$vhhealth-git/infra/kubernetes/base/monitoring/loki-values.yaml',
  },
]);

function scalarValue(raw) {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function metadataName(raw) {
  const lines = raw.split(/\r?\n/);
  const metadata = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  if (metadata < 0) return '';
  for (let index = metadata + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && !/^\s/.test(lines[index])) break;
    const match = lines[index].match(/^  name:\s*(.+?)\s*$/);
    if (match) return scalarValue(match[1]);
  }
  return '';
}

function scalarOccurrences(raw, field, value) {
  const pattern = new RegExp(
    `^\\s*(?:-\\s*)?${field}:\\s*["']?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`,
    'gm',
  );
  return [...raw.matchAll(pattern)].length;
}

export function extractHelmApplications(renderedByTarget) {
  const applications = [];
  for (const [target, rendered] of Object.entries(renderedByTarget)) {
    for (const raw of rendered.split(/^---\s*$/m).map((document) => document.trim()).filter(Boolean)) {
      if (!/^kind:\s*Application\s*$/m.test(raw)) continue;
      const charts = [...raw.matchAll(/^\s*(?:-\s*)?chart:\s*["']?([^\s"']+)["']?\s*$/gm)]
        .map((match) => match[1]);
      if (charts.length === 0) continue;
      applications.push({ target, name: metadataName(raw), charts, raw });
    }
  }
  return applications;
}

export function validateHelmApplicationInventory(applications) {
  const expectedKeys = new Set(EXPECTED_HELM_APPLICATIONS.map(({ target, name }) => `${target}|${name}`));
  const actualKeys = applications.map(({ target, name }) => `${target}|${name}`);
  const extras = actualKeys.filter((key) => !expectedKeys.has(key));
  const missing = [...expectedKeys].filter((key) => !actualKeys.includes(key));
  if (
    applications.length !== EXPECTED_HELM_APPLICATIONS.length ||
    new Set(actualKeys).size !== actualKeys.length ||
    missing.length > 0 ||
    extras.length > 0
  ) {
    throw new Error(
      `Helm Application inventory must remain the exact reviewed set` +
        `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}` +
        `${extras.length > 0 ? `; extra: ${extras.join(', ')}` : ''}`,
    );
  }

  for (const expected of EXPECTED_HELM_APPLICATIONS) {
    const application = applications.find(
      ({ target, name }) => target === expected.target && name === expected.name,
    );
    const chartOccurrences = application.charts.filter((chart) => chart === expected.chart).length;
    const foreignCharts = application.charts.filter((chart) => chart !== expected.chart);
    const repositoryOccurrences = scalarOccurrences(application.raw, 'repoURL', expected.repository);
    const revisionOccurrences = scalarOccurrences(application.raw, 'targetRevision', expected.revision);
    if (
      foreignCharts.length > 0 ||
      chartOccurrences !== expected.sourceOccurrences ||
      repositoryOccurrences !== expected.sourceOccurrences ||
      revisionOccurrences !== expected.sourceOccurrences
    ) {
      throw new Error(
        `Application/${expected.name} Helm source drifted; expected ` +
          `${expected.sourceOccurrences} occurrence(s) of ${expected.repository}/` +
          `${expected.chart}@${expected.revision}`,
      );
    }
    if (expected.valueFile && !application.raw.includes(`- ${expected.valueFile}`)) {
      throw new Error(`Application/${expected.name} must use reviewed values file ${expected.valueFile}`);
    }
    if (!expected.valueFile && !/^\s+values:\s*\|/m.test(application.raw)) {
      throw new Error(`Application/${expected.name} must retain its reviewed inline Helm values`);
    }
  }
  return applications;
}

export function renderProductionHelmApplications({
  roots = PRODUCTION_ROOTS,
  cwd = repoRoot,
  kustomize = findKustomize(),
  execFile = execFileSync,
} = {}) {
  const renderedByTarget = {};
  for (const target of roots) {
    renderedByTarget[target] = execFile(kustomize, ['build', target], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return extractHelmApplications(renderedByTarget);
}

export function checkProductionHelmImageInventory(options = {}) {
  return validateHelmApplicationInventory(renderProductionHelmApplications(options));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  try {
    const applications = checkProductionHelmImageInventory();
    const sources = applications.reduce((count, application) => count + application.charts.length, 0);
    console.log(
      `[helm-image-inventory] BOUNDED: ${applications.length} reviewed Helm Application(s) / ` +
        `${sources} chart source declaration(s). Chart-generated image references remain outside ` +
        `the live registry verifier and require Helm rendering before activation.`,
    );
  } catch (error) {
    console.error(`[helm-image-inventory] FAIL: ${error.message}`);
    process.exit(1);
  }
}
