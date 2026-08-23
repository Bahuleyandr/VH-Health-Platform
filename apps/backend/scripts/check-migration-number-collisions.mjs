// scripts/check-migration-number-collisions.mjs
// Fails when two migration files share a numeric prefix (once-over 2026-08-23:
// five collisions had already accumulated from concurrent PR trains). Ordering
// between same-number files is filename-alphabetical, which is fine only while
// the pair is independent — a colliding pair with a real dependency would be a
// subtle production-ordering hazard, and the HL7-outbound work already tripped
// over filename-compare collisions once.
//
// The five historical pairs are grandfathered BY EXACT FILENAME so the
// backlog does not force a rename of already-applied migrations (renames would
// desync the _migrations tracker on every existing database).

import { readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/migrations');

const GRANDFATHERED = new Set([
  '203', '211', '217', '233', '574',
]);

const byNumber = new Map();
for (const file of readdirSync(migrationsDir)) {
  const m = /^(\d+)_.+\.sql$/.exec(file);
  if (!m) continue;
  const num = m[1];
  if (!byNumber.has(num)) byNumber.set(num, []);
  byNumber.get(num).push(file);
}

const offenders = [...byNumber.entries()]
  .filter(([num, files]) => files.length > 1 && !GRANDFATHERED.has(num));

if (offenders.length > 0) {
  console.error('Duplicate migration numbers detected (pick the next free number):');
  for (const [num, files] of offenders) {
    console.error(`  ${num}: ${files.join(', ')}`);
  }
  process.exit(1);
}

// Grandfathered numbers must not grow a THIRD file either.
const grownGrandfathers = [...byNumber.entries()]
  .filter(([num, files]) => GRANDFATHERED.has(num) && files.length > (num === '217' ? 3 : 2));
if (grownGrandfathers.length > 0) {
  console.error('A grandfathered migration number gained another file:');
  for (const [num, files] of grownGrandfathers) {
    console.error(`  ${num}: ${files.join(', ')}`);
  }
  process.exit(1);
}

console.log(`Migration numbering clean: ${byNumber.size} distinct numbers, ${GRANDFATHERED.size} grandfathered collisions.`);
