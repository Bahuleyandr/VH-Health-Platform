/**
 * ICU Ventilator / Sedation Bundle Reviewer.
 *
 * Audits VAP bundle compliance (head-of-bed elevation, oral care, sedation
 * interruption, DVT/PUD prophylaxis, subglottic suction), sedation
 * assessment (RASS score + CAM-ICU delirium screen), and SBT readiness
 * (FiO2, PEEP, hemodynamic stability, oxygenation) for mechanically
 * ventilated ICU admissions.
 *
 * Rules are authoritative. This service never changes ventilator settings,
 * stops sedation, orders extubation, or writes/modifies any clinical order.
 * ICU team / pulmonologist signoff is required before action.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'icu_ventilator_sedation_bundle';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support ICU ventilator/sedation bundle review. Rules are authoritative. Use only supplied chart evidence and deterministic rule signals. Return JSON only. Never order extubation, stop sedation, or modify ventilator settings.',
  user_prompt_template:
    'Given the chart packet and rule-based ventilator/sedation bundle audit, return keys: compliance_score, risk_band, vap_bundle, sedation_assessment, sbt_readiness, bundle_gaps, recommendations, summary, source_citations, safety_flags.',
};

const RISK_BANDS = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
const VENT_STATUSES = new Set(['not_ventilated', 'ventilated', 'weaning', 'extubated', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'escalated']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'escalated']);

// Keyword banks -----------------------------------------------------------
const VENT_ACTIVE_TERMS = [
  'intubated', 'intubation', 'mechanical ventilation', 'mechanically ventilated',
  'ventilator settings', 'vent settings', 'on vent', 'on ventilator',
  'fio2', 'peep', 'pressure support', 'tidal volume', 'assist control',
  'simv', 'ac/vc', 'pc/vc', 'ett', 'endotracheal tube',
];
const VENT_WEANING_TERMS = ['weaning', 'wean from vent', 'sbt', 'spontaneous breathing trial', 'pressure support wean'];
const VENT_EXTUBATED_TERMS = ['extubated', 'extubation', 'post-extubation', 'off ventilator', 'ventilator weaned off'];

const HOB_TERMS = ['head of bed elevated', 'hob 30', 'hob elevated', 'head of bed 30', 'semi-fowler', 'semi fowler', 'semifowler', 'hob >= 30'];
const ORAL_CARE_TERMS = ['oral care', 'chlorhexidine mouthwash', 'chlorhexidine oral', 'mouth care performed'];
const SEDATION_INTERRUPTION_TERMS = ['sedation interruption', 'daily awakening', 'sat done', 'spontaneous awakening trial', 'sedation vacation', 'daily sedation break'];
const SUBGLOTTIC_TERMS = ['subglottic suction', 'subglottic secretion drainage', 'ssd tube'];

const DVT_MEDICATIONS = ['enoxaparin', 'heparin', 'dalteparin', 'fondaparinux', 'lmwh', 'low molecular weight heparin', 'tinzaparin'];
const PUD_MEDICATIONS = ['pantoprazole', 'esomeprazole', 'omeprazole', 'lansoprazole', 'rabeprazole', 'ranitidine', 'famotidine'];

const CAM_ICU_POSITIVE_TERMS = ['cam-icu positive', 'cam icu positive', 'delirium positive', 'positive for delirium'];
const CAM_ICU_NEGATIVE_TERMS = ['cam-icu negative', 'cam icu negative', 'delirium negative', 'no delirium'];
const DELIRIUM_TERMS = ['delirium', 'icu delirium', 'encephalopathic', 'disoriented'];

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
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

function eventText(event) {
  return normalizedText(`${event?.summary || ''} ${JSON.stringify(event?.payload || {})} ${event?.notes || ''}`);
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function payloadValue(event, key) {
  return event?.payload?.[key] ?? event?.payload?.details?.[key] ?? event?.[key] ?? null;
}

function payloadNumber(event, key) {
  const value = payloadValue(event, key);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function routeOf(event) {
  return normalizedText(payloadValue(event, 'route'));
}

function medicationName(event) {
  return cleanText(
    payloadValue(event, 'medication_name')
    || payloadValue(event, 'name')
    || payloadValue(event, 'drug_name')
    || event?.summary
  );
}

function eventCitation(event, label = null) {
  if (!event) return null;
  return {
    source_type: event.event_type || 'chart',
    source_id: event.id === null || event.id === undefined ? null : String(event.id),
    label: label || event.summary || event.event_type || 'Chart evidence',
    timestamp: event.timestamp || event.payload?.created_at || event.created_at || null,
  };
}

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    if (!citation) return false;
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findFirstEvent(events, terms) {
  return asArray(events).find((event) => hasAny(eventText(event), terms)) || null;
}

function findLastEvent(events, terms) {
  const filtered = asArray(events).filter((event) => hasAny(eventText(event), terms));
  return filtered.length ? filtered[filtered.length - 1] : null;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Detect mechanical-ventilation status from medications, orders, and notes.
 * Returns { status, evidence: [citation, ...] }.
 */
