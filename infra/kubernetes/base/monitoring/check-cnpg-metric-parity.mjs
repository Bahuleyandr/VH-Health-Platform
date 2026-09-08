// infra/kubernetes/base/monitoring/check-cnpg-metric-parity.mjs
//
// Ties every `cnpg_vhhealth_*` reference in the monitoring rules back to a
// user-defined query column that actually declares it in
// infra/kubernetes/base/cnpg/cluster.yaml.
//
// WHY THIS EXISTS. Two independent defects shipped inert in the postgres alert
// group because nothing connected the two halves:
//   * four rules selected `vhhealth_replication_lag_seconds` /
//     `vhhealth_connections_total`, the query-LOCAL column names, while the
//     CNPG exporter publishes `cnpg_<query>_<column>`; and
//   * the seconds column those rules thresholded on was computed from
//     `pg_last_xact_replay_timestamp()`, which cannot measure per-standby lag
//     on a primary at all.
// promtool fixtures cannot catch either one: the fixture author writes both the
// rule and the sample it is fed, so a rule and its test agree with each other
// while agreeing with nothing that any target exports. This check reads the two
// halves from two different files and refuses to let them disagree.
//
// WHAT IT PROVES
//   1. Every cnpg_vhhealth_* series named in an alert/record `expr:`, in an
//      alert annotation, or in a promtool fixture `- series:` line is derivable
//      as `cnpg_<query>_<column>` from a non-LABEL column of a query declared in
//      cluster.yaml.
//   2. Every label matcher applied to such a series is either a `usage: LABEL`
//      column of that same query or one of the target labels Prometheus itself
//      attaches (TARGET_LABELS below). This is what keeps the C6.2 DR selector
//      {application_name=~"(?i).*dr.*"} honest.
//   3. No PromQL selector or fixture sample uses the QUERY-LOCAL spelling — a
//      bare `<query>_<column>` with the `cnpg_` prefix missing. That is the
//      literal form the four original rules shipped in, so without this arm the
//      check would not have caught the defect it exists for. Prose is exempt:
//      annotations legitimately name a query, e.g. "the vhhealth_connections
//      user-defined query reads pg_stat_activity".
//   4. It never passes vacuously: zero queries parsed, zero derivable series, or
//      zero references found are each a failure.
//
// WHAT IT DOES NOT PROVE. The `cnpg_` prefix convention itself, which no file in
// this repository can confirm — there is no live CNPG scrape here (the test rig
// runs a plain postgres StatefulSet; only the hospital overlay runs CNPG). The
// absent() meta-alerts PostgresConnectionMetricsAbsent and
// PostgresReplicationMetricAbsent are the runtime arm for that residual bet.
// It also does not check units or thresholds — a column named `_seconds` that
// returns bytes would pass here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const clusterFile = join(here, '..', 'cnpg', 'cluster.yaml');

// Only the vhhealth_* custom-query namespace is in scope. `cnpg_pg_*` series
// (cnpg_pg_stat_archiver_*, cnpg_pg_replication_lag) come from CNPG's own
// built-in queries, which this repository does not define and cannot enumerate.
const SERIES_PREFIX = 'cnpg_vhhealth_';

// Labels Prometheus/the ServiceMonitor attach to a scraped sample, so they are
// legitimately present on these series without being columns of any query.
const TARGET_LABELS = new Set([
  '__name__',
  'cluster',
  'container',
  'endpoint',
  'instance',
  'job',
  'namespace',
  'node',
  'pod',
  'prometheus',
  'service',
]);

const failures = [];
const rel = (p) => relative(repoRoot, p).split(sep).join('/');

// ── 1. Derive what cluster.yaml actually produces ────────────────────────────
const { seriesByName, labelColumnsByQuery, labelOnlyByName, queryCount } =
  parseCustomQueries(readFileSync(clusterFile, 'utf8'));

if (queryCount === 0) {
  failures.push(
    `${rel(clusterFile)}: parsed no user-defined queries — the ConfigMap shape changed and this check would otherwise pass vacuously`,
  );
}
if (seriesByName.size === 0) {
  failures.push(
    `${rel(clusterFile)}: parsed no non-LABEL metric columns, so no series could be derived`,
  );
}

