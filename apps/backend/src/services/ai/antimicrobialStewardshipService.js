/**
 * Antimicrobial Stewardship Assistant.
 *
 * Reviews antibiotic therapy against chart evidence for cultures, fever,
 * renal-risk drugs, allergies, duration, duplicate spectrum, de-escalation,
 * and IV-to-oral review. Rules are authoritative. The AI layer may summarize
 * rationale and gaps, but this service never writes orders or changes meds.
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
import { groundWithKnowledgeBases } from './knowledgeGroundingService.js';

const MODULE_KEY = 'antimicrobial_stewardship';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support antimicrobial stewardship review. Use only supplied chart evidence and return JSON only.',
  user_prompt_template: 'Summarize antimicrobial stewardship gaps. Do not order, stop, or change medications.',
};

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected']);
const RISK_BANDS = new Set(['low', 'medium', 'high', 'critical', 'unknown']);
const CULTURE_TERMS = ['culture', 'sensitivity', 'microbiology', 'blood culture', 'urine culture', 'sputum culture', 'wound culture'];
const POSITIVE_CULTURE_TERMS = ['positive', 'growth', 'detected', 'isolated', 'organism', 'colonies', 'cfu', 'sensitive', 'resistant'];
const PENDING_STATUSES = new Set(['pending', 'ordered', 'in_progress', 'requested', 'sample_collected', 'processing']);
const COMPLETED_STATUSES = new Set(['completed', 'reported', 'resulted', 'done', 'cancelled', 'canceled']);
const IV_ROUTES = new Set(['iv', 'i.v.', 'intravenous', 'infusion']);

const ANTIBIOTICS = [
  { term: 'amoxicillin', display: 'Amoxicillin', className: 'aminopenicillin', betaLactam: true, oralAvailable: true },
  { term: 'clavulanate', display: 'Amoxicillin clavulanate', className: 'beta-lactam/beta-lactamase inhibitor', betaLactam: true, oralAvailable: true },
  { term: 'ampicillin', display: 'Ampicillin', className: 'aminopenicillin', betaLactam: true, oralAvailable: true },
  { term: 'piperacillin', display: 'Piperacillin tazobactam', className: 'anti-pseudomonal penicillin', broad: true, betaLactam: true },
  { term: 'tazobactam', display: 'Piperacillin tazobactam', className: 'anti-pseudomonal penicillin', broad: true, betaLactam: true },
  { term: 'cefazolin', display: 'Cefazolin', className: 'cephalosporin', betaLactam: true },
  { term: 'cefuroxime', display: 'Cefuroxime', className: 'cephalosporin', betaLactam: true, oralAvailable: true },
  { term: 'cefixime', display: 'Cefixime', className: 'cephalosporin', betaLactam: true, oralAvailable: true },
  { term: 'ceftriaxone', display: 'Ceftriaxone', className: 'cephalosporin', broad: true, betaLactam: true },
  { term: 'cefotaxime', display: 'Cefotaxime', className: 'cephalosporin', broad: true, betaLactam: true },
  { term: 'ceftazidime', display: 'Ceftazidime', className: 'cephalosporin', broad: true, betaLactam: true },
  { term: 'cefepime', display: 'Cefepime', className: 'cephalosporin', broad: true, betaLactam: true },
  { term: 'meropenem', display: 'Meropenem', className: 'carbapenem', broad: true, betaLactam: true },
  { term: 'imipenem', display: 'Imipenem', className: 'carbapenem', broad: true, betaLactam: true },
  { term: 'ertapenem', display: 'Ertapenem', className: 'carbapenem', broad: true, betaLactam: true },
  { term: 'azithromycin', display: 'Azithromycin', className: 'macrolide', oralAvailable: true },
  { term: 'clarithromycin', display: 'Clarithromycin', className: 'macrolide', oralAvailable: true },
  { term: 'ciprofloxacin', display: 'Ciprofloxacin', className: 'fluoroquinolone', broad: true, renalRisk: true, oralAvailable: true },
  { term: 'levofloxacin', display: 'Levofloxacin', className: 'fluoroquinolone', broad: true, renalRisk: true, oralAvailable: true },
  { term: 'metronidazole', display: 'Metronidazole', className: 'nitroimidazole', oralAvailable: true },
  { term: 'vancomycin', display: 'Vancomycin', className: 'glycopeptide', broad: true, renalRisk: true },
  { term: 'teicoplanin', display: 'Teicoplanin', className: 'glycopeptide', broad: true, renalRisk: true },
  { term: 'linezolid', display: 'Linezolid', className: 'oxazolidinone', broad: true, oralAvailable: true },
  { term: 'doxycycline', display: 'Doxycycline', className: 'tetracycline', oralAvailable: true },
  { term: 'gentamicin', display: 'Gentamicin', className: 'aminoglycoside', renalRisk: true },
  { term: 'amikacin', display: 'Amikacin', className: 'aminoglycoside', renalRisk: true },
  { term: 'colistin', display: 'Colistin', className: 'polymyxin', broad: true, renalRisk: true },
  { term: 'clindamycin', display: 'Clindamycin', className: 'lincosamide', oralAvailable: true },
];

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

function eventCitation(event, label = null) {
  if (!event) return null;
  return {
    source_type: event.event_type || event.source_type || 'chart',
    source_id: event.id === null || event.id === undefined ? null : String(event.id),
    label: label || event.summary || event.event_type || event.allergen || event.name || 'Chart evidence',
    timestamp: event.timestamp || event.payload?.created_at || event.created_at || null,
  };
}

function allergyCitation(allergy) {
  if (!allergy) return null;
  return {
    source_type: 'allergy',
    source_id: allergy.id === null || allergy.id === undefined ? null : String(allergy.id),
    label: allergy.allergen || allergy.name || allergy.allergy_name || 'Allergy evidence',
    timestamp: allergy.created_at || null,
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

function eventText(event) {
  return normalizedText(`${event?.summary || ''} ${JSON.stringify(event?.payload || {})} ${event?.notes || ''}`);
}

function payloadValue(event, key) {
  return event?.payload?.[key] ?? event?.payload?.details?.[key] ?? event?.[key] ?? null;
}

function medicationName(event) {
  return cleanText(
    payloadValue(event, 'medication_name')
    || payloadValue(event, 'name')
    || payloadValue(event, 'drug_name')
    || event?.summary
  );
}

function routeOf(event) {
  return normalizedText(payloadValue(event, 'route'));
}

function durationOf(event) {
  return cleanText(
    payloadValue(event, 'duration')
    || payloadValue(event, 'duration_days')
    || payloadValue(event, 'stop_date')
    || payloadValue(event, 'end_date')
    || event?.payload?.end_date
  );
}

function statusOf(event) {
  return normalizedText(payloadValue(event, 'status') || event?.sub_type);
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function matchedAntibiotics(event) {
  const text = eventText(event);
  const matches = [];
  const seen = new Set();
  for (const antibiotic of ANTIBIOTICS) {
    if (antibiotic.term === 'amoxicillin' && text.includes('clavulanate')) continue;
    if (!text.includes(antibiotic.term) || seen.has(antibiotic.display)) continue;
    seen.add(antibiotic.display);
    matches.push(antibiotic);
  }
  return matches;
}

function antibioticEventsFrom(context) {
  const sourceEvents = [
    ...asArray(context.medications),
    ...asArray(context.orders).filter((event) => /medication|drug|antibiotic|anti/.test(eventText(event))),
    ...asArray(context.notes).filter((event) => hasAny(eventText(event), ANTIBIOTICS.map((item) => item.term))),
  ];
  const entries = [];
  for (const event of sourceEvents) {
    for (const antibiotic of matchedAntibiotics(event)) {
      entries.push({
        event,
        antibiotic,
        medication: medicationName(event) || antibiotic.display,
        route: routeOf(event),
        duration: durationOf(event),
        status: statusOf(event),
        citation: eventCitation(event, antibiotic.display),
      });
    }
  }
  return entries;
}

function cultureEventsFrom(context) {
  return asArray(context.investigations)
    .filter((event) => hasAny(eventText(event), CULTURE_TERMS))
    .map((event) => {
      const text = eventText(event);
      const status = statusOf(event);
      let cultureStatus = 'unknown';
      if (PENDING_STATUSES.has(status)) cultureStatus = 'pending';
      if (COMPLETED_STATUSES.has(status)) cultureStatus = 'reported';
      if (hasAny(text, POSITIVE_CULTURE_TERMS)) cultureStatus = 'positive_or_sensitivity_present';
      return {
        event,
        test_name: cleanText(payloadValue(event, 'test_name') || event.summary || 'Culture'),
        status: cultureStatus,
        result_summary: cleanText(
          payloadValue(event, 'result_summary')
          || payloadValue(event, 'interpretation')
          || payloadValue(event, 'conclusion')
        ),
        citation: eventCitation(event, 'Culture evidence'),
      };
    });
}

function payloadNumber(event, key) {
  const value = payloadValue(event, key);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function feverSummaryFrom(context) {
  const temperatures = asArray(context.vitals)
    .map((event) => ({
      value: payloadNumber(event, 'temperature'),
      timestamp: event.timestamp || event.payload?.recorded_at || null,
      citation: eventCitation(event, 'Temperature'),
    }))
    .filter((item) => item.value !== null);
  const feverVitals = temperatures.filter((item) => item.value >= 38);
  const latest = temperatures.slice(-1)[0] || temperatures[0] || null;
  return {
    febrile: feverVitals.length > 0,
    fever_count: feverVitals.length,
    max_temperature: temperatures.length ? Math.max(...temperatures.map((item) => item.value)) : null,
    latest_temperature: latest?.value ?? null,
    citations: uniqueCitations(feverVitals.map((item) => item.citation)).slice(0, 5),
  };
}

function renalSummaryFrom(context) {
  const renalEvents = [
    ...asArray(context.investigations),
    ...asArray(context.notes),
  ].filter((event) => /creatinine|egfr|e-gfr|\burea\b|renal|kidney|aki|ckd/.test(eventText(event)));
  const texts = renalEvents.map((event) => eventText(event));
  const abnormal = texts.some((text) => /high|raised|elevated|aki|ckd|renal impairment|low egfr|e-gfr low|creatinine.*[2-9]\./.test(text));
  return {
    evidence_found: renalEvents.length > 0,
    abnormal_or_impaired: abnormal,
    summary: renalEvents[0]?.summary || (renalEvents.length ? 'Renal evidence found' : 'No renal-function evidence found in chart packet'),
    citations: uniqueCitations(renalEvents.slice(0, 5).map((event) => eventCitation(event, 'Renal function evidence'))),
  };
}

function allergyTexts(context) {
  return asArray(context.allergies)
    .map((allergy) => ({
      text: normalizedText(`${allergy.allergen || ''} ${allergy.name || ''} ${allergy.allergy_name || ''} ${allergy.reaction || ''}`),
      allergy,
    }))
    .filter((item) => item.text);
}

function antibioticAllergyConflict(entry, allergies) {
  const medText = `${entry.antibiotic.term} ${entry.antibiotic.className} ${entry.medication}`.toLowerCase();
  for (const item of allergies) {
    const allergy = item.text;
    const betaLactamConflict = entry.antibiotic.betaLactam
      && /\b(penicillin|beta lactam|beta-lactam|amoxicillin|ampicillin|cephalosporin|cef)\b/.test(allergy);
    if (betaLactamConflict || medText.includes(allergy)) {
      return item;
    }
  }
  return null;
}

function severityWeight(severity) {
  if (severity === 'critical') return 40;
  if (severity === 'high') return 25;
  if (severity === 'medium') return 12;
  return 4;
}

function riskBandFor(flags) {
  if (flags.some((flag) => flag.severity === 'critical')) return 'critical';
  if (flags.some((flag) => flag.severity === 'high')) return 'high';
  if (flags.some((flag) => flag.severity === 'medium')) return 'medium';
  return 'low';
}

function makeFlag({ severity, code, category, title, recommendation, evidence = [] }) {
  return {
    severity,
    code,
    category,
    title,
    recommendation,
    evidence: asArray(evidence).filter(Boolean).slice(0, 8),
  };
}

function addFlag(flags, flag) {
  if (!flags.some((item) => item.code === flag.code)) {
    flags.push(makeFlag(flag));
  }
}

function summarizeAntibiotics(entries) {
  return entries.map((entry) => ({
    medication: entry.medication || entry.antibiotic.display,
    antibiotic: entry.antibiotic.display,
    class_name: entry.antibiotic.className,
    route: entry.route || null,
    duration: entry.duration || null,
    broad_spectrum: Boolean(entry.antibiotic.broad),
    renal_risk: Boolean(entry.antibiotic.renalRisk),
    status: entry.status || null,
    source_citation: entry.citation,
  }));
}

function summarizeCultures(cultures) {
  return cultures.map((culture) => ({
    test_name: culture.test_name,
    status: culture.status,
    result_summary: culture.result_summary || null,
    source_citation: culture.citation,
  }));
}

export function evaluateAntimicrobialStewardship(context = {}) {
  const flags = [];
  const citations = [];
  const antibiotics = antibioticEventsFrom(context);
  const cultures = cultureEventsFrom(context);
  const renalSummary = renalSummaryFrom(context);
  const feverSummary = feverSummaryFrom(context);
  const allergies = allergyTexts(context);
  const broadSpectrum = antibiotics.filter((entry) => entry.antibiotic.broad);
  const renalRiskAntibiotics = antibiotics.filter((entry) => entry.antibiotic.renalRisk);
  const uniqueClasses = new Set(antibiotics.map((entry) => entry.antibiotic.className));
  const pendingCultures = cultures.filter((culture) => culture.status === 'pending');
  const positiveCultures = cultures.filter((culture) => culture.status === 'positive_or_sensitivity_present');
  const missingDuration = antibiotics.filter((entry) => !entry.duration);
  const ivAntibiotics = antibiotics.filter((entry) => IV_ROUTES.has(entry.route));

  const add = (flag) => {
    addFlag(flags, flag);
    for (const item of asArray(flag.evidence)) {
      if (item?.citation) citations.push(item.citation);
    }
  };

  for (const entry of antibiotics) {
    const conflict = antibioticAllergyConflict(entry, allergies);
    if (conflict) {
      add({
        severity: 'critical',
        code: 'ALLERGY_CONFLICT',
        category: 'allergy',
        title: `${entry.antibiotic.display} may conflict with documented allergy.`,
        recommendation: 'Do not auto-change therapy. Escalate to the treating clinician/pharmacist for allergy verification and alternative selection.',
        evidence: [
          { medication: entry.medication, citation: entry.citation },
          { allergy: conflict.text, citation: allergyCitation(conflict.allergy) },
        ],
      });
    }
  }

  if (broadSpectrum.length && cultures.length === 0) {
    add({
      severity: 'high',
      code: 'NO_CULTURE_BEFORE_BROAD_SPECTRUM',
      category: 'culture',
      title: 'Broad-spectrum antibiotic therapy has no culture evidence in the chart packet.',
      recommendation: 'Verify whether cultures were obtained before antibiotics or document why cultures were not appropriate.',
      evidence: broadSpectrum.slice(0, 5).map((entry) => ({
        medication: entry.medication,
        citation: entry.citation,
      })),
    });
  } else if (antibiotics.length && cultures.length === 0) {
    add({
      severity: 'medium',
      code: 'ANTIBIOTIC_WITHOUT_CULTURE_EVIDENCE',
      category: 'culture',
      title: 'Antibiotic therapy has no culture evidence in the chart packet.',
      recommendation: 'Confirm infection diagnosis, culture status, start date, review date, and stop/de-escalation plan.',
      evidence: antibiotics.slice(0, 5).map((entry) => ({
        medication: entry.medication,
        citation: entry.citation,
      })),
    });
  }

  if (pendingCultures.length) {
    add({
      severity: broadSpectrum.length ? 'high' : 'medium',
      code: 'PENDING_CULTURE_REVIEW',
      category: 'culture',
      title: 'Culture or sensitivity results are pending while antibiotics are active.',
      recommendation: 'Track pending culture results and reassess antibiotic spectrum once results are available.',
      evidence: pendingCultures.slice(0, 5).map((culture) => ({
        test_name: culture.test_name,
        status: culture.status,
        citation: culture.citation,
      })),
    });
  }

  if (positiveCultures.length && antibiotics.length) {
    add({
      severity: 'medium',
      code: 'DE_ESCALATION_REVIEW',
      category: 'de_escalation',
      title: 'Reported microbiology evidence should be reconciled with current antibiotics.',
      recommendation: 'Review organism, sensitivities, source, and whether spectrum can be narrowed.',
      evidence: positiveCultures.slice(0, 5).map((culture) => ({
        test_name: culture.test_name,
        result_summary: culture.result_summary,
        citation: culture.citation,
      })),
    });
  }

  if (missingDuration.length) {
    add({
      severity: 'medium',
      code: 'MISSING_ANTIBIOTIC_DURATION',
      category: 'duration',
      title: 'At least one antibiotic has no documented duration or stop/review date.',
      recommendation: 'Add or verify a stop/review date according to the clinical plan and local antimicrobial policy.',
      evidence: missingDuration.slice(0, 5).map((entry) => ({
        medication: entry.medication,
        citation: entry.citation,
      })),
    });
  }

  if (ivAntibiotics.length && !feverSummary.febrile) {
    add({
      severity: 'medium',
      code: 'IV_TO_ORAL_REVIEW',
      category: 'route',
      title: 'IV antibiotic therapy may need IV-to-oral review if clinically stable.',
      recommendation: 'Assess oral tolerance, fever trend, hemodynamic stability, organism, and available oral options before switching.',
      evidence: ivAntibiotics.slice(0, 5).map((entry) => ({
        medication: entry.medication,
        route: entry.route,
        citation: entry.citation,
      })),
    });
  }

  if (antibiotics.length >= 2 && uniqueClasses.size >= 2) {
    add({
      severity: broadSpectrum.length >= 2 ? 'high' : 'medium',
      code: 'DUPLICATE_ANTIMICROBIAL_SPECTRUM',
      category: 'spectrum',
      title: 'Multiple antimicrobial classes are active in the chart packet.',
      recommendation: 'Review duplicate spectrum, combination rationale, planned duration, and culture-guided narrowing.',
      evidence: antibiotics.slice(0, 6).map((entry) => ({
        medication: entry.medication,
        class_name: entry.antibiotic.className,
        citation: entry.citation,
      })),
    });
  }

  if (renalRiskAntibiotics.length && (!renalSummary.evidence_found || renalSummary.abnormal_or_impaired)) {
    add({
      severity: renalSummary.abnormal_or_impaired ? 'high' : 'medium',
      code: 'RENAL_DOSE_REVIEW',
      category: 'renal',
      title: renalSummary.abnormal_or_impaired
        ? 'Renal-risk antibiotic is active with renal impairment evidence.'
        : 'Renal-risk antibiotic is active without renal-function evidence in the chart packet.',
      recommendation: 'Verify latest creatinine/eGFR and dose interval before continuing renal-risk antimicrobials.',
      evidence: [
        ...renalRiskAntibiotics.slice(0, 4).map((entry) => ({
          medication: entry.medication,
          citation: entry.citation,
        })),
        ...asArray(renalSummary.citations).map((citation) => ({ citation })),
      ],
    });
  }

  if (!antibiotics.length) {
    add({
      severity: 'low',
      code: 'NO_ACTIVE_ANTIBIOTIC',
      category: 'baseline',
      title: 'No active antibiotic evidence was detected in the supplied chart packet.',
      recommendation: 'Continue routine stewardship surveillance and human review.',
      evidence: asArray(context.citations).slice(0, 2).map((citation) => ({ citation })),
    });
  }

  const riskBand = riskBandFor(flags);
  const penalty = Math.min(95, flags.reduce((sum, flag) => sum + severityWeight(flag.severity), 0));
  const stewardshipScore = Math.max(0, 100 - penalty);
  const antibioticSummary = summarizeAntibiotics(antibiotics);
  const cultureSummary = summarizeCultures(cultures);
  const sourceCitations = uniqueCitations([
    ...citations,
    ...antibioticSummary.map((item) => item.source_citation),
    ...cultureSummary.map((item) => item.source_citation),
    ...asArray(feverSummary.citations),
    ...asArray(renalSummary.citations),
    ...asArray(context.citations).slice(0, 10),
  ]);

  return {
    stewardship_score: stewardshipScore,
    risk_band: riskBand,
    antibiotic_summary: antibioticSummary,
    culture_summary: cultureSummary,
    renal_summary: renalSummary,
    fever_summary: {
      febrile: feverSummary.febrile,
      fever_count: feverSummary.fever_count,
      max_temperature: feverSummary.max_temperature,
      latest_temperature: feverSummary.latest_temperature,
    },
    flags,
    recommendations: flags.map((flag) => ({
      code: flag.code,
      severity: flag.severity,
      recommendation: flag.recommendation,
    })),
    summary: `${flags.length} stewardship flag(s), ${antibioticSummary.length} antibiotic evidence item(s), ${cultureSummary.length} culture evidence item(s).`,
    source_citations: sourceCitations,
    safety_flags: [],
    rules_authoritative: true,
    decision_support_only: true,
  };
}

function recentSummary(events, limit = 10) {
  return asArray(events)
    .slice(-limit)
    .map((event) => ({
      id: event.id,
      type: event.event_type,
      sub_type: event.sub_type,
      summary: event.summary,
      timestamp: event.timestamp,
      status: event.payload?.status || event.sub_type || null,
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
      status: context.admission?.status || null,
      ward: context.admission?.ward || null,
      bed_number: context.admission?.bed_number || null,
      chief_complaint: context.admission?.chief_complaint || null,
      admitting_diagnosis: context.admission?.admitting_diagnosis || null,
      admitted_at: context.admission?.admitted_at || context.admission?.created_at || null,
    },
    counts: {
      antibiotics: asArray(fallbackDraft.antibiotic_summary).length,
      cultures: asArray(fallbackDraft.culture_summary).length,
      vitals: asArray(context.vitals).length,
      allergies: asArray(context.allergies).length,
      notes: asArray(context.notes).length,
      orders: asArray(context.orders).length,
    },
    recent: {
      antibiotics: asArray(fallbackDraft.antibiotic_summary).slice(0, 12),
      cultures: asArray(fallbackDraft.culture_summary).slice(0, 12),
      vitals: recentSummary(context.vitals, 8),
      notes: recentSummary(context.notes, 5),
      orders: recentSummary(context.orders, 8),
      investigations: recentSummary(context.investigations, 8),
      allergies: asArray(context.allergies).slice(0, 8),
    },
  };
}

function normalizeAiSummary(parsed, fallbackDraft) {
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
    return rows[0] || DEFAULT_PROMPT;
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
    usage.latency_ms || aiResult?.latencyMs || null,
    usage.provider_request_id || aiResult?.requestId || null,
    usage.finish_reason || aiResult?.finishReason || null,
    JSON.stringify(metadata || {})
  );
  return rows[0] || null;
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
        review_roles: module.settings?.reviewRoles || ['DOCTOR', 'PHARMACY_STAFF', 'INFECTION_CONTROL'],
        source: 'antimicrobial_stewardship',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Antimicrobial stewardship review placeholder failed', { error: err.message });
    }
    return null;
  }
}

export async function generateAntimicrobialStewardshipReview({
  req = null,
  admissionId,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeAdmissionId = optionalInt(admissionId, 'admission_id');
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const context = await collectAdmissionClinicalContext(safeAdmissionId);
  const fallbackDraft = evaluateAntimicrobialStewardship(context);
  const packet = buildChartPacket(context, fallbackDraft);
  const prompt = await getActivePrompt(tenantId);

  // WS5 B5.5 — curated knowledge-base grounding. ADDITIVE + GATED via the
  // module's settings.knowledgeBases (antibiotic_policy / clinical_guideline
  // / formulary). Graceful: no chunks / KB down → prompt + citations are
  // unchanged. Rules stay authoritative; KB is decision-support context.
  // The grounding query is built from culture + antibiotic evidence so the
  // local antibiogram / policy chunks retrieved are relevant.
  const groundingQuery = [
    context.admission?.chief_complaint,
    context.admission?.admitting_diagnosis,
    asArray(fallbackDraft.antibiotic_summary).map((item) => item.antibiotic || item.medication).slice(0, 6).join(' '),
    asArray(fallbackDraft.culture_summary).map((item) => item.result_summary || item.test_name).slice(0, 4).join(' '),
  ].filter(Boolean).join('. ');
  const kbGrounding = await groundWithKnowledgeBases({
    module,
    tenantId,
    queryText: groundingQuery,
    role: req?.user?.role || null,
    retrievedBy: req?.user?.uid || null,
    moduleKey: MODULE_KEY,
  });

  const aiResult = await generateClinicalText({
    taskType: MODULE_KEY,
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
      chart_packet: packet,
      rule_based_stewardship: fallbackDraft,
      ...(kbGrounding.used ? { curated_knowledge: kbGrounding.groundingChunks } : {}),
    })}`,
    tenantRegion: req?.tenant?.region || null,
  });
  const parsed = safeJsonParse(aiResult.text, {});
  const draft = normalizeAiSummary(parsed, fallbackDraft);
  // baseCitations = chart/rule-derived citations ONLY (NO curated KB). The
  // NO_STEWARDSHIP_CITATIONS fail-close is evaluated on these alone, so a
  // curated-KB citation can NEVER satisfy a gate that must require chart
  // grounding. `citations` is the full union (base + KB) that is persisted,
  // returned, and displayed — KB chunks stay visible for traceability.
  const baseCitations = uniqueCitations(
    asArray(draft.source_citations).length ? draft.source_citations : fallbackDraft.source_citations
  );
  const citations = uniqueCitations([
    ...baseCitations,
    ...kbGrounding.citations,
  ]);
  const safetyFlags = [
    ...(baseCitations.length ? [] : [{
      severity: 'high',
      code: 'NO_STEWARDSHIP_CITATIONS',
      message: 'Antimicrobial stewardship output has no source citations.',
    }]),
    ...(draft.risk_band === 'critical' ? [{
      severity: 'critical',
      code: 'CRITICAL_STEWARDSHIP_SIGNAL',
      message: 'Critical antimicrobial stewardship signal requires clinician/pharmacist review.',
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

  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    prompt,
    sourceHashValue: sourceHash({ admission_id: safeAdmissionId, packet, fallbackDraft }),
    draft,
    citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      admission_id: safeAdmissionId,
      tenant_region: req?.tenant?.region || null,
      flag_codes: draft.flags.map((flag) => flag.code),
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
      rules_authoritative: true,
    },
  });

  let reviewRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_antimicrobial_reviews
         (tenant_id, patient_uid, admission_id, generation_id, stewardship_score,
          risk_band, antibiotic_summary, culture_summary, renal_summary,
          fever_summary, flags, recommendations, source_citations, safety_flags,
          reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
               $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
               $14::jsonb, 'pending', $15::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, generation_id,
                 stewardship_score, risk_band, antibiotic_summary,
                 culture_summary, renal_summary, fever_summary, flags,
                 recommendations, source_citations, safety_flags,
                 reviewer_decision, metadata, created_at, updated_at`,
      tenantId,
      context.admission?.patient_uid || null,
      safeAdmissionId,
      generation?.id || null,
      draft.stewardship_score,
      RISK_BANDS.has(draft.risk_band) ? draft.risk_band : 'unknown',
      JSON.stringify(draft.antibiotic_summary),
      JSON.stringify(draft.culture_summary),
      JSON.stringify(draft.renal_summary),
      JSON.stringify(draft.fever_summary),
      JSON.stringify(draft.flags),
      JSON.stringify(draft.recommendations),
      JSON.stringify(citations),
      JSON.stringify(safetyFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult.usedAi),
        provider: aiResult.provider || 'template',
        model: aiResult.model || null,
        rules_authoritative: true,
      })
    );
    reviewRow = rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        review_id: null,
        generation_id: generation?.id || null,
        draft,
        source_citations: citations,
        safety_flags: safetyFlags,
        module_key: MODULE_KEY,
        prompt_version: prompt.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_antimicrobial_reviews_unavailable',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        decision_support_only: true,
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

  await publishEvent({
    eventType: 'clinical_ai.antimicrobial_stewardship_review_generated',
    aggregateType: 'clinical_ai_antimicrobial_review',
    aggregateId: reviewRow?.id || generation?.id || safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    payload: {
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      review_id: reviewRow?.id || null,
      generation_id: generation?.id || null,
      risk_band: draft.risk_band,
      stewardship_score: draft.stewardship_score,
      flag_codes: draft.flags.map((flag) => flag.code),
    },
  });

  return {
    review_id: reviewRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    review: reviewRow,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || reviewRow?.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      usage: aiResult.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listAntimicrobialStewardshipReviews({
  tenantId = null,
  admissionId = null,
  patientUid = null,
  decision = null,
  riskBand = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const normalizedDecision = decision && DECISIONS.has(cleanText(decision).toLowerCase())
    ? cleanText(decision).toLowerCase()
    : null;
  const normalizedRiskBand = riskBand && RISK_BANDS.has(cleanText(riskBand).toLowerCase())
    ? cleanText(riskBand).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.tenant_id, r.patient_uid, u.name AS patient_name,
              r.admission_id, r.generation_id, r.stewardship_score,
              r.risk_band, r.antibiotic_summary, r.culture_summary,
              r.renal_summary, r.fever_summary, r.flags,
              r.recommendations, r.source_citations, r.safety_flags,
              r.reviewer_decision, r.reviewed_by, r.reviewed_at,
              r.reviewer_note, r.metadata, r.created_at, r.updated_at
       FROM clinical_ai_antimicrobial_reviews r
       LEFT JOIN users u ON u.uid = r.patient_uid
       WHERE r.tenant_id = $1::uuid
         AND ($2::int IS NULL OR r.admission_id = $2)
         AND ($3::uuid IS NULL OR r.patient_uid = $3::uuid)
         AND ($4::text IS NULL OR r.reviewer_decision = $4)
         AND ($5::text IS NULL OR r.risk_band = $5)
       ORDER BY
         CASE r.risk_band
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         r.created_at DESC
       LIMIT $6`,
      tid,
      aid,
      patientUid || null,
      normalizedDecision,
      normalizedRiskBand,
      safeLimit
    );
    return { reviews: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { reviews: [], count: 0 };
    throw err;
  }
}

export async function decideAntimicrobialStewardshipReview({
  tenantId = null,
  reviewId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!['accepted', 'deferred', 'rejected'].includes(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, or rejected');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_antimicrobial_reviews
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, admission_id, patient_uid, generation_id,
               stewardship_score, risk_band, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(reviewId, 'review_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Antimicrobial stewardship review not found');
  return rows[0];
}

export default {
  decideAntimicrobialStewardshipReview,
  evaluateAntimicrobialStewardship,
  generateAntimicrobialStewardshipReview,
  listAntimicrobialStewardshipReviews,
};