export function detectVentilatorStatus({ medications = [], clinicalOrders = [], notes = [] } = {}) {
  const orders = asArray(clinicalOrders);
  const allEvents = [...asArray(medications), ...orders, ...asArray(notes)];
  const evidence = [];

  const lastExtubated = findLastEvent(allEvents, VENT_EXTUBATED_TERMS);
  const lastWeaning = findLastEvent(allEvents, VENT_WEANING_TERMS);
  const lastActive = findLastEvent(allEvents, VENT_ACTIVE_TERMS);

  // Pick latest timestamp among the three candidates to decide precedence.
  function ts(event) {
    if (!event) return -Infinity;
    const t = event.timestamp || event.payload?.created_at || event.created_at;
    if (!t) return 0;
    const value = new Date(t).getTime();
    return Number.isFinite(value) ? value : 0;
  }

  const extubatedAt = ts(lastExtubated);
  const weaningAt = ts(lastWeaning);
  const activeAt = ts(lastActive);

  let status = 'unknown';
  let chosen = null;
  if (lastExtubated && extubatedAt >= weaningAt && extubatedAt >= activeAt) {
    status = 'extubated';
    chosen = lastExtubated;
  } else if (lastWeaning && weaningAt >= activeAt) {
    status = 'weaning';
    chosen = lastWeaning;
  } else if (lastActive) {
    status = 'ventilated';
    chosen = lastActive;
  } else {
    status = 'not_ventilated';
  }

  if (chosen) {
    const citation = eventCitation(chosen, `Ventilator status evidence (${status})`);
    if (citation) evidence.push(citation);
  }

  // Fallback: if no keyword evidence anywhere, mark unknown (we cannot confirm
  // whether the patient is on a vent or not without data).
  if (!lastExtubated && !lastWeaning && !lastActive) {
    status = 'unknown';
  }

  return { status, evidence };
}

/**
 * Evaluate the six-item VAP bundle from available context.
 * Returns a stable shape with bool|null per component.
 */
export function evaluateVapBundle({ notes = [], orders = [], vitals = [], medications = [] } = {}) {
  void vitals; // kept for signature symmetry; vitals not directly used here
  const nts = asArray(notes);
  const ors = asArray(orders);
  const meds = asArray(medications);
  const evidence = [];

  function checkText(events, terms, component) {
    const hit = findFirstEvent(events, terms);
    if (hit) {
      evidence.push({ component, found: true, citation: eventCitation(hit, `${component} evidence`) });
      return true;
    }
    return null;
  }

  const hob = checkText([...nts, ...ors], HOB_TERMS, 'head_of_bed_elevated');
  const oralCare = checkText([...nts, ...ors], ORAL_CARE_TERMS, 'oral_care_performed');
  const sedInterrupt = checkText([...nts, ...ors], SEDATION_INTERRUPTION_TERMS, 'sedation_interruption');
  const subglottic = checkText(ors, SUBGLOTTIC_TERMS, 'subglottic_suction');

  // DVT prophylaxis — medication match, prefer sub-q / prophylactic dose indication.
  let dvt = null;
  for (const event of meds) {
    const name = normalizedText(medicationName(event));
    if (!name) continue;
    const matched = DVT_MEDICATIONS.find((term) => name.includes(term));
    if (!matched) continue;
    const route = routeOf(event);
    const text = eventText(event);
    const looksProphylactic = /prophyla|dvt|vte|thromboprophylaxis|sub[- ]?q|subcutaneous/.test(text) || route === 'sc' || route === 'subcutaneous' || route === 'sub-q' || !route;
    if (looksProphylactic) {
      dvt = true;
      evidence.push({ component: 'dvt_prophylaxis', found: true, citation: eventCitation(event, `DVT prophylaxis (${matched})`) });
      break;
    }
  }

  // Peptic ulcer prophylaxis — medication match.
  let pud = null;
  for (const event of meds) {
    const name = normalizedText(medicationName(event));
    if (!name) continue;
    const matched = PUD_MEDICATIONS.find((term) => name.includes(term));
    if (!matched) continue;
    pud = true;
    evidence.push({ component: 'peptic_ulcer_prophylaxis', found: true, citation: eventCitation(event, `PUD prophylaxis (${matched})`) });
    break;
  }

  return {
    head_of_bed_elevated: hob,
    oral_care_performed: oralCare,
    sedation_interruption: sedInterrupt,
    dvt_prophylaxis: dvt,
    peptic_ulcer_prophylaxis: pud,
    subglottic_suction: subglottic,
    evidence,
  };
}

