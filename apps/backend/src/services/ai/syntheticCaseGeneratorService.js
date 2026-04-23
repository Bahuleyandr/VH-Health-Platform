/**
 * Synthetic Clinical Case Generator.
 *
 * Deterministic de-identified synthetic-case generator for AI eval, canary
 * suites, regression tests, demos, and edge-case exploration. Given a
 * pathway, complexity tier, persona template, and PRNG seed, produces
 * demographics, chief complaint, vitals, labs, a timeline of events, and
 * edge-flag annotations. Review-only — cases require eval-lead approval
 * before entering a canary set or training corpus, and the module never
 * touches real patient data. All narratives are prefixed `[synthetic]` so
 * reviewers can immediately tell the content is simulated.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'synthetic_case_generator';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support the synthetic-case generator. Rules authoritative. Synthetic-only. Never real patient data. Return JSON only.',
  user_prompt_template: 'Write a short [synthetic] narrative summary. Do not override rule-generated fields. No identifiers.',
};

export const PATHWAYS = new Set([
  'sepsis',
  'stroke',
  'chest_pain_acs',
  'pneumonia',
  'asthma_exacerbation',
  'diabetic_ketoacidosis',
  'postpartum_hemorrhage',
  'trauma_blunt',
  'pediatric_fever',
  'geriatric_fall',
  'mental_health_crisis',
  'unknown',
]);

export const COMPLEXITIES = new Set(['simple', 'standard', 'complex', 'edge', 'unknown']);
export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const ETHNICITY_CODES = ['south_asian', 'east_asian', 'african', 'european', 'mixed'];
const GENDER_CODES = ['female', 'male', 'other'];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Deterministic 32-bit unsigned int derived from a SHA-256 prefix of the
 * seed string. Empty / nullish seeds use the literal 'default'.
 */
export function hashSeed(seed) {
  const normalized = String(seed || '') === '' ? 'default' : String(seed);
  const digest = crypto.createHash('sha256').update(normalized).digest();
  // First four bytes → 32-bit unsigned int.
  return digest.readUInt32BE(0);
}

/**
 * mulberry32 PRNG — tiny, deterministic, well-behaved for synthetic-data
 * generation. Returns a closure bundle. All outputs are deterministic
 * from the supplied seed.
 */
