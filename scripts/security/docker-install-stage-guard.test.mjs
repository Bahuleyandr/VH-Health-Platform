import assert from 'node:assert/strict';
import test from 'node:test';
import { installStagesCopyOnlyManifestsBeforeNpmCi } from './docker-install-stage-guard.mjs';

const backendDockerfile = `FROM node AS builder
COPY package.json package-lock.json* ./
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci
FROM node AS production
COPY package.json package-lock.json* ./
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev
`;

test('recognizes both approved backend install stages and a bare admin install', () => {
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi(backendDockerfile, 2), true);
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi(
    'FROM node\nCOPY package.json package-lock.json* ./\nRUN npm ci\n', 1,
  ), true);
});

test('fails closed on missing or unrecognized install commands', () => {
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi('FROM node\n', 1), false);
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi('FROM node\n', 0), false);
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi(
    backendDockerfile.replace('ONNXRUNTIME_NODE_INSTALL=skip', 'OTHER_INSTALL_FLAG=skip'), 2,
  ), false);
});

test('rejects a non-manifest copy before an install', () => {
  const changed = backendDockerfile.replace(
    'RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci',
    'COPY scripts ./scripts\nRUN ONNXRUNTIME_NODE_INSTALL=skip npm ci',
  );
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi(changed, 2), false);
});

test('rejects a non-manifest add before an install', () => {
  const changed = backendDockerfile.replace(
    'RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci',
    'ADD scripts ./scripts\nRUN ONNXRUNTIME_NODE_INSTALL=skip npm ci',
  );
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi(changed, 2), false);
});

test('rejects a second install after a non-manifest copy', () => {
  const changed = backendDockerfile.replace(
    'RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci\n',
    'RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci\nCOPY scripts ./scripts\nRUN npm ci\n',
  );
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi(changed, 2), false);
});

test('rejects a second BuildKit install after a non-manifest copy', () => {
  const changed = backendDockerfile.replace(
    'RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci\n',
    'RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci\nCOPY scripts ./scripts\nRUN --mount=type=cache,target=/tmp npm ci\n',
  );
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi(changed, 2), false);
});

test('rejects an alternate install in an additional stage', () => {
  const changed = `${backendDockerfile}FROM node AS alternate
COPY scripts ./scripts
RUN --mount=type=cache,target=/tmp npm ci
`;
  assert.equal(installStagesCopyOnlyManifestsBeforeNpmCi(changed, 2), false);
});