/**
 * Parse RASS / CAM-ICU / delirium signals from notes and vitals.
 * Returns { rass_score, rass_target, sedation_interruption_done,
 *           delirium_screen_cam_icu, delirium_positive, evidence }.
 */
export function evaluateSedationAssessment({ notes = [], vitals = [], medications = [] } = {}) {
  void medications;
  const nts = asArray(notes);
  const vts = asArray(vitals);
  const evidence = [];

  let rassScore = null;
  let rassTarget = null;
  let camIcu = false;
  let deliriumPositive = false;
  let sedInterrupt = false;

  const allText = [...nts, ...vts];
  for (const event of allText) {
    const text = eventText(event);
    if (!text) continue;

    // RASS target — prefer explicit "target RASS" phrasing, parse FIRST.
    const targetMatch = /(?:target\s+rass|rass\s+target|goal\s+rass)\s*(?:of\s*)?(-?\d+)/i.exec(text);
    if (targetMatch && rassTarget === null) {
      const value = Number.parseInt(targetMatch[1], 10);
      if (Number.isFinite(value) && value >= -5 && value <= 4) {
        rassTarget = value;
        const citation = eventCitation(event, `RASS target ${value}`);
        if (citation) evidence.push(citation);
      }
    }

    // Current RASS score — must not be preceded by target/goal keyword.
    // Match "rass" followed by a number, but skip target matches.
    if (rassScore === null) {
      const rassMatches = [...text.matchAll(/rass\s*(-?\d+)/g)];
      for (const match of rassMatches) {
        const precedingIdx = Math.max(0, match.index - 20);
        const preceding = text.slice(precedingIdx, match.index);
        if (/target|goal/.test(preceding)) continue;
        const value = Number.parseInt(match[1], 10);
        if (Number.isFinite(value) && value >= -5 && value <= 4) {
          rassScore = value;
          const citation = eventCitation(event, `RASS ${value}`);
          if (citation) evidence.push(citation);
          break;
        }
      }
    }

    // Also check payload RASS fields directly.
    if (rassScore === null) {
      const payloadRass = payloadNumber(event, 'rass') ?? payloadNumber(event, 'rass_score');
      if (payloadRass !== null && payloadRass >= -5 && payloadRass <= 4) {
        rassScore = payloadRass;
        const citation = eventCitation(event, `RASS ${payloadRass}`);
        if (citation) evidence.push(citation);
      }
    }

    if (hasAny(text, CAM_ICU_POSITIVE_TERMS)) {
      camIcu = true;
      deliriumPositive = true;
      const citation = eventCitation(event, 'CAM-ICU positive');
      if (citation) evidence.push(citation);
    } else if (hasAny(text, CAM_ICU_NEGATIVE_TERMS)) {
      camIcu = true;
      const citation = eventCitation(event, 'CAM-ICU negative');
      if (citation) evidence.push(citation);
    } else if (!deliriumPositive && hasAny(text, DELIRIUM_TERMS) && !/no delirium|denies delirium/.test(text)) {
      deliriumPositive = true;
      const citation = eventCitation(event, 'Delirium evidence');
      if (citation) evidence.push(citation);
    }

    if (!sedInterrupt && hasAny(text, SEDATION_INTERRUPTION_TERMS)) {
      sedInterrupt = true;
      const citation = eventCitation(event, 'Sedation interruption / SAT');
      if (citation) evidence.push(citation);
    }
  }

  return {
    rass_score: rassScore,
    rass_target: rassTarget,
    sedation_interruption_done: sedInterrupt,
    delirium_screen_cam_icu: camIcu,
    delirium_positive: deliriumPositive,
    evidence,
  };
}

/**
 * Evaluate Spontaneous Breathing Trial readiness from vitals, notes, orders.
 * Returns { fio2_below_50, peep_below_8, hemodynamically_stable,
 *           adequate_oxygenation, ready, evidence }.
 */