export function createPrng(seed) {
  let state = hashSeed(seed) >>> 0;
  const nextFloat = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nextInt = (min, max) => {
    const lo = Math.ceil(Number(min));
    const hi = Math.floor(Number(max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return lo;
    return lo + Math.floor(nextFloat() * (hi - lo + 1));
  };
  const pick = (arr) => {
    const list = asArray(arr);
    if (!list.length) return null;
    return list[nextInt(0, list.length - 1)];
  };
  const bool = (prob = 0.5) => nextFloat() < Number(prob);
  return { nextFloat, nextInt, pick, bool };
}

function ageForPathway(prng, pathway, complexity) {
  if (pathway === 'pediatric_fever') return prng.nextInt(1, 12);
  if (pathway === 'geriatric_fall') return prng.nextInt(70, 95);
  if (pathway === 'postpartum_hemorrhage') return prng.nextInt(18, 40);
  // Weighted 18-85 for everyone else.
  const band = prng.nextFloat();
  if (band < 0.25) return prng.nextInt(18, 35);
  if (band < 0.7) return prng.nextInt(36, 65);
  return prng.nextInt(66, 85);
}

function comorbidityPool() {
  return [
    'HTN', 'DM2', 'CAD', 'COPD', 'CKD3', 'CHF', 'OBESITY', 'DYSLIPID',
    'OSA', 'GERD', 'DEPRESSION', 'HYPOTHYROID', 'ASTHMA',
  ];
}

function allergyPool() {
  return ['penicillin', 'sulfa', 'nsaid', 'latex', 'peanut', 'shellfish', 'iodine'];
}

/**
 * Deterministic persona. Age distribution and gender are pathway-aware.
 * Complexity 'complex' injects 2-3 comorbidities; 'edge' injects an
 * outlier (extreme age, high BMI, or many allergies).
 */
export function generatePersona({ prng, complexity, pathway }) {
  const safePrng = prng || createPrng('default');
  let age = ageForPathway(safePrng, pathway, complexity);
  let gender;
  if (pathway === 'postpartum_hemorrhage') {
    gender = 'female';
  } else {
    gender = safePrng.pick(GENDER_CODES);
  }
  const ethnicity_code = safePrng.pick(ETHNICITY_CODES);
  let weight_kg = safePrng.nextInt(45, 110);
  let height_cm = safePrng.nextInt(150, 185);
  const comorbidity_codes = [];
  const pool = comorbidityPool();
  if (complexity === 'complex') {
    const count = safePrng.nextInt(2, 3);
    const seen = new Set();
    while (comorbidity_codes.length < count && seen.size < pool.length) {
      const c = safePrng.pick(pool);
      if (c && !seen.has(c)) {
        seen.add(c);
        comorbidity_codes.push(c);
      }
    }
  } else if (complexity === 'edge') {
    // Edge always has at least 3 comorbidities to seed MULTIPLE_COMORBIDITIES flag
    // alongside the outlier that gets injected below.
    const count = safePrng.nextInt(3, 4);
    const seen = new Set();
    while (comorbidity_codes.length < count && seen.size < pool.length) {
      const c = safePrng.pick(pool);
      if (c && !seen.has(c)) {
        seen.add(c);
        comorbidity_codes.push(c);
      }
    }
  } else if (complexity === 'standard' && safePrng.bool(0.3)) {
    const c = safePrng.pick(pool);
    if (c) comorbidity_codes.push(c);
  }
  const allergies = [];
  const aPool = allergyPool();
  const allergyCount = complexity === 'edge'
    ? safePrng.nextInt(4, 5)
    : complexity === 'complex'
      ? safePrng.nextInt(0, 2)
      : safePrng.bool(0.2) ? 1 : 0;
  const seenA = new Set();
  while (allergies.length < allergyCount && seenA.size < aPool.length) {
    const a = safePrng.pick(aPool);
    if (a && !seenA.has(a)) {
      seenA.add(a);
      allergies.push(a);
    }
  }
  if (complexity === 'edge') {
    // Inject outlier — extreme age, BMI, or allergies.
    const pick = safePrng.nextInt(0, 2);
    if (pick === 0) {
      // Extreme age: respect pathway-driven bands where possible.
      if (pathway === 'pediatric_fever') age = 0;
      else age = 96 + safePrng.nextInt(0, 5);
    } else if (pick === 1) {
      // High BMI — force BMI > 45. BMI = weight / (height/100)^2.
      // For height 170cm (1.70m), BMI 46 → weight ~ 133. Set weight high.
      weight_kg = 140 + safePrng.nextInt(0, 30);
      height_cm = 165 + safePrng.nextInt(0, 10);
    }
    // else: allergies already set to 4-5, satisfies MULTIPLE_ALLERGIES.
  }
  return {
    age_years: age,
    gender,
    ethnicity_code,
    weight_kg,
    height_cm,
    comorbidity_codes,
    allergies,
  };
}

function vitalCountForComplexity(complexity) {
  switch (complexity) {
    case 'simple': return 2;
    case 'standard': return 4;
    case 'complex': return 6;
    case 'edge': return 8;
    default: return 4;
  }
}

function baselineVitals(pathway, persona) {
  const ageIsPed = toNumber(persona?.age_years, 30) <= 12;
  // Defaults roughly normal adult.
  let hr = 80;
  let sbp = 120;
  let dbp = 75;
  let rr = 16;
  let spo2 = 98;
  let temp_c = 36.8;
  if (ageIsPed) {
    hr = 110;
    sbp = 100;
    dbp = 65;
    rr = 22;
  }
  switch (pathway) {
    case 'sepsis':
      hr = 115; sbp = 95; dbp = 55; rr = 22; spo2 = 94; temp_c = 38.8;
      break;
    case 'stroke':
      hr = 84; sbp = 158; dbp = 92; rr = 16; spo2 = 97; temp_c = 36.7;
      break;
    case 'chest_pain_acs':
      hr = 95; sbp = 140; dbp = 88; rr = 18; spo2 = 96; temp_c = 36.9;
      break;
    case 'pneumonia':
      hr = 102; sbp = 118; dbp = 72; rr = 24; spo2 = 91; temp_c = 38.6;
      break;
    case 'asthma_exacerbation':
      hr = 110; sbp = 124; dbp = 78; rr = 28; spo2 = 92; temp_c = 37.0;
      break;
    case 'diabetic_ketoacidosis':
      hr = 108; sbp = 118; dbp = 72; rr = 28; spo2 = 97; temp_c = 37.1;
      break;
    case 'postpartum_hemorrhage':
      hr = 118; sbp = 100; dbp = 60; rr = 20; spo2 = 97; temp_c = 36.8;
      break;
    case 'trauma_blunt':
      hr = 110; sbp = 110; dbp = 68; rr = 22; spo2 = 95; temp_c = 36.6;
      break;
    case 'pediatric_fever':
      hr = 140; sbp = 100; dbp = 65; rr = 28; spo2 = 97; temp_c = 39.3;
      break;
    case 'geriatric_fall':
      hr = 84; sbp = 132; dbp = 78; rr = 18; spo2 = 96; temp_c = 36.7;
      break;
    case 'mental_health_crisis':
      hr = 100; sbp = 135; dbp = 82; rr = 20; spo2 = 98; temp_c = 36.9;
      break;
    default:
      break;
  }
  return { hr, sbp, dbp, rr, spo2, temp_c };
}

function clampVital(key, value) {
  const rounders = {
    hr: [30, 220], sbp: [50, 230], dbp: [30, 140], rr: [6, 60], spo2: [50, 100], temp_c: [33, 42],
  };
  const [lo, hi] = rounders[key] || [0, 1000];
  const v = toNumber(value, lo);
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Ordered vitals snapshots. Count driven by complexity; first snapshot is
 * the baseline for the pathway, later snapshots drift per prng. Edge
 * complexity always injects at least one critical outlier.
 */
export function generateVitals({ prng, pathway, complexity, persona }) {
  const safePrng = prng || createPrng('default');
  const count = vitalCountForComplexity(complexity);
  const base = baselineVitals(pathway, persona || {});
  const snapshots = [];
  for (let i = 0; i < count; i += 1) {
    const t_offset_minutes = i * 20 + safePrng.nextInt(0, 5);
    // Small drift per snapshot.
    let hr = base.hr + safePrng.nextInt(-6, 8);
    let sbp = base.sbp + safePrng.nextInt(-8, 8);
    let dbp = base.dbp + safePrng.nextInt(-5, 5);
    let rr = base.rr + safePrng.nextInt(-2, 3);
    let spo2 = base.spo2 + safePrng.nextInt(-2, 1);
    let temp_c = +(base.temp_c + (safePrng.nextInt(-3, 3) / 10)).toFixed(1);
    if (pathway === 'postpartum_hemorrhage') {
      // SBP trends downward across snapshots.
      sbp -= i * 4;
    }
    snapshots.push({
      t_offset_minutes,
      hr: clampVital('hr', hr),
      sbp: clampVital('sbp', sbp),
      dbp: clampVital('dbp', dbp),
      rr: clampVital('rr', rr),
      spo2: clampVital('spo2', spo2),
      temp_c: clampVital('temp_c', temp_c),
    });
  }
  if (complexity === 'edge' && snapshots.length > 0) {
    // Inject a critical outlier into a deterministic snapshot.
    const idx = safePrng.nextInt(0, snapshots.length - 1);
    const kind = safePrng.nextInt(0, 2);
    if (kind === 0) {
      snapshots[idx].spo2 = clampVital('spo2', 78 + safePrng.nextInt(0, 5));
    } else if (kind === 1) {
      snapshots[idx].sbp = clampVital('sbp', 60 + safePrng.nextInt(0, 15));
    } else {
      snapshots[idx].temp_c = clampVital('temp_c', 40.5 + (safePrng.nextInt(0, 10) / 10));
    }
  }
  return snapshots;
}

function labEntry(name, value, unit, reference_range, abnormalKey) {
  return {
    name,
    value,
    unit,
    reference_range,
    abnormal_flag: abnormalKey,
  };
}

function flagFor(value, ref) {
  // ref like '2.0-20.0' or '70-110'. Returns 'normal', 'high', 'low',
  // 'critical_high', 'critical_low' based on simple heuristics.
  const match = String(ref).match(/^(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)$/);
  if (!match) return 'normal';
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  const v = Number(value);
  if (!Number.isFinite(v)) return 'normal';
  if (v < lo) {
    if (v < lo * 0.6) return 'critical_low';
    return 'low';
  }
  if (v > hi) {
    if (v > hi * 1.6) return 'critical_high';
    return 'high';
  }
  return 'normal';
}

/**
 * Pathway-scoped lab panel. Values deterministic per prng. Complexity
 * shifts how abnormal values skew (edge → critical, complex → strongly
 * abnormal, simple → mild).
 */
export function generateLabs({ prng, pathway, persona, complexity }) {
  const safePrng = prng || createPrng('default');
  const labs = [];
  const severityMultiplier = complexity === 'edge' ? 2.0 : complexity === 'complex' ? 1.4 : 1.0;
  switch (pathway) {
    case 'sepsis': {
      const lactate = +(2.2 + safePrng.nextFloat() * 3 * severityMultiplier).toFixed(1);
      const wbc = +(12 + safePrng.nextFloat() * 10 * severityMultiplier).toFixed(1);
      const crp = +(40 + safePrng.nextFloat() * 160 * severityMultiplier).toFixed(1);
      const pct = +(0.5 + safePrng.nextFloat() * 8 * severityMultiplier).toFixed(2);
      labs.push(labEntry('lactate', lactate, 'mmol/L', '0.5-2.0', flagFor(lactate, '0.5-2.0')));
      labs.push(labEntry('wbc', wbc, '10^9/L', '4.0-11.0', flagFor(wbc, '4.0-11.0')));
      labs.push(labEntry('crp', crp, 'mg/L', '0.0-10.0', flagFor(crp, '0.0-10.0')));
      labs.push(labEntry('procalcitonin', pct, 'ng/mL', '0.0-0.5', flagFor(pct, '0.0-0.5')));
      break;
    }
    case 'stroke': {
      const glucose = +(100 + safePrng.nextFloat() * 80 * severityMultiplier).toFixed(1);
      const inr = +(1.0 + safePrng.nextFloat() * 0.8).toFixed(2);
      labs.push(labEntry('glucose', glucose, 'mg/dL', '70-110', flagFor(glucose, '70-110')));
      labs.push(labEntry('inr', inr, 'ratio', '0.9-1.2', flagFor(inr, '0.9-1.2')));
      break;
    }
    case 'chest_pain_acs': {
      const troponinHs = +(20 + safePrng.nextFloat() * 600 * severityMultiplier).toFixed(1);
      const ckMb = +(2 + safePrng.nextFloat() * 40 * severityMultiplier).toFixed(1);
      const dDimer = +(100 + safePrng.nextFloat() * 900).toFixed(0);
      labs.push(labEntry('troponin_hs', troponinHs, 'ng/L', '0-14', flagFor(troponinHs, '0-14')));
      labs.push(labEntry('ck_mb', ckMb, 'U/L', '0-5', flagFor(ckMb, '0-5')));
      labs.push(labEntry('d_dimer', dDimer, 'ng/mL', '0-500', flagFor(dDimer, '0-500')));
      break;
    }
    case 'pneumonia': {
      const wbc = +(11 + safePrng.nextFloat() * 10 * severityMultiplier).toFixed(1);
      const crp = +(30 + safePrng.nextFloat() * 150 * severityMultiplier).toFixed(1);
      labs.push(labEntry('wbc', wbc, '10^9/L', '4.0-11.0', flagFor(wbc, '4.0-11.0')));
      labs.push(labEntry('crp', crp, 'mg/L', '0.0-10.0', flagFor(crp, '0.0-10.0')));
      break;
    }
    case 'diabetic_ketoacidosis': {
      const glucose = +(300 + safePrng.nextFloat() * 400 * severityMultiplier).toFixed(1);
      const bicarb = +(15 - safePrng.nextFloat() * 10 * severityMultiplier).toFixed(1);
      const anionGap = +(16 + safePrng.nextFloat() * 12 * severityMultiplier).toFixed(1);
      const ph = +(7.25 - safePrng.nextFloat() * 0.2).toFixed(2);
      const ketones = +(3 + safePrng.nextFloat() * 4 * severityMultiplier).toFixed(1);
      labs.push(labEntry('glucose', glucose, 'mg/dL', '70-110', flagFor(glucose, '70-110')));
      labs.push(labEntry('bicarb', bicarb, 'mEq/L', '22-28', flagFor(bicarb, '22-28')));
      labs.push(labEntry('anion_gap', anionGap, 'mEq/L', '8-12', flagFor(anionGap, '8-12')));
      labs.push(labEntry('pH', ph, 'units', '7.35-7.45', flagFor(ph, '7.35-7.45')));
      labs.push(labEntry('ketones', ketones, 'mmol/L', '0.0-0.6', flagFor(ketones, '0.0-0.6')));
      break;
    }
    case 'postpartum_hemorrhage': {
      const hb = +(6 + safePrng.nextFloat() * 4).toFixed(1);
      const plt = +(90 + safePrng.nextFloat() * 80).toFixed(0);
      const fibrinogen = +(150 + safePrng.nextFloat() * 150).toFixed(0);
      labs.push(labEntry('hb', hb, 'g/dL', '11.0-15.5', flagFor(hb, '11.0-15.5')));
      labs.push(labEntry('platelets', plt, '10^9/L', '150-400', flagFor(plt, '150-400')));
      labs.push(labEntry('fibrinogen', fibrinogen, 'mg/dL', '200-400', flagFor(fibrinogen, '200-400')));
      break;
    }
    case 'asthma_exacerbation': {
      const peakFlow = +(100 + safePrng.nextFloat() * 200).toFixed(0);
      labs.push(labEntry('peak_flow', peakFlow, 'L/min', '400-600', flagFor(peakFlow, '400-600')));
      break;
    }
    case 'trauma_blunt': {
      const hb = +(9 + safePrng.nextFloat() * 5).toFixed(1);
      const lactate = +(2 + safePrng.nextFloat() * 4 * severityMultiplier).toFixed(1);
      labs.push(labEntry('hb', hb, 'g/dL', '11.0-15.5', flagFor(hb, '11.0-15.5')));
      labs.push(labEntry('lactate', lactate, 'mmol/L', '0.5-2.0', flagFor(lactate, '0.5-2.0')));
      break;
    }
    case 'pediatric_fever': {
      const wbc = +(10 + safePrng.nextFloat() * 12 * severityMultiplier).toFixed(1);
      const crp = +(20 + safePrng.nextFloat() * 120 * severityMultiplier).toFixed(1);
      labs.push(labEntry('wbc', wbc, '10^9/L', '5.0-15.0', flagFor(wbc, '5.0-15.0')));
      labs.push(labEntry('crp', crp, 'mg/L', '0.0-10.0', flagFor(crp, '0.0-10.0')));
      break;
    }
    case 'geriatric_fall': {
      const hb = +(10 + safePrng.nextFloat() * 4).toFixed(1);
      const creatinine = +(0.9 + safePrng.nextFloat() * 1.5).toFixed(2);
      labs.push(labEntry('hb', hb, 'g/dL', '11.0-15.5', flagFor(hb, '11.0-15.5')));
      labs.push(labEntry('creatinine', creatinine, 'mg/dL', '0.6-1.2', flagFor(creatinine, '0.6-1.2')));
      break;
    }
    case 'mental_health_crisis': {
      const toxScreen = safePrng.bool(0.5) ? 'positive' : 'negative';
      labs.push(labEntry('tox_screen', toxScreen, 'qualitative', 'negative', toxScreen === 'positive' ? 'high' : 'normal'));
      break;
    }
    default: {
      const glucose = +(80 + safePrng.nextFloat() * 50).toFixed(1);
      labs.push(labEntry('glucose', glucose, 'mg/dL', '70-110', flagFor(glucose, '70-110')));
      break;
    }
  }
  return labs;
}

function baseTimeline(pathway) {
  switch (pathway) {
    case 'sepsis':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival to ED, triage priority high.' },
        { t_offset_minutes: 6, event_type: 'triage', description: 'Triage vitals recorded, sepsis pathway activated.' },
        { t_offset_minutes: 12, event_type: 'order_placed', description: 'Blood cultures + lactate + broad-spectrum antibiotic ordered.' },
        { t_offset_minutes: 20, event_type: 'medication_given', description: 'Empiric broad-spectrum antibiotic administered.' },
        { t_offset_minutes: 45, event_type: 'result_available', description: 'Initial lactate result available.' },
        { t_offset_minutes: 120, event_type: 'disposition', description: 'Admitted to ICU or ward based on response.' },
      ];
    case 'stroke':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival to ED with focal neurologic deficit.' },
        { t_offset_minutes: 5, event_type: 'triage', description: 'Stroke pathway activated, NIHSS assessed.' },
        { t_offset_minutes: 15, event_type: 'order_placed', description: 'CT head without contrast ordered.' },
        { t_offset_minutes: 35, event_type: 'result_available', description: 'CT imaging reviewed.' },
        { t_offset_minutes: 55, event_type: 'disposition', description: 'Thrombolysis / thrombectomy decision.' },
      ];
    case 'chest_pain_acs':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival with anginal chest pain.' },
        { t_offset_minutes: 5, event_type: 'triage', description: 'ACS pathway, ECG within 10 minutes.' },
        { t_offset_minutes: 10, event_type: 'order_placed', description: 'ECG + serial troponin ordered.' },
        { t_offset_minutes: 25, event_type: 'medication_given', description: 'Aspirin loading dose given.' },
        { t_offset_minutes: 60, event_type: 'result_available', description: 'First troponin reported.' },
        { t_offset_minutes: 90, event_type: 'disposition', description: 'Cath lab activation or admission.' },
      ];
    case 'pneumonia':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival with productive cough and fever.' },
        { t_offset_minutes: 8, event_type: 'triage', description: 'Respiratory isolation screen completed.' },
        { t_offset_minutes: 20, event_type: 'order_placed', description: 'CXR + sputum culture + CBC ordered.' },
        { t_offset_minutes: 40, event_type: 'medication_given', description: 'Empiric antibiotic started.' },
        { t_offset_minutes: 90, event_type: 'disposition', description: 'Admit vs discharge decision.' },
      ];
    case 'asthma_exacerbation':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival with wheeze and dyspnea.' },
        { t_offset_minutes: 5, event_type: 'triage', description: 'Severity scored; oxygen applied.' },
        { t_offset_minutes: 10, event_type: 'medication_given', description: 'Nebulized beta-agonist + steroid.' },
        { t_offset_minutes: 40, event_type: 'result_available', description: 'Post-treatment peak flow measured.' },
        { t_offset_minutes: 70, event_type: 'disposition', description: 'Discharge with plan or admit.' },
      ];
    case 'diabetic_ketoacidosis':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival with vomiting and altered mental status.' },
        { t_offset_minutes: 10, event_type: 'triage', description: 'Finger-stick glucose elevated; DKA pathway.' },
        { t_offset_minutes: 20, event_type: 'order_placed', description: 'VBG, electrolytes, beta-hydroxybutyrate ordered.' },
        { t_offset_minutes: 30, event_type: 'medication_given', description: 'IV fluids and insulin infusion started.' },
        { t_offset_minutes: 90, event_type: 'disposition', description: 'Admission with continuous monitoring.' },
      ];
    case 'postpartum_hemorrhage':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Postpartum bleeding flagged.' },
        { t_offset_minutes: 5, event_type: 'triage', description: 'Massive transfusion protocol considered.' },
        { t_offset_minutes: 15, event_type: 'medication_given', description: 'Uterotonics administered.' },
        { t_offset_minutes: 30, event_type: 'order_placed', description: 'Type + cross, CBC, coag panel.' },
        { t_offset_minutes: 60, event_type: 'disposition', description: 'OR for exploration or ongoing management.' },
      ];
    case 'trauma_blunt':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival via EMS after blunt mechanism.' },
        { t_offset_minutes: 5, event_type: 'triage', description: 'Primary + secondary survey.' },
        { t_offset_minutes: 15, event_type: 'order_placed', description: 'FAST scan + CT pan-scan ordered.' },
        { t_offset_minutes: 45, event_type: 'result_available', description: 'Imaging reviewed.' },
        { t_offset_minutes: 80, event_type: 'disposition', description: 'OR vs admission decision.' },
      ];
    case 'pediatric_fever':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Pediatric arrival with fever.' },
        { t_offset_minutes: 8, event_type: 'triage', description: 'Age-based vital assessment.' },
        { t_offset_minutes: 20, event_type: 'medication_given', description: 'Antipyretic administered.' },
        { t_offset_minutes: 45, event_type: 'result_available', description: 'Rapid viral panel reported.' },
        { t_offset_minutes: 80, event_type: 'disposition', description: 'Discharge or admission per pathway.' },
      ];
    case 'geriatric_fall':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Geriatric arrival after ground-level fall.' },
        { t_offset_minutes: 8, event_type: 'triage', description: 'C-spine and head injury screen.' },
        { t_offset_minutes: 20, event_type: 'order_placed', description: 'CT head + hip films ordered.' },
        { t_offset_minutes: 55, event_type: 'result_available', description: 'Imaging reviewed.' },
        { t_offset_minutes: 100, event_type: 'disposition', description: 'Admit vs observation.' },
      ];
    case 'mental_health_crisis':
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival with acute psychiatric presentation.' },
        { t_offset_minutes: 10, event_type: 'triage', description: 'Safety assessment performed.' },
        { t_offset_minutes: 25, event_type: 'order_placed', description: 'Medical clearance workup ordered.' },
        { t_offset_minutes: 60, event_type: 'result_available', description: 'Labs reviewed; medical clearance given.' },
        { t_offset_minutes: 100, event_type: 'disposition', description: 'Psychiatric consult + disposition.' },
      ];
    default:
      return [
        { t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival to care area.' },
        { t_offset_minutes: 6, event_type: 'triage', description: 'Triage completed.' },
        { t_offset_minutes: 20, event_type: 'order_placed', description: 'Initial workup ordered.' },
        { t_offset_minutes: 60, event_type: 'result_available', description: 'Initial results reported.' },
        { t_offset_minutes: 90, event_type: 'disposition', description: 'Disposition decision.' },
      ];
  }
}

