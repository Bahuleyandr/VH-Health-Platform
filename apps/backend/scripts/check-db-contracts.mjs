#!/usr/bin/env node
import pg from 'pg';
import { runSchemaContractCheck } from '../src/db/schemaContracts.js';

const requireSeeded = process.argv.includes('--require-seeded');
const jsonOutput = process.argv.includes('--json');
const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL or TEST_DATABASE_URL is required for DB contract checks.');
  process.exit(2);
}

const client = new pg.Client({ connectionString });

try {
  await client.connect();
  const report = await runSchemaContractCheck(client, { requireSeeded });

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { totals } = report;
    console.log(
      `DB contracts: ${totals.passing}/${totals.contracts} passing, ${totals.failures} failure(s).`
    );
    if (report.seeded) {
      console.log(
        `Seed coverage: ${report.seeded.nonEmptyAppTables}/${report.seeded.totalAppTables} app tables non-empty.`
      );
      if (report.seeded.intentionallyEmptyAppTables.length > 0) {
        console.log(
          `Intentionally empty: ${report.seeded.intentionallyEmptyAppTables.join(', ')}.`
        );
      }
    }
    for (const failure of report.failures) {
      console.error(`x ${failure.contract}: ${failure.message}`);
    }
  }

  process.exit(report.ok ? 0 : 1);
} catch (err) {
  console.error(`DB contract check failed: ${err.message}`);
  process.exit(2);
} finally {
  await client.end().catch(() => {});
}