export function evaluateSbtReadiness({ vitals = [], notes = [], orders = [] } = {}) {
  const vts = asArray(vitals);
  const nts = asArray(notes);
  const ors = asArray(orders);
  const evidence = [];

  // Parse FiO2 and PEEP — from notes/orders text or vitals payloads.
  let fio2Value = null;
  let peepValue = null;

  const allTextEvents = [...nts, ...ors, ...vts];
  for (const event of allTextEvents) {
    const text = eventText(event);
    if (!text) continue;

    if (fio2Value === null) {
      // "fio2 40%", "fio2 0.4", "fio2 40"
      const fio2Match = /fio2\s*(?:of\s*|:\s*|=\s*)?(\d+(?:\.\d+)?)\s*%?/i.exec(text);
      if (fio2Match) {
        let v = Number.parseFloat(fio2Match[1]);
        if (Number.isFinite(v)) {
          if (v <= 1) v *= 100; // decimal form
          fio2Value = v;
          const citation = eventCitation(event, `FiO2 ${v}%`);
          if (citation) evidence.push(citation);
        }
      } else {
        const payloadFio2 = payloadNumber(event, 'fio2');
        if (payloadFio2 !== null) {
          let v = payloadFio2;
          if (v <= 1) v *= 100;
          fio2Value = v;
          const citation = eventCitation(event, `FiO2 ${v}%`);
          if (citation) evidence.push(citation);
        }
      }
    }

    if (peepValue === null) {
      const peepMatch = /peep\s*(?:of\s*|:\s*|=\s*)?(\d+(?:\.\d+)?)/i.exec(text);
      if (peepMatch) {
        const v = Number.parseFloat(peepMatch[1]);
        if (Number.isFinite(v)) {
          peepValue = v;
          const citation = eventCitation(event, `PEEP ${v}`);
          if (citation) evidence.push(citation);
        }
      } else {
        const payloadPeep = payloadNumber(event, 'peep');
        if (payloadPeep !== null) {
          peepValue = payloadPeep;
          const citation = eventCitation(event, `PEEP ${payloadPeep}`);
          if (citation) evidence.push(citation);
        }
      }
    }

    if (fio2Value !== null && peepValue !== null) break;
  }

  // Hemodynamic stability — latest SBP > 90 AND HR 50-130 from vitals.
  let hemoStable = null;
  const hemoSamples = vts
    .map((event) => ({
      sbp: payloadNumber(event, 'systolic_bp'),
      hr: payloadNumber(event, 'heart_rate'),
      event,
    }))
    .filter((item) => item.sbp !== null || item.hr !== null);
  if (hemoSamples.length) {
    const latest = hemoSamples[hemoSamples.length - 1];
    const sbpOk = latest.sbp !== null ? latest.sbp > 90 : true;
    const hrOk = latest.hr !== null ? (latest.hr >= 50 && latest.hr <= 130) : true;
    hemoStable = Boolean(sbpOk && hrOk);
    const citation = eventCitation(latest.event, `Hemodynamics (SBP=${latest.sbp ?? 'n/a'}, HR=${latest.hr ?? 'n/a'})`);
    if (citation) evidence.push(citation);
  }

  // Adequate oxygenation — SpO2 > 92%.
  let oxygenationOk = null;
  const spo2Samples = vts
    .map((event) => ({ spo2: payloadNumber(event, 'spo2'), event }))
    .filter((item) => item.spo2 !== null);
  if (spo2Samples.length) {
    const latest = spo2Samples[spo2Samples.length - 1];
    oxygenationOk = latest.spo2 > 92;
    const citation = eventCitation(latest.event, `SpO2 ${latest.spo2}%`);
    if (citation) evidence.push(citation);
  }

  const fio2Below50 = fio2Value === null ? null : fio2Value < 50;
  const peepBelow8 = peepValue === null ? null : peepValue < 8;

  const readyComponents = [fio2Below50, peepBelow8, hemoStable, oxygenationOk];
  const hasAnyKnown = readyComponents.some((v) => v !== null);
  const allTrue = hasAnyKnown && readyComponents.every((v) => v === true || v === null) && readyComponents.some((v) => v === true);
  const ready = Boolean(hasAnyKnown && readyComponents.filter((v) => v !== null).length >= 2 && allTrue);

  return {
    fio2_below_50: fio2Below50,
    peep_below_8: peepBelow8,
    hemodynamically_stable: hemoStable,
    adequate_oxygenation: oxygenationOk,
    ready,
    evidence,
  };
}

/**
 * Combine bundle + sedation + SBT signals into compliance score, risk band,
 * bundle gaps, and recommendations.
 */
