#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const defaultRepoRoot = path.resolve(packageRoot, '..', '..');

function parseArgs(argv) {
  const result = {
    repoRoot: defaultRepoRoot,
    out: path.join(packageRoot, 'runtime'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--repo-root', '--out'].includes(token)) {
      throw new Error(`unsupported argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${token} requires a value`);
    result[token === '--repo-root' ? 'repoRoot' : 'out'] = path.resolve(value);
    index += 1;
  }
  return result;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function replaceExactlyOnce(source, from, to) {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) {
    throw new Error(`expected exactly one verifier import: ${from}`);
  }
  return source.replace(from, to);
}

export async function buildRuntimeVerifier({
  repoRoot = defaultRepoRoot,
  out = path.join(packageRoot, 'runtime'),
} = {}) {
  const downtimeRoot = path.join(
    repoRoot,
    'apps',
    'backend',
    'src',
    'services',
    'downtime',
  );
  const sources = {
    verifier: path.join(downtimeRoot, 'continuityEdgeMirrorVerifier.js'),
    canonical: path.join(downtimeRoot, 'continuityPackCanonical.js'),
    publication: path.join(downtimeRoot, 'continuityPackPublicationService.js'),
  };
  const [verifierSource, canonicalSource, publicationSource] = await Promise.all([
    readFile(sources.verifier, 'utf8'),
    readFile(sources.canonical, 'utf8'),
    readFile(sources.publication, 'utf8'),
  ]);

  let adapted = verifierSource;
  adapted = replaceExactlyOnce(
    adapted,
    "from './continuityEdgeAccessService.js';",
    "from './runtime-contracts.js';",
  );
  adapted = replaceExactlyOnce(
    adapted,
    "from './clinicalContinuityPackOrchestrationService.js';",
    "from './runtime-contracts.js';",
  );
  adapted = replaceExactlyOnce(
    adapted,
    "from '../../observability/continuityMetrics.js';",
    "from './runtime-metrics.js';",
  );

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await Promise.all([
    writeFile(path.join(out, 'continuityEdgeMirrorVerifier.js'), adapted, 'utf8'),
    writeFile(path.join(out, 'continuityPackCanonical.js'), canonicalSource, 'utf8'),
    writeFile(path.join(out, 'continuityPackPublicationService.js'), publicationSource, 'utf8'),
    copyFile(
      path.join(packageRoot, 'runtime-adapter', 'runtime-contracts.js'),
      path.join(out, 'runtime-contracts.js'),
    ),
    copyFile(
      path.join(packageRoot, 'runtime-adapter', 'runtime-metrics.js'),
      path.join(out, 'runtime-metrics.js'),
    ),
    writeFile(path.join(out, 'package.json'), '{"type":"module"}\n', 'utf8'),
  ]);
  const receipt = {
    format: 'vhhealth_continuity_edge_verifier_source_receipt/v1',
    sources: {
      'continuityEdgeMirrorVerifier.js': sha256(verifierSource),
      'continuityPackCanonical.js': sha256(canonicalSource),
      'continuityPackPublicationService.js': sha256(publicationSource),
    },
  };
  await writeFile(
    path.join(out, 'source-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  );
  return { out, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await buildRuntimeVerifier(options);
    process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
