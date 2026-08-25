// Re-audit lane L: the CSSD console offers one button per legal issue
// transition, and each button maps to exactly one backend route. Both halves
// are pinned against the backend source here, because both are ways this train
// has shipped a control that can never fire:
//
//   - a transition the service's ISSUE_TRANSITIONS does not allow → 409 only;
//   - a transition with no route entry → a button with nothing behind it.
//
// The enum mirrors (statuses, cycle types, indicator results, return
// conditions) are pinned for the same reason: a select offering a value the
// service rejects is a 400 the operator cannot avoid.

import fs from "fs";
import path from "path";

import {
  CSSD_CYCLE_TYPES,
  CSSD_INDICATOR_RESULTS,
  CSSD_ISSUE_TRANSITIONS,
  CSSD_ISSUE_TRANSITION_ACTIONS,
  CSSD_LOAD_STATUSES,
  CSSD_RETURN_CONDITIONS,
  CSSD_SET_STATUSES,
  cssdIssueTransitions,
} from "@/lib/api/cssd";

const BACKEND = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "backend",
  "src",
);
const SERVICE = path.join(BACKEND, "services", "cssd", "cssdService.js");
const ROUTES = path.join(BACKEND, "routes", "cssd", "cssdRoutes.js");

function read(file: string): string {
  expect(fs.existsSync(file)).toBe(true);
  return fs.readFileSync(file, "utf8");
}

function parseTransitionMap(name: string): Record<string, string[]> {
  const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(
    read(SERVICE),
  );
  expect(block).not.toBeNull();
  const map: Record<string, string[]> = {};
  for (const line of block![1].split("\n")) {
    const entry = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*\[([^\]]*)\]/.exec(line);
    if (!entry) continue;
    map[entry[1]] = [...entry[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  expect(Object.keys(map).length).toBeGreaterThan(0);
  return map;
}

function parseStringSet(name: string): string[] {
  const source = read(SERVICE);
  const block = new RegExp(
    `const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`,
  ).exec(source);
  expect(block).not.toBeNull();
  const values = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(values.length).toBeGreaterThan(0);
  return values;
}

describe("CSSD issue transition contract", () => {
  it("mirrors ISSUE_TRANSITIONS in cssdService.js exactly", () => {
    const backend = parseTransitionMap("ISSUE_TRANSITIONS");

    expect(Object.keys(CSSD_ISSUE_TRANSITIONS).sort()).toEqual(
      Object.keys(backend).sort(),
    );
    for (const [status, targets] of Object.entries(backend)) {
      expect([...CSSD_ISSUE_TRANSITIONS[status]].sort()).toEqual(
        [...targets].sort(),
      );
    }
  });

  it("has a route behind every transition it offers, and offers every route it has", () => {
    const reachable = new Set(
      Object.values(CSSD_ISSUE_TRANSITIONS).flatMap((targets) => [...targets]),
    );
    // Every target a status can move to must have an action to run…
    for (const target of reachable) {
      expect(Object.keys(CSSD_ISSUE_TRANSITION_ACTIONS)).toContain(target);
    }
    // …and no action may exist for a target no status can ever reach.
    for (const target of Object.keys(CSSD_ISSUE_TRANSITION_ACTIONS)) {
      expect([...reachable]).toContain(target);
    }
  });

  it("maps each transition to a route cssdRoutes.js actually mounts", () => {
    const routes = read(ROUTES);
    // transitionIssue() is reached through these four POSTs only.
    const mounted = [
      ...routes.matchAll(/router\.post\('\/issues\/:id\/([a-z-]+)'/g),
    ].map((m) => m[1]);
    expect(mounted.sort()).toEqual(
      ["cancel", "decontaminate", "return", "theatre-use"].sort(),
    );
    // One console action per mounted transition route.
    expect(Object.keys(CSSD_ISSUE_TRANSITION_ACTIONS).length).toBe(
      mounted.length,
    );
  });

  it("returns nothing for a closed or unknown status", () => {
    expect(cssdIssueTransitions("awaiting_sterilization")).toEqual([]);
    expect(cssdIssueTransitions("sterilized")).toEqual([]);
    expect(cssdIssueTransitions("cancelled")).toEqual([]);
    expect(cssdIssueTransitions("nonsense")).toEqual([]);
    expect(cssdIssueTransitions(undefined)).toEqual([]);
  });
});

describe("CSSD vocabulary mirrors", () => {
  it.each([
    ["SET_STATUSES", CSSD_SET_STATUSES],
    ["LOAD_STATUSES", CSSD_LOAD_STATUSES],
    ["LOAD_CYCLE_TYPES", CSSD_CYCLE_TYPES],
    ["INDICATOR_RESULTS", CSSD_INDICATOR_RESULTS],
    ["RETURN_CONDITIONS", CSSD_RETURN_CONDITIONS],
  ])("mirrors %s from cssdService.js", (name, mirror) => {
    expect([...mirror].sort()).toEqual(parseStringSet(name as string).sort());
  });
});