export function computeComplianceAndGaps({
  vapBundle = {},
  sedationAssessment = {},
  sbtReadiness = {},
  ventilatorStatus = 'unknown',
} = {}) {
  const bundleGaps = [];
  const recommendations = [];

  // Short-circuit: non-ventilated / extubated / unknown patients default to
  // low-risk baseline — the ventilator bundle does not apply.
  if (!['ventilated', 'weaning'].includes(ventilatorStatus)) {
    return {
      compliance_score: 100,
      risk_band: 'low',
      bundle_gaps: [],
      recommendations: [],
    };
  }

  // Components evaluated: 6 VAP + 3 sedation-relevant + 4 SBT = 13 total.
  // bool=true → 1, bool=false → 0, null → excluded from denominator.
  const components = [
    { key: 'head_of_bed_elevated', value: vapBundle.head_of_bed_elevated, severity: 'high', desc: 'Head of bed is not elevated to 30 degrees.', rec: 'Elevate head of bed to 30-45 degrees unless contraindicated.' },
    { key: 'oral_care_performed', value: vapBundle.oral_care_performed, severity: 'medium', desc: 'Oral care / chlorhexidine mouthwash not documented.', rec: 'Perform documented oral care with chlorhexidine per local VAP policy.' },
    { key: 'sedation_interruption', value: vapBundle.sedation_interruption, severity: 'high', desc: 'Daily sedation interruption / spontaneous awakening trial not documented.', rec: 'Perform and document a daily sedation interruption (SAT) with safety screen.' },
    { key: 'dvt_prophylaxis', value: vapBundle.dvt_prophylaxis, severity: 'high', desc: 'DVT / VTE prophylaxis is not documented in active medications.', rec: 'Start VTE prophylaxis (LMWH / heparin) unless contraindicated.' },
    { key: 'peptic_ulcer_prophylaxis', value: vapBundle.peptic_ulcer_prophylaxis, severity: 'medium', desc: 'Peptic ulcer prophylaxis is not documented.', rec: 'Start stress-ulcer prophylaxis (PPI or H2 blocker) per policy.' },
    { key: 'subglottic_suction', value: vapBundle.subglottic_suction, severity: 'medium', desc: 'Subglottic secretion drainage is not documented in orders.', rec: 'Confirm an ETT with subglottic suction port and document drainage per shift.' },
    // Sedation: interruption done, delirium screened, and delirium status.
    { key: 'sedation_interruption_done', value: sedationAssessment.sedation_interruption_done === true ? true : sedationAssessment.sedation_interruption_done === false ? false : null, severity: 'high', desc: 'Sedation interruption not documented in sedation assessment.', rec: 'Document a daily sedation break (SAT) tied to RASS target.' },
    { key: 'delirium_screen_cam_icu', value: sedationAssessment.delirium_screen_cam_icu === true ? true : null, severity: 'medium', desc: 'CAM-ICU delirium screen not documented.', rec: 'Perform CAM-ICU screen once per shift and document result.' },
    { key: 'delirium_positive', value: sedationAssessment.delirium_positive === true ? false : sedationAssessment.delirium_positive === false ? true : null, severity: 'medium', desc: 'Delirium is positive — bundle interventions are incomplete.', rec: 'Apply delirium bundle (pain, minimize sedation, mobility, reorientation).' },
    // SBT readiness components — each present counts as a compliance point.
    { key: 'fio2_below_50', value: sbtReadiness.fio2_below_50, severity: 'low', desc: 'FiO2 is at or above 50% — SBT readiness incomplete.', rec: 'Wean FiO2 below 50% before attempting SBT.' },
    { key: 'peep_below_8', value: sbtReadiness.peep_below_8, severity: 'low', desc: 'PEEP is at or above 8 — SBT readiness incomplete.', rec: 'Wean PEEP below 8 cmH2O before attempting SBT.' },
    { key: 'hemodynamically_stable', value: sbtReadiness.hemodynamically_stable, severity: 'medium', desc: 'Hemodynamic instability prevents SBT readiness.', rec: 'Stabilize hemodynamics (BP, HR) before attempting SBT.' },
    { key: 'adequate_oxygenation', value: sbtReadiness.adequate_oxygenation, severity: 'medium', desc: 'Oxygenation (SpO2 <= 92%) is inadequate for SBT.', rec: 'Optimize oxygenation and reassess SBT readiness.' },
  ];

  let sum = 0;
  let denominator = 0;
  for (const component of components) {
    if (component.value === null || component.value === undefined) continue;
    denominator += 1;
    if (component.value === true) {
      sum += 1;
    } else if (component.value === false) {
      bundleGaps.push({
        component: component.key,
        severity: component.severity,
        description: component.desc,
      });
      recommendations.push({
        component: component.key,
        severity: component.severity,
        recommendation: component.rec,
      });
    }
  }

  const complianceScore = denominator > 0 ? Math.round((sum / denominator) * 100) : 0;

  let riskBand = 'unknown';
  if (denominator === 0) {
    riskBand = 'unknown';
  } else if (complianceScore >= 85) {
    riskBand = 'low';
  } else if (complianceScore >= 70) {
    riskBand = 'moderate';
  } else if (complianceScore >= 50) {
    riskBand = 'high';
  } else {
    riskBand = 'critical';
  }

  return {
    compliance_score: complianceScore,
    risk_band: riskBand,
    bundle_gaps: bundleGaps,
    recommendations,
  };
}

