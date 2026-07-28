import {
  parseExcludedPortRanges,
  findExclusionRange,
  parsePostmasterPid,
  classifyStartFailure,
} from '../../../scripts/lib/qaPortDiagnostics.mjs';

// Real `netsh int ipv4 show excludedportrange protocol=tcp` output captured
// on Trenzalore 2026-07-28 while 55432 was inside a WinNAT dynamic range.
const NETSH_WITH_55432_EXCLUDED = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5357        5357
      5985        5985
     27339       27339
     47001       47001
     50000       50059     *
     50101       50200
     54913       55012
     55390       55489
     58598       58697
     59263       59362

* - Administered port exclusions.
`;

// Real postmaster.pid content from the same incident (cluster restarted on
// the low port 15432 while 55432 was excluded).
const POSTMASTER_PID_15432 = [
  '209080',
  'D:/Dev/Tools/vhhealth-test-postgres-data',
  '1785212459',
  '15432',
  '',
  '127.0.0.1',
  '',
  'ready',
  '',
].join('\n');

const LOG_TAIL_LOCK_HELD = [
  '2026-07-28 10:16:23.546 IST [242136] FATAL:  lock file "postmaster.pid" already exists',
  '2026-07-28 10:16:23.546 IST [242136] HINT:  Is another postmaster (PID 209080) running in data directory "D:/Dev/Tools/vhhealth-test-postgres-data"?',
].join('\n');

const LOG_TAIL_BIND_DENIED = [
  '2026-07-28 09:31:02.101 IST [201314] LOG:  starting PostgreSQL 17.4, compiled by Visual C++ build 1942, 64-bit',
  '2026-07-28 09:31:02.104 IST [201314] LOG:  could not bind IPv4 address "127.0.0.1": Permission denied',
  '2026-07-28 09:31:02.104 IST [201314] WARNING:  could not create listen socket for "127.0.0.1"',
  '2026-07-28 09:31:02.104 IST [201314] FATAL:  could not create any TCP/IP sockets',
].join('\n');

describe('parseExcludedPortRanges', () => {
  it('parses real netsh output into numeric ranges, including administered (*) rows', () => {
    const ranges = parseExcludedPortRanges(NETSH_WITH_55432_EXCLUDED);
    expect(ranges).toContainEqual({ start: 55390, end: 55489 });
    expect(ranges).toContainEqual({ start: 50000, end: 50059 });
    expect(ranges).toContainEqual({ start: 5357, end: 5357 });
    expect(ranges).toHaveLength(10);
  });

  it('ignores headers, separators, and footer text', () => {
    const ranges = parseExcludedPortRanges(NETSH_WITH_55432_EXCLUDED);
    for (const r of ranges) {
      expect(typeof r.start).toBe('number');
      expect(typeof r.end).toBe('number');
      expect(r.start).toBeLessThanOrEqual(r.end);
    }
  });

  it('returns [] for empty or garbage input (e.g. netsh unavailable)', () => {
    expect(parseExcludedPortRanges('')).toEqual([]);
    expect(parseExcludedPortRanges('The command failed')).toEqual([]);
    expect(parseExcludedPortRanges(null)).toEqual([]);
  });
});

describe('findExclusionRange', () => {
  const ranges = parseExcludedPortRanges(NETSH_WITH_55432_EXCLUDED);

  it('finds the range containing the port', () => {
    expect(findExclusionRange(55432, ranges)).toEqual({ start: 55390, end: 55489 });
  });

  it('is inclusive at both boundaries', () => {
    expect(findExclusionRange(55390, ranges)).toEqual({ start: 55390, end: 55489 });
    expect(findExclusionRange(55489, ranges)).toEqual({ start: 55390, end: 55489 });
    expect(findExclusionRange(55490, ranges)).toBeNull();
  });

  it('returns null for unexcluded ports and accepts string ports', () => {
    expect(findExclusionRange(15432, ranges)).toBeNull();
    expect(findExclusionRange('55432', ranges)).toEqual({ start: 55390, end: 55489 });
  });
});

describe('parsePostmasterPid', () => {
  it('parses the real Windows postmaster.pid layout', () => {
    const pm = parsePostmasterPid(POSTMASTER_PID_15432);
    expect(pm).toEqual({
      pid: 209080,
      dataDir: 'D:/Dev/Tools/vhhealth-test-postgres-data',
      port: 15432,
      listenAddr: '127.0.0.1',
      status: 'ready',
    });
  });

  it('tolerates CRLF line endings', () => {
    const pm = parsePostmasterPid(POSTMASTER_PID_15432.replace(/\n/g, '\r\n'));
    expect(pm.pid).toBe(209080);
    expect(pm.port).toBe(15432);
    expect(pm.status).toBe('ready');
  });

  it('returns null for empty or malformed content', () => {
    expect(parsePostmasterPid('')).toBeNull();
    expect(parsePostmasterPid(null)).toBeNull();
    expect(parsePostmasterPid('not-a-pid\n')).toBeNull();
  });
});

describe('classifyStartFailure', () => {
  const excludedRanges = parseExcludedPortRanges(NETSH_WITH_55432_EXCLUDED);
  const postmaster15432 = parsePostmasterPid(POSTMASTER_PID_15432);

  it('reports already-running-other-port when a live postmaster serves a different port', () => {
    const res = classifyStartFailure({
      port: 55432,
      logTail: LOG_TAIL_LOCK_HELD,
      excludedRanges,
      postmaster: postmaster15432,
      postmasterAlive: true,
    });
    expect(res.kind).toBe('already-running-other-port');
    const text = res.remediation.join('\n');
    expect(text).toMatch(/VHHEALTH_TEST_DB_PORT=15432/);
    expect(text).toMatch(/pg_ctl/);
    expect(text).toMatch(/stop/);
  });

  it('reports lock-file-held when the lock is present but no live other-port postmaster is known', () => {
    const res = classifyStartFailure({
      port: 55432,
      logTail: LOG_TAIL_LOCK_HELD,
      excludedRanges: [],
      postmaster: null,
      postmasterAlive: false,
    });
    expect(res.kind).toBe('lock-file-held');
    expect(res.remediation.join('\n')).toMatch(/postmaster\.pid/);
  });

  it('reports winnat-exclusion with exact remediation when the port is inside an excluded range', () => {
    const res = classifyStartFailure({
      port: 55432,
      logTail: LOG_TAIL_BIND_DENIED,
      excludedRanges,
      postmaster: null,
      postmasterAlive: false,
    });
    expect(res.kind).toBe('winnat-exclusion');
    const text = res.remediation.join('\n');
    expect(text).toMatch(/55390-55489/);
    expect(text).toMatch(/net stop winnat && net start winnat/);
    expect(text).toMatch(/VHHEALTH_TEST_DB_PORT=15432/);
    expect(text).toMatch(/47001/);
    expect(text).toMatch(/netsh int ipv4 show excludedportrange protocol=tcp/);
  });

  it('reports bind-permission-denied for the invisible-reservation class when the port is NOT excluded', () => {
    const res = classifyStartFailure({
      port: 55432,
      logTail: LOG_TAIL_BIND_DENIED,
      excludedRanges: [],
      postmaster: null,
      postmasterAlive: false,
    });
    expect(res.kind).toBe('bind-permission-denied');
    const text = res.remediation.join('\n');
    expect(text).toMatch(/wsl --shutdown/);
    expect(text).toMatch(/VHHEALTH_TEST_DB_PORT=/);
  });

  it('reports log-unreadable instead of "<could not read logfile>" when the tail is missing', () => {
    for (const logTail of [null, '', '   \n']) {
      const res = classifyStartFailure({
        port: 55432,
        logTail,
        excludedRanges: [],
        postmaster: postmaster15432,
        postmasterAlive: false,
      });
      expect(res.kind).toBe('log-unreadable');
      expect(res.remediation.join('\n')).toMatch(/another postmaster/i);
    }
  });

  it('reports still-starting when the log shows crash recovery in progress (slow fsync is progress, not a hang)', () => {
    const res = classifyStartFailure({
      port: 55432,
      logTail: [
        '2026-07-28 09:50:59.902 IST [209080] LOG:  syncing data directory (fsync), elapsed time: 45.01 s, current path: ./base/17024',
        '2026-07-28 09:51:40.115 IST [209081] FATAL:  the database system is starting up',
      ].join('\n'),
      excludedRanges: [],
      postmaster: null,
      postmasterAlive: false,
    });
    expect(res.kind).toBe('still-starting');
    const text = res.remediation.join('\n');
    expect(text).toMatch(/progress/i);
    expect(text).toMatch(/VHHEALTH_TEST_DB_START_TIMEOUT_S/);
  });

  it('falls back to unknown for unrecognized failures', () => {
    const res = classifyStartFailure({
      port: 55432,
      logTail: '2026-07-28 09:31:02 IST FATAL:  configuration file error',
      excludedRanges,
      postmaster: null,
      postmasterAlive: false,
    });
    expect(res.kind).toBe('unknown');
    expect(res.remediation.length).toBeGreaterThan(0);
  });
});
