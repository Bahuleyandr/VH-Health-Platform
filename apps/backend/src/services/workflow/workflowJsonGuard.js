const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const WORKFLOW_JSON_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 4096,
  maxBytes: 65536,
});

function defaultViolation({ message }) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertWorkflowJsonBudget(value, {
  label = 'value',
  maxDepth = WORKFLOW_JSON_LIMITS.maxDepth,
  maxNodes = WORKFLOW_JSON_LIMITS.maxNodes,
  maxBytes = WORKFLOW_JSON_LIMITS.maxBytes,
  allowUndefined = false,
  allowBigInt = false,
  allowDate = false,
  onViolation = defaultViolation,
} = {}) {
  const fail = (kind, path, message) => onViolation(Object.freeze({ kind, path, message }));
  const active = new WeakSet();
  const stack = [{ type: 'visit', value, path: label, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame.type === 'exit') {
      active.delete(frame.value);
      continue;
    }

    nodes += 1;
    if (nodes > maxNodes) {
      fail('nodes', frame.path, `${label} exceeds the ${maxNodes}-node JSON limit`);
    }
    if (frame.depth > maxDepth) {
      fail('depth', frame.path, `${label} exceeds the ${maxDepth}-level JSON depth limit`);
    }

    const item = frame.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('type', frame.path, `${frame.path} must be a finite number`);
      continue;
    }
    if (typeof item === 'undefined' && allowUndefined) continue;
    if (typeof item === 'bigint' && allowBigInt) continue;
    if (item instanceof Date && allowDate) {
      if (Number.isNaN(item.getTime())) fail('type', frame.path, `${frame.path} must be a valid date`);
      continue;
    }
    if (typeof item !== 'object') {
      fail('type', frame.path, `${frame.path} must contain only JSON data`);
    }
    if (active.has(item)) {
      fail('circular', frame.path, `${label} must not contain circular references`);
    }

    if (Array.isArray(item)) {
      if (item.length > maxNodes) {
        fail('nodes', frame.path, `${label} exceeds the ${maxNodes}-node JSON limit`);
      }
      for (const key of Reflect.ownKeys(item)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
          fail('property', frame.path, `${frame.path} contains an unsupported array property`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
          fail('property', `${frame.path}[${key}]`, `${frame.path}[${key}] must be an enumerable data property`);
        }
      }
      active.add(item);
      stack.push({ type: 'exit', value: item });
      for (let index = item.length - 1; index >= 0; index -= 1) {
        if (!Object.prototype.hasOwnProperty.call(item, index)) {
          fail('property', `${frame.path}[${index}]`, `${frame.path} must not be a sparse array`);
        }
        stack.push({
          type: 'visit',
          value: item[index],
          path: `${frame.path}[${index}]`,
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    if (!isPlainObject(item)) {
      fail('type', frame.path, `${frame.path} must be a plain JSON object`);
    }
    const entries = [];
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) {
        fail('unsafe_key', frame.path, `${frame.path} contains an unsafe key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
        fail('property', `${frame.path}.${key}`, `${frame.path}.${key} must be an enumerable data property`);
      }
      entries.push([key, descriptor.value]);
    }
    active.add(item);
    stack.push({ type: 'exit', value: item });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entryValue] = entries[index];
      stack.push({
        type: 'visit',
        value: entryValue,
        path: `${frame.path}.${key}`,
        depth: frame.depth + 1,
      });
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(value, (_key, item) => (
      typeof item === 'bigint' ? item.toString() : item
    ));
  } catch {
    fail('type', label, `${label} must contain only serializable JSON data`);
  }
  const bytes = Buffer.byteLength(serialized ?? 'null', 'utf8');
  if (bytes > maxBytes) {
    fail('bytes', label, `${label} exceeds the ${maxBytes}-byte serialized JSON limit`);
  }

  return Object.freeze({ nodes, bytes, maxDepth, maxNodes, maxBytes });
}

export default assertWorkflowJsonBudget;
