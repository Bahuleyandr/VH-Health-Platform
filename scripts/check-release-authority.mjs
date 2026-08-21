import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = 'infra/release-authority.json';
const providerNames = ['github', 'forgejo'];
const shaPattern = /^[0-9a-f]{40}$/i;

function fail(message) {
  throw new Error(message);
}

function normalizedUrl(value) {
  return String(value || '').replace(/\.git$/i, '').replace(/\/$/, '');
}

function requireHttpsUrl(value, label) {
  requiredString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') fail(`${label} must use HTTPS`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value;
}

function workflowJobBlock(workflow, jobId) {
  const jobsIndex = workflow.search(/^jobs:\s*$/m);
  if (jobsIndex === -1) return '';
  const jobs = workflow.slice(jobsIndex);
  const escaped = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^  ${escaped}:\\s*$`, 'm').exec(jobs);
  if (!match) return '';
  const start = match.index;
  const rest = jobs.slice(start + match[0].length);
  const next = rest.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + match[0].length + next);
}

function workflowStepBlock(jobBlock, stepName) {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^      - name:\\s*${escaped}\\s*$`, 'm').exec(jobBlock);
  if (!match) return '';
  const start = match.index;
  const rest = jobBlock.slice(start + match[0].length);
  const next = rest.search(/^      - (?:name|uses):/m);
  return next === -1 ? jobBlock.slice(start) : jobBlock.slice(start, start + match[0].length + next);
}

function topLevelPermissions(workflow) {
  const match = /^permissions:\s*$([\s\S]*?)(?=^[A-Za-z0-9_-]+:\s*$)/m.exec(workflow);
  return match?.[1] || '';
}

function workflowRunBlocks(workflow) {
  const lines = workflow.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*[|>]\s*$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const lineIndent = /^\s*/.exec(line)[0].length;
      if (line.trim() && lineIndent <= indent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

function workflowTriggerBlock(workflow) {
  const match = /^on:\s*$([\s\S]*?)(?=^[A-Za-z0-9_-]+:\s*$)/m.exec(workflow);
  return match?.[1] || '';
}

function yamlFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...yamlFiles(path));
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(path);
  }
  return files;
}

