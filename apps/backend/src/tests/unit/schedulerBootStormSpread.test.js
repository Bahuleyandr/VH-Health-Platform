// src/tests/unit/schedulerBootStormSpread.test.js
//
// The 2026-09-09 06:40Z incident in one property: 06:40:00 is simultaneously a
// `*/1`, `*/2`, `*/5` and `*/10` boundary, and scheduler.js registers 77
// schedules, so a pod that booted seconds earlier ran dozens of jobs against
// one database inside the same second.
//
// Cron registration is skipped entirely under NODE_ENV=test (the CI-8
// open-handle guard), so the roster is read from the scheduler source with a
// real ES parser rather than imported. Two arms run over that roster:
//   • control   — pacing disabled: every boundary job lands in one second.
//                 This is the pre-fix behaviour, and it proves the measurement
//                 can see the bad state.
//   • treatment — the shipped jitter window: the same jobs spread out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import {
  DEFAULT_BOOT_JITTER_WINDOW_MS,
  firstRunOffsetMs,
} from '../../utils/schedulerBootPacing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULER_PATH = path.resolve(__dirname, '../../utils/scheduler.js');
const source = fs.readFileSync(SCHEDULER_PATH, 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') { return; }
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') { continue; }
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((child) => walk(child, visit));
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

// Registration order == source order: the whole roster is one linear block.
const registrations = [];
walk(ast, (node) => {
  if (node.type === 'CallExpression'
    && node.callee?.type === 'Identifier'
    && node.callee.name === 'registerCron') {
    registrations.push(node);
  }
});
registrations.sort((a, b) => a.range[0] - b.range[0]);

// Three registrations take their expression from an env override or a config
// helper rather than a bare literal. `process.env.X || '<literal>'` still has a
// statically known default; a plain call does not. Both keep their registration
// index — that is what the running process assigns them.
const dynamicCallees = [];
const roster = registrations.map((node, index) => {
  const first = node.arguments[0];
  const line = node.loc.start.line;
  if (first?.type === 'Literal' && typeof first.value === 'string') {
    return { index, expression: first.value, line };
  }
  if (first?.type === 'LogicalExpression'
    && first.operator === '||'
    && first.right?.type === 'Literal'
    && typeof first.right.value === 'string') {
    return { index, expression: first.right.value, line };
  }
  dynamicCallees.push(first?.callee?.name || first?.type || 'unknown');
  return { index, expression: null, line };
});
const staticRoster = roster.filter((job) => job.expression !== null);

/** Match one cron field against a value. Supports `*`, `* /N` and integers. */
function fieldMatches(field, value, unsupported) {
  if (field === '*') { return true; }
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) { return value % Number(step[1]) === 0; }
  if (/^\d+$/.test(field)) { return Number(field) === value; }
  unsupported.push(field);
  return false;
}

/**
 * Does `expression` fire at 06:40:00 on a Wednesday, the 9th of September?
 * That is the exact instant of the incident.
 */