/**
 * Ordered timeline of events. Always starts with arrival at t=0. For
 * complex/edge complexity, adds a vitals_recorded and at least one
 * escalation event.
 */
export function generateTimeline({ prng, pathway, complexity }) {
  const safePrng = prng || createPrng('default');
  const events = baseTimeline(pathway).map((e) => ({ ...e }));
  if (complexity === 'complex' || complexity === 'edge') {
    events.push({
      t_offset_minutes: 35 + safePrng.nextInt(0, 10),
      event_type: 'vitals_recorded',
      description: 'Repeat vitals captured by nursing.',
    });
  }
  if (complexity === 'edge') {
    events.push({
      t_offset_minutes: 75 + safePrng.nextInt(0, 15),
      event_type: 'escalation',
      description: 'Clinical deterioration — rapid response / senior review escalation.',
    });
    events.push({
      t_offset_minutes: 110 + safePrng.nextInt(0, 15),
      event_type: 'medication_given',
      description: 'Additional resuscitation medication administered.',
    });
  } else if (complexity === 'complex') {
    events.push({
      t_offset_minutes: 75 + safePrng.nextInt(0, 15),
      event_type: 'escalation',
      description: 'Senior clinician paged for additional review.',
    });
  }
  events.sort((a, b) => a.t_offset_minutes - b.t_offset_minutes);
  // Guarantee arrival first at t=0.
  if (!events.length || events[0].event_type !== 'arrival' || events[0].t_offset_minutes !== 0) {
    events.unshift({ t_offset_minutes: 0, event_type: 'arrival', description: 'Arrival to care area.' });
  }
  return events;
}

