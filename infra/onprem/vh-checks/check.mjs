#!/usr/bin/env node
/**
 * vh-checks — weekly DB drift + error scan.
 *
 * Runs three diagnostic queries against the in-cluster Postgres on
 * dalekdefender, writes a JSON report to ./reports/<date>.json (and
 * ./reports/latest.json), and posts a GitHub issue via `gh` when drift
 * or new-error patterns show up.
 *
 * Replaces the cloud-side MCP path that couldn't pass claude.ai's
 * connector validator (likely policy block on `*.ts.net` / non-443
 * ports). Runs locally on dalekdefender via systemd timer; DB access
 * is in-cluster (no public exposure).
 *
 * Required env:
 *   DATABASE_URL    — postgresql://vhhealth:...@<pod-ip>:5432/vhhealth
 *   GITHUB_REPO     — owner/repo for issue posting (e.g. Bahuleyandr/VH-Health-Platform)
 *   REPORTS_DIR     — output directory (default ./reports)
 *
 * Exit codes:
 *   0 — clean (no drift, no spikes, no new patterns)
 *   1 — drift detected (issue posted if gh is configured)
 *   2 — infrastructure failure (DB unreachable, missing env, etc.)
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL required');
  process.exit(2);
}
const GITHUB_REPO = process.env.GITHUB_REPO || 'Bahuleyandr/VH-Health-Platform';
const REPORTS_DIR = process.env.REPORTS_DIR || './reports';

const pool = new Pool({ connectionString: DATABASE_URL, application_name: 'vh-checks' });
pool.on('error', (err) => console.error('pg pool error:', err.message));

async function tryQuery(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return { rows };
  } catch (err) {
    return { error: err.message };
  }
}

async function phiBackfillStatus() {
  return tryQuery(`
    SELECT 'users.name' AS col, COUNT(*)::int AS unencrypted_count
    FROM users WHERE name IS NOT NULL AND name_encrypted IS NULL
    UNION ALL SELECT 'users.phone', COUNT(*)::int
    FROM users WHERE phone IS NOT NULL AND phone_encrypted IS NULL
    UNION ALL SELECT 'users.phone_search_hash', COUNT(*)::int
    FROM users WHERE phone IS NOT NULL AND phone_search_hash IS NULL
    UNION ALL SELECT 'users.address', COUNT(*)::int
    FROM users WHERE address IS NOT NULL AND address_encrypted IS NULL
    UNION ALL SELECT 'medical_records.description', COUNT(*)::int
    FROM medical_records WHERE description IS NOT NULL AND description_encrypted IS NULL
    UNION ALL SELECT 'medical_records.diagnosis', COUNT(*)::int
    FROM medical_records WHERE diagnosis IS NOT NULL AND diagnosis_encrypted IS NULL
    UNION ALL SELECT 'medical_records.treatment', COUNT(*)::int
    FROM medical_records WHERE treatment IS NOT NULL AND treatment_encrypted IS NULL
  `);
}

async function errorPatterns(days = 14, limit = 30) {
  return tryQuery(
    `SELECT request_summary, status_code, COUNT(*)::int AS occurrences
     FROM audit_log
     WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
       AND status_code >= 500
     GROUP BY request_summary, status_code
     ORDER BY occurrences DESC
     LIMIT $2`,
    [days, limit],
  );
}

async function newErrorPatterns() {
  return tryQuery(`
    SELECT request_summary, status_code, COUNT(*)::int AS recent_count
    FROM audit_log
    WHERE created_at >= NOW() - INTERVAL '14 days'
      AND status_code >= 500
      AND (request_summary, status_code) NOT IN (
        SELECT request_summary, status_code
        FROM audit_log
        WHERE created_at >= NOW() - INTERVAL '28 days'
          AND created_at < NOW() - INTERVAL '14 days'
          AND status_code >= 500
      )
    GROUP BY request_summary, status_code
    ORDER BY recent_count DESC
    LIMIT 20
  `);
}

function formatIssueBody(report) {
  const lines = [
    `# VH Health weekly DB check — ${report.generated_at}`,
    '',
    '## Summary',
    `- PHI unencrypted rows: **${report.summary.phi_unencrypted_total}**`,
    `- Error pattern spikes (>50 occurrences in 14d): **${report.summary.error_pattern_spikes}**`,
    `- NEW error patterns vs prior 14d: **${report.summary.new_error_patterns}**`,
    '',
  ];

  if (report.phi_backfill.error) {
    lines.push('## PHI backfill', '', `> Query failed: \`${report.phi_backfill.error}\``);
    if (/does not exist/i.test(report.phi_backfill.error)) {
      lines.push('', 'Migration 132 (`132_phi_column_rotation.sql`) likely hasn\'t been applied to this DB yet. Check the migrations runner output.');
    }
    lines.push('');
  } else if (report.summary.phi_unencrypted_total > 0) {
    lines.push('## PHI backfill drift', '', '| Column | Unencrypted rows |', '|---|---:|');
    for (const r of report.phi_backfill.rows) {
      if (Number(r.unencrypted_count) > 0) lines.push(`| \`${r.col}\` | ${r.unencrypted_count} |`);
    }
    lines.push('', 'Run the backfill:', '```bash', 'cd apps/backend',
      'export KMS_MASTER_KEY=<32 bytes base64>',
      'export PHI_SEARCH_HASH_KEY=<32 bytes base64>',
      'node scripts/phi-backfill.mjs --batch-size 500',
      '```', '');
  }

  if (report.spikes.length > 0) {
    lines.push('## Error pattern spikes (>50 occurrences in 14d)', '');
    lines.push('| Status | Summary | Occurrences |', '|---:|---|---:|');
    for (const s of report.spikes) {
      const summary = (s.request_summary || '(null)').slice(0, 100).replace(/[|`]/g, '_');
      lines.push(`| ${s.status_code} | \`${summary}\` | ${s.occurrences} |`);
    }
    lines.push('');
  }

  if (report.new_error_patterns.rows && report.new_error_patterns.rows.length > 0) {
    lines.push('## NEW error patterns (last 14d not seen in prior 14d)', '');
    lines.push('| Status | Summary | Recent count |', '|---:|---|---:|');
    for (const n of report.new_error_patterns.rows) {
      const summary = (n.request_summary || '(null)').slice(0, 100).replace(/[|`]/g, '_');
      lines.push(`| ${n.status_code} | \`${summary}\` | ${n.recent_count} |`);
    }
    lines.push('');
  }

  lines.push('---',
    '<sub>Auto-posted by `vh-checks.service` systemd timer on dalekdefender. ',
    `Source: [\`infra/onprem/vh-checks/\`](https://github.com/${GITHUB_REPO}/tree/main/infra/onprem/vh-checks). `,
    'Edit the schedule via `systemctl edit vh-checks.timer`.</sub>');
  return lines.join('\n');
}

async function main() {
  const [phi, errs, newErrs] = await Promise.all([
    phiBackfillStatus(),
    errorPatterns(14, 30),
    newErrorPatterns(),
  ]);

  const phiTotal = phi.rows
    ? phi.rows.reduce((s, r) => s + Number(r.unencrypted_count), 0)
    : 0;
  const spikes = errs.rows ? errs.rows.filter((r) => Number(r.occurrences) > 50) : [];
  const newCount = newErrs.rows ? newErrs.rows.length : 0;
  const hasDrift = phiTotal > 0 || spikes.length > 0 || newCount > 0;

  const report = {
    generated_at: new Date().toISOString(),
    has_drift: hasDrift,
    summary: {
      phi_unencrypted_total: phiTotal,
      error_pattern_spikes: spikes.length,
      new_error_patterns: newCount,
    },
    spikes,
    phi_backfill: phi,
    error_patterns: errs,
    new_error_patterns: newErrs,
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = join(REPORTS_DIR, `${date}.json`);
  const latestPath = join(REPORTS_DIR, 'latest.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(latestPath, JSON.stringify(report, null, 2));
  console.log(`Report written: ${reportPath}`);
  console.log(`Drift detected: ${hasDrift}`);
  console.log(`Summary: ${JSON.stringify(report.summary)}`);

  if (hasDrift) {
    const titleParts = [];
    if (phiTotal > 0) titleParts.push(`${phiTotal} unencrypted PHI rows`);
    if (spikes.length > 0) titleParts.push(`${spikes.length} error spikes`);
    if (newCount > 0) titleParts.push(`${newCount} new error patterns`);
    const title = `chore: weekly DB check ${date} — ${titleParts.join(', ')}`;
    const body = formatIssueBody(report);
    try {
      execSync(
        `gh issue create --repo ${GITHUB_REPO} --title ${JSON.stringify(title)} --body-file -`,
        { input: body, stdio: ['pipe', 'inherit', 'inherit'] },
      );
      console.log('GitHub issue posted.');
    } catch (err) {
      console.error('gh issue create failed:', err.message);
    }
  } else {
    console.log('No drift; skipping GitHub issue.');
  }

  await pool.end();
  process.exit(hasDrift ? 1 : 0);
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(2);
});