// ── 2. Collect every reference in the monitoring rules ───────────────────────
const references = [];
for (const file of listRuleFiles(here)) {
  references.push(...collectReferences(readFileSync(file, 'utf8'), file));
}

const exportedReferences = references.filter((ref) => ref.name.startsWith(SERIES_PREFIX));
if (exportedReferences.length === 0) {
  failures.push(
    `no ${SERIES_PREFIX}* references were found under ${rel(here)} — the rule files or this scanner changed shape, and a check that inspects nothing proves nothing`,
  );
}

// ── 3. Assert each reference is derivable ────────────────────────────────────
const referenced = new Set();
const queryNames = [...labelColumnsByQuery.keys()];
for (const ref of references) {
  if (ref.unknownPrefix) {
    failures.push(
      `${ref.where}: ${ref.name} is neither a CNPG built-in (cnpg_pg_* / cnpg_collector_*) nor derivable from ${rel(clusterFile)} — if this is a custom-query series the prefix or query name is misspelled`,
    );
    continue;
  }
  if (ref.bare) {
    // Query-local spelling in PromQL: `vhhealth_replication_lag_seconds` where
    // the exporter publishes `cnpg_vhhealth_replication_lag_seconds`. Only
    // flagged when the identifier is, or starts with, a declared query name —
    // backend-exported series such as vhhealth_continuity_edge_replication_lag_
    // seconds share the vhhealth_ prefix but no query name and are untouched.
    const owner = queryNames.find((q) => ref.name === q || ref.name.startsWith(`${q}_`));
    if (owner) {
      const prefixed = `cnpg_${ref.name}`;
      failures.push(
        seriesByName.has(prefixed)
          ? `${ref.where}: ${ref.name} is the query-local spelling and matches nothing — the CNPG exporter publishes this column as ${prefixed}`
          : `${ref.where}: ${ref.name} names query \`${owner}\` but is not a column of it, and ${prefixed} is not a series either. Columns of \`${owner}\`: ${describeQuery(owner)}`,
      );
    }
    continue;
  }

  const definition = seriesByName.get(ref.name);
  if (!definition) {
    const labelOnly = labelOnlyByName.get(ref.name);
    failures.push(
      labelOnly
        ? `${ref.where}: ${ref.name} is not a series — column \`${labelOnly.column}\` of query \`${labelOnly.query}\` is declared \`usage: LABEL\`, so it becomes a label on that query's gauges, not a metric of its own`
        : `${ref.where}: ${ref.name} is not produced by any query in ${rel(clusterFile)}. Derivable series: ${[...seriesByName.keys()].sort().join(', ')}`,
    );
    continue;
  }

  referenced.add(ref.name);
  const allowed = labelColumnsByQuery.get(definition.query) ?? new Set();
  for (const label of ref.labels) {
    if (allowed.has(label) || TARGET_LABELS.has(label)) continue;
    failures.push(
      `${ref.where}: ${ref.name}{${label}=...} — \`${label}\` is neither a \`usage: LABEL\` column of query \`${definition.query}\` (${[...allowed].sort().join(', ') || 'none'}) nor a Prometheus target label`,
    );
  }
}

// ── 4. Report ────────────────────────────────────────────────────────────────
for (const failure of failures) console.error(`✗ ${failure}`);

if (failures.length > 0) {
  console.error(
    `✗ ${failures.length} CNPG metric-parity failure(s); alert expressions and ${rel(clusterFile)} disagree`,
  );
  process.exit(1);
}

console.log(
  `✓ ${exportedReferences.length} ${SERIES_PREFIX}* reference(s) across the monitoring rules all resolve to a query+column declared in ${rel(clusterFile)}, and no selector uses a query-local spelling`,
);
const unreferenced = [...seriesByName.keys()].filter((n) => !referenced.has(n)).sort();
if (unreferenced.length > 0) {
  // Not a failure: diagnostic gauges deliberately carry no thresholds. Printed
  // so an exported-but-unread metric stays visible instead of accumulating.
  console.log(`  note: exported but not referenced by any rule: ${unreferenced.join(', ')}`);
}