/**
 * Flag outlier conditions so reviewers can quickly spot intentional
 * edge-cases in a case. Pure — derives only from the passed persona /
 * vitals / labs.
 */
export function detectEdgeFlags({ persona, vitals, labs }) {
  const flags = [];
  const age = toNumber(persona?.age_years, -1);
  if (age >= 0 && (age < 1 || age > 95)) {
    flags.push({ code: 'EXTREME_AGE', detail: `age=${age}` });
  }
  const h = toNumber(persona?.height_cm, 0);
  const w = toNumber(persona?.weight_kg, 0);
  if (h > 0 && w > 0) {
    const bmi = w / Math.pow(h / 100, 2);
    if (bmi > 45) {
      flags.push({ code: 'EXTREME_BMI', detail: `bmi=${bmi.toFixed(1)}` });
    }
  }
  const allergies = asArray(persona?.allergies);
  if (allergies.length >= 4) {
    flags.push({ code: 'MULTIPLE_ALLERGIES', detail: `count=${allergies.length}` });
  }
  const comorbidities = asArray(persona?.comorbidity_codes);
  if (comorbidities.length >= 3) {
    flags.push({ code: 'MULTIPLE_COMORBIDITIES', detail: `count=${comorbidities.length}` });
  }
  for (const v of asArray(vitals)) {
    if (!v) continue;
    if (toNumber(v.spo2, 100) < 85
      || toNumber(v.sbp, 120) < 80
      || toNumber(v.hr, 80) > 180
      || toNumber(v.temp_c, 37) > 40
      || toNumber(v.temp_c, 37) < 34) {
      flags.push({ code: 'CRITICAL_VITAL', detail: `t=${v.t_offset_minutes}` });
      break;
    }
  }
  for (const l of asArray(labs)) {
    if (!l) continue;
    if (l.abnormal_flag === 'critical_high' || l.abnormal_flag === 'critical_low') {
      flags.push({ code: 'CRITICAL_LAB', detail: `${l.name}:${l.abnormal_flag}` });
      break;
    }
  }
  return flags;
}