function firesAtIncidentInstant(expression, unsupported) {
  const fields = expression.trim().split(/\s+/);
  const at = {
    second: 0, minute: 40, hour: 6, dayOfMonth: 9, month: 9, dayOfWeek: 3,
  };
  let second = '0';
  let rest = fields;
  if (fields.length === 6) {
    [second, ...rest] = fields;
  } else if (fields.length !== 5) {
    unsupported.push(expression);
    return false;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = rest;
  return fieldMatches(second, at.second, unsupported)
    && fieldMatches(minute, at.minute, unsupported)
    && fieldMatches(hour, at.hour, unsupported)
    && fieldMatches(dayOfMonth, at.dayOfMonth, unsupported)
    && fieldMatches(month, at.month, unsupported)
    && fieldMatches(dayOfWeek, at.dayOfWeek, unsupported);
}

function busiestSecond(jobs, windowMs) {
  const buckets = new Map();
  for (const job of jobs) {
    const offset = firstRunOffsetMs(job.index, job.expression, windowMs);
    const bucket = Math.floor(offset / 1000);
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  return Math.max(...buckets.values());
}

describe('scheduler boot-storm spread', () => {
  const unsupported = [];
  const boundaryJobs = staticRoster.filter(
    (job) => firesAtIncidentInstant(job.expression, unsupported),
  );

  it('parses every registration in the roster', () => {
    // Every cron field in the roster is one of `*`, `*/N` or an integer. A new
    // shape here means the boundary analysis below silently stopped covering
    // part of the roster.
    expect(unsupported).toEqual([]);
    // Only the care-pathway reconciliation cron is computed at call time; the
    // other two dynamic sites fall back to a statically known literal.
    expect(dynamicCallees).toEqual(['pathwayReconciliationCron']);
    // Population guard: a roster that failed to parse would make every
    // assertion below vacuously true.
    expect(roster.length).toBeGreaterThanOrEqual(70);
    expect(staticRoster.length).toBe(roster.length - 1);
  });

  it('reproduces the incident: dozens of jobs share the 06:40:00 tick', () => {
    expect(boundaryJobs.length).toBeGreaterThanOrEqual(30);
  });

  it('control arm — with pacing disabled they all land in the same second', () => {
    expect(busiestSecond(boundaryJobs, 0)).toBe(boundaryJobs.length);
  });

  it('treatment arm — the shipped jitter window spreads them out', () => {
    const busiest = busiestSecond(boundaryJobs, DEFAULT_BOOT_JITTER_WINDOW_MS);
    expect(busiest).toBeLessThanOrEqual(4);
    // And the spread is a genuine reduction, not a rounding artefact.
    expect(busiest).toBeLessThan(boundaryJobs.length / 5);
  });
});

describe('scheduler.js boot-pacing wiring', () => {
  const registerCronFn = (() => {
    let found = null;
    walk(ast, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id?.name === 'registerCron') {
        found = node;
      }
    });
    return found;
  })();

  it('declares registerCron', () => {
    expect(registerCronFn).not.toBeNull();
  });

  it('wraps every registered handler in the boot pacing, keyed on the registration index', () => {
    const body = source.slice(registerCronFn.range[0], registerCronFn.range[1]);
    expect(body).toContain('withBootPacing(');
    // The index must be read BEFORE the push, or every job would share it.
    expect(body.indexOf('withBootPacing(scheduledTasks.length'))
      .toBeGreaterThan(-1);
    expect(body.indexOf('withBootPacing('))
      .toBeLessThan(body.indexOf('scheduledTasks.push('));

    // Second, differently-constructed signal: the pacing call is an actual
    // CallExpression wrapping the handler that reaches cronSchedule, not a
    // string that happens to appear in a comment.
    const calls = [];
    walk(registerCronFn, (node) => {
      if (node.type === 'CallExpression' && node.callee?.name === 'withBootPacing') {
        calls.push(node);
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toHaveLength(3);
  });

  it('cancels pending paced first runs during graceful shutdown', () => {
    let stopFn = null;
    walk(ast, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id?.name === 'stopAllScheduledTasks') {
        stopFn = node;
      }
    });
    expect(stopFn).not.toBeNull();
    const calls = [];
    walk(stopFn, (node) => {
      if (node.type === 'CallExpression' && node.callee?.name === 'cancelPendingBootPacing') {
        calls.push(node);
      }
    });
    expect(calls).toHaveLength(1);
  });

  it('imports the pacing helpers it wires', () => {
    const imported = new Set();
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration' && node.source.value === './schedulerBootPacing.js') {
        for (const spec of node.specifiers) { imported.add(spec.imported?.name || spec.local.name); }
      }
    }
    expect([...imported].sort()).toEqual(['cancelPendingBootPacing', 'withBootPacing']);
  });
});

describe('boot sweep stagger', () => {
  it('threads a per-task pause through runAllScheduledTasksNow', () => {
    const startup = source.slice(source.indexOf('export async function runAllScheduledTasksNow'));
    expect(startup).toContain('runAllScheduledTasksNow({ stepDelayMs = 0 } = {})');
    // The pause must sit between tasks, not before the first one.
    expect(startup).toContain('pause > 0 && manualTasksStarted > 0');
  });
});
