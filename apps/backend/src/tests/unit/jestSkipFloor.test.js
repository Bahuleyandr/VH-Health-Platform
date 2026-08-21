// Skip-floor reconciliation — the static half of the HIGH-3 (PR #874)
// follow-up. The runtime half is scripts/jest-skip-floor-reporter.cjs, which
// fails any JEST_ENFORCE_SKIP_FLOOR run (the canonical CI jobs set it) where
// a test skipped without a floor entry — catching dynamic skips (env guards,
// stray `.only` starving siblings) that no static scan can see.
//
// This suite reconciles the floor file scripts/jest-skip-floor.json against
// the corpus in BOTH directions, mirroring the Spectral-baseline philosophy
// (a stale entry is as much a failure as a new finding, so the floor can
// never silently absorb a returning skip):
//   1. every literal skip marker in src/tests (it.skip / test.skip /
//      describe.skip / xit / xtest / xdescribe / it.todo / test.todo) must
//      have a floor entry — a new skip is an explicit, reviewed decision;
//   2. every floor entry must still name a title present in its file — a
//      removed or renamed test prunes its entry, the floor only ever shrinks
//      unless a new skip is deliberately added;
// and pins the enforcement wiring so the gate cannot be hollow:
//   3. package.json jest.reporters carries the reporter (a config nobody
//      invokes is the exact failure mode the R9 coverage-gate audit found);
//   4. both canonical backend CI workflows export JEST_ENFORCE_SKIP_FLOOR.
//
// The reporter's own behavior (inert without the env var, offender detection,
// title and ancestor-title matching) is exercised directly below.
//
// NOTE ON SELF-MATCHING: the marker regexes require `(` after the marker, so
// the conditional-guard idiom (`dbUrl ? describe : describe.skip;`) and prose
// mentions never match; this file's own regex sources are shaped so they do
// not match themselves.

import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const testsRoot = path.join(backendRoot, 'src', 'tests');
const floorPath = path.join(backendRoot, 'scripts', 'jest-skip-floor.json');
const reporterPath = path.join(backendRoot, 'scripts', 'jest-skip-floor-reporter.cjs');
const repoRoot = path.resolve(backendRoot, '..', '..');

const floor = JSON.parse(readFileSync(floorPath, 'utf8'));
const entries = floor.entries;

// Literal skip/todo markers. The string-literal capture accepts ' " ` quoted
// titles (no template interpolation — a computed title cannot be reconciled,
// so the forward scan flags it as an offender with a null title).
const MARKER_PATTERNS = [
  /(?<![\w.$])(?:it|test|describe)\s*\.\s*skip\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*?)\1)?/g,
  /(?<![\w.$])x(?:it|test|describe)\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*?)\1)?/g,
  /(?<![\w.$])(?:it|test)\s*\.\s*todo\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*?)\1)?/g,
];

function listTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function relBackendPath(absPath) {
  return path.relative(backendRoot, absPath).split(path.sep).join('/');
}

function extractMarkers(source) {
  const markers = [];
  for (const pattern of MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      markers.push({ title: match[2] ?? null });
    }
  }
  return markers;
}