/**
 * Deterministic human-readable label: synthetic-<pathway>-<complexity>-<first 6 of hash>.
 */
export function buildCaseLabel({ pathway, complexity, seed }) {
  const hashHex = crypto.createHash('sha256')
    .update(String(seed || 'default') + '|' + String(pathway || '') + '|' + String(complexity || ''))
    .digest('hex')
    .slice(0, 6);
  return `synthetic-${pathway || 'unknown'}-${complexity || 'standard'}-${hashHex}`;
}

/**
 * Short multi-sentence narrative written entirely from template phrases.
 * Always prefixed `[synthetic]`. Never includes real identifiers.
 */
export function buildSyntheticNarrative({ persona, pathway, complexity, vitals, labs, timeline }) {
  const age = toNumber(persona?.age_years, 0);
  const gender = cleanText(persona?.gender) || 'unspecified';
  const ethnicity = cleanText(persona?.ethnicity_code) || 'unspecified';
  const vitalsCount = asArray(vitals).length;
  const labsCount = asArray(labs).length;
  const timelineCount = asArray(timeline).length;
  const pathwayStr = cleanText(pathway) || 'unknown';
  const complexityStr = cleanText(complexity) || 'standard';
  const comorbidities = asArray(persona?.comorbidity_codes);
  const comorbidityPhrase = comorbidities.length
    ? `comorbidities noted: ${comorbidities.join(', ')}.`
    : 'no significant comorbidities recorded.';
  const sentences = [
    `[synthetic] Case pathway ${pathwayStr} at ${complexityStr} complexity.`,
    `Simulated persona: age ${age}, gender ${gender}, ethnicity code ${ethnicity}.`,
    `${comorbidityPhrase}`,
    `Captured ${vitalsCount} vitals snapshots, ${labsCount} lab entries, ${timelineCount} timeline events.`,
    'Synthetic data only — not for clinical use and never derived from real patient records.',
  ];
  return sentences.join(' ');
}

