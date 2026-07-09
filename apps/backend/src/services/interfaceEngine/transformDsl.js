import { isDeepStrictEqual } from 'node:util';

import { parseHL7, decodeHL7Escapes } from '../hl7/hl7Parser.js';
import { AppError } from '../../utils/AppError.js';

const FORBIDDEN_KEYS = new Set([
  'eval',
  'Function',
  'function',
  'constructor',
  'prototype',
  '__proto__',
  'import',
  'require',
  'process',
  'env',
  'fs',
  'net',
  'http',
  'https',
  'child_process',
  'exec',
  'spawn',
  'setTimeout',
  'setInterval',
  'random',
  'Date.now',
]);

const MAX_DSL_DEPTH = 24;
const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_MAX_OPERATIONS = 1500;

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`, 'INTEROP_TRANSFORM_DSL_INVALID');
  }
}

function assertNoForbidden(value, path = 'dsl', depth = 0) {
  if (depth > MAX_DSL_DEPTH) {
    throw AppError.badRequest('Transform DSL is too deeply nested', 'INTEROP_TRANSFORM_DSL_TOO_DEEP');
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbidden(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw AppError.badRequest(`Transform DSL key is forbidden: ${path}.${key}`, 'INTEROP_TRANSFORM_FORBIDDEN_OPERATION');
    }
    if (typeof child === 'string' && FORBIDDEN_KEYS.has(child)) {
      throw AppError.badRequest(`Transform DSL value is forbidden: ${path}.${key}`, 'INTEROP_TRANSFORM_FORBIDDEN_OPERATION');
    }
    assertNoForbidden(child, `${path}.${key}`, depth + 1);
  }
}

function parsePayload(protocol, payload) {
  if (protocol === 'hl7v2') {
    const parsed = parseHL7(String(payload || ''));
    return { parsed, messageType: parsed.msh?.messageType || null };
  }
  if (protocol === 'json') {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return { parsed, messageType: null };
  }
  return { parsed: { raw: String(payload || '') }, messageType: null };
}

function hl7Segment(parsed, segment) {
  const key = String(segment || '').toUpperCase();
  if (key === 'MSH') return parsed.msh || null;
  if (key === 'PID') return parsed.pid || null;
  if (key === 'PV1') return parsed.pv1 || null;
  if (key === 'OBR') return parsed.obr || null;
  if (key === 'OBX') return parsed.obx || [];
  return null;
}

function selectHl7Field(parsed, path) {
  const [segmentRaw, fieldRaw] = String(path || '').split('.');
  const segment = String(segmentRaw || '').toUpperCase();
  const field = String(fieldRaw || '');
  const value = hl7Segment(parsed, segment);
  const firstValue = Array.isArray(value) ? value[0] : value;
  if (!firstValue) return null;

  const known = {
    'MSH.3': 'sendingApp',
    'MSH.4': 'sendingFacility',
    'MSH.5': 'receivingApp',
    'MSH.6': 'receivingFacility',
    'MSH.7': 'dateTime',
    'MSH.9': 'messageType',
    'MSH.10': 'messageControlId',
    'PID.3': 'patientId',
    'PID.5': 'name',
    'PID.7': 'birthDate',
    'PID.8': 'gender',
    'PID.11': 'address',
    'PID.13': 'phone',
    'PV1.2': 'patientClass',
    'PV1.3': 'assignedLocation',
    'PV1.7': 'attendingDoctor',
    'PV1.44': 'admitDate',
    'PV1.45': 'dischargeDate',
    'OBR.2': 'placerOrderNumber',
    'OBR.3': 'fillerOrderNumber',
    'OBR.4': 'testCode',
    'OBR.7': 'orderDateTime',
    'OBR.25': 'resultStatus',
    'OBX.2': 'valueType',
    'OBX.3': 'observationId',
    'OBX.5': 'value',
    'OBX.6': 'units',
    'OBX.7': 'referenceRange',
    'OBX.8': 'abnormalFlag',
    'OBX.11': 'resultStatus',
  };
  const property = known[`${segment}.${field}`];
  if (property) return firstValue[property] ?? null;

  const numericIndex = Number.parseInt(field, 10);
  if (Number.isInteger(numericIndex) && firstValue.fields) {
    return firstValue.fields[numericIndex] ?? null;
  }
  return null;
}

function selectJsonPath(value, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => {
      if (acc == null) return null;
      if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[Number.parseInt(key, 10)] ?? null;
      return Object.prototype.hasOwnProperty.call(Object(acc), key) ? acc[key] : null;
    }, value);
}

function normalizeValue(kind, value) {
  if (value == null) return null;
  switch (kind) {
    case 'trim':
      return String(value).trim();
    case 'uppercase':
      return String(value).trim().toUpperCase();
    case 'lowercase':
      return String(value).trim().toLowerCase();
    case 'phone':
      return String(value).replace(/[^\d+]/g, '');
    case 'number': {
      const parsed = Number(String(value).trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'datetime': {
      const text = String(value).trim();
      if (/^\d{8,14}$/.test(text)) {
        const year = text.slice(0, 4);
        const month = text.slice(4, 6);
        const day = text.slice(6, 8);
        const hour = text.slice(8, 10) || '00';
        const minute = text.slice(10, 12) || '00';
        const second = text.slice(12, 14) || '00';
        return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
      }
      const date = new Date(text);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    case 'hl7_escape_decode':
      return decodeHL7Escapes(String(value));
    default:
      throw AppError.badRequest(`Unsupported normalize operation: ${kind}`, 'INTEROP_TRANSFORM_NORMALIZE_INVALID');
  }
}

function makeRuntime({ protocol, parsed, timeoutMs, maxOperations }) {
  const startedAt = Date.now();
  let operations = 0;
  return {
    select(path) {
      if (protocol === 'hl7v2') return selectHl7Field(parsed, path);
      return selectJsonPath(parsed, path);
    },
    tick() {
      operations += 1;
      if (operations > maxOperations || Date.now() - startedAt > timeoutMs) {
        throw AppError.badRequest('Transform DSL timed out', 'INTEROP_TRANSFORM_TIMEOUT');
      }
    },
    operations() {
      return operations;
    },
  };
}

function evaluatePredicate(predicate, runtime, context) {
  if (!predicate || typeof predicate !== 'object') return false;
  const value = predicate.path ? selectJsonPath(context.output, predicate.path) : evaluateExpression(predicate.value, runtime, context);
  if (predicate.present === true) return value !== null && value !== undefined && value !== '';
  if (predicate.equals !== undefined) return String(value ?? '') === String(predicate.equals);
  if (predicate.regex) return new RegExp(String(predicate.regex).slice(0, 120)).test(String(value ?? ''));
  if (predicate.messageType) return String(context.messageType || '') === String(predicate.messageType);
  return false;
}

function evaluateExpression(expr, runtime, context) {
  runtime.tick();
  if (expr == null || typeof expr !== 'object' || Array.isArray(expr)) return expr;
  if (Object.prototype.hasOwnProperty.call(expr, 'constant')) return expr.constant;
  if (expr.select) return runtime.select(expr.select);
  if (expr.coalesce) {
    for (const candidate of expr.coalesce) {
      const value = evaluateExpression(candidate, runtime, context);
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  }
  if (expr.concat) {
    const separator = expr.separator == null ? '' : String(expr.separator);
    return expr.concat
      .map((candidate) => evaluateExpression(candidate, runtime, context))
      .filter((value) => value !== null && value !== undefined && value !== '')
      .join(separator);
  }
  if (expr.normalize) {
    return normalizeValue(expr.normalize, evaluateExpression(expr.from, runtime, context));
  }
  if (expr.map) {
    const source = evaluateExpression(expr.from, runtime, context);
    const values = expr.values && typeof expr.values === 'object' ? expr.values : {};
    if (Object.prototype.hasOwnProperty.call(values, String(source))) return values[String(source)];
    if (expr.missing === 'null') return null;
    if (Object.prototype.hasOwnProperty.call(expr, 'default')) return expr.default;
    return source;
  }
  if (expr.condition) {
    return evaluatePredicate(expr.condition.if, runtime, context)
      ? evaluateExpression(expr.condition.then, runtime, context)
      : evaluateExpression(expr.condition.else, runtime, context);
  }
  throw AppError.badRequest('Unsupported transform expression', 'INTEROP_TRANSFORM_EXPR_INVALID');
}

function validateOutput(output, rules = []) {
  const findings = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const path = String(rule.path || '');
    const value = selectJsonPath(output, path);
    if (rule.required && (value === null || value === undefined || value === '')) {
      findings.push({ severity: 'error', path, message: `${path} is required` });
      continue;
    }
    if (value == null || value === '') continue;
    if (rule.type === 'datetime' && Number.isNaN(new Date(value).getTime())) {
      findings.push({ severity: 'error', path, message: `${path} must be a datetime` });
    }
    if (rule.type === 'number' && !Number.isFinite(Number(value))) {
      findings.push({ severity: 'error', path, message: `${path} must be numeric` });
    }
    if (rule.enum && !rule.enum.includes(value)) {
      findings.push({ severity: 'error', path, message: `${path} is not an allowed value` });
    }
    if (rule.regex && !new RegExp(String(rule.regex).slice(0, 120)).test(String(value))) {
      findings.push({ severity: 'error', path, message: `${path} does not match the required format` });
    }
    if (rule.maxLength && String(value).length > Number(rule.maxLength)) {
      findings.push({ severity: 'error', path, message: `${path} is too long` });
    }
  }
  return findings;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function validateTransformDsl(dsl = {}) {
  assertObject(dsl, 'transform_dsl');
  assertNoForbidden(dsl);
  if (dsl.kind && !/^[a-z0-9_.-]+$/i.test(String(dsl.kind))) {
    throw AppError.badRequest('transform_dsl.kind contains unsupported characters', 'INTEROP_TRANSFORM_DSL_INVALID');
  }
  if (dsl.output !== undefined) assertObject(dsl.output, 'transform_dsl.output');
  if (dsl.validate !== undefined && !Array.isArray(dsl.validate)) {
    throw AppError.badRequest('transform_dsl.validate must be an array', 'INTEROP_TRANSFORM_DSL_INVALID');
  }
  return true;
}

export function runTransformDsl({
  protocol,
  payload,
  dsl = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputSizeLimit = DEFAULT_OUTPUT_LIMIT,
  maxOperations = DEFAULT_MAX_OPERATIONS,
} = {}) {
  validateTransformDsl(dsl);
  const { parsed, messageType } = parsePayload(protocol, payload);
  const runtime = makeRuntime({ protocol, parsed, timeoutMs, maxOperations });
  const context = { output: {}, messageType };
  const output = {};
  for (const [key, expr] of Object.entries(dsl.output || {})) {
    output[key] = evaluateExpression(expr, runtime, { ...context, output });
  }
  const findings = validateOutput(output, dsl.validate);
  const serialized = JSON.stringify(output);
  if (serialized.length > outputSizeLimit) {
    throw AppError.badRequest('Transform DSL output is too large', 'INTEROP_TRANSFORM_OUTPUT_TOO_LARGE');
  }
  return {
    output,
    findings,
    emit: dsl.emit || null,
    messageType,
    operationCount: runtime.operations(),
  };
}

export function transformMatchesExpected(actual, expected = {}) {
  if (!expected || Object.keys(expected).length === 0) return true;
  return isDeepStrictEqual(JSON.parse(stableJson(actual || {})), JSON.parse(stableJson(expected)));
}

export default {
  runTransformDsl,
  transformMatchesExpected,
  validateTransformDsl,
};
