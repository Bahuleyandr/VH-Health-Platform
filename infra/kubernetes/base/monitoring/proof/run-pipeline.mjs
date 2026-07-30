import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const composeFile = join(here, 'compose.yaml');
const project = 'vhhealth-c13-proof';
const families = [
  'platform',
  'database',
  'backup',
  'backend',
  'continuity',
  'device',
];
let failed = false;

try {
  compose(['up', '--detach', '--force-recreate', '--remove-orphans']);
  await waitForUrl('http://127.0.0.1:18080/metrics');
  await waitForUrl('http://127.0.0.1:19090/-/ready');
  await waitForUrl('http://127.0.0.1:19093/-/ready');
  await post('http://127.0.0.1:18080/reset');

  await waitForEvents('Watchdog', 'firing', ['deadman-external']);
  console.log('✓ Watchdog -> deadman-external');

  for (const family of families) {
    const alertname = `C13${capitalize(family)}Synthetic`;
    const expectedReceivers = [
      'ops-webhook',
      'critical-pagerduty',
      `team-${family}`,
    ];

    await post(`http://127.0.0.1:18080/control/${family}/1`);
    await waitForEvents(alertname, 'firing', expectedReceivers);
    console.log(`✓ ${family}: scrape -> rule -> ${expectedReceivers.join(', ')}`);

    await post(`http://127.0.0.1:18080/control/${family}/0`);
    await waitForEvents(alertname, 'resolved', expectedReceivers);
    console.log(`✓ ${family}: resolved -> ${expectedReceivers.join(', ')}`);
  }
} catch (error) {
  failed = true;
  console.error(error.stack || error.message);
  try {
    compose(['logs', '--no-color']);
  } catch {
    // The original pipeline error is authoritative.
  }
} finally {
  try {
    compose(['down', '--volumes', '--remove-orphans']);
  } catch (error) {
    failed = true;
    console.error(error.message);
  }
}

process.exit(failed ? 1 : 0);

function compose(args) {
  execFileSync(
    'docker',
    ['compose', '--file', composeFile, '--project-name', project, ...args],
    { cwd: here, stdio: 'inherit' },
  );
}

async function waitForUrl(url, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Containers are still starting.
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitForEvents(alertname, status, receivers, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch('http://127.0.0.1:18080/events');
    const events = await response.json();
    const seen = new Set(
      events
        .filter((event) => event.alertname === alertname && event.status === status)
        .map((event) => event.receiver),
    );
    if (receivers.every((receiver) => seen.has(receiver))) return;
    await delay(500);
  }
  throw new Error(
    `timed out waiting for ${alertname} ${status} at ${receivers.join(', ')}`,
  );
}

async function post(url) {
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
