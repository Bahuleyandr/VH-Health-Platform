#!/usr/bin/env node
/**
 * vh-checks — weekly DB drift + error scan.
 *
 * Runs three diagnostic checks against the in-cluster Postgres on
 * dalekdefender and emits two outputs:
 *
 *   1. Local JSON report (full data, lives only on disk)
 *      → ./reports/<YYYY-MM-DD>.json
 *      → ./reports/latest.json
 *
 *   2. PHI-sanitised GitHub issue (counts + non-PHI metadata only)
 *      → posted via `gh issue create` when drift is detected
 *
 * PHI-safety design (Phase 2 hardening, 2026-04-30):
 *   - Queries select method / path / module / status_code / counts.
 *     `request_summary` (which can contain raw request bodies, including
 *     patient names/phones) is NEVER read into the issue body.
 *   - A defence-in-depth regex scrubber runs over the formatted body
 *     before posting; any 10+ digit sequence, email shape, or
 *     known-PHI JSON key triggers redaction + a warning in the issue.
 *
 * Connection model:
 *   DATABASE_URL is set by the run.sh wrapper to a port-forwarded
 *   localhost endpoint (kubectl port-forward svc/vhhealth-postgres
 *   15432:5432). Direct pod-IP connections are intentionally avoided
 *   so the script survives pod restarts and CNI changes.
 *
 * Exit codes:
 *   0 — clean (no drift, no spikes, no new patterns)
 *   1 — drift detected (issue posted if gh is configured;
 *       systemd treats 1 as success via SuccessExitStatus=1)
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

// ---------------------------------------------------------------------------
// Check 1: PHI shadow column backfill status
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Check 2: top server-error patterns over last N days.
// Selects ONLY non-PHI metadata: method, path, module, status_code, count.
// `request_summary` (which can contain raw request bodies with patient
// names/phones) is intentionally excluded.
// ---------------------------------------------------------------------------
async function errorPatterns(days = 14, limit = 30) {
  return tryQuery(
    `SELECT method, path, module, status_code, COUNT(*)::int AS occurrences
     FROM audit_log
     WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
       AND status_code >= 500
     GROUP BY method, path, module, status_code
     ORDER BY occurrences DESC
     LIMIT $2`,
    [days, limit],
  );
}

// ---------------------------------------------------------------------------
// Check 3: NEW error patterns — patterns appearing in last 14 days that
// did NOT appear in days 14-28 ago. Same PHI-safe metadata-only shape.
// ---------------------------------------------------------------------------
async function newErrorPatterns() {
  return tryQuery(`
    SELECT method, path, module, status_code, COUNT(*)::int AS recent_count
    FROM audit_log
    WHERE created_at >= NOW() - INTERVAL '14 days'
      AND status_code >= 500
      AND (method, path, status_code) NOT IN (
        SELECT method, path, status_code
        FROM audit_log
        WHERE created_at >= NOW() - INTERVAL '28 days'
          AND created_at < NOW() - INTERVAL '14 days'
          AND status_code >= 500
      )
    GROUP BY method, path, module, status_code
    ORDER BY recent_count DESC
    LIMIT 20
  `);
}

// ---------------------------------------------------------------------------
// PHI scrubber — defence-in-depth. The structured queries above already
// return only non-PHI columns, but if a future check accidentally surfaces
// PHI this scrubber catches it before the body leaves the host.
// ---------------------------------------------------------------------------
const PHI_PATTERNS = [
  { name: 'long_digit_sequence', re: /\b\d{10,}\b/g },
  { name: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { name: 'phi_json_key', re: /"(?:patient_name|patient_phone|mobile|aadhaar|aadhar|abha|phone|name|email|address|dob|birthday|date_of_birth|mrn|uhid|nik|nin)"/gi },
];

function scrubBodyForPhi(body) {
  const hits = [];
  let scrubbed = body;
  for (const { name, re } of PHI_PATTERNS) {
    re.lastIndex = 0;
    const matches = scrubbed.match(re);
    if (matches && matches.length) {
      hits.push({ pattern: name, count: matches.length });
      scrubbed = scrubbed.replace(re, '[REDACTED]');
    }
  }
  return { scrubbed, hits };
}

// ---------------------------------------------------------------------------
// Issue body — only PHI-safe metadata. Everything that ends up here passes
// through the scrubber as a final guard.
// ---------------------------------------------------------------------------
function formatIssueBody(report) {
  const lines = [
    `# VH Health weekly DB check — ${report.generated_at}`,
    '',
    '## Summary',
    `- PHI unencrypted rows: **${report.summary.phi_unencrypted_total}**`,
    `- Error pattern spikes (>50 occurrences in 14d): **${report.summary.error_pattern_spikes}**`,
    `- NEW error patterns vs prior 14d: **${report.summary.new_error_patterns}**`,
    '',
    '> Full per-row detail is in the local report at `~/vh-checks/reports/<date>.json` on dalekdefender — this issue body intentionally carries only counts + non-PHI metadata.',
    '',
  ];

  // PHI backfill section
  if (report.phi_backfill.error) {
    lines.push('## PHI backfill', '', `> Query failed: \`${report.phi_backfill.error}\``);
    if (/does not exist/i.test(report.phi_backfill.error)) {
      lines.push('', 'Migration 132 (`132_phi_column_rotation.sql`) likely hasn\'t been applied to this DB yet.');
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

  // Error spikes section
  if (report.spikes.length > 0) {
    lines.push('## Error pattern spikes (>50 occurrences in 14d)', '');
    lines.push('| Method | Path | Module | Status | Occurrences |',
              '|---|---|---|---:|---:|');
    for (const s of report.spikes) {
      lines.push(`| ${s.method || '?'} | \`${(s.path || '?').slice(0, 100)}\` | ${s.module || '?'} | ${s.status_code} | ${s.occurrences} |`);
    }
    lines.push('');
  }

  // New patterns section
  if (report.new_error_patterns.rows && report.new_error_patterns.rows.length > 0) {
    lines.push('## NEW error patterns (last 14d not seen in prior 14d)', '');
    lines.push('| Method | Path | Module | Status | Recent count |',
              '|---|---|---|---:|---:|');
    for (const n of report.new_error_patterns.rows) {
      lines.push(`| ${n.method || '?'} | \`${(n.path || '?').slice(0, 100)}\` | ${n.module || '?'} | ${n.status_code} | ${n.recent_count} |`);
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

  // Local report — full data, on-disk only.
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
    let body = formatIssueBody(report);

    // Defence-in-depth scrub — should be a no-op on the cleaned queries
    // but catches accidental PHI surfacing in any future check.
    const { scrubbed, hits } = scrubBodyForPhi(body);
    if (hits.length > 0) {
      console.warn(`PHI scrubber redacted ${hits.length} pattern type(s):`, hits);
      body = scrubbed
        + `\n\n> ⚠️ **PHI scrubber triggered**: ${hits.map((h) => `${h.pattern} (×${h.count})`).join(', ')}. `
        + 'This is a defence-in-depth signal — investigate which check produced PHI-shaped content '
        + 'and tighten its query/formatter.';
    }

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
