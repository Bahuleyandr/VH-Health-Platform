import {
  classifyAtom,
  columnBoundValue,
  explainColumnBoundValue,
  parseCheckDefinition,
  referencedColumns
} from '../../../scripts/lib/checkConstraintValues.mjs';

// Until 2026-09-03 the seeder's checkedValue() harvested the FIRST quoted literal
// of the first CHECK definition whose text merely contained the column name.
// Which definition came first was decided by the catalog (and, after
// dce625f48, by constraint name), so the same column seeded differently on
// databases with the same schema, and a neighbouring column's literal was
// returned whenever a multi-column CHECK sorted first. These tests pin the
// replacement: a literal belongs to a column only when the atom carrying it
// compares that column, literals that engage a side condition on another
// column are avoided, and the answer is a function of the SET of definitions.

// Real definitions from main (migration tip 762), verbatim from
// pg_get_constraintdef. Each set previously needed an override pin.
const BODY_CUSTODY_EVENTS = [
  "CHECK (((event_type)::text = ANY ((ARRAY['receive'::character varying, 'store'::character varying, 'release'::character varying])::text[])))",
  "CHECK (((release_method IS NULL) OR ((release_method)::text = ANY ((ARRAY['family'::character varying, 'mortuary_van'::character varying, 'unclaimed_to_municipality'::character varying])::text[]))))",
  "CHECK ((((event_type)::text <> 'release'::text) OR (release_method IS NOT NULL)))",
  "CHECK ((((event_type)::text <> 'store'::text) OR (slot_id IS NOT NULL)))"
];
const FACILITY_ASSET_EVENTS = [
  "CHECK ((((event_type)::text <> ALL ((ARRAY['status_changed'::character varying, 'repair_opened'::character varying, 'repair_closed'::character varying, 'condemned'::character varying, 'disposed'::character varying])::text[])) OR (to_status IS NOT NULL)))",
  "CHECK (((event_type)::text = ANY ((ARRAY['created'::character varying, 'updated'::character varying, 'moved'::character varying, 'custodian_assigned'::character varying, 'condition_changed'::character varying, 'status_changed'::character varying, 'repair_opened'::character varying, 'repair_closed'::character varying, 'maintenance'::character varying, 'condemned'::character varying, 'disposed'::character varying])::text[])))"
];
const PHARMACY_FUNDING_DECISION_EVENTS = [
  "CHECK (((source_authority_version > 0) AND (source_authority_sha256 ~ '^[0-9a-f]{64}$'::text) AND (command_key_sha256 ~ '^[0-9a-f]{64}$'::text) AND (amount >= (0)::numeric)))",
  "CHECK (((((event_type)::text = ANY ((ARRAY['FUNDING_RESOLVED'::character varying, 'AUTHORITY_INVALIDATED'::character varying])::text[])) AND (authority_generation IS NOT NULL) AND (authority_generation > 0) AND ((((event_type)::text = 'FUNDING_RESOLVED'::text) AND (authority_generation = 1) AND (supersedes_event_id IS NULL)) OR ((authority_generation > 1) AND (supersedes_event_id IS NOT NULL)))) OR (((event_type)::text <> ALL ((ARRAY['FUNDING_RESOLVED'::character varying, 'AUTHORITY_INVALIDATED'::character varying])::text[])) AND (authority_generation IS NULL) AND (supersedes_event_id IS NULL))))",
  "CHECK (((event_type)::text = ANY ((ARRAY['LINE_MATERIALIZED'::character varying, 'AUTHORITY_INVALIDATED'::character varying, 'TPA_DECISION_RECORDED'::character varying, 'PAYMENT_VERIFIED'::character varying, 'FUNDING_RESOLVED'::character varying])::text[])))"
];
// pharmacy_orders.status is constrained ONLY inside multi-column CHECKs
// (each `x OR status = ANY(...)`, all NOT VALID). There is no allowed set.
const PHARMACY_ORDERS = [
  "CHECK (((facility_id IS NOT NULL) OR ((status)::text = ANY ((ARRAY['CANCELLED'::character varying, 'DELIVERED'::character varying, 'DISPENSED'::character varying, 'UNAVAILABLE'::character varying])::text[])))) NOT VALID",
  "CHECK (((legacy_verification_grandfathered = false) OR ((status)::text = ANY ((ARRAY['CANCELLED'::character varying, 'DELIVERED'::character varying, 'DISPENSED'::character varying, 'UNAVAILABLE'::character varying])::text[])))) NOT VALID",
  "CHECK ((((clinical_verification_status)::text <> 'rejected'::text) OR ((status)::text = ANY ((ARRAY['ON_HOLD'::character varying, 'CANCELLED'::character varying, 'UNAVAILABLE'::character varying])::text[])))) NOT VALID"
];