/**
 * Normalize and validate a pathway value. Throws AppError.badRequest on
 * an unknown pathway.
 */
export function validatePathway(pathway) {
  const normalized = cleanText(pathway).toLowerCase();
  if (!normalized) throw AppError.badRequest('pathway is required');
  if (!PATHWAYS.has(normalized)) {
    throw AppError.badRequest(`pathway must be one of: ${Array.from(PATHWAYS).join(', ')}`);
  }
  return normalized;
}

/**
 * Normalize and validate a complexity value. Defaults to 'standard' when
 * empty.
 */
export function validateComplexity(complexity) {
  const raw = cleanText(complexity).toLowerCase();
  if (!raw) return 'standard';
  if (!COMPLEXITIES.has(raw)) {
    throw AppError.badRequest(`complexity must be one of: ${Array.from(COMPLEXITIES).join(', ')}`);
  }
  return raw;
}

/**
 * Compose a full synthetic case from seed + pathway + complexity +
 * intendedUse. Pure — no DB, no events, deterministic.
 */
export function generateSyntheticCase({ pathway, complexity = 'standard', seed = null, intendedUse = null } = {}) {
  const validPathway = validatePathway(pathway);
  const validComplexity = validateComplexity(complexity);
  const seedStr = seed === null || seed === undefined ? '' : String(seed);
  const prng = createPrng(seedStr);
  const persona = generatePersona({ prng, complexity: validComplexity, pathway: validPathway });
  const vitals = generateVitals({ prng, pathway: validPathway, complexity: validComplexity, persona });
  const labs = generateLabs({ prng, pathway: validPathway, persona, complexity: validComplexity });
  const timeline = generateTimeline({ prng, pathway: validPathway, complexity: validComplexity });
  const narrative = buildSyntheticNarrative({ persona, pathway: validPathway, complexity: validComplexity, vitals, labs, timeline });
  const edge_flags = detectEdgeFlags({ persona, vitals, labs });
  const case_label = buildCaseLabel({ pathway: validPathway, complexity: validComplexity, seed: seedStr });
  return {
    case_label,
    pathway: validPathway,
    complexity: validComplexity,
    seed: seedStr || null,
    persona,
    vitals,
    labs,
    timeline,
    narrative,
    edge_flags,
    intended_use: intendedUse ? cleanText(intendedUse) : null,
  };
}

