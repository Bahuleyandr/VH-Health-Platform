#!/usr/bin/env node
// scripts/warehouse-verify.mjs — analytics warehouse health check (roadmap F1).
//
// Owner-side ops tool: run it whenever you want proof the pipeline is whole
// (after bring-up, after a release's warehouse-migrate, in a cron with
// alerting — exit code is the contract).
//
//   DATABASE_URL  = OLTP (publisher)   [required]
//   WAREHOUSE_URL = warehouse          [optional — publisher-only checks if absent]
//
// Checks:
//   1. publisher: publication exists + member count; replication slot state
//      + retained WAL (warns >1GB, fails >8GB);
//   2. warehouse: subscription enabled + workers alive (pg_stat_subscription);
//   3. warehouse: row-count spot-compare vs publisher on 3 high-churn tables
//      (tolerance — replication is async);
//   4. warehouse: marts exist + dim_date is fresh (dbt ran recently).
//
// Exit codes: 0 healthy, 1 broken, 2 misconfigured.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromBackend = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
);
const pg = requireFromBackend('pg');

const SPOT_TABLES = ['admissions', 'billing_invoices', 'clinical_orders'];
const SLOT = 'vh_analytics_slot';
let failures = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures += 1; };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.warn(`  ! ${msg}`);

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function main() {
  const oltpUrl = process.env.DATABASE_URL;
  const whUrl = process.env.WAREHOUSE_URL;
  if (!oltpUrl) { console.error('DATABASE_URL required'); process.exit(2); }

  console.log('— publisher —');
  const pubTables = await withClient(oltpUrl, async (c) => {
    const pub = await c.query(
      `SELECT count(*)::int AS n FROM pg_publication_tables WHERE pubname = 'vh_analytics_pub'`,
    );
    if (!pub.rows[0].n) fail('publication vh_analytics_pub missing/empty (migration 295 deployed?)');
    else ok(`publication present (${pub.rows[0].n} tables)`);

    const slot = await c.query(
      `SELECT active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint AS retained
         FROM pg_replication_slots WHERE slot_name = $1`, [SLOT],
    );
    if (!slot.rows.length) {
      warn(`slot ${SLOT} absent — subscription not created yet (fine pre-bring-up)`);
    } else {
      const { active, retained } = slot.rows[0];
      const gb = Number(retained) / 1024 ** 3;
      if (!active) fail(`slot ${SLOT} INACTIVE — subscription down; WAL retained: ${gb.toFixed(2)} GB`);
      else if (gb > 8) fail(`slot retaining ${gb.toFixed(1)} GB WAL (>8GB) — apply wedged?`);
      else if (gb > 1) warn(`slot retaining ${gb.toFixed(2)} GB WAL — watch it`);
      else ok(`slot active, retained WAL ${(gb * 1024).toFixed(0)} MB`);
    }

    const counts = {};
    for (const t of SPOT_TABLES) {
      counts[t] = Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    }
    return counts;
  });

  if (!whUrl) {
    console.log('(WAREHOUSE_URL not set — publisher-only run)');
    process.exit(failures ? 1 : 0);
  }

  console.log('— warehouse —');
  await withClient(whUrl, async (c) => {
    const sub = await c.query(
      `SELECT s.subenabled, count(st.pid)::int AS workers
         FROM pg_subscription s
         LEFT JOIN pg_stat_subscription st ON st.subid = s.oid AND st.pid IS NOT NULL
        WHERE s.subname = 'vh_analytics_sub'
        GROUP BY s.subenabled`,
    );
    if (!sub.rows.length) fail('subscription vh_analytics_sub missing');
    else if (!sub.rows[0].subenabled) fail('subscription DISABLED');
    else if (!sub.rows[0].workers) fail('subscription enabled but no live worker (check warehouse logs)');
    else ok(`subscription enabled, ${sub.rows[0].workers} worker(s)`);

    for (const t of SPOT_TABLES) {
      const n = Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
      const src = pubTables[t];
      const drift = src ? Math.abs(src - n) / Math.max(src, 1) : 0;
      if (src && drift > 0.05 && Math.abs(src - n) > 50) {
        fail(`${t}: warehouse ${n} vs publisher ${src} (>5% behind — copy incomplete or apply stalled)`);
      } else {
        ok(`${t}: ${n} rows (publisher ${src})`);
      }
    }

    const marts = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema LIKE '%marts' AND table_name IN
          ('mart_bed_flow_daily','mart_ot_utilization_daily',
           'mart_department_revenue_monthly','mart_payer_mix_monthly')`,
    );
    if (marts.rows[0].n < 4) fail(`marts present: ${marts.rows[0].n}/4 — dbt build run yet?`);
    else ok('all 4 operational marts present');

    // dim_date extends a year past the LAST dbt run — cheap freshness probe.
    const dimDateLoc = await c.query(
      `SELECT table_schema FROM information_schema.tables
        WHERE table_name = 'dim_date' AND table_schema LIKE '%marts' LIMIT 1`,
    );
    if (dimDateLoc.rows.length) {
      const schema = dimDateLoc.rows[0].table_schema;
      const fresh = await c.query(
        `SELECT max(date_day) >= current_date AS fresh FROM "${schema}".dim_date`,
      );
      if (fresh.rows[0].fresh === false) {
        warn('dim_date max(date_day) < today — dbt has not rebuilt in a long time');
      } else {
        ok('dim_date fresh (dbt has run recently)');
      }
    }
  });

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nwarehouse pipeline healthy');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('verify crashed:', err.message); process.exit(2); });