// Deterministic shuffles so a failure reproduces.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, seed) {
  const random = mulberry32(seed);
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function everyOrder(definitions) {
  const orders = [definitions, [...definitions].reverse()];
  for (let seed = 1; seed <= 8; seed += 1) orders.push(shuffled(definitions, seed));
  return orders;
}
function answersInEveryOrder(definitions, column) {
  return new Set(everyOrder(definitions).map(order => columnBoundValue(order, column)));
}

describe('columnBoundValue: the three definition sets that used to need pins', () => {
  it.each([
    ['body_custody_events', BODY_CUSTODY_EVENTS, 'receive'],
    ['facility_asset_events', FACILITY_ASSET_EVENTS, 'created'],
    ['pharmacy_funding_decision_events', PHARMACY_FUNDING_DECISION_EVENTS, 'LINE_MATERIALIZED']
  ])(
    '%s.event_type resolves to the pinned value in every order',
    (_table, definitions, expected) => {
      expect(answersInEveryOrder(definitions, 'event_type')).toEqual(new Set([expected]));
    }
  );

  // The allowed list keeps the authored order (it decides the answer); the
  // trigger list is a set, reported in definition-text order.
  it('avoids every literal that would engage a side condition on another column', () => {
    const bodyCustody = explainColumnBoundValue(BODY_CUSTODY_EVENTS, 'event_type');
    expect(bodyCustody.value).toBe('receive');
    expect(bodyCustody.tier).toBe(1);
    expect(bodyCustody.allowed).toEqual(['receive', 'store', 'release']);
    expect(new Set(bodyCustody.triggers)).toEqual(new Set(['release', 'store']));
    expect(new Set(explainColumnBoundValue(FACILITY_ASSET_EVENTS, 'event_type').triggers)).toEqual(
      new Set(['status_changed', 'repair_opened', 'repair_closed', 'condemned', 'disposed'])
    );
    expect(
      new Set(explainColumnBoundValue(PHARMACY_FUNDING_DECISION_EVENTS, 'event_type').triggers)
    ).toEqual(new Set(['FUNDING_RESOLVED', 'AUTHORITY_INVALIDATED']));
  });
});

describe('columnBoundValue: column binding', () => {
  it('never returns a neighbouring conjunct literal', () => {
    const definitions = [
      "CHECK (((kind)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])) AND ((status)::text = ANY ((ARRAY['x'::character varying, 'y'::character varying])::text[])))"
    ];
    expect(columnBoundValue(definitions, 'status')).toBe('x');
    expect(columnBoundValue(definitions, 'kind')).toBe('a');
  });

  it('matches the column as a whole identifier, never as a substring', () => {
    const definitions = [
      "CHECK (((order_status)::text = ANY ((ARRAY['open'::character varying, 'closed'::character varying])::text[])))"
    ];
    expect(columnBoundValue(definitions, 'status')).toBeNull();
    expect(columnBoundValue(definitions, 'order_status')).toBe('open');
  });

  it('returns null when the column is constrained only inside multi-column conjuncts', () => {
    expect(answersInEveryOrder(PHARMACY_ORDERS, 'status')).toEqual(new Set([null]));
    const explained = explainColumnBoundValue(PHARMACY_ORDERS, 'status');
    expect(explained.value).toBeNull();
    expect(explained.tier).toBeNull();
    expect(explained.allowed).toEqual([]);
    expect(new Set(explained.triggers)).toEqual(
      new Set(['CANCELLED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE', 'ON_HOLD'])
    );
  });

  it('returns null when the only mention of the column is a negative trigger', () => {
    const definitions = [
      "CHECK ((((indent_type)::text <> 'pharmacy'::text) OR ((status)::text = ANY ((ARRAY['rejected'::character varying, 'cancelled'::character varying, 'closed'::character varying])::text[])) OR (facility_id IS NOT NULL))) NOT VALID"
    ];
    expect(columnBoundValue(definitions, 'indent_type')).toBeNull();
    expect(columnBoundValue(definitions, 'status')).toBeNull();
  });
});