// ---------- Chart packet + AI glue --------------------------------------

function latestSummary(events, limit = 8) {
  return asArray(events)
    .slice(-limit)
    .map((event) => ({
      id: event.id,
      type: event.event_type,
      summary: event.summary,
      timestamp: event.timestamp,
    }));
}

function buildChartPacket(context, fallbackDraft) {
  return {
    patient: {
      uid: context.patient?.uid || context.admission?.patient_uid || null,
      name: context.patient?.name || null,
    },
    admission: {
      id: context.admission?.id || null,
      ward: context.admission?.ward || null,
      status: context.admission?.status || null,
      admitted_at: context.admission?.admitted_at || context.admission?.created_at || null,
    },
    ventilator_status: fallbackDraft.ventilator_status,
    counts: {
      vitals: asArray(context.vitals).length,
      medications: asArray(context.medications).length,
      notes: asArray(context.notes).length,
      orders: asArray(context.orders).length,
      investigations: asArray(context.investigations).length,
    },
    recent: {
      vitals: latestSummary(context.vitals),
      medications: latestSummary(context.medications),
      notes: latestSummary(context.notes, 5),
      orders: latestSummary(context.orders, 5),
    },
  };
}

function buildFallbackDraft(context) {
  const ventilator = detectVentilatorStatus({
    medications: context.medications,
    clinicalOrders: context.orders,
    notes: context.notes,
  });
  const vapBundle = evaluateVapBundle({
    notes: context.notes,
    orders: context.orders,
    vitals: context.vitals,
    medications: context.medications,
  });
  const sedationAssessment = evaluateSedationAssessment({
    notes: context.notes,
    vitals: context.vitals,
    medications: context.medications,
  });
  const sbtReadiness = evaluateSbtReadiness({
    vitals: context.vitals,
    notes: context.notes,
    orders: context.orders,
  });
  const compliance = computeComplianceAndGaps({
    vapBundle,
    sedationAssessment,
    sbtReadiness,
    ventilatorStatus: ventilator.status,
  });

  const evidenceCitations = [
    ...asArray(ventilator.evidence),
    ...asArray(vapBundle.evidence).map((item) => item?.citation).filter(Boolean),
    ...asArray(sedationAssessment.evidence),
    ...asArray(sbtReadiness.evidence),
  ];

  return {
    ventilator_status: ventilator.status,
    ventilator_days: computeVentilatorDays(context),
    compliance_score: compliance.compliance_score,
    risk_band: compliance.risk_band,
    vap_bundle: {
      head_of_bed_elevated: vapBundle.head_of_bed_elevated,
      oral_care_performed: vapBundle.oral_care_performed,
      sedation_interruption: vapBundle.sedation_interruption,
      dvt_prophylaxis: vapBundle.dvt_prophylaxis,
      peptic_ulcer_prophylaxis: vapBundle.peptic_ulcer_prophylaxis,
      subglottic_suction: vapBundle.subglottic_suction,
    },
    sedation_assessment: {
      rass_score: sedationAssessment.rass_score,
      rass_target: sedationAssessment.rass_target,
      sedation_interruption_done: sedationAssessment.sedation_interruption_done,
      delirium_screen_cam_icu: sedationAssessment.delirium_screen_cam_icu,
      delirium_positive: sedationAssessment.delirium_positive,
    },
    sbt_readiness: {
      fio2_below_50: sbtReadiness.fio2_below_50,
      peep_below_8: sbtReadiness.peep_below_8,
      hemodynamically_stable: sbtReadiness.hemodynamically_stable,
      adequate_oxygenation: sbtReadiness.adequate_oxygenation,
      ready: sbtReadiness.ready,
    },
    bundle_gaps: compliance.bundle_gaps,
    recommendations: compliance.recommendations,
    summary: `${compliance.bundle_gaps.length} bundle gap(s); compliance ${compliance.compliance_score}% (${compliance.risk_band}).`,
    source_citations: uniqueCitations(evidenceCitations),
    safety_flags: [],
    rules_authoritative: true,
    decision_support_only: true,
  };
}

function computeVentilatorDays(context) {
  // Approximate: count distinct calendar days in the last 30 days of timeline
  // with vent-active keywords. Capped at 30 to avoid runaway values.
  const vent = [...asArray(context.notes), ...asArray(context.orders), ...asArray(context.medications)]
    .filter((event) => hasAny(eventText(event), VENT_ACTIVE_TERMS));
  const days = new Set();
  for (const event of vent) {
    const ts = event.timestamp || event.payload?.created_at || event.created_at;
    if (!ts) continue;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    days.add(d.toISOString().slice(0, 10));
  }
  return Math.min(days.size, 30);
}

