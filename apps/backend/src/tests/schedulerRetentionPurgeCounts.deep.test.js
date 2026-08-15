// Scheduler retention purges must log REAL deleted-row counts.
//
// The three purge crons (invalidated_tokens, otp_sessions,
// file_deletion_log) and the boot-time manual file_deletion_log task used
// prisma.$queryRawUnsafe for their DELETEs. A RETURNING-less DELETE through
// $queryRawUnsafe resolves to an empty array, so `Number(result) || 0`
// logged "0 rows deleted" forever regardless of what was purged. The fix is
// $executeRawUnsafe, whose resolution IS the affected-row count.
// (2026-08-14 findings, services P3 #7)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scheduler = fs.readFileSync(
  path.resolve(__dirname, '../utils/scheduler.js'),
  'utf8',
);

describe('scheduler retention purge counts', () => {
  it('runs every retention DELETE through $executeRawUnsafe, never $queryRawUnsafe', () => {
    const deleteSites = [...scheduler.matchAll(
      /prisma\.\$(queryRawUnsafe|executeRawUnsafe)\(\s*`DELETE FROM (invalidated_tokens|otp_sessions|file_deletion_log)/g,
    )];
    // Three crons + one manual task; file_deletion_log appears twice.
    expect(deleteSites).toHaveLength(4);
    for (const site of deleteSites) {
      expect(site[1]).toBe('executeRawUnsafe');
    }
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('purge mechanism yields real counts (live DB)', () => {
  let prisma;

  beforeAll(async () => {
    ({ default: prisma } = await import('../lib/prisma.js'));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('$executeRawUnsafe DELETE on invalidated_tokens reports the purged row count', async () => {
    const jti = `purge-count-proof-${Date.now()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO invalidated_tokens (jti, expires_at)
       VALUES ($1, NOW() - INTERVAL '2 days')`,
      jti,
    );

    // The exact statement shape the cron runs, narrowed to our fixture row so
    // the assertion is deterministic against concurrent suites.
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM invalidated_tokens WHERE expires_at < NOW() AND jti = $1`,
      jti,
    );
    expect(deleted).toBe(1);

    // And the buggy form really did lie: $queryRawUnsafe on a RETURNING-less
    // DELETE gives an empty array, which numbers to 0.
    const buggy = await prisma.$queryRawUnsafe(
      `DELETE FROM invalidated_tokens WHERE expires_at < NOW() AND jti = $1`,
      jti,
    );
    expect(Number(buggy) || 0).toBe(0);
  });
});