function argoSourceForApplication(root, manifest, application) {
  const knownUrls = new Map(
    providerNames.map((name) => [normalizedUrl(manifest.providers[name].repositoryUrl), name]),
  );
  const matches = [];
  for (const sourcePath of manifest.argo.sourceManifests) {
    const content = readFileSync(join(root, sourcePath), 'utf8').replace(/\r\n/g, '\n');
    for (const document of content.split(/^---\s*$/m)) {
      if (!new RegExp(`^  name:\\s*${application.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(document)) continue;
      for (const match of document.matchAll(/^\s*-?\s*repoURL:\s*([^\s#]+)[^\n]*\n\s*targetRevision:\s*["']?([^\s#"']+)/gm)) {
        const provider = knownUrls.get(normalizedUrl(match[1]));
        if (provider) matches.push({ provider, repositoryUrl: normalizedUrl(match[1]), revision: match[2], sourcePath });
      }
    }
  }
  if (matches.length !== 1) fail(`Argo application ${application} must have exactly one source from a governed provider; found ${matches.length}`);
  return matches[0];
}

export function validateReleaseAuthorityManifest(manifest, root = process.cwd()) {
  if (!manifest || manifest.schemaVersion !== 1) fail('release authority schemaVersion must be 1');
  if (!['HELD', 'ACTIVE'].includes(manifest.state)) fail('release authority state must be HELD or ACTIVE');
  requiredString(manifest.mainBranch, 'mainBranch');

  const configuredProviders = Object.keys(manifest.providers || {}).sort();
  if (configuredProviders.join(',') !== [...providerNames].sort().join(',')) {
    fail(`providers must be exactly ${providerNames.join(', ')}`);
  }

  for (const name of providerNames) {
    const provider = manifest.providers[name];
    if (typeof provider.selected !== 'boolean') fail(`providers.${name}.selected must be boolean`);
    if (provider.apiKind !== name) fail(`providers.${name}.apiKind must be ${name}`);
    requiredString(provider.repository, `providers.${name}.repository`);
    requireHttpsUrl(provider.repositoryUrl, `providers.${name}.repositoryUrl`);
    requireHttpsUrl(provider.apiBaseUrl, `providers.${name}.apiBaseUrl`);
    requiredString(provider.tokenEnvironment, `providers.${name}.tokenEnvironment`);
    requiredString(provider.executionBoundary?.mode, `providers.${name}.executionBoundary.mode`);
    if (name === 'github') {
      if (provider.executionBoundary.mode !== 'protected-environment') {
        fail('GitHub execution boundary must be a protected environment');
      }
      requiredString(provider.executionBoundary.environment, 'providers.github.executionBoundary.environment');
    } else if (provider.executionBoundary.mode === 'inert-template') {
      requiredString(provider.executionBoundary.templateRoot, 'providers.forgejo.executionBoundary.templateRoot');
    }
    requiredString(provider.signer?.kind, `providers.${name}.signer.kind`);
    if (provider.signer.publicKeyPath && !existsSync(join(root, provider.signer.publicKeyPath))) {
      fail(`providers.${name}.signer.publicKeyPath does not exist: ${provider.signer.publicKeyPath}`);
    }
  }

  const githubImageRelease = readFileSync(join(root, '.github/workflows/release-authority-images.yml'), 'utf8');
  const forgejoImageRelease = readFileSync(join(root, '.forgejo/release-authority-templates/release-authority-images.yml'), 'utf8');
  const expectedGithubIdentity = `${normalizedUrl(manifest.providers.github.repositoryUrl)}/.github/workflows/release-authority-images.yml@`;
  if (
    manifest.providers.github.signer.kind !== 'sigstore-keyless' ||
    manifest.providers.github.signer.identityPrefix !== expectedGithubIdentity ||
    !githubImageRelease.includes('cosign sign --yes "${tag}@${DIGEST}"') ||
    !githubImageRelease.includes('/\\.github/workflows/release-authority-images\\.yml@.*$') ||
    !githubImageRelease.includes('--certificate-oidc-issuer https://token.actions.githubusercontent.com')
  ) {
    fail('GitHub release signer contract is not aligned with its keyless workflow identity');
  }
  if (
    manifest.providers.forgejo.signer.kind !== 'cosign-key-pair' ||
    !forgejoImageRelease.includes('cosign sign --yes --key env://COSIGN_PRIVATE_KEY') ||
    !forgejoImageRelease.includes('cosign verify --key infra/forgejo/signing/cosign.pub') ||
    !forgejoImageRelease.includes('cosign public-key --key env://COSIGN_PRIVATE_KEY') ||
    !forgejoImageRelease.includes('cmp -s /tmp/vh-release-tools/release-authority.pub infra/forgejo/signing/cosign.pub') ||
    forgejoImageRelease.includes('cosign verify --key env://COSIGN_PUBLIC_KEY')
  ) {
    fail('Forgejo release signer contract is not aligned with its cosign key-pair workflow');
  }

  const selected = providerNames.filter((name) => manifest.providers[name].selected);
  const historical = manifest.historicalWorkflowContainment;
  if (!historical || !['PENDING', 'VERIFIED'].includes(historical.state)) {
    fail('historicalWorkflowContainment.state must be PENDING or VERIFIED');
  }
  if (!Array.isArray(historical.legacyWorkflowPaths) || historical.legacyWorkflowPaths.length === 0) {
    fail('historicalWorkflowContainment.legacyWorkflowPaths must be a non-empty array');
  }
  for (const legacyPath of historical.legacyWorkflowPaths) {
    requiredString(legacyPath, 'historicalWorkflowContainment legacy workflow path');
    if (existsSync(join(root, legacyPath))) fail(`legacy mutating workflow must be removed from HEAD: ${legacyPath}`);
  }
  const containmentEvidence = historical.activationEvidence || {};
  const containmentEvidenceFields = [
    'githubLegacyWorkflowDisablement',
    'forgejoLegacyWorkflowDisablement',
    'githubReleaseTagProtection',
    'forgejoReleaseTagProtection',
    'publicationCredentialRotation',
    'githubProtectedEnvironmentPolicy',
    'forgejoCredentialBrokerPolicy',
  ];
  if (manifest.state === 'HELD') {
    if (selected.length !== 0) fail('HELD release authority must not select a provider');
    for (const field of ['selectedProvider', 'releaseSignerProvider', 'argoSourceProvider']) {
      if (manifest[field] !== null) fail(`HELD release authority requires ${field} to be null`);
    }
    if (historical.state !== 'PENDING') fail('HELD release authority requires historical workflow containment to remain PENDING');
    for (const field of containmentEvidenceFields) {
      if (containmentEvidence[field] !== null) fail(`HELD release authority requires ${field} activation evidence to be null`);
    }
  } else {
    if (selected.length !== 1) fail(`ACTIVE release authority requires exactly one selected provider; found ${selected.length}`);
    for (const field of ['selectedProvider', 'releaseSignerProvider', 'argoSourceProvider']) {
      if (manifest[field] !== selected[0]) fail(`ACTIVE release authority requires ${field} to equal ${selected[0]}`);
    }
    if (historical.state !== 'VERIFIED') fail('ACTIVE release authority requires verified historical workflow containment');
    for (const field of containmentEvidenceFields) {
      requiredString(containmentEvidence[field], `historicalWorkflowContainment.activationEvidence.${field}`);
    }
    if (manifest.providers[manifest.selectedProvider].executionBoundary.mode === 'inert-template') {
      fail(`ACTIVE release authority cannot select ${manifest.selectedProvider} while its workflows are inert templates`);
    }
  }

  if (!Array.isArray(manifest.argo?.applications) || manifest.argo.applications.length === 0) {
    fail('argo.applications must be a non-empty array');
  }
  requiredString(manifest.argo.apiUrlEnvironment, 'argo.apiUrlEnvironment');
  requiredString(manifest.argo.tokenEnvironment, 'argo.tokenEnvironment');
  if (!Array.isArray(manifest.argo.sourceManifests) || manifest.argo.sourceManifests.length === 0) {
    fail('argo.sourceManifests must be a non-empty array');
  }
  for (const path of manifest.argo.sourceManifests) {
    if (!existsSync(join(root, path))) fail(`Argo source manifest does not exist: ${path}`);
  }

  const argoSources = manifest.argo.applications.map((application) => ({
    application,
    ...argoSourceForApplication(root, manifest, application),
  }));
  if (manifest.state === 'ACTIVE') {
    for (const source of argoSources) {
      if (source.provider !== manifest.selectedProvider) {
        fail(`Argo application ${source.application} points at ${source.provider}, not selected provider ${manifest.selectedProvider}`);
      }
      if (source.revision !== manifest.mainBranch) {
        fail(`Argo application ${source.application} must target ${manifest.mainBranch}, not ${source.revision}`);
      }
    }
  }

  if (!Array.isArray(manifest.workflowContracts) || manifest.workflowContracts.length === 0) {
    fail('workflowContracts must be a non-empty array');
  }
  for (const contract of manifest.workflowContracts) {
    if (!providerNames.includes(contract.provider)) fail(`Unknown workflow provider: ${contract.provider}`);
    requiredString(contract.intent, `${contract.path}.intent`);
    const path = join(root, contract.path);
    if (!existsSync(path)) fail(`Governed workflow does not exist: ${contract.path}`);
    const workflow = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    if (contract.executable === false && !contract.path.startsWith('.forgejo/release-authority-templates/')) {
      fail(`${contract.path} is marked inert but is not under the Forgejo inert-template root`);
    }
    if (contract.executable !== false && contract.path.startsWith('.forgejo/release-authority-templates/')) {
      fail(`${contract.path} is an inert template and must be marked executable=false`);
    }
    if (/\bgit\s+push\b/i.test(workflow.replace(/\\\n\s*/g, ' '))) {
      fail(`${contract.path} must not push Git refs directly; emit a reviewed patch instead`);
    }
    if (!/^permissions:\s*$/m.test(workflow)) fail(`${contract.path} must declare top-level permissions`);
    if (/^\s+[A-Za-z0-9_-]+:\s*write\s*$/m.test(topLevelPermissions(workflow))) {
      fail(`${contract.path} top-level permissions must be read-only`);
    }
    if (/^\s{4}tags:\s*/m.test(workflowTriggerBlock(workflow))) {
      fail(`${contract.path} must not mutate from a tag-push workflow; use a protected default-branch dispatcher`);
    }
    const triggerBlock = workflowTriggerBlock(workflow);
    if (!/^\s{2}workflow_dispatch:\s*$/m.test(triggerBlock)) {
      fail(`${contract.path} must expose a protected default-branch workflow_dispatch`);
    }
    if (/^\s{2}push:\s*$/m.test(triggerBlock)) {
      fail(`${contract.path} must not expose push-triggered mutation`);
    }
    for (const runBlock of workflowRunBlocks(workflow)) {
      if (/\$\{\{\s*(?:inputs\.|github\.(?:ref_name|event\.workflow_run\.))/m.test(runBlock)) {
        fail(`${contract.path} must pass attacker-controlled workflow expressions through env before shell execution`);
      }
    }
    if (contract.provider === 'forgejo' && workflow.includes('cosign sign --yes --key env://COSIGN_PRIVATE_KEY')) {
      if (
        !workflow.includes('cosign public-key --key env://COSIGN_PRIVATE_KEY') ||
        !workflow.includes('cosign verify --key infra/forgejo/signing/cosign.pub') ||
        !workflow.includes('cmp -s ') ||
        !workflow.includes('infra/forgejo/signing/cosign.pub') ||
        workflow.includes('cosign verify --key env://COSIGN_PUBLIC_KEY')
      ) {
        fail(`${contract.path} must prove its private signer and verify signatures against the tracked Forgejo cosign public key`);
      }
    }
    const authorityJob = workflowJobBlock(workflow, 'release-authority');
    if (!authorityJob) fail(`${contract.path} must define a release-authority job`);
    if (!authorityJob.includes(`--provider ${contract.provider}`) || !authorityJob.includes(`--intent ${contract.intent}`)) {
      fail(`${contract.path} release-authority job must invoke its exact provider and intent`);
    }
    if (!/permissions:\s*\n\s+contents:\s*read/m.test(authorityJob)) {
      fail(`${contract.path} release-authority job must have contents: read`);
    }
    if (contract.provider === 'github') {
      const environment = manifest.providers.github.executionBoundary.environment;
      if (!new RegExp(`^    environment:\\s*${environment.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'm').test(authorityJob)) {
        fail(`${contract.path} release-authority job must use protected environment ${environment}`);
      }
    }
    for (const jobId of contract.guardedJobs || []) {
      const block = workflowJobBlock(workflow, jobId);
      if (!block) fail(`${contract.path} is missing guarded job ${jobId}`);
      if (!/needs:\s*(?:release-authority|\[[^\]]*\brelease-authority\b)/m.test(block)) {
        fail(`${contract.path} job ${jobId} must need release-authority`);
      }
      if (!block.includes("needs.release-authority.outputs.authorized == 'true'")) {
        fail(`${contract.path} job ${jobId} must fail closed on release-authority authorization`);
      }
      if (contract.provider === 'github') {
        const environment = manifest.providers.github.executionBoundary.environment;
        if (!new RegExp(`^    environment:\\s*${environment.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'm').test(block)) {
          fail(`${contract.path} job ${jobId} must use protected environment ${environment}`);
        }
      }
    }
    for (const step of contract.guardedSteps || []) {
      const block = workflowJobBlock(workflow, step.job);
      if (!block) fail(`${contract.path} is missing guarded-step job ${step.job}`);
      if (!/needs:\s*(?:release-authority|\[[^\]]*\brelease-authority\b)/m.test(block)) {
        fail(`${contract.path} job ${step.job} must need release-authority`);
      }
      const stepBlock = workflowStepBlock(block, step.name);
      if (!stepBlock) fail(`${contract.path} is missing guarded step ${step.name}`);
      if (!stepBlock.includes("needs.release-authority.outputs.authorized == 'true'")) {
        fail(`${contract.path} step ${step.name} must fail closed on release-authority authorization`);
      }
    }
  }

  for (const workflowRoot of ['.github/workflows', '.forgejo/workflows']) {
    for (const path of yamlFiles(join(root, workflowRoot))) {
      const content = readFileSync(path, 'utf8');
      if (/\bgit\s+push\b[^\r\n]*(?:\bmain\b|HEAD:main)/i.test(content.replace(/\\\r?\n\s*/g, ' '))) {
        fail(`${relative(root, path).replaceAll('\\', '/')} must not push directly to main`);
      }
    }
  }

  return { selected, argoSources };
}

export function loadReleaseAuthorityManifest(root = process.cwd()) {
  const path = join(root, MANIFEST_PATH);
  if (!existsSync(path)) fail(`${MANIFEST_PATH} is missing`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${MANIFEST_PATH} is not valid JSON: ${error.message}`);
  }
  validateReleaseAuthorityManifest(manifest, root);
  return manifest;
}

function apiUrl(provider, suffix) {
  return `${provider.apiBaseUrl.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
}

async function requestJson(url, token, kind, fetchImpl = fetch) {
  if (!token) fail(`missing read token for ${kind}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        Authorization: kind === 'forgejo' ? `token ${token}` : `Bearer ${token}`,
        'User-Agent': 'vh-health-release-authority/1',
        ...(kind === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    fail(`${kind} request failed for ${url}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) fail(`${kind} request failed for ${url}: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    fail(`${kind} returned invalid JSON for ${url}: ${error.message}`);
  }
}

async function providerMain(provider, mainBranch, token, fetchImpl) {
  const repository = provider.repository.split('/').map(encodeURIComponent).join('/');
  const suffix = provider.apiKind === 'github'
    ? `repos/${repository}/commits/${encodeURIComponent(mainBranch)}`
    : `repos/${repository}/branches/${encodeURIComponent(mainBranch)}`;
  const payload = await requestJson(apiUrl(provider, suffix), token, provider.apiKind, fetchImpl);
  const sha = provider.apiKind === 'github' ? payload.sha : payload.commit?.id || payload.commit?.sha;
  if (!shaPattern.test(sha || '')) fail(`${provider.apiKind} main did not resolve to a full commit SHA`);
  return sha.toLowerCase();
}

async function providerTag(provider, token, tag, fetchImpl) {
  const repository = provider.repository.split('/').map(encodeURIComponent).join('/');
  const encodedTag = encodeURIComponent(tag);
  if (provider.apiKind === 'forgejo') {
    const payload = await requestJson(apiUrl(provider, `repos/${repository}/tags/${encodedTag}`), token, provider.apiKind, fetchImpl);
    const sha = payload.commit?.sha || payload.commit?.id;
    if (!shaPattern.test(sha || '')) fail(`forgejo tag ${tag} did not resolve to a full commit SHA`);
    return sha.toLowerCase();
  }

  let object = (await requestJson(
    apiUrl(provider, `repos/${repository}/git/ref/tags/${encodedTag}`),
    token,
    provider.apiKind,
    fetchImpl,
  )).object;
  for (let depth = 0; depth < 4 && object?.type === 'tag'; depth += 1) {
    object = (await requestJson(
      apiUrl(provider, `repos/${repository}/git/tags/${object.sha}`),
      token,
      provider.apiKind,
      fetchImpl,
    )).object;
  }
  if (object?.type !== 'commit' || !shaPattern.test(object.sha || '')) {
    fail(`github tag ${tag} did not resolve to a commit within four tag objects`);
  }
  return object.sha.toLowerCase();
}

function assertLocalContainment(commit, mainSha, git = execFileSync) {
  try {
    git('git', ['cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' });
    git('git', ['cat-file', '-e', `${mainSha}^{commit}`], { stdio: 'ignore' });
    git('git', ['merge-base', '--is-ancestor', commit, mainSha], { stdio: 'ignore' });
  } catch {
    fail(`commit ${commit} is not provably contained in main ${mainSha} in the full checkout`);
  }
}

async function observeArgo(manifest, selectedProvider, mainSha, env, fetchImpl) {
  const baseUrl = env[manifest.argo.apiUrlEnvironment];
  const token = env[manifest.argo.tokenEnvironment];
  if (!baseUrl) fail(`missing ${manifest.argo.apiUrlEnvironment}`);
  if (!token) fail(`missing ${manifest.argo.tokenEnvironment}`);
  requireHttpsUrl(baseUrl, manifest.argo.apiUrlEnvironment);
  const selectedUrl = normalizedUrl(manifest.providers[selectedProvider].repositoryUrl);
  const governedUrls = new Map(
    providerNames.map((name) => [normalizedUrl(manifest.providers[name].repositoryUrl), name]),
  );
  const results = [];
  for (const application of manifest.argo.applications) {
    const payload = await requestJson(
      `${baseUrl.replace(/\/$/, '')}/api/v1/applications/${encodeURIComponent(application)}`,
      token,
      'argo',
      fetchImpl,
    );
    const sources = payload.spec?.sources || (payload.spec?.source ? [payload.spec.source] : []);
    const governedSources = sources
      .map((source, index) => ({ source, index, provider: governedUrls.get(normalizedUrl(source.repoURL)) }))
      .filter((entry) => entry.provider);
    if (governedSources.length !== 1) {
      fail(`Argo application ${application} must have exactly one governed-provider source; found ${governedSources.length}`);
    }
    const governed = governedSources[0];
    if (normalizedUrl(governed.source.repoURL) !== selectedUrl) {
      fail(`Argo application ${application} uses ${governed.provider}, not selected provider ${selectedProvider}`);
    }
    if (governed.source.targetRevision !== manifest.mainBranch) {
      fail(`Argo application ${application} targets ${governed.source.targetRevision}, not ${manifest.mainBranch}`);
    }
    const reportedRevisions = payload.status?.sync?.revisions;
    let revision = null;
    if (Array.isArray(reportedRevisions)) {
      if (reportedRevisions.length !== sources.length) {
        fail(`Argo application ${application} reports ${reportedRevisions.length} revisions for ${sources.length} sources`);
      }
      revision = reportedRevisions[governed.index];
    } else if (sources.length === 1) {
      revision = payload.status?.sync?.revision;
    } else {
      fail(`Argo application ${application} has multiple sources but no indexed sync revisions`);
    }
    if (String(revision || '').toLowerCase() !== mainSha) {
      fail(`Argo application ${application} reports ${revision || 'no revision'}, not main ${mainSha}`);
    }
    results.push({ application, revision: mainSha, repositoryUrl: selectedUrl });
  }
  return results;
}

function validateInvocationTags(manifest, intent, tags, event, ref) {
  const patternText = manifest.tagPatterns?.[intent];
  if (!patternText) {
    if (tags.length > 0) fail(`${intent} does not accept release tags`);
    return;
  }
  const pattern = new RegExp(patternText);
  for (const tag of tags) {
    if (!pattern.test(tag)) fail(`${intent} received invalid tag ${tag}`);
  }
  const taglessImageVerification =
    intent === 'image-release' &&
    (event === 'workflow_dispatch' || (event === 'push' && ref === `refs/heads/${manifest.mainBranch}`));
  if (tags.length === 0 && !taglessImageVerification) {
    fail(`${intent} requires at least one governed release tag`);
  }
}

export async function verifyReleaseAuthority({
  manifest,
  root = process.cwd(),
  providerName,
  intent,
  commit = '',
  tags = [],
  event = '',
  ref = '',
  env = process.env,
  fetchImpl = fetch,
  git = execFileSync,
  validateManifest = validateReleaseAuthorityManifest,
}) {
  validateManifest(manifest, root);
  if (!providerNames.includes(providerName)) fail(`provider must be one of ${providerNames.join(', ')}`);
  const contract = manifest.workflowContracts.find(
    (entry) => entry.provider === providerName && entry.intent === intent,
  );
  if (!contract) fail(`no workflow contract exists for ${providerName}/${intent}`);

  if (manifest.state === 'HELD') {
    return {
      state: 'HELD',
      authorized: false,
      provider: providerName,
      intent,
      reason: 'Release authority is decision-neutral and held; no provider, signer, or Argo source is selected.',
    };
  }
  if (manifest.selectedProvider !== providerName) {
    return {
      state: 'ACTIVE',
      authorized: false,
      provider: providerName,
      intent,
      reason: `${providerName} is not the selected release authority.`,
    };
  }
  if (event === 'pull_request') {
    return {
      state: 'ACTIVE',
      authorized: false,
      provider: providerName,
      intent,
      reason: 'Pull-request verification never has release authority.',
    };
  }
  if (event === 'workflow_dispatch' && ref !== `refs/heads/${manifest.mainBranch}`) {
    fail(`workflow_dispatch must execute the protected ${manifest.mainBranch} workflow, got ${ref || 'no ref'}`);
  }

  const normalizedTags = [...new Set(tags.filter(Boolean))];
  validateInvocationTags(manifest, intent, normalizedTags, event, ref);
  const normalizedCommit = commit ? commit.toLowerCase() : '';
  if (normalizedCommit && !shaPattern.test(normalizedCommit)) fail(`commit must be a full 40-character SHA, got ${commit}`);

  const observations = {};
  for (const name of providerNames) {
    const provider = manifest.providers[name];
    const token = env[provider.tokenEnvironment];
    observations[name] = {
      mainSha: await providerMain(provider, manifest.mainBranch, token, fetchImpl),
      tags: {},
    };
    for (const tag of normalizedTags) {
      observations[name].tags[tag] = await providerTag(provider, token, tag, fetchImpl);
    }
  }

  const mainSha = observations.github.mainSha;
  if (observations.forgejo.mainSha !== mainSha) {
    fail(`main parity failed: github=${mainSha}, forgejo=${observations.forgejo.mainSha}`);
  }
  for (const tag of normalizedTags) {
    const githubTag = observations.github.tags[tag];
    const forgejoTag = observations.forgejo.tags[tag];
    if (githubTag !== forgejoTag) fail(`tag parity failed for ${tag}: github=${githubTag}, forgejo=${forgejoTag}`);
    assertLocalContainment(githubTag, mainSha, git);
  }

  if (normalizedCommit) assertLocalContainment(normalizedCommit, mainSha, git);
  if (['image-release', 'patient-release', 'staff-release', 'digest-pin'].includes(intent) && normalizedCommit && normalizedTags.length === 1) {
    const tagCommit = observations.github.tags[normalizedTags[0]];
    if (tagCommit !== normalizedCommit) fail(`release tag ${normalizedTags[0]} resolves to ${tagCommit}, not workflow commit ${normalizedCommit}`);
  }

  const argo = await observeArgo(manifest, providerName, mainSha, env, fetchImpl);
  return {
    state: 'ACTIVE',
    authorized: true,
    provider: providerName,
    mirrorProvider: providerNames.find((name) => name !== providerName),
    signerProvider: manifest.releaseSignerProvider,
    argoSourceProvider: manifest.argoSourceProvider,
    intent,
    commit: normalizedCommit || null,
    tags: normalizedTags,
    mainSha,
    observations,
    argo,
  };
}

function parseArgs(argv) {
  const args = { tags: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--contract') args.contract = true;
    else if (value === '--provider') args.provider = argv[++index];
    else if (value === '--intent') args.intent = argv[++index];
    else if (value === '--commit') args.commit = argv[++index];
    else if (value === '--tag') args.tags.push(argv[++index]);
    else if (value === '--event') args.event = argv[++index];
    else if (value === '--ref') args.ref = argv[++index];
    else if (value === '--evidence-file') args.evidenceFile = argv[++index];
    else fail(`unknown argument ${value}`);
  }
  return args;
}

function writeEvidence(path, evidence) {
  if (!path) return;
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

function writeOutputs(evidence, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = [
    `state=${evidence.state || 'BLOCKED'}`,
    `authorized=${evidence.authorized === true ? 'true' : 'false'}`,
  ];
  writeFileSync(outputPath, `${lines.join('\n')}\n`, { flag: 'a' });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const root = options.root || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let evidence;
  try {
    const manifest = loadReleaseAuthorityManifest(root);
    if (args.contract) {
      evidence = { state: manifest.state, authorized: false, contract: 'valid' };
    } else {
      requiredString(args.provider, '--provider');
      requiredString(args.intent, '--intent');
      evidence = await verifyReleaseAuthority({
        manifest,
        root,
        providerName: args.provider,
        intent: args.intent,
        commit: args.commit,
        tags: args.tags,
        event: args.event,
        ref: args.ref,
        env: options.env || process.env,
        fetchImpl: options.fetchImpl || fetch,
        git: options.git || execFileSync,
      });
    }
    writeEvidence(args.evidenceFile, evidence);
    writeOutputs(evidence, options.outputPath);
    console.log(evidence.authorized ? `Release authority authorized ${evidence.provider}/${evidence.intent}.` : `Release authority ${evidence.state}: mutation is not authorized.`);
    return evidence;
  } catch (error) {
    evidence = { state: 'BLOCKED', authorized: false, error: error.message };
    writeEvidence(args.evidenceFile, evidence);
    writeOutputs(evidence, options.outputPath);
    throw error;
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(`Release authority check failed: ${error.message}`);
    process.exit(1);
  });
}
