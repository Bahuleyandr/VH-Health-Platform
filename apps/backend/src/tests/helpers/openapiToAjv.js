// Convert an OpenAPI-3.0.3-flavoured schema (which uses `nullable: true`) into a
// plain JSON-Schema form ajv can compile + validate. ajv has no `nullable`
// keyword, so a raw `nullable` either errors ("nullable cannot be used without
// type") or is silently ignored (null then fails validation). We rewrite:
//   scalar  { type: X, nullable: true }     -> { type: [X, 'null'] }
//   ref/any { nullable: true, ...rest }      -> { anyOf: [ {...rest}, { type: 'null' } ] }
export function toAjv(node) {
  if (Array.isArray(node)) return node.map(toAjv);
  if (!node || typeof node !== 'object') return node;
  const mapped = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'nullable') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      mapped.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toAjv(pv)]));
    } else if (k === 'items') {
      mapped.items = toAjv(v);
    } else if ((k === 'allOf' || k === 'anyOf' || k === 'oneOf') && Array.isArray(v)) {
      mapped[k] = v.map(toAjv);
    } else {
      mapped[k] = v;
    }
  }
  if (node.nullable === true) {
    if (typeof mapped.type === 'string') return { ...mapped, type: [mapped.type, 'null'] };
    return { anyOf: [mapped, { type: 'null' }] };
  }
  return mapped;
}

/** Return a copy of the spec with every components.schemas entry made ajv-ready. */
export function ajvReadySpec(spec) {
  return {
    ...spec,
    components: {
      ...spec.components,
      schemas: Object.fromEntries(
        Object.entries(spec.components.schemas).map(([k, v]) => [k, toAjv(v)]),
      ),
    },
  };
}
