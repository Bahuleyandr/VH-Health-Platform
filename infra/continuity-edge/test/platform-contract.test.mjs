import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const edgeRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(edgeRoot, '..', '..');

async function filesBelow(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(target)));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

test('held RWX component renders exact writer/reader mounts and is absent from active overlays', async () => {
  const windowsKustomize = 'D:\\Dev\\Tools\\kubetools\\kustomize.exe';
  const binary = existsSync(windowsKustomize) ? windowsKustomize : 'kustomize';
  const fixture = path.join(
    edgeRoot,
    'test',
    'fixtures',
    'held-publication',
  );
  const render = spawnSync(
    binary,
    ['build', '--load-restrictor', 'LoadRestrictionsNone', fixture],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(
    render.status,
    0,
    render.error?.message || render.stderr || 'kustomize render failed',
  );
  assert.match(render.stdout, /claimName: vhhealth-continuity-publication/);
  assert.match(render.stdout, /mountPath: \/var\/lib\/vhhealth\/continuity/);
  assert.match(render.stdout, /name: DOWNTIME_MIRROR_DIR/);
  assert.match(render.stdout, /name: CLINICAL_CONTINUITY_PACKS_ENABLED\s+value: "false"/);
  assert.match(render.stdout, /readOnly: true/);
  assert.match(render.stdout, /readOnly: false/);

  const overlays = path.join(repoRoot, 'infra', 'kubernetes', 'overlays');
  for (const file of await filesBelow(overlays)) {
    const content = await readFile(file, 'utf8');
    assert.doesNotMatch(
      content,
      /continuity-publication-rwx/,
      `${path.relative(repoRoot, file)} activates the held component`,
    );
  }
});

test('Caddy is loopback-only, path allowlisted, non-browsable, and image pins are immutable', async () => {
  const [caddyfile, dockerfile, example] = await Promise.all([
    readFile(path.join(edgeRoot, 'Caddyfile'), 'utf8'),
    readFile(path.join(edgeRoot, 'Dockerfile'), 'utf8'),
    readFile(path.join(edgeRoot, 'config', 'edge.env.example'), 'utf8'),
  ]);
  assert.match(caddyfile, /http:\/\/127\.0\.0\.1:8080/);
  assert.match(caddyfile, /pack\\\.\(\?:html\|json\)|pack\\\.\(html\|json\)/);
  assert.match(caddyfile, /respond "Not found" 404/);
  assert.doesNotMatch(caddyfile, /\bbrowse\b/);
  assert.match(caddyfile, /hide \._\* current\.json manifest\.json edge-access\.json/);
  const digests = `${dockerfile}\n${example}`.match(/@sha256:[0-9a-f]{64}/g);
  assert.ok(digests && digests.length >= 3);
  for (const digest of digests) {
    if (example.includes(digest) && digest.endsWith('0'.repeat(64))) continue;
    assert.notEqual(digest, `@sha256:${'0'.repeat(64)}`);
  }
  assert.match(example, /VHEDGE_ACTIVATION_APPROVED=false/);
});

test('preflight contains fail-closed LUKS2, mount-option, receipt, and trusted-clock gates', async () => {
  const [preflight, validator] = await Promise.all([
    readFile(path.join(edgeRoot, 'preflight.sh'), 'utf8'),
    readFile(path.join(edgeRoot, 'bin', 'validate-config.mjs'), 'utf8'),
  ]);
  for (const contract of [
    /type:\[\[:space:\]\]\+LUKS2/,
    /rw nodev nosuid noexec/,
    /VHEDGE_ACTIVATION_APPROVED.*true/s,
    /validate-config\.mjs/,
    /NTPSynchronized/,
    /pull, upload, and TLS private keys must be distinct/,
    /require_private_directory "\$\{VHEDGE_DATA_ROOT\}" "data root"/,
    /owner="\$\(stat -c '%u:%g' "\$\{file\}"\)"/,
    /owned by 10001:10001 without group\/world access/,
  ]) {
    assert.match(preflight, contract);
  }
  assert.match(validator, /logger:\$\{location\} certificate/);
  assert.match(validator, /privateMode: true/);
  assert.match(validator, /ownerUid: 10001/);
  assert.match(validator, /ownerGid: 10001/);
});

test('systemd uses one root-owned Podman store while forcing non-root containers', async () => {
  const systemdRoot = path.join(edgeRoot, 'systemd');
  const services = (await readdir(systemdRoot))
    .filter(
      (name) =>
        name.endsWith('.service') &&
        !name.endsWith('-preflight.service'),
    );
  for (const name of services) {
    const unit = await readFile(path.join(systemdRoot, name), 'utf8');
    assert.match(unit, /^User=root$/m);
    assert.match(unit, /podman run .*--read-only .*--user 10001:10001/);
    assert.match(
      unit,
      /--cap-drop=all (?:--cap-add=net_bind_service )?--security-opt=no-new-privileges/,
    );
    assert.match(unit, /ReadWritePaths=.*\/var\/lib\/containers .*\/run\/containers/);
  }
  const caddy = await readFile(
    path.join(systemdRoot, 'vhhealth-continuity-edge-caddy.service'),
    'utf8',
  );
  assert.match(
    caddy,
    /--cap-drop=all --cap-add=net_bind_service --security-opt=no-new-privileges/,
  );
  assert.match(caddy, /--tmpfs=\/config:[^\s]*uid=10001,gid=10001,mode=700/);
  const gateway = await readFile(
    path.join(systemdRoot, 'vhhealth-continuity-edge-gateway.service'),
    'utf8',
  );
  assert.match(
    gateway,
    /--volume=\$\{VHEDGE_DATA_ROOT\}:\$\{VHEDGE_DATA_ROOT\}:ro/,
  );
  assert.match(
    gateway,
    /--volume=\$\{VHEDGE_DATA_ROOT\}\/state:\$\{VHEDGE_DATA_ROOT\}\/state:rw/,
  );
  assert.match(
    gateway,
    /--volume=\$\{VHEDGE_DATA_ROOT\}\/metrics:\$\{VHEDGE_DATA_ROOT\}\/metrics:rw/,
  );
  const preflight = await readFile(
    path.join(systemdRoot, 'vhhealth-continuity-edge-preflight.service'),
    'utf8',
  );
  assert.doesNotMatch(preflight, /RemainAfterExit=yes/);
  assert.match(
    preflight,
    /ReadWritePaths=.*\/var\/lib\/containers .*\/run\/containers/,
  );
});

test('source pull pins its preflighted key and known-hosts files at execution', async () => {
  const [source, example] = await Promise.all([
    readFile(path.join(edgeRoot, 'lib', 'rclone-source.mjs'), 'utf8'),
    readFile(
      path.join(edgeRoot, 'config', 'rclone-source.conf.example'),
      'utf8',
    ),
  ]);
  assert.match(source, /'--sftp-key-file',\s*this\.identityPath/);
  assert.match(source, /'--sftp-known-hosts-file',\s*this\.knownHostsPath/);
  assert.doesNotMatch(example, /^\s*(?:key_file|known_hosts_file)\s*=/m);
});