function normalizeAiDraft(parsed, fallbackDraft) {
  return {
    ...fallbackDraft,
    summary: cleanText(parsed?.summary) || fallbackDraft.summary,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed?.source_citations),
    ]),
    safety_flags: [
      ...asArray(fallbackDraft.safety_flags),
      ...asArray(parsed?.safety_flags),
    ],
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
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  admissionId,
  patientUid,
  prompt,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb, $14::uuid, $15, $16, $17,
               $18, $19, $20, $21, $22::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      admissionId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? usage.estimated_cost_minor ?? 0,
      aiResult?.latencyMs || usage.latency_ms || null,
      aiResult?.requestId || usage.provider_request_id || null,
      aiResult?.finishReason || usage.finish_reason || null,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('ICU ventilator bundle generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, admissionId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      admissionId,
      JSON.stringify({
        review_roles: module.settings?.reviewRoles || ['DOCTOR', 'NURSING_STAFF', 'ICU_TEAM', 'PULMONOLOGIST'],
        source: 'icu_ventilator_sedation_bundle',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('ICU ventilator bundle review placeholder failed', { error: err.message });
    }
    return null;
  }
}

// ---------- Public API --------------------------------------------------

export async function generateVentilatorBundleAudit({ req = null, admissionId } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeAdmissionId = optionalInt(admissionId, 'admission_id');
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const context = await collectAdmissionClinicalContext(safeAdmissionId);
  const fallbackDraft = buildFallbackDraft(context);
  const packet = buildChartPacket(context, fallbackDraft);
  const prompt = await getActivePrompt(tenantId);
  const aiResult = await generateClinicalText({
    taskType: MODULE_KEY,
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
      chart_packet: packet,
      rule_based_bundle_audit: fallbackDraft,
    })}`,
    tenantRegion: req?.tenant?.region || null,
  });

  const parsed = safeJsonParse(aiResult?.text, {});
  const draft = normalizeAiDraft(parsed, fallbackDraft);

  const citations = uniqueCitations(
    asArray(draft.source_citations).length ? draft.source_citations : fallbackDraft.source_citations
  );

  const safetyFlags = [
    ...(citations.length ? [] : [{
      severity: 'high',
      code: 'NO_ICU_BUNDLE_CITATIONS',
      message: 'ICU ventilator bundle audit output has no source citations.',
    }]),
    ...(draft.risk_band === 'critical' ? [{
      severity: 'critical',
      code: 'CRITICAL_ICU_BUNDLE_SIGNAL',
      message: 'Critical ventilator bundle compliance gap — ICU team review required.',
    }] : []),
    ...((fallbackDraft.sbt_readiness?.ready === true && !sbtAttempted(context)) ? [{
      severity: 'medium',
      code: 'SBT_READY_NOT_ATTEMPTED',
      message: 'SBT readiness criteria appear met but no SBT has been attempted or documented.',
    }] : []),
    ...asArray(draft.safety_flags),
    ...runOutputDefenses({
      draft,
      module,
      context: packet,
      citations,
    }),
  ];
  draft.safety_flags = safetyFlags;

  const sourceHashValue = sourceHash({ admission_id: safeAdmissionId, packet, fallbackDraft });
  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    prompt,
    sourceHashValue,
    draft,
    citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      admission_id: safeAdmissionId,
      tenant_region: req?.tenant?.region || null,
      ventilator_status: draft.ventilator_status,
      risk_band: draft.risk_band,
      compliance_score: draft.compliance_score,
      fallback_reason: aiResult?.usedAi ? null : aiResult?.reason || 'template_or_rule_output',
      rules_authoritative: true,
    },
  });

  let auditRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_ventilator_bundle_audits
         (tenant_id, admission_id, patient_uid, generation_id, ventilator_status,
          ventilator_days, compliance_score, risk_band, vap_bundle,
          sedation_assessment, sbt_readiness, bundle_gaps, recommendations,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
               $14::jsonb, $15::jsonb, 'pending', $16::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, admission_id, patient_uid, generation_id,
                 ventilator_status, ventilator_days, compliance_score,
                 risk_band, vap_bundle, sedation_assessment, sbt_readiness,
                 bundle_gaps, recommendations, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      safeAdmissionId,
      context.admission?.patient_uid || null,
      generation?.id || null,
      VENT_STATUSES.has(draft.ventilator_status) ? draft.ventilator_status : 'unknown',
      Math.max(0, Number.parseInt(draft.ventilator_days, 10) || 0),
      Math.max(0, Math.min(100, Number.parseInt(draft.compliance_score, 10) || 0)),
      RISK_BANDS.has(draft.risk_band) ? draft.risk_band : 'unknown',
      JSON.stringify(draft.vap_bundle || {}),
      JSON.stringify(draft.sedation_assessment || {}),
      JSON.stringify(draft.sbt_readiness || {}),
      JSON.stringify(draft.bundle_gaps || []),
      JSON.stringify(draft.recommendations || []),
      JSON.stringify(citations),
      JSON.stringify(safetyFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        rules_authoritative: true,
      })
    );
    auditRow = (rows && rows[0]) || null;
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        audit_id: null,
        generation_id: generation?.id || null,
        draft,
        source_citations: citations,
        safety_flags: safetyFlags,
        module_key: MODULE_KEY,
        prompt_version: prompt.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_ventilator_bundle_audits_unavailable',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        decision_support_only: true,
        rules_authoritative: true,
      };
    }
    throw err;
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.icu_ventilator_bundle_audited',
      aggregateType: 'clinical_ai_ventilator_bundle_audit',
      aggregateId: auditRow?.id || generation?.id || safeAdmissionId,
      patientUid: context.admission?.patient_uid || null,
      payload: {
        tenant_id: tenantId,
        admission_id: safeAdmissionId,
        audit_id: auditRow?.id || null,
        generation_id: generation?.id || null,
        ventilator_status: draft.ventilator_status,
        compliance_score: draft.compliance_score,
        risk_band: draft.risk_band,
        bundle_gap_count: asArray(draft.bundle_gaps).length,
      },
    });
  } catch (err) {
    logger.warn('ICU ventilator bundle event publish failed', { error: err?.message });
  }

  return {
    audit_id: auditRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    audit: auditRow,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || auditRow?.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

function sbtAttempted(context) {
  const events = [...asArray(context.notes), ...asArray(context.orders)];
  return events.some((event) => /\bsbt\b|spontaneous breathing trial|sbt attempted|sbt completed/.test(eventText(event)));
}

export async function listVentilatorBundleAudits({
  tenantId = null,
  admissionId = null,
  riskBand = null,
  reviewerDecision = null,
  ventilatorStatus = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const normalizedBand = riskBand && RISK_BANDS.has(cleanText(riskBand).toLowerCase())
    ? cleanText(riskBand).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;
  const normalizedStatus = ventilatorStatus && VENT_STATUSES.has(cleanText(ventilatorStatus).toLowerCase())
    ? cleanText(ventilatorStatus).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.admission_id, a.patient_uid, u.name AS patient_name,
              a.generation_id, a.ventilator_status, a.ventilator_days,
              a.compliance_score, a.risk_band, a.vap_bundle,
              a.sedation_assessment, a.sbt_readiness, a.bundle_gaps,
              a.recommendations, a.source_citations, a.safety_flags,
              a.reviewer_decision, a.reviewed_by, a.reviewed_at,
              a.reviewer_note, a.metadata, a.created_at, a.updated_at
       FROM clinical_ai_ventilator_bundle_audits a
       LEFT JOIN users u ON u.uid = a.patient_uid
       WHERE a.tenant_id = $1::uuid
         AND ($2::int IS NULL OR a.admission_id = $2)
         AND ($3::text IS NULL OR a.risk_band = $3)
         AND ($4::text IS NULL OR a.reviewer_decision = $4)
         AND ($5::text IS NULL OR a.ventilator_status = $5)
       ORDER BY
         CASE a.risk_band
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         a.created_at DESC
       LIMIT $6`,
      tid,
      aid,
      normalizedBand,
      normalizedDecision,
      normalizedStatus,
      safeLimit
    );
    return { audits: asArray(rows), count: asArray(rows).length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { audits: [], count: 0 };
    throw err;
  }
}

export async function decideVentilatorBundleAudit({
  tenantId = null,
  auditId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or escalated');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_ventilator_bundle_audits
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, admission_id, patient_uid, generation_id,
               ventilator_status, ventilator_days, compliance_score,
               risk_band, vap_bundle, sedation_assessment, sbt_readiness,
               bundle_gaps, recommendations, source_citations, safety_flags,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    optionalInt(auditId, 'audit_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('ICU ventilator bundle audit not found');
  return rows[0];
}

export default {
  computeComplianceAndGaps,
  decideVentilatorBundleAudit,
  detectVentilatorStatus,
  evaluateSbtReadiness,
  evaluateSedationAssessment,
  evaluateVapBundle,
  generateVentilatorBundleAudit,
  listVentilatorBundleAudits,
};