describe('columnBoundValue: policy tiers', () => {
  const enumeration =
    "CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))";

  it('falls back to the enumeration when every allowed value is a trigger (tier 2)', () => {
    const definitions = [
      enumeration,
      "CHECK ((((status)::text <> 'a'::text) OR (x IS NOT NULL)))",
      "CHECK ((((status)::text <> 'b'::text) OR (y IS NOT NULL)))"
    ];
    expect(answersInEveryOrder(definitions, 'status')).toEqual(new Set(['a']));
    expect(explainColumnBoundValue(definitions, 'status').tier).toBe(2);
  });

  it('intersects two single-column enumerations of the same column, in every order', () => {
    const definitions = [
      "CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying, 'c'::character varying])::text[])))",
      "CHECK (((status)::text = ANY ((ARRAY['c'::character varying, 'b'::character varying])::text[])))"
    ];
    expect(answersInEveryOrder(definitions, 'status')).toEqual(new Set(['b']));
  });

  it('skips a trigger even when it heads the enumeration', () => {
    // Without the trigger exclusion the first listed value wins and the row
    // then fails the conditional CHECK it engages.
    const definitions = [
      "CHECK (((status)::text = ANY ((ARRAY['release'::character varying, 'receive'::character varying])::text[])))",
      "CHECK ((((status)::text <> 'release'::text) OR (release_method IS NOT NULL)))"
    ];
    expect(answersInEveryOrder(definitions, 'status')).toEqual(new Set(['receive']));
    expect(explainColumnBoundValue(definitions, 'status').tier).toBe(1);
  });

  it('keeps the authored list order, so the first allowed value is the initial state', () => {
    expect(columnBoundValue([enumeration], 'status')).toBe('a');
  });
});

describe('columnBoundValue: atom shapes from pg_get_constraintdef', () => {
  it('reads a single equality, with and without casts', () => {
    expect(columnBoundValue(["CHECK ((realm = 'staff'::text))"], 'realm')).toBe('staff');
    expect(columnBoundValue(["CHECK (((realm)::text = 'staff'::text))"], 'realm')).toBe('staff');
  });

  it('reads an OR of equalities inside a single-column conjunct as one enumeration', () => {
    const definitions = [
      "CHECK ((((mode)::text = 'CASH'::text) OR ((mode)::text = 'CARD'::text)))"
    ];
    expect(columnBoundValue(definitions, 'mode')).toBe('CASH');
  });

  it('binds a literal compared through a function of the column', () => {
    expect(columnBoundValue(["CHECK ((upper((code)::text) = 'ABC'::text))"], 'code')).toBe('ABC');
  });

  it('unescapes doubled quotes inside a literal', () => {
    expect(columnBoundValue(["CHECK ((label = 'it''s'::text))"], 'label')).toBe("it's");
  });

  it('takes nothing from a format constraint', () => {
    expect(
      columnBoundValue(["CHECK (((digest)::text ~ '^[0-9a-f]{64}$'::text))"], 'digest')
    ).toBeNull();
    expect(columnBoundValue(["CHECK (((path)::text ~~ '/%'::text))"], 'path')).toBeNull();
    expect(columnBoundValue(["CHECK ((path ~~* '/%'::text))"], 'path')).toBeNull();
  });

  it('ignores a trailing NOT VALID and a NO INHERIT clause', () => {
    expect(columnBoundValue(["CHECK ((status = 'open'::text)) NOT VALID"], 'status')).toBe('open');
    expect(columnBoundValue(["CHECK ((status = 'open'::text)) NO INHERIT"], 'status')).toBe('open');
  });

  it('treats a CASE expression as one opaque atom that still references its columns', () => {
    const definitions = [
      "CHECK (CASE WHEN ((kind)::text = 'a'::text) THEN (x IS NOT NULL) ELSE true END)"
    ];
    expect(columnBoundValue(definitions, 'kind')).toBeNull();
    expect([...referencedColumns(parseCheckDefinition(definitions[0]))].sort()).toEqual([
      'kind',
      'x'
    ]);
  });

  it('rejects text that is not a CHECK definition', () => {
    expect(() => parseCheckDefinition('FOREIGN KEY (a) REFERENCES b(id)')).toThrow(
      /not a CHECK definition/
    );
  });
});

describe('classifyAtom', () => {
  const atomsOf = definition => {
    const found = [];
    const walk = node => {
      if (node.kind === 'atom') found.push(node);
      else if (node.kind === 'not') walk(node.child);
      else node.children.forEach(walk);
    };
    walk(parseCheckDefinition(definition));
    return found.map(classifyAtom);
  };

  it('classifies the shapes that bind a literal to a column', () => {
    expect(
      atomsOf("CHECK ((((event_type)::text <> 'release'::text) OR (release_method IS NOT NULL)))")
    ).toEqual([
      { column: 'event_type', polarity: 'negative', literals: ['release'] },
      { column: 'release_method', polarity: 'null', literals: [] }
    ]);
    expect(
      atomsOf(
        "CHECK (((event_type)::text <> ALL ((ARRAY['x'::character varying, 'y'::character varying])::text[])))"
      )
    ).toEqual([{ column: 'event_type', polarity: 'negative', literals: ['x', 'y'] }]);
    expect(atomsOf('CHECK ((length((code)::text) <= 12))')).toEqual([
      { column: 'code', polarity: 'opaque', literals: [] }
    ]);
    expect(atomsOf("CHECK ((metadata ? 'acceptance_snapshot'::text))")).toEqual([
      { column: 'metadata', polarity: 'opaque', literals: [] }
    ]);
  });
});