async function getActivePrompt(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT version, system_prompt, user_prompt_template
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      tenantId,
      MODULE_KEY
    );
    return rows[0] || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, NULL, NULL, $2, $2, $3, $4, $5, $6, 'draft', $7,
               $8::jsonb, $9::jsonb, $10::jsonb, $11::uuid, $12, $13, $14,
               $15, $16, $17, $18, $19::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? usage.estimated_cost_minor ?? 0,
      usage.latency_ms || aiResult?.latencyMs || null,
      usage.provider_request_id || aiResult?.requestId || null,
      usage.finish_reason || aiResult?.finishReason || null,
      JSON.stringify(metadata || {})
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Synthetic case: generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, NULL, 'pending', $4::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'AI_EVAL_LEAD', 'DOCTOR'],
        source: 'synthetic_case_generator',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
        synthetic_data_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Synthetic case: review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function buildNarrativePrompt({ prompt, draft }) {
  return `${prompt.user_prompt_template}\n\n${JSON.stringify({
    rules_authoritative: true,
    synthetic_only: true,
    never_real_patient_data: true,
    case_label: draft.case_label,
    pathway: draft.pathway,
    complexity: draft.complexity,
    persona_summary: {
      age_years: draft.persona?.age_years,
      gender: draft.persona?.gender,
      ethnicity_code: draft.persona?.ethnicity_code,
      comorbidity_codes: draft.persona?.comorbidity_codes,
    },
    vitals_count: asArray(draft.vitals).length,
    labs_count: asArray(draft.labs).length,
    timeline_count: asArray(draft.timeline).length,
    edge_flags: draft.edge_flags,
  })}`;
}

function normalizeAiNarrative(parsed, fallbackNarrative) {
  if (!parsed || typeof parsed !== 'object') return fallbackNarrative;
  const text = cleanText(parsed.narrative || parsed.summary || '');
  if (!text) return fallbackNarrative;
  // Enforce the [synthetic] prefix. If AI dropped it, restore it.
  if (!/^\[synthetic\]/i.test(text)) {
    return `[synthetic] ${text}`;
  }
  return text;
}