/** Human-readable column inventory for one query, for failure messages. */
function describeQuery(query) {
  const gauges = [...seriesByName.entries()]
    .filter(([, d]) => d.query === query)
    .map(([, d]) => d.column)
    .sort();
  const labels = [...(labelColumnsByQuery.get(query) ?? [])].sort();
  return `${gauges.join(', ') || 'none'} (metrics); ${labels.join(', ') || 'none'} (labels)`;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/**
 * Pull the embedded `queries.yaml: |` document out of the custom-queries
 * ConfigMap and read the query name / metric column / usage triples out of it.
 * Deliberately line-based and strict about indentation, matching the sibling
 * monitoring scripts: a reformat makes this parse nothing, and the vacuity
 * guards above turn "parsed nothing" into a failure rather than a pass.
 */
function parseCustomQueries(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^(\s*)queries\.yaml:\s*\|\s*$/.test(line));
  const seriesByName = new Map();
  const labelColumnsByQuery = new Map();
  const labelOnlyByName = new Map();
  if (start === -1) return { seriesByName, labelColumnsByQuery, labelOnlyByName, queryCount: 0 };

  const blockIndent = lines[start].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (line.match(/^(\s*)/)[1].length <= blockIndent) break;
    body.push(line);
  }

  const contentIndent = Math.min(
    ...body.filter((l) => l.trim() !== '').map((l) => l.match(/^(\s*)/)[1].length),
  );
  const dedented = body.map((l) => (l.trim() === '' ? '' : l.slice(contentIndent)));

  let query = null;
  let column = null;
  let inScalarBlock = false;
  let queryCount = 0;

  for (const line of dedented) {
    if (inScalarBlock) {
      // The `query: |` SQL body sits at indent >= 4; anything shallower ends it.
      if (line.trim() === '' || line.match(/^(\s*)/)[1].length >= 4) continue;
      inScalarBlock = false;
    }
    if (/^\s*#/.test(line) || line.trim() === '') continue;

    const queryMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (queryMatch) {
      query = queryMatch[1];
      column = null;
      queryCount += 1;
      labelColumnsByQuery.set(query, new Set());
      continue;
    }
    if (/^ {2}query:\s*[|>][-+]?\s*$/.test(line)) {
      inScalarBlock = true;
      continue;
    }

    const columnMatch = line.match(/^ {4}- ([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (columnMatch) {
      column = columnMatch[1];
      continue;
    }

    const usageMatch = line.match(/^ {8}usage:\s*([A-Za-z_]+)\s*$/);
    if (usageMatch && query && column) {
      const name = `cnpg_${query}_${column}`;
      if (usageMatch[1].toUpperCase() === 'LABEL') {
        labelColumnsByQuery.get(query).add(column);
        labelOnlyByName.set(name, { query, column });
      } else {
        seriesByName.set(name, { query, column, usage: usageMatch[1] });
      }
      column = null;
    }
  }

  return { seriesByName, labelColumnsByQuery, labelOnlyByName, queryCount };
}

/** Every rule/fixture document under the monitoring directory, recursively. */
function listRuleFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listRuleFiles(full));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yaml.example')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Scan the three places a rule can name a series: the PromQL in `expr:`, the
 * `summary:` / `description:` annotations that tell an operator what the alert
 * measured, and the `- series:` samples in the promtool fixtures. Annotations
 * are included because an annotation naming a metric the rule does not read is
 * how an operator gets sent to a series that does not exist.
 */
function collectReferences(raw, file) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const references = [];
  let rule = 'unknown rule';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const ruleMatch = line.match(/^\s*- (?:alert|record):\s+(\S+)\s*$/);
    if (ruleMatch) rule = ruleMatch[1];

    const exprMatch = line.match(/^(\s*)expr:\s*(.*)$/);
    if (exprMatch) {
      const indent = exprMatch[1].length;
      let text = exprMatch[2].trim();
      if (/^[|>][-+]?(?:\s+#.*)?$/.test(text)) {
        text = '';
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j];
          if (next.trim() !== '' && next.match(/^(\s*)/)[1].length <= indent) break;
          text += `${next}\n`;
          i = j;
        }
      }
      references.push(...extract(unquoteScalar(text), `${rel(file)}:${rule} expr`, { promql: true }));
      continue;
    }

    const annotationMatch = line.match(/^\s*(?:summary|description):\s*(.+)$/);
    if (annotationMatch) {
      references.push(...extract(annotationMatch[1], `${rel(file)}:${rule} annotation`));
      continue;
    }

    const seriesMatch = line.match(/^\s*- series:\s*(.+)$/);
    if (seriesMatch) {
      references.push(
        ...extract(unquoteScalar(seriesMatch[1]), `${rel(file)}:${i + 1} promtool input_series`, {
          promql: true,
        }),
      );
    }
  }

  return references;
}

