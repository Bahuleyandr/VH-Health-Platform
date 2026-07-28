// Pure diagnostics helpers for qa-cluster-up.mjs port/bind failures.
// No I/O here — callers pass in netsh output, postmaster.pid content,
// and log tails; these functions only parse and classify. Behaviour is
// pinned by src/tests/unit/qaPortDiagnostics.test.js.
//
// Failure classes covered (all observed on this dev host):
// - winnat-exclusion (2026-07-01, 2026-07-28): the target port fell into a
//   WinNAT dynamic TCP exclusion range after a service restart/reboot.
// - already-running-other-port (2026-07-28): the cluster was manually
//   restarted on a low port while the canonical port was excluded.
// - still-starting: first start after an unclean shutdown does a slow
//   fsync/redo pass — progress, not a hang.
// - bind-permission-denied (2026-05-13): the invisible kernel-level
//   reservation class netsh does NOT list (see the IPv6 ::1:55432 caveat).

const LOW_PORT_FALLBACK = 15432;

export function parseExcludedPortRanges(netshText) {
  if (typeof netshText !== 'string' || netshText.length === 0) return [];
  const ranges = [];
  for (const line of netshText.split(/\r?\n/)) {
    // Rows look like `     55390       55489` with an optional trailing `*`
    // marking administered exclusions. Headers/separators never match.
    const m = /^\s*(\d{1,5})\s+(\d{1,5})\s*\*?\s*$/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start <= end) ranges.push({ start, end });
  }
  return ranges;
}

export function findExclusionRange(port, ranges) {
  const p = Number(port);
  if (!Number.isFinite(p) || !Array.isArray(ranges)) return null;
  return ranges.find((r) => p >= r.start && p <= r.end) || null;
}

// postmaster.pid layout: line 1 pid, 2 data dir, 3 start epoch, 4 port,
// 5 socket dir (empty on Windows), 6 listen addr, 7 shmem key (empty on
// Windows), 8 status ("ready"/"starting"). Status is read as the last
// non-empty line so minor layout drift across PG versions stays harmless.
export function parsePostmasterPid(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  const lines = text.split(/\r?\n/);
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0) return null;
  const status = [...lines].reverse().find((l) => l.trim().length > 0)?.trim() ?? '';
  return {
    pid,
    dataDir: (lines[1] || '').trim(),
    port,
    listenAddr: (lines[5] || '').trim(),
    status,
  };
}

export function buildWinnatRemediation(port, range) {
  return [
    `Port ${port} is inside the WinNAT dynamic TCP exclusion range ${range.start}-${range.end} — postgres cannot bind it.`,
    'Fix (pick one):',
    '  1. Elevated shell: net stop winnat && net start winnat   (clears dynamic ranges; re-run this script after)',
    '  2. Reboot (dynamic ranges reshuffle).',
    '  3. Low-port fallback, no admin needed (ports below 47001 stay outside the dynamic pool):',
    `     VHHEALTH_TEST_DB_PORT=${LOW_PORT_FALLBACK} node apps/backend/scripts/qa-cluster-up.mjs`,
    '     (jest then needs DATABASE_URL / TEST_DATABASE_URL pointing at the same port)',
    'Inspect the ranges: netsh int ipv4 show excludedportrange protocol=tcp',
  ];
}

export function classifyStartFailure({
  port,
  logTail,
  excludedRanges = [],
  postmaster = null,
  postmasterAlive = false,
} = {}) {
  const p = Number(port);
  const tail = typeof logTail === 'string' ? logTail : '';
  const hasTail = tail.trim().length > 0;

  if (postmasterAlive && postmaster && Number(postmaster.port) !== p) {
    return {
      kind: 'already-running-other-port',
      remediation: [
        `A postmaster (PID ${postmaster.pid}) from this PGDATA is already running on port ${postmaster.port}, not ${p}.`,
        `Use it as-is: VHHEALTH_TEST_DB_PORT=${postmaster.port} node apps/backend/scripts/qa-cluster-up.mjs`,
        `(point jest at it via DATABASE_URL / TEST_DATABASE_URL), or move it back to ${p}:`,
        `  pg_ctl -D "${postmaster.dataDir}" stop -m fast    # then re-run this script`,
      ],
    };
  }

  if (/lock file "postmaster\.pid" already exists/.test(tail)) {
    return {
      kind: 'lock-file-held',
      remediation: [
        'postmaster.pid is locked — another postmaster is running or starting from this PGDATA.',
        'Check: Get-Process postgres; and read <PGDATA>/postmaster.pid (line 4 is the port it bound).',
        'Only if NO postgres.exe is using this PGDATA is it safe to treat the lock as stale.',
      ],
    };
  }

  if (/could not bind/.test(tail) && /Permission denied/.test(tail)) {
    const range = findExclusionRange(p, excludedRanges);
    if (range) {
      return { kind: 'winnat-exclusion', remediation: buildWinnatRemediation(p, range) };
    }
    return {
      kind: 'bind-permission-denied',
      remediation: [
        `Bind on ${p} was denied but the port is NOT in a WinNAT exclusion range — likely the invisible`,
        'kernel-level reservation class (see the IPv6 ::1:55432 caveat in apps/backend/CLAUDE.md).',
        'Try: 1) Get-Process postgres (kill any zombie non-service postmaster); 2) wsl --shutdown;',
        `3) low-port fallback: VHHEALTH_TEST_DB_PORT=${LOW_PORT_FALLBACK} node apps/backend/scripts/qa-cluster-up.mjs`,
      ],
    };
  }

  if (/syncing data directory|database system is starting up|redo in progress/.test(tail)) {
    return {
      kind: 'still-starting',
      remediation: [
        'The cluster is mid crash-recovery (fsync/redo after an unclean shutdown) — this is progress, not a hang.',
        'Wait and re-run; the first start after a crash can take minutes.',
        'Raise the wait with VHHEALTH_TEST_DB_START_TIMEOUT_S=<seconds> (default 300).',
      ],
    };
  }

  if (!hasTail) {
    return {
      kind: 'log-unreadable',
      remediation: [
        'pg_ctl failed and the logfile could not be read (exclusively locked) — on Windows that usually',
        'means another postmaster is running or starting from this PGDATA and holds the logfile open.',
        'Check <PGDATA>/postmaster.pid (line 4 = bound port) and Get-Process postgres before retrying.',
      ],
    };
  }

  return {
    kind: 'unknown',
    remediation: [
      'pg_ctl start failed for an unrecognized reason — read the log tail above.',
      'Full log: <PGDATA>/logfile',
    ],
  };
}