export async function generateAndPersistSyntheticCase({
  req = null,
  pathway,
  complexity = 'standard',
  seed = null,
  intendedUse = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const validPathway = validatePathway(pathway);
  const validComplexity = validateComplexity(complexity);
  const seedStr = seed === null || seed === undefined ? '' : String(seed);

  const pureCase = generateSyntheticCase({
    pathway: validPathway,
    complexity: validComplexity,
    seed: seedStr,
    intendedUse,
  });

  const citations = [
    {
      source_type: 'synthetic_template',
      source_id: `${pureCase.intended_use || 'eval'}:${validPathway}:${validComplexity}`,
      label: `Synthetic template — ${validPathway} @ ${validComplexity}`,
      timestamp: null,
    },
  ];

  const safetyFlags = [
    {
      severity: 'low',
      code: 'SYNTHETIC_DATA_ONLY',
      message: 'This case is entirely synthetic — not a real patient. Never use for clinical decisions or as training data without eval-lead approval.',
    },
    ...asArray(pureCase.edge_flags).map((flag) => ({
      severity: 'high',
      code: `SYNTHETIC_EDGE_${flag.code}`,
      message: `Synthetic edge-case flag: ${flag.code}${flag.detail ? ` (${flag.detail})` : ''}`,
    })),
  ];

  const draft = {
    module_key: MODULE_KEY,
    case_label: pureCase.case_label,
    pathway: pureCase.pathway,
    complexity: pureCase.complexity,
    seed: pureCase.seed,
    persona: pureCase.persona,
    vitals: pureCase.vitals,
    labs: pureCase.labs,
    timeline: pureCase.timeline,
    narrative: pureCase.narrative,
    edge_flags: pureCase.edge_flags,
    intended_use: pureCase.intended_use,
    source_citations: citations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
    synthetic: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = { usedAi: false, provider: 'template', model: null, text: '', usage: {} };
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: buildNarrativePrompt({ prompt, draft }),
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
  } catch (err) {
    logger.warn('Synthetic case: AI narrative failed (non-fatal)', { error: err.message });
  }
  // AI narrative is decorative only — never override persona / vitals / labs / timeline.
  const parsed = safeJsonParse(aiResult?.text, {});
  draft.narrative = normalizeAiNarrative(parsed, pureCase.narrative);

  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        synthetic: true,
        pathway: validPathway,
        complexity: validComplexity,
      },
      citations,
    }),
  ];
  draft.safety_flags = combinedFlags;

  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      module_key: MODULE_KEY,
      pathway: validPathway,
      complexity: validComplexity,
      seed: seedStr,
      intended_use: pureCase.intended_use,
    }),
    draft,
    citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      pathway: validPathway,
      complexity: validComplexity,
      seed: seedStr,
      tenant_region: req?.tenant?.region || null,
      rules_authoritative: true,
      decision_support_only: true,
      synthetic: true,
      never_real_patient_data: true,
    },
  });

  let caseRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_synthetic_cases
         (tenant_id, case_label, pathway, complexity, seed, generation_id,
          persona, vitals, labs, timeline, narrative, edge_flags,
          source_citations, safety_flags, reviewer_decision,
          intended_use, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6,
               $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb,
               $13::jsonb, $14::jsonb, 'pending',
               $15, $16::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, case_label, pathway, complexity, seed,
                 generation_id, persona, vitals, labs, timeline, narrative,
                 edge_flags, source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, intended_use,
                 metadata, created_at, updated_at`,
      tenantId,
      pureCase.case_label,
      validPathway,
      validComplexity,
      seedStr || null,
      generation?.id || null,
      JSON.stringify(pureCase.persona || {}),
      JSON.stringify(pureCase.vitals || []),
      JSON.stringify(pureCase.labs || []),
      JSON.stringify(pureCase.timeline || []),
      draft.narrative,
      JSON.stringify(pureCase.edge_flags || []),
      JSON.stringify(citations),
      JSON.stringify(combinedFlags),
      pureCase.intended_use,
      JSON.stringify({
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        rules_authoritative: true,
        decision_support_only: true,
        synthetic: true,
        never_real_patient_data: true,
      })
    );
    caseRow = rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      case_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: citations,
      safety_flags: combinedFlags,
      edge_flags: pureCase.edge_flags,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_synthetic_cases_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
      synthetic: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.synthetic_case_generated',
    aggregateType: 'clinical_ai_synthetic_case',
    aggregateId: caseRow?.id || generation?.id || null,
    payload: {
      tenant_id: tenantId,
      case_id: caseRow?.id || null,
      generation_id: generation?.id || null,
      pathway: validPathway,
      complexity: validComplexity,
      case_label: pureCase.case_label,
      edge_flag_count: asArray(pureCase.edge_flags).length,
      synthetic: true,
    },
  });

  return {
    case_id: caseRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    case: caseRow,
    pathway: validPathway,
    complexity: validComplexity,
    source_citations: citations,
    safety_flags: combinedFlags,
    edge_flags: pureCase.edge_flags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || caseRow?.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
    synthetic: true,
  };
}

export async function listSyntheticCases({
  tenantId = null,
  pathway = null,
  complexity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedPathway = pathway && PATHWAYS.has(cleanText(pathway).toLowerCase())
    ? cleanText(pathway).toLowerCase()
    : null;
  const normalizedComplexity = complexity && COMPLEXITIES.has(cleanText(complexity).toLowerCase())
    ? cleanText(complexity).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, case_label, pathway, complexity, seed,
              generation_id, persona, vitals, labs, timeline, narrative,
              edge_flags, source_citations, safety_flags, reviewer_decision,
              reviewed_by, reviewed_at, reviewer_note, intended_use,
              metadata, created_at, updated_at
       FROM clinical_ai_synthetic_cases
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR pathway = $2)
         AND ($3::text IS NULL OR complexity = $3)
         AND ($4::text IS NULL OR reviewer_decision = $4)
       ORDER BY created_at DESC
       LIMIT $5`,
      tid,
      normalizedPathway,
      normalizedComplexity,
      normalizedDecision,
      safeLimit
    );
    return { cases: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { cases: [], count: 0 };
    throw err;
  }
}

export async function decideSyntheticCase({
  tenantId = null,
  caseId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_synthetic_cases
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, case_label, pathway, complexity, seed, generation_id,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(caseId, 'case_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Synthetic case not found');
  const row = rows[0];
  return {
    ...row,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

export default {
  PATHWAYS,
  COMPLEXITIES,
  DECISIONS,
  FINAL_DECISIONS,
  hashSeed,
  createPrng,
  generatePersona,
  generateVitals,
  generateLabs,
  generateTimeline,
  detectEdgeFlags,
  buildCaseLabel,
  buildSyntheticNarrative,
  validatePathway,
  validateComplexity,
  generateSyntheticCase,
  generateAndPersistSyntheticCase,
  listSyntheticCases,
  decideSyntheticCase,
};
