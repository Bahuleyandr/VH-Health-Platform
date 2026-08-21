import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  loadReleaseAuthorityManifest,
  validateReleaseAuthorityManifest,
  verifyReleaseAuthority,
} from './check-release-authority.mjs';

const root = resolve(import.meta.dirname, '..');

function manifestCopy() {
  return JSON.parse(readFileSync(join(root, 'infra/release-authority.json'), 'utf8'));
}

function activate(manifest, provider = 'github') {
  manifest.state = 'ACTIVE';
  manifest.selectedProvider = provider;
  manifest.releaseSignerProvider = provider;
  manifest.argoSourceProvider = provider;
  for (const name of Object.keys(manifest.providers)) manifest.providers[name].selected = name === provider;
  manifest.historicalWorkflowContainment.state = 'VERIFIED';
  for (const name of Object.keys(manifest.historicalWorkflowContainment.activationEvidence)) {
    manifest.historicalWorkflowContainment.activationEvidence[name] = `owner-receipt:${name}`;
  }
  return manifest;
}

const mainSha = '1'.repeat(40);
const tagSha = '2'.repeat(40);

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function activeFetch({ forgejoMain = mainSha, forgejoTag = tagSha, argoRevision = mainSha, mixedArgo = false, ambiguousArgo = false } = {}) {
  return async (url) => {
    if (url.includes('api.github.com') && url.endsWith('/commits/main')) return response({ sha: mainSha });
    if (url.includes('api.github.com') && url.includes('/git/ref/tags/')) {
      return response({ object: { type: 'commit', sha: tagSha } });
    }
    if (url.includes('/api/v1/repos/') && url.endsWith('/branches/main')) {
      return response({ commit: { id: forgejoMain } });
    }
    if (url.includes('/api/v1/repos/') && url.includes('/tags/')) {
      return response({ commit: { sha: forgejoTag } });
    }
    if (url.includes('/api/v1/applications/')) {
      return response({
        spec: {
          sources: [
            {
              repoURL: 'https://github.com/Bahuleyandr/VH-Health-Platform',
              targetRevision: 'main',
            },
            ...(mixedArgo ? [{
              repoURL: 'https://forgejo.hippocampus-monitor.ts.net/bahuleyan/VH-Health-Platform',
              targetRevision: 'main',
            }] : []),
            ...(ambiguousArgo ? [{
              repoURL: 'https://charts.example.test',
              targetRevision: '1.2.3',
            }] : []),
          ],
        },
        status: { sync: { revisions: mixedArgo ? [argoRevision, argoRevision] : [argoRevision] } },
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
}

function activeOptions(manifest, overrides = {}) {
  return {
    manifest,
    root,
    providerName: 'github',
    intent: 'patient-release',
    commit: tagSha,
    tags: ['patient-v1.2.3'],
    env: {
      RELEASE_AUTHORITY_GITHUB_TOKEN: 'github-read',
      RELEASE_AUTHORITY_FORGEJO_TOKEN: 'forgejo-read',
      RELEASE_AUTHORITY_ARGO_API_URL: 'https://argo.example',
      RELEASE_AUTHORITY_ARGO_TOKEN: 'argo-read',
    },
    fetchImpl: activeFetch(),
    git: () => Buffer.from(''),
    validateManifest: () => {},
    ...overrides,
  };
}

test('repository contract is decision-neutral and held', () => {
  const manifest = loadReleaseAuthorityManifest(root);
  assert.equal(manifest.state, 'HELD');
  assert.equal(manifest.selectedProvider, null);
  assert.equal(Object.values(manifest.providers).filter((provider) => provider.selected).length, 0);
  assert.equal(manifest.historicalWorkflowContainment.state, 'PENDING');
});

test('ACTIVE state requires external historical workflow containment evidence', () => {
  const manifest = activate(manifestCopy());
  manifest.historicalWorkflowContainment.state = 'PENDING';
  assert.throws(() => validateReleaseAuthorityManifest(manifest, root), /verified historical workflow containment/);

  const missingReceipt = activate(manifestCopy());
  missingReceipt.historicalWorkflowContainment.activationEvidence.githubReleaseTagProtection = null;
  assert.throws(() => validateReleaseAuthorityManifest(missingReceipt, root), /githubReleaseTagProtection/);
});

test('HELD state returns a non-authorizing result without network or credentials', async () => {
  const manifest = manifestCopy();
  let fetched = false;
  const result = await verifyReleaseAuthority({
    manifest,
    root,
    providerName: 'github',
    intent: 'patient-release',
    commit: 'a'.repeat(40),
    tags: ['patient-v1.2.3'],
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });
  assert.equal(result.authorized, false);
  assert.equal(result.state, 'HELD');
  assert.equal(fetched, false);
});

test('ACTIVE state rejects zero or multiple selected providers', () => {
  const none = activate(manifestCopy());
  none.providers.github.selected = false;
  assert.throws(() => validateReleaseAuthorityManifest(none, root), /exactly one selected provider/);

  const both = activate(manifestCopy());
  both.providers.forgejo.selected = true;
  assert.throws(() => validateReleaseAuthorityManifest(both, root), /exactly one selected provider/);
});

test('ACTIVE state rejects provider, signer, or Argo authority disagreement', () => {
  const signer = activate(manifestCopy());
  signer.releaseSignerProvider = 'forgejo';
  assert.throws(() => validateReleaseAuthorityManifest(signer, root), /releaseSignerProvider/);

  const argo = activate(manifestCopy());
  argo.argoSourceProvider = 'forgejo';
  assert.throws(() => validateReleaseAuthorityManifest(argo, root), /argoSourceProvider/);
});

test('ACTIVE state rejects the current Argo source until owners align it explicitly', () => {
  // Forgejo is deferred by owner decision, so its release-authority workflows are
  // inert templates outside `.forgejo/workflows/`. Selecting it is refused on that
  // ground alone, before Argo alignment is even considered — the deferral is the
  // blocker an owner needs told about first.
  const forgejo = activate(manifestCopy(), 'forgejo');
  assert.throws(
    () => validateReleaseAuthorityManifest(forgejo, root),
    /cannot select forgejo while its workflows are inert templates/,
  );

  // GitHub is the only currently selectable provider, and it is still refused:
  // the governed Argo Applications track `HEAD`, not the literal `main` branch.
  const github = activate(manifestCopy(), 'github');
  assert.throws(() => validateReleaseAuthorityManifest(github, root), /must target main, not HEAD/);

  // The Argo source-provider check must stay live for the day Forgejo stops being
  // inert; otherwise lifting the deferral would silently lift Argo alignment too.
  const runnableForgejo = activate(manifestCopy(), 'forgejo');
  runnableForgejo.providers.forgejo.executionBoundary = {
    mode: 'protected-environment',
    environment: 'release-authority-main',
  };
  assert.throws(
    () => validateReleaseAuthorityManifest(runnableForgejo, root),
    /points at github, not selected provider forgejo/,
  );
});

test('missing manifest fails closed', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'vh-release-authority-'));
  try {
    assert.throws(() => loadReleaseAuthorityManifest(temporary), /is missing/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('malformed manifest fails closed', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'vh-release-authority-'));
  try {
    mkdirSync(join(temporary, 'infra'));
    writeFileSync(join(temporary, 'infra', 'release-authority.json'), '{');
    assert.throws(() => loadReleaseAuthorityManifest(temporary), /is not valid JSON/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('network uncertainty blocks an ACTIVE release', async () => {
  const manifest = manifestCopy();
  // Bypass repository Argo-source activation mismatch to reach the live path;
  // the unit under test here is the mandatory provider observation.
  manifest.state = 'ACTIVE';
  manifest.selectedProvider = 'github';
  manifest.releaseSignerProvider = 'github';
  manifest.argoSourceProvider = 'github';
  manifest.providers.github.selected = true;
  await assert.rejects(
    () => verifyReleaseAuthority({
      manifest,
      root,
      providerName: 'github',
      intent: 'patient-release',
      commit: 'a'.repeat(40),
      tags: ['patient-v1.2.3'],
      env: {
        RELEASE_AUTHORITY_GITHUB_TOKEN: 'read-only',
        RELEASE_AUTHORITY_FORGEJO_TOKEN: 'read-only',
      },
      fetchImpl: async () => {
        throw new Error('network down');
      },
      validateManifest: () => {},
    }),
    /request failed/,
  );
});

test('authentication uncertainty blocks an ACTIVE release', async () => {
  const manifest = activate(manifestCopy());
  const options = activeOptions(manifest);
  delete options.env.RELEASE_AUTHORITY_FORGEJO_TOKEN;
  await assert.rejects(() => verifyReleaseAuthority(options), /missing read token for forgejo/);
});

test('a non-selected provider stays read-only without observing credentials', async () => {
  const manifest = activate(manifestCopy(), 'github');
  let fetched = false;
  const result = await verifyReleaseAuthority({
    ...activeOptions(manifest),
    providerName: 'forgejo',
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });
  assert.equal(result.authorized, false);
  assert.equal(fetched, false);
});

test('invalid release tags and insecure API endpoints fail closed', async () => {
  const manifest = activate(manifestCopy());
  await assert.rejects(
    () => verifyReleaseAuthority(activeOptions(manifest, { tags: ['patient-latest'] })),
    /invalid tag/,
  );

  const insecure = manifestCopy();
  insecure.providers.forgejo.apiBaseUrl = 'http://forgejo.example/api/v1';
  assert.throws(() => validateReleaseAuthorityManifest(insecure, root), /must use HTTPS/);
});

test('main SHA drift blocks an ACTIVE release', async () => {
  const manifest = activate(manifestCopy());
  await assert.rejects(
    () => verifyReleaseAuthority(activeOptions(manifest, {
      fetchImpl: activeFetch({ forgejoMain: '3'.repeat(40) }),
    })),
    /main parity failed/,
  );
});

test('tag SHA drift blocks an ACTIVE release', async () => {
  const manifest = activate(manifestCopy());
  await assert.rejects(
    () => verifyReleaseAuthority(activeOptions(manifest, {
      fetchImpl: activeFetch({ forgejoTag: '4'.repeat(40) }),
    })),
    /tag parity failed/,
  );
});

test('tag or workflow commit outside main blocks an ACTIVE release', async () => {
  const manifest = activate(manifestCopy());
  await assert.rejects(
    () => verifyReleaseAuthority(activeOptions(manifest, {
      git: () => {
        const error = new Error('not an ancestor');
        error.status = 1;
        throw error;
      },
    })),
    /not provably contained in main/,
  );
});

test('Argo live revision drift blocks an ACTIVE release', async () => {
  const manifest = activate(manifestCopy());
  await assert.rejects(
    () => verifyReleaseAuthority(activeOptions(manifest, {
      fetchImpl: activeFetch({ argoRevision: '5'.repeat(40) }),
    })),
    /not main/,
  );
});

test('mixed-provider Argo sources block an ACTIVE release', async () => {
  const manifest = activate(manifestCopy());
  await assert.rejects(
    () => verifyReleaseAuthority(activeOptions(manifest, {
      fetchImpl: activeFetch({ mixedArgo: true }),
    })),
    /exactly one governed-provider source/,
  );
});

test('ambiguous multi-source Argo revision reporting blocks an ACTIVE release', async () => {
  const manifest = activate(manifestCopy());
  await assert.rejects(
    () => verifyReleaseAuthority(activeOptions(manifest, {
      fetchImpl: activeFetch({ ambiguousArgo: true }),
    })),
    /reports 1 revisions for 2 sources/,
  );
});

test('manual dispatch from a non-main ref blocks before provider observation', async () => {
  const manifest = activate(manifestCopy());
  let fetched = false;
  await assert.rejects(
    () => verifyReleaseAuthority(activeOptions(manifest, {
      event: 'workflow_dispatch',
      ref: 'refs/tags/patient-v1.2.3',
      fetchImpl: async () => {
        fetched = true;
        throw new Error('must not fetch');
      },
    })),
    /must execute the protected main workflow/,
  );
  assert.equal(fetched, false);
});

test('matching provider, mirror, tag, containment, signer, and Argo facts authorize', async () => {
  const manifest = activate(manifestCopy());
  const result = await verifyReleaseAuthority(activeOptions(manifest));
  assert.equal(result.authorized, true);
  assert.equal(result.mainSha, mainSha);
  assert.equal(result.observations.github.tags['patient-v1.2.3'], tagSha);
  assert.equal(result.argo.length, manifest.argo.applications.length);
});

test('the Forgejo release lane stays deregistered while its activation is deferred', () => {
  // Forgejo Actions only registers workflows under `.forgejo/workflows/`. Moving a
  // release-authority workflow back there would re-arm a dispatchable Forgejo
  // publication path, which is exactly what the owner deferral forbids.
  for (const contract of loadReleaseAuthorityManifest(root).workflowContracts) {
    if (contract.provider !== 'forgejo') continue;
    assert.equal(contract.executable, false, `${contract.path} must be inert`);
    assert.ok(
      contract.path.startsWith('.forgejo/release-authority-templates/'),
      `${contract.path} must stay outside .forgejo/workflows/`,
    );
  }
  assert.ok(
    !existsSync(join(root, '.forgejo/workflows/release-authority-images.yml')),
    'the Forgejo image-release lane must not be a registered Forgejo workflow',
  );
});

test('repository workflows preserve immutable Forgejo pins while release mutation is held', () => {
  const forgejo = readFileSync(join(root, '.forgejo/release-authority-templates/release-authority-images.yml'), 'utf8');
  assert.match(forgejo, /checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(forgejo, /setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(forgejo, /cosign public-key --key env:\/\/COSIGN_PRIVATE_KEY/);
  assert.match(forgejo, /cosign verify --key infra\/forgejo\/signing\/cosign\.pub/);
  assert.doesNotMatch(forgejo, /cosign verify --key env:\/\/COSIGN_PUBLIC_KEY/);
});