describe('skip floor file shape', () => {
  test('entries are well-formed, unique, and point at real files', () => {
    expect(Array.isArray(entries)).toBe(true);
    const seen = new Set();
    for (const entry of entries) {
      expect(typeof entry.file).toBe('string');
      expect(entry.file.startsWith('src/tests/')).toBe(true);
      expect(typeof entry.title).toBe('string');
      expect(entry.title.length).toBeGreaterThan(0);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      const key = `${entry.file}::${entry.title}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      // Throws (failing the test) when the file is gone — stale entries must
      // be pruned with the test they described.
      readFileSync(path.join(backendRoot, entry.file), 'utf8');
    }
  });
});

describe('skip floor reconciliation (corpus <-> floor, both directions)', () => {
  test('every literal skip marker in the corpus has a floor entry', () => {
    const offenders = [];
    for (const filePath of listTestFiles(testsRoot)) {
      const relPath = relBackendPath(filePath);
      const source = readFileSync(filePath, 'utf8');
      for (const marker of extractMarkers(source)) {
        const allowed = marker.title !== null
          && entries.some((entry) => entry.file === relPath && entry.title === marker.title);
        if (!allowed) offenders.push({ file: relPath, title: marker.title });
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        [
          'Skip markers without a floor entry (a skip is an explicit, reviewed',
          'decision — declare it in apps/backend/scripts/jest-skip-floor.json',
          'with a reason, or un-skip the test). A null title means the marker',
          'has a computed title, which cannot be reconciled — use a literal:',
          ...offenders.map((o) => `  { "file": ${JSON.stringify(o.file)}, "title": ${JSON.stringify(o.title)}, "reason": "" },`),
        ].join('\n'),
      );
    }
  });

  test('every floor entry still names a title present in its file (stale entries must be pruned)', () => {
    const stale = [];
    for (const entry of entries) {
      const source = readFileSync(path.join(backendRoot, entry.file), 'utf8');
      if (!source.includes(entry.title)) {
        stale.push(entry);
      }
    }
    if (stale.length > 0) {
      throw new Error(
        [
          'Stale skip-floor entries — the named test no longer exists in the file.',
          'Prune them (a stale entry would let the same skip return unnoticed):',
          ...stale.map((e) => `  - ${e.file} :: ${e.title}`),
        ].join('\n'),
      );
    }
  });
});

describe('skip floor enforcement wiring (the gate must not be hollow)', () => {
  test('package.json jest config carries the reporter alongside the default reporter', () => {
    const pkg = JSON.parse(readFileSync(path.join(backendRoot, 'package.json'), 'utf8'));
    expect(pkg.jest.reporters).toEqual([
      'default',
      '<rootDir>/scripts/jest-skip-floor-reporter.cjs',
    ]);
  });

  test('the canonical CI workflows export JEST_ENFORCE_SKIP_FLOOR in every jest-running job', () => {
    const lintTest = readFileSync(
      path.join(repoRoot, '.github', 'workflows', '_reusable-backend-lint-test.yml'),
      'utf8',
    );
    const quick = readFileSync(
      path.join(repoRoot, '.github', 'workflows', '_reusable-backend-quick.yml'),
      'utf8',
    );
    // static-checks (coverage gate) + test shards.
    expect(lintTest.match(/JEST_ENFORCE_SKIP_FLOOR: '1'/g)).toHaveLength(2);
    // affected-tests job.
    expect(quick.match(/JEST_ENFORCE_SKIP_FLOOR: '1'/g)).toHaveLength(1);
  });
});

describe('jest-skip-floor-reporter.cjs behavior', () => {
  const Reporter = require(reporterPath);
  const savedEnv = process.env.JEST_ENFORCE_SKIP_FLOOR;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.JEST_ENFORCE_SKIP_FLOOR;
    else process.env.JEST_ENFORCE_SKIP_FLOOR = savedEnv;
  });

  function runReporter(assertions, { testFile = 'src/tests/fake-suite.test.js' } = {}) {
    const reporter = new Reporter({ rootDir: backendRoot });
    reporter.onRunComplete(new Set(), {
      testResults: [
        {
          testFilePath: path.join(backendRoot, testFile),
          testResults: assertions,
        },
      ],
    });
    return reporter.getLastError();
  }

  test('inert when JEST_ENFORCE_SKIP_FLOOR is unset (local DB-less runs keep skipping freely)', () => {
    delete process.env.JEST_ENFORCE_SKIP_FLOOR;
    const err = runReporter([
      { title: 'anything', fullName: 'suite anything', ancestorTitles: ['suite'], status: 'pending' },
    ]);
    expect(err).toBeUndefined();
  });

  test('an undeclared skipped test fails the enforced run with a paste-ready floor entry', () => {
    process.env.JEST_ENFORCE_SKIP_FLOOR = '1';
    const err = runReporter([
      { title: 'passes fine', fullName: 'suite passes fine', ancestorTitles: ['suite'], status: 'passed' },
      { title: 'quietly gone', fullName: 'suite quietly gone', ancestorTitles: ['suite'], status: 'pending' },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('SKIP FLOOR VIOLATION');
    expect(err.message).toContain('src/tests/fake-suite.test.js :: suite quietly gone');
    expect(err.message).toContain('"title": "quietly gone"');
  });

  test('todo and disabled statuses count as skips', () => {
    process.env.JEST_ENFORCE_SKIP_FLOOR = '1';
    for (const status of ['todo', 'disabled', 'skipped']) {
      const err = runReporter([
        { title: 'left behind', fullName: `s left behind (${status})`, ancestorTitles: ['s'], status },
      ]);
      expect(err).toBeInstanceOf(Error);
    }
  });

  test('a floor entry allows the skip when matched by exact title in the right file', () => {
    process.env.JEST_ENFORCE_SKIP_FLOOR = '1';
    const allowed = entries[0];
    const err = runReporter(
      [
        {
          title: allowed.title,
          fullName: `some suite ${allowed.title}`,
          ancestorTitles: ['some suite'],
          status: 'pending',
        },
      ],
      { testFile: allowed.file },
    );
    expect(err).toBeUndefined();
  });

  test('a floor entry naming a describe title allows every test under it (ancestor match)', () => {
    process.env.JEST_ENFORCE_SKIP_FLOOR = '1';
    const allowed = entries[0];
    const err = runReporter(
      [
        {
          title: 'child test under an allowlisted describe',
          fullName: `${allowed.title} child test under an allowlisted describe`,
          ancestorTitles: ['outer', allowed.title],
          status: 'pending',
        },
      ],
      { testFile: allowed.file },
    );
    expect(err).toBeUndefined();
  });

  test('the same title in a different file is NOT allowed (floor entries are file-scoped)', () => {
    process.env.JEST_ENFORCE_SKIP_FLOOR = '1';
    const allowed = entries[0];
    const err = runReporter(
      [
        {
          title: allowed.title,
          fullName: `suite ${allowed.title}`,
          ancestorTitles: ['suite'],
          status: 'pending',
        },
      ],
      { testFile: 'src/tests/some-other-file.test.js' },
    );
    expect(err).toBeInstanceOf(Error);
  });
});
