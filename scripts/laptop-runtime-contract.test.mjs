import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');
const compose = read('infra/local/laptop/compose.yaml');
const nginx = read('infra/local/laptop/nginx.conf');
const example = read('infra/local/laptop/.env.example');
const docs = read('docs/LOCAL_LAPTOP_RUNTIME.md');
const serviceNames = ['postgres', 'backend', 'admin', 'proxy'];

// These are source contracts, not a YAML/nginx parser or runtime isolation test.
function service(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|^networks:|^volumes:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing service ${name}`);
  return match[1];
}

function containment(source) {
  assert.match(source, /^name: vhhealth-laptop$/m);
  assert.match(source, /^  restart: "no"$/m);
  assert.match(source, /^  pull_policy: never$/m);
  assert.match(source, /^  dns: \[127\.0\.0\.1\]$/m);
  assert.match(source, /^  dns_search: \["\."\]$/m);
  assert.match(source, /^  networks: \[laptop\]$/m);
  const networks = source.match(/^networks:\n([\s\S]*?)\nvolumes:/m);
  assert.ok(networks);
  assert.equal(networks[1], `  laptop:
    name: vhhealth-laptop-internal
    driver: bridge
    internal: true
    enable_ipv6: false
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated
    ipam:
      config:
        - subnet: 10.231.254.32/28
  edge:
    name: vhhealth-laptop-edge
    driver: bridge
    internal: false
    enable_ipv6: false
    ipam:
      config:
        - subnet: 10.231.254.48/28
`);
  assert.doesNotMatch(source, /^\s*(?:network_mode|privileged|build|extra_hosts):/m);
  assert.doesNotMatch(source, /docker\.sock|host\.docker\.internal|host-gateway/);
  assert.deepEqual([...source.matchAll(/^  ([a-z_]+):\n    <<: \*contained$/gm)].map((m) => m[1]), serviceNames);
  assert.deepEqual([...source.matchAll(/^      - "([^"\n]+:[0-9]+:[0-9]+)"$/gm)].map((m) => m[1]), [
    '127.0.0.1:8444:8444', '127.0.0.1:8445:8445',
  ]);
  assert.equal([...source.matchAll(/^    ports:$/gm)].length, 1);
  for (const name of serviceNames) {
    const text = service(source, name);
    assert.match(text, name === 'postgres' ? /^    profiles: \[database, runtime\]$/m : /^    profiles: \[runtime\]$/m);
    assert.match(text, /^    mem_limit: (?:1g|1536m|128m)$/m);
    assert.match(text, /^    pids_limit: (?:128|64)$/m);
    if (name === 'proxy') {
      assert.match(text, /^    networks: \[laptop, edge\]$/m);
      assert.doesNotMatch(text, /^    (?:env_file|environment):/m);
      assert.deepEqual([...text.matchAll(/^        target: (.+)$/gm)].map((m) => m[1]), ['/etc/nginx/nginx.conf', '/etc/nginx/tls']);
    } else {
      assert.doesNotMatch(text, /^    (?:networks|ports):/m);
    }
  }
}

function proxyContract(source) {
  assert.doesNotMatch(source, /proxy_hide_header|proxy_pass_header|proxy_add_x_forwarded_for|proxy_set_header\s+(?:Authorization|Cookie|X-API-Key|X-CSRF-Token)\b/i);
  assert.doesNotMatch(source, /^\s*(?:resolver|stream|forward_proxy)\b/m);
  assert.deepEqual([...source.matchAll(/proxy_pass ([^;]+);/g)].map((m) => m[1]), ['http://backend:5000', 'http://admin:3001']);
  for (const directive of [
    'X-Forwarded-Proto https', 'X-Forwarded-For 127.0.0.1', 'Forwarded ""',
    'X-Real-IP ""', 'X-Client-IP ""', 'X-Original-Forwarded-For ""',
    'True-Client-IP ""', 'CF-Connecting-IP ""',
  ]) assert.equal(source.split(`proxy_set_header ${directive};`).length - 1, 2, directive);
  const policies = [...source.matchAll(/add_header Content-Security-Policy "([^"]+)" always;/g)];
  assert.equal(policies.length, 1);
  const policy = policies[0][1];
  assert.doesNotMatch(policy, /(?:^|;\s*)(?:default-src|script-src)\b|unsafe-inline|unsafe-eval|\*/);
  assert.match(policy, /^connect-src https:\/\/localhost:8444 https:\/\/localhost:8445 wss:\/\/localhost:8444 wss:\/\/localhost:8445;/);
  for (const name of ['img-src', 'font-src', 'media-src', 'frame-src', 'form-action']) assert.ok(policy.includes(`${name} 'self'`));
  assert.doesNotMatch(policy, /(?:https?|wss?):\/\/(?!localhost:844[45](?:[ ;]|$))/);
}

test('static controls run on the pinned Node runtime', () => assert.equal(process.version, 'v26.5.0'));
test('services retain explicit profiles, resource bounds and the two-network boundary', () => containment(compose));
test('an external application bridge cannot pass the contract', () => assert.throws(() => containment(compose.replace('internal: true', 'internal: false'))));
test('removing isolated gateway mode cannot pass the contract', () => assert.throws(() => containment(compose.replace('gateway_mode_ipv4: isolated', 'gateway_mode_ipv4: nat'))));
test('an application edge attachment cannot pass the contract', () => assert.throws(() => containment(compose.replace('  backend:\n    <<: *contained\n', '  backend:\n    <<: *contained\n    networks: [laptop, edge]\n'))));
test('proxy application credentials cannot pass the contract', () => assert.throws(() => containment(compose.replace('    networks: [laptop, edge]\n', '    networks: [laptop, edge]\n    env_file: [private.env]\n'))));
test('public port publication cannot pass the contract', () => assert.throws(() => containment(compose.replace('127.0.0.1:8444', '0.0.0.0:8444'))));
test('host resolver substitution cannot pass the contract', () => assert.throws(() => containment(compose.replace('dns: [127.0.0.1]', 'dns: [8.8.8.8]'))));
test('automatic restart cannot pass the contract', () => assert.throws(() => containment(compose.replace('restart: "no"', 'restart: always'))));
test('default-profile application startup cannot pass the contract', () => assert.throws(() => containment(compose.replace('    profiles: [runtime]\n', ''))));

test('preloaded infrastructure images use exact reviewed digests', () => {
  assert.match(service(compose, 'postgres'), /image: pgvector\/pgvector@sha256:494dff7e67e7bc2c826b94c331364978d145ebb86fd338154138b084223b7f67\n/);
  assert.match(service(compose, 'backend'), /image: ghcr\.io\/bahuleyandr\/vh-health-platform-backend@sha256:94739041b7d96e30517085a8950544953fd062dbeb34c478d57140e03d46d883\n/);
  assert.match(service(compose, 'proxy'), /image: nginxinc\/nginx-unprivileged@sha256:f35982400455b4f359083ba9d1ef573fbbe4221a6a8a194dc7a14beb4e2cd3dc\n/);
});

test('Admin image binding has no mutable or implicit default', () => {
  assert.match(service(compose, 'admin'), /image: \$\{LAPTOP_ADMIN_IMAGE_ID:\?[^}]+\}/);
  const acceptedId = /^sha256:[0-9a-f]{64}$/;
  assert.ok(acceptedId.test(`sha256:${'a'.repeat(64)}`));
  for (const value of ['', 'admin:latest', 'admin:local', 'sha256:1234', `sha256:${'A'.repeat(64)}`]) assert.ok(!acceptedId.test(value));
  assert.match(docs, /matches the reviewed build receipt/);
});

test('database is external and cannot be implicitly initialized', () => {
  assert.match(compose, /restored_postgres:\n    external: true\n    name: \$\{LAPTOP_POSTGRES_VOLUME:\?/);
  const pg = service(compose, 'postgres');
  assert.match(pg, /PGDATA: \/var\/lib\/postgresql\/data\/pgdata/);
  assert.match(pg, /test -s "\$\$PGDATA\/PG_VERSION"/);
  assert.match(pg, /test "\$\$\(cat "\$\$PGDATA\/PG_VERSION"\)" = 17/);
  assert.match(pg, /test -s "\$\$PGDATA\/global\/pg_control"/);
  assert.ok(pg.indexOf('PG_VERSION') < pg.indexOf('exec /usr/local/bin/docker-entrypoint.sh'));
  assert.match(pg, /nocopy: true/);
  assert.doesNotMatch(pg, /POSTGRES_PASSWORD|POSTGRES_HOST_AUTH_METHOD|docker-entrypoint-initdb|\n    ports:/);
});

test('backend has one direct process and retains production safety guards', () => {
  const backend = service(compose, 'backend');
  for (const text of ['entrypoint: [node]', 'command: [src/bin/www.js]', 'NODE_ENV: production', 'NODE_OPTIONS: --max-old-space-size=768', 'RUN_MIGRATIONS: "false"', 'AUTH_ENFORCE_TENANT_RLS: "true"', 'AUTH_TENANT_RLS_RUNTIME_ROLE: vhhealth_app', 'AUTH_TENANT_RLS_FAIL_OPEN: "false"', 'ALLOW_DEV_OTP: "false"']) assert.ok(backend.includes(text), text);
  assert.doesNotMatch(backend, /cluster\.js|RUNTIME_QUALIFICATION_MODE|RUN_STARTUP_TASKS|ALLOW_DEFAULT_TENANT:/);
  assert.match(backend, /mem_limit: 1536m/);
});

test('existing no-Redis posture is explicit, without a new cache service', () => {
  const backend = service(compose, 'backend');
  for (const text of ['REDIS_REQUIRE_SENTINEL: "false"', 'REDIS_URL: ""', 'REDIS_SENTINEL_HOSTS: ""']) assert.ok(backend.includes(text));
  assert.doesNotMatch(compose, /^  redis:/m);
});

test('runtime URL, allowlist, telemetry and cache settings are laptop-specific', () => {
  const admin = service(compose, 'admin');
  for (const text of ['BACKEND_URL: http://backend:5000', 'NEXT_PUBLIC_API_URL: https://localhost:8444', 'NEXT_PUBLIC_ALLOWED_ORIGIN: https://localhost:8445', 'ADMIN_CANONICAL_ORIGIN: https://localhost:8445', 'ADMIN_IP_ALLOWLIST: 127.0.0.1', 'NEXT_TELEMETRY_DISABLED: "1"', 'NEXT_PUBLIC_SENTRY_DSN: ""', 'SENTRY_DSN: ""', '/app/.next/cache:rw']) assert.ok(admin.includes(text), text);
  assert.match(service(compose, 'backend'), /PUBLIC_BASE_URL: https:\/\/localhost:8444/);
});

test('env files are external, required and raw; bind paths cannot be created', () => {
  assert.equal([...compose.matchAll(/format: raw/g)].length, 2);
  assert.equal([...compose.matchAll(/required: true/g)].length, 2);
  assert.equal([...compose.matchAll(/create_host_path: false/g)].length, 3);
  assert.match(compose, /\$\{LAPTOP_BACKEND_ENV_FILE:\?/);
  assert.match(compose, /\$\{LAPTOP_ADMIN_ENV_FILE:\?/);
  assert.doesNotMatch(compose, /\n\s*(?:JWT_SECRET|API_KEY|BACKEND_API_KEY|FIELD_ENCRYPTION_KEY|TOTP_ENCRYPTION_KEY|BACKUP_ENCRYPTION_KEY):/);
});

test('template contains only empty unresolved private bindings', () => {
  const rows = example.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(rows, ['LAPTOP_POSTGRES_VOLUME=', 'LAPTOP_ADMIN_IMAGE_ID=', 'LAPTOP_BACKEND_ENV_FILE=', 'LAPTOP_ADMIN_ENV_FILE=', 'LAPTOP_BACKEND_STATE_DIR=', 'LAPTOP_TLS_DIR=']);
});

test('TLS mounts and exact localhost hosts preserve authentication boundaries', () => {
  assert.match(compose, /target: \/etc\/nginx\/tls\n        read_only: true/);
  assert.match(nginx, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  for (const port of [8444, 8445]) {
    assert.ok(nginx.includes(`if ($http_host != "localhost:${port}") { return 421; }`));
    assert.ok(nginx.includes(`proxy_set_header Host localhost:${port};`));
  }
  proxyContract(nginx);
});
test('caller-controlled forwarding cannot pass the contract', () => assert.throws(() => proxyContract(nginx.replace('X-Forwarded-For 127.0.0.1;', 'X-Forwarded-For $proxy_add_x_forwarded_for;'))));
test('a dynamic proxy resolver cannot pass the contract', () => assert.throws(() => proxyContract(`${nginx}\nresolver 8.8.8.8;`)));
test('removing upstream CSP cannot pass the contract', () => assert.throws(() => proxyContract(`${nginx}\nproxy_hide_header Content-Security-Policy;`)));
test('a second script policy cannot pass the contract', () => assert.throws(() => proxyContract(nginx.replace('connect-src https:', "script-src 'self'; connect-src https:"))));
test('external resource hosts cannot pass the contract', () => assert.throws(() => proxyContract(nginx.replace("img-src 'self'", "img-src 'self' https://example.invalid"))));

test('build provenance, single-writer cutover and mutation limits are documented', () => {
  const prose = docs.replace(/\s+/g, ' ');
  for (const text of ['a38055b8d2f3e2215ccc17338f6e199d0a063685', 'NEXT_PUBLIC_API_URL=https://localhost:8444', 'NEXT_PUBLIC_ALLOWED_ORIGIN=https://localhost:8445', 'NEXT_PUBLIC_SENTRY_DSN=', 'SENTRY_UPLOAD_SOURCE_MAPS=false', 'fenced every old', 'immutable archive', 'write delivery attempts', 'not proof', 'Static contract verification only']) assert.ok(prose.includes(text), text);
});

test('role documentation preserves the login and scoped NOLOGIN role transition', () => {
  const prose = docs.replace(/\s+/g, ' ');
  assert.ok(prose.includes('using the preserved `vhhealth` login'));
  assert.ok(prose.includes('`vhhealth_app` NOLOGIN role'));
  assert.ok(prose.includes('unscoped work retains the connection role'));
  assert.ok(prose.includes('prove the intended tenant isolation'));
  assert.doesNotMatch(docs, /authenticate as the provisioned `vhhealth_app`/);
  assert.match(example, /preserved vhhealth login/);
});

test('proxy edge access and limited network evidence are documented truthfully', () => {
  const prose = docs.replace(/\s+/g, ' ');
  for (const text of ['10.231.254.48/28', 'gateway_mode_ipv4=isolated', 'Windows-loopback publication', 'does not claim universal proxy egress denial', 'authentication material in transit']) assert.ok(prose.includes(text), text);
});
