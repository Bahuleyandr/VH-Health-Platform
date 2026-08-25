// Re-audit lane L: the linen console offers one button per legal cycle
// transition. The list lives in the admin bundle, but the authority is
// CYCLE_TRANSITIONS in the backend service — ensureTransition() throws
// AppError.invalidTransition for anything outside it. An unpinned mirror is the
// exact shape this train has shipped twice: a control wired to a path that can
// only ever answer 409, or a legal transition with no control at all.
//
// So this reads the backend source rather than trusting a comment.

import fs from "fs";
import path from "path";

import {
  LINEN_CYCLE_TRANSITIONS,
  LINEN_ITEM_CATEGORIES,
  linenCycleTransitions,
} from "@/lib/api/linenLaundry";

const SERVICE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "backend",
  "src",
  "services",
  "linen",
  "linenLaundryService.js",
);

function serviceSource(): string {
  expect(fs.existsSync(SERVICE)).toBe(true);
  return fs.readFileSync(SERVICE, "utf8");
}

/** Parse `const <name> = { key: ['a', 'b'], … };` out of the service. */
function parseTransitionMap(name: string): Record<string, string[]> {
  const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(
    serviceSource(),
  );
  expect(block).not.toBeNull();
  const map: Record<string, string[]> = {};
  for (const line of block![1].split("\n")) {
    const entry = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*\[([^\]]*)\]/.exec(line);
    if (!entry) continue;
    map[entry[1]] = [...entry[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  // A regex that silently matched nothing would make every assertion vacuous.
  expect(Object.keys(map).length).toBeGreaterThan(0);
  return map;
}

/** Parse `const <name> = new Set([ 'a', 'b' ]);` out of the service. */
function parseStringSet(name: string): string[] {
  const block = new RegExp(
    `const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`,
  ).exec(serviceSource());
  expect(block).not.toBeNull();
  const values = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(values.length).toBeGreaterThan(0);
  return values;
}

describe("linen cycle transition contract", () => {
  it("mirrors CYCLE_TRANSITIONS in linenLaundryService.js exactly", () => {
    const backend = parseTransitionMap("CYCLE_TRANSITIONS");

    expect(Object.keys(LINEN_CYCLE_TRANSITIONS).sort()).toEqual(
      Object.keys(backend).sort(),
    );
    for (const [status, targets] of Object.entries(backend)) {
      expect([...LINEN_CYCLE_TRANSITIONS[status]].sort()).toEqual(
        [...targets].sort(),
      );
    }
  });

  it("offers no transition the service would reject", () => {
    const backend = parseTransitionMap("CYCLE_TRANSITIONS");
    for (const [status, targets] of Object.entries(LINEN_CYCLE_TRANSITIONS)) {
      for (const target of targets) {
        expect(backend[status]).toContain(target);
      }
    }
  });

  it("returns nothing for a closed or unknown status", () => {
    expect(linenCycleTransitions("reconciled")).toEqual([]);
    expect(linenCycleTransitions("cancelled")).toEqual([]);
    expect(linenCycleTransitions("nonsense")).toEqual([]);
    expect(linenCycleTransitions(undefined)).toEqual([]);
  });

  it("matches the service on the status the board is allowed to act from", () => {
    // The board renders a button per entry here; these three are the ones an
    // operator actually walks, so pin them against the parsed source too.
    const backend = parseTransitionMap("CYCLE_TRANSITIONS");
    expect(backend.collection_requested).toContain("collected");
    expect(backend.collected).toContain("in_laundry");
    expect(backend.in_laundry).toContain("returned");
    expect(backend.returned).toContain("reconciled");
  });

  it("mirrors ITEM_CATEGORIES — a category outside it is a 400", () => {
    expect([...LINEN_ITEM_CATEGORIES].sort()).toEqual(
      parseStringSet("ITEM_CATEGORIES").sort(),
    );
  });
});
