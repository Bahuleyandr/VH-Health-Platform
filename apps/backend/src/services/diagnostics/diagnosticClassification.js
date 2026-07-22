import { createHash } from 'node:crypto';

const NORMAL_FLAGS = new Set(['N']);
const ABNORMAL_FLAGS = new Set(['L', 'H', 'A']);
const CRITICAL_FLAGS = new Set(['LL', 'HH', 'AA']);
const SUPPORTED_FLAGS = new Set([...NORMAL_FLAGS, ...ABNORMAL_FLAGS, ...CRITICAL_FLAGS]);
const SIGNED_STATUSES = new Set(['final', 'corrected', 'verified', 'amended']);

export function stableClinicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableClinicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableClinicalJson(value[key])}`
  )).join(',')}}`;
}

export function sha256ClinicalJson(value) {
  return createHash('sha256').update(stableClinicalJson(value), 'utf8').digest('hex');
}

export function classifySignedLabItem(row = {}) {
  const status = String(row.status || '').trim().toLowerCase();
  if (!row.signed_off_at || !SIGNED_STATUSES.has(status)) return 'indeterminate';
  const flag = row.abnormal_flag == null
    ? null
    : String(row.abnormal_flag).trim().toUpperCase();
  if (row.is_critical === true || CRITICAL_FLAGS.has(flag)) return 'critical';
  if (!flag || !SUPPORTED_FLAGS.has(flag)) return 'indeterminate';
  if (ABNORMAL_FLAGS.has(flag)) return 'abnormal';
  return NORMAL_FLAGS.has(flag) ? 'normal' : 'indeterminate';
}

export function classifySignedLabEpisode(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'indeterminate';
  const classifications = rows.map(classifySignedLabItem);
  if (classifications.includes('critical')) return 'critical';
  if (classifications.includes('abnormal')) return 'abnormal';
  return classifications.every((value) => value === 'normal') ? 'normal' : 'indeterminate';
}

export function aggregateItemHashes(itemHashes) {
  return createHash('sha256').update(itemHashes.join(':'), 'utf8').digest('hex');
}

export default {
  stableClinicalJson,
  sha256ClinicalJson,
  classifySignedLabItem,
  classifySignedLabEpisode,
  aggregateItemHashes,
};
