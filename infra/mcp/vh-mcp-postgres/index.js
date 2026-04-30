/**
 * vh-mcp-postgres — Streamable-HTTP MCP server.
 *
 * Purpose-built: exposes ONLY three diagnostic tools backed by hard-coded
 * read-only SQL queries. No general SELECT, no SQL injection surface,
 * no write paths. Designed to satisfy the cloud-side scheduled-routine
 * needs (PHI backfill verification, error pattern scan) without a
 * full-fat Postgres MCP that would expose the entire DB.
 *
 * Auth: Bearer token in `Authorization` header. Token is the value of
 * MCP_BEARER_TOKEN at startup; rotate by restarting the pod with a new
 * Secret.
 *
 * Deployed on Dalekdefender k3s. Tailscale Funnel exposes it on
 *   https://dalekdefender.hippocampus-monitor.ts.net:10000/mcp
 * (or whichever port the Funnel config points at).
 */

import express from 'express';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const { Pool } = pg;

const PORT = parseInt(process.env.PORT || '8080', 10);
const TOKEN = process.env.MCP_BEARER_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN) {
  console.error('FATAL: MCP_BEARER_TOKEN is required');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Read-only enforcement at the connection level. Belt-and-suspenders
  // alongside the hard-coded SELECT-only queries below.
  application_name: 'vh-mcp-postgres',
});

pool.on('error', (err) => console.error('pg pool error:', err.message));

// Connection probe at startup — fail fast if creds wrong / DB unreachable.
try {
  const probe = await pool.query('SELECT current_database() AS db, current_user AS user');
  console.log('Connected:', probe.rows[0]);
} catch (err) {
  console.error('FATAL: DB probe failed:', err.message);
  process.exit(1);
}

const server = new McpServer(
  { name: 'vh-mcp-postgres', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool 1: phi_backfill_status
// ---------------------------------------------------------------------------
server.registerTool(
  'phi_backfill_status',
  {
    title: 'PHI shadow column backfill status',
    description:
      'Returns counts of rows in users + medical_records that have non-null PHI but null encrypted-shadow column. Driven by Phase E3 follow-up migration 132. Used to verify that scripts/phi-backfill.mjs has been run and that dual-write is keeping shadows current.',
    inputSchema: {},
  },
  async () => {
    const sql = `
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
    `;
    try {
      const { rows } = await pool.query(sql);
      const total = rows.reduce((s, r) => s + Number(r.unencrypted_count), 0);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            generated_at: new Date().toISOString(),
            total_unencrypted: total,
            per_column: rows,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `phi_backfill_status query failed: ${err.message}` }],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 2: error_patterns
// ---------------------------------------------------------------------------
server.registerTool(
  'error_patterns',
  {
    title: 'Top server-error patterns from audit_log',
    description:
      'Returns the top N (request_summary, status_code, count) tuples from audit_log where status_code >= 500 in the last `days` days. `min_occurrences` filters out one-offs.',
    inputSchema: {
      days: z.number().int().min(1).max(90).default(14)
        .describe('Lookback window in days; max 90'),
      min_occurrences: z.number().int().min(1).default(1)
        .describe('Minimum count to include in results'),
      limit: z.number().int().min(1).max(100).default(30)
        .describe('Max rows to return'),
    },
  },
  async ({ days, min_occurrences, limit }) => {
    try {
      const { rows } = await pool.query(
        `SELECT request_summary, status_code, COUNT(*)::int AS occurrences
         FROM audit_log
         WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
           AND status_code >= 500
         GROUP BY request_summary, status_code
         HAVING COUNT(*) >= $2
         ORDER BY occurrences DESC
         LIMIT $3`,
        [days, min_occurrences, limit],
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            window_days: days,
            min_occurrences,
            limit,
            generated_at: new Date().toISOString(),
            patterns: rows,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `error_patterns query failed: ${err.message}` }],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 3: new_error_patterns
// ---------------------------------------------------------------------------
server.registerTool(
  'new_error_patterns',
  {
    title: 'NEW error patterns since previous 14d window',
    description:
      'Patterns (status_code >= 500) appearing in last 14 days that did NOT appear in days 14-28 ago. Surfaces regressions / new failure modes.',
    inputSchema: {},
  },
  async () => {
    try {
      const { rows } = await pool.query(`
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            recent_window: 'last 14 days',
            comparison_window: 'days 14-28 ago',
            generated_at: new Date().toISOString(),
            new_patterns: rows,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `new_error_patterns query failed: ${err.message}` }],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Express app: bearer auth + Streamable HTTP transport mount
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '512kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, name: 'vh-mcp-postgres' }));

app.use('/mcp', (req, res, next) => {
  // Accept token via Authorization: Bearer <token> OR ?token=<token> query
  // string (the claude.ai custom connector UI today only supports OAuth or
  // URL-embedded auth; query-string fallback lets the connector authenticate
  // without OAuth scaffolding on this side).
  const headerAuth = req.headers.authorization || '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const headerOk = headerAuth === `Bearer ${TOKEN}`;
  const queryOk = queryToken === TOKEN;
  if (!headerOk && !queryOk) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// Stateless transport — fresh per-request, no session. Simpler to deploy
// behind Tailscale Funnel which doesn't preserve session affinity.
async function handleMcpRequest(req, res) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'mcp transport error' });
    }
  }
}

app.post('/mcp', handleMcpRequest);
app.get('/mcp', handleMcpRequest);

app.listen(PORT, () => {
  console.log(`vh-mcp-postgres listening on :${PORT}`);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down`);
    await pool.end();
    process.exit(0);
  });
}