function unquoteScalar(text) {
  const singleQuoted = text.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  if (singleQuoted) return singleQuoted[1].replace(/''/g, "'");
  const doubleQuoted = text.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
  return doubleQuoted ? JSON.parse(doubleQuoted[1]) : text;
}

/**
 * Every SERIES_PREFIX name in a blob of text, with any label matchers on it.
 *
 * When `promql` is set the blob is a selector rather than prose, so bare
 * `vhhealth_*` identifiers are collected too and checked against the declared
 * query names — that is the arm that catches the missing `cnpg_` prefix. Prose
 * (annotations) is scanned for exported names only.
 */
function extract(text, where, { promql = false } = {}) {
  const references = [];
  // Preserve offsets into the original selector while excluding prose inside
  // PromQL strings and comments from the executable metric inventory.
  const searchable = promql
    ? text.replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`[^`]*`|#[^\r\n]*/g,
      (part) => part.replace(/[^\r\n]/g, ' '))
    : text;
  if (promql) {
    const bareRe = /(?<![A-Za-z0-9_:])vhhealth_[A-Za-z0-9_:]*/g;
    let bare;
    while ((bare = bareRe.exec(searchable)) !== null) {
      references.push({ name: bare[0], labels: [], where, bare: true });
    }
  }

  // Executable expressions must also police misspellings of the custom prefix;
  // otherwise those names fall out of the very namespace being validated.
  const nameRe = promql
    ? /(?<![A-Za-z0-9_:])cnpg_[A-Za-z0-9_:]*/g
    : new RegExp(`${SERIES_PREFIX}[A-Za-z0-9_]*`, 'g');
  const matches = [...searchable.matchAll(nameRe)].map((match) => ({
    name: match[0],
    rest: text.slice(match.index + match[0].length),
  }));
  if (promql) {
    // An exact __name__ matcher is a selector's metric identity, not an
    // ordinary string label. It carries the same label contract as a name
    // written before the opening brace.
    const exactName = /(?<![A-Za-z0-9_])__name__\s*=\s*(["'`])((?:cnpg_|vhhealth_)[A-Za-z0-9_:]+)\1/g;
    for (const match of text.matchAll(exactName)) {
      if (searchable[match.index] !== '_') continue;
      const start = searchable.lastIndexOf('{', match.index);
      const end = searchable.indexOf('}', start);
      if (start === -1 || end < match.index) continue;
      matches.push({ name: match[2], rest: text.slice(start, end + 1) });
    }
  }
  for (const { name, rest } of matches) {
    if (promql && name.startsWith('vhhealth_')) {
      references.push({ name, labels: [], where, bare: true });
      continue;
    }
    if (promql && !name.startsWith(SERIES_PREFIX)) {
      if (!name.startsWith('cnpg_pg_') && !name.startsWith('cnpg_collector_')) {
        references.push({ name, labels: [], where, unknownPrefix: true });
      }
      continue;
    }
    const selector = rest.match(/^\s*\{([^}]*)\}/);
    const labels = [];
    if (selector) {
      // Consume `name op "value"` triples in order so that an identifier inside
      // a quoted label value can never be mistaken for a label name.
      const matcherRe = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|=|!=)\s*"(?:[^"\\]|\\.)*"/g;
      let matcher;
      while ((matcher = matcherRe.exec(selector[1])) !== null) labels.push(matcher[1]);
    }
    references.push({ name, labels, where });
  }
  return references;
}
