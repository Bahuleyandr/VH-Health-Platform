import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const allowedTeams = new Set([
  'backend',
  'backup',
  'continuity',
  'database',
  'device',
  'platform',
]);
const lockEntries = new Map(
  readFileSync(join(here, 'rule-semantics.sha256'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/, 2)),
);

let alertCount = 0;
let failed = false;

for (const [file, expectedHash] of lockEntries) {
  const raw = readFileSync(join(here, file), 'utf8').replace(/\r\n/g, '\n');
  const semanticSource = raw
    .split('\n')
    .filter((line) => !/^\s+team:\s/.test(line))
    .join('\n');
  const actualHash = createHash('sha256').update(semanticSource).digest('hex');

  if (actualHash !== expectedHash) {
    failed = true;
    console.error(
      `✗ ${file}: non-team content changed (${actualHash}, expected ${expectedHash})`,
    );
  } else {
    console.log(`✓ ${file}: expressions, for, severity, and thresholds unchanged`);
  }

  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const alertMatch = lines[index].match(/^\s+- alert:\s+(\S+)\s*$/);
    if (!alertMatch) continue;

    alertCount += 1;
    let team;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s+- (?:alert|record):\s+/.test(lines[cursor])) break;
      const teamMatch = lines[cursor].match(/^\s+team:\s+(\S+)\s*$/);
      if (teamMatch) {
        if (team) {
          failed = true;
          console.error(`✗ ${file}: ${alertMatch[1]} has more than one team label`);
        }
        team = teamMatch[1];
      }
    }

    if (!team || !allowedTeams.has(team)) {
      failed = true;
      console.error(
        `✗ ${file}: ${alertMatch[1]} has invalid or missing team label (${team || 'missing'})`,
      );
    }
  }
}

if (alertCount === 0) {
  failed = true;
  console.error('✗ no alerting rules were inspected');
} else if (!failed) {
  console.log(`✓ ${alertCount} alerting rules have one approved team label`);
}

process.exit(failed ? 1 : 0);
