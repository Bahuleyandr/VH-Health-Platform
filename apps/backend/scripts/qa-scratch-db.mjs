#!/usr/bin/env node
// scripts/qa-scratch-db.mjs
//
// List / prune the throwaway per-session databases that accumulate on the
// QA Postgres cluster. Sessions routinely build isolated scratch DBs with
// the documented recipe (CREATE DATABASE → ensure-pgvector → ci-setup-db)
// and historically never dropped them: on 2026-07-28 the cluster carried
// 155 databases and its post-crash "syncing data directory (fsync)" pass
// took 10-20+ minutes before accepting connections.
//
// Usage:
//   node scripts/qa-scratch-db.mjs list   [--url <admin-url>]
//   node scripts/qa-scratch-db.mjs prune  [--url <admin-url>] [--max-age-days N]
//                                         [--keep <name>]... [--include-active]
//                                         [--yes]
//
// `prune` is a DRY RUN unless --yes is passed. postgres, vhhealth_test and
// the template databases are never dropped (see PROTECTED_DATABASES in
// scripts/lib/qaScratchDbSelect.mjs; policy pinned by
// src/tests/unit/qaScratchDbPrune.test.js). Age comes from the mtime of the
// database's directory (pg_stat_file), i.e. roughly "last write", so a
// scratch DB a colleague is still using today is not eligible even if it
// was created weeks ago. Drops use WITH (FORCE) only when --include-active
// is set; otherwise databases with live connections are skipped.
//
// Default admin URL targets the QA cluster; override with --url or
// QA_ADMIN_DATABASE_URL for a non-default port (e.g. when WinNAT has eaten
// 55432 and the cluster runs on a low port).

import process from 'node:process';

import pg from 'pg';

import { selectPruneTargets, PROTECTED_DATABASES } from './lib/qaScratchDbSelect.mjs';

const DEFAULT_ADMIN_URL =
  process.env.QA_ADMIN_DATABASE_URL || 'postgresql://postgres@127.0.0.1:55432/postgres';

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  const options = {
    url: DEFAULT_ADMIN_URL,
    maxAgeDays: 3,
    keep: [],
    includeActive: false,
    yes: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--url') options.url = rest[++i];
    else if (arg === '--max-age-days') options.maxAgeDays = Number(rest[++i]);
    else if (arg === '--keep') options.keep.push(rest[++i]);
    else if (arg === '--include-active') options.includeActive = true;
    else if (arg === '--yes') options.yes = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      return { command: null, options };
    }
  }
  if (!Number.isFinite(options.maxAgeDays) || options.maxAgeDays < 0) {
    console.error('--max-age-days must be a non-negative number');
    return { command: null, options };
  }
  return { command, options };
}

async function fetchDatabases(client) {
  // pg_stat_file needs superuser (or pg_read_server_files); the QA cluster's
  // postgres role over trust auth qualifies. missing_ok=true keeps a race
  // with a concurrent DROP from failing the whole listing.
  const { rows } = await client.query(`
    SELECT d.datname,
           d.datistemplate                            AS is_template,
           COALESCE(s.numbackends, 0)                 AS numbackends,
           EXTRACT(EPOCH FROM (
             NOW() - (pg_stat_file('base/' || d.oid::text, true)).modification
           )) / 86400.0                               AS age_days
      FROM pg_database d
      LEFT JOIN pg_stat_database s ON s.datname = d.datname
     ORDER BY d.datname
  `);
  return rows.map((row) => ({
    datname: row.datname,
    isTemplate: row.is_template,
    numbackends: Number(row.numbackends),
    ageDays: row.age_days == null ? null : Number(row.age_days),
  }));
}

function formatAge(ageDays) {
  if (ageDays == null) return 'age unknown';
  if (ageDays < 1) return `${(ageDays * 24).toFixed(1)}h old`;
  return `${ageDays.toFixed(1)}d old`;
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  if (command !== 'list' && command !== 'prune') {
    console.error('Usage: qa-scratch-db.mjs <list|prune> [--url U] [--max-age-days N] [--keep NAME]... [--include-active] [--yes]');
    process.exitCode = 2;
    return;
  }

  const client = new pg.Client({ connectionString: options.url });
  await client.connect();
  try {
    const databases = await fetchDatabases(client);

    if (command === 'list') {
      for (const row of databases) {
        const marks = [];
        if (row.isTemplate || PROTECTED_DATABASES.includes(row.datname)) marks.push('protected');
        if (row.numbackends > 0) marks.push(`${row.numbackends} conn`);
        console.log(
          `${row.datname.padEnd(56)} ${formatAge(row.ageDays).padStart(12)}${marks.length ? '  [' + marks.join(', ') + ']' : ''}`,
        );
      }
      console.log(`\n${databases.length} database(s).`);
      return;
    }

    const { targets, skipped } = selectPruneTargets(databases, options);

    for (const skip of skipped) {
      if (skip.reason === 'too-recent' || skip.reason === 'active' || skip.reason === 'kept') {
        console.log(`keep  ${skip.datname} (${skip.reason})`);
      }
    }
    if (targets.length === 0) {
      console.log('Nothing to prune.');
      return;
    }

    if (!options.yes) {
      for (const name of targets) console.log(`would drop  ${name}`);
      console.log(`\nDry run: ${targets.length} database(s) would be dropped. Re-run with --yes to execute.`);
      return;
    }

    let dropped = 0;
    for (const name of targets) {
      const force = options.includeActive ? ' WITH (FORCE)' : '';
      try {
        await client.query(`DROP DATABASE ${client.escapeIdentifier(name)}${force}`);
        console.log(`dropped  ${name}`);
        dropped += 1;
      } catch (err) {
        console.error(`FAILED   ${name} — ${err.message}`);
        process.exitCode = 1;
      }
    }
    console.log(`\nDropped ${dropped}/${targets.length} database(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
