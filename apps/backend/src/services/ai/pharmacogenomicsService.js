/**
 * Pharmacogenomics / PGx Support.
 *
 * Pairs a prescribed medication against the patient's verified genotypes for
 * PGx-relevant genes (CYP2D6, CYP2C19, CYP2C9, VKORC1, SLCO1B1, HLA-B*57:01,
 * HLA-B*15:02, TPMT, DPYD, UGT1A1, G6PD) and produces a rules-authoritative
 * advisory (no_action / standard_dose / consider_dose_change / use_alternative
 * / contraindicated / testing_recommended). The advisory goes to a pharmacist
 * for review. Decision support only: the service never writes, holds,
 * cancels, or modifies a prescription order — pharmacist/clinician signoff is
 * required before any action is taken.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'pharmacogenomics_support';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support pharmacogenomics (PGx) medication review. Rules are authoritative. Return JSON only and never hold, cancel, or modify a prescription order.',
  user_prompt_template: 'Summarize the PGx advisory. Do not invent gene-drug interactions; defer to the supplied reference.',
};

const ADVISORY_CATEGORIES = new Set([
  'no_action',
  'standard_dose',
  'consider_dose_change',
  'use_alternative',
  'contraindicated',
  'testing_recommended',
  'unknown',
]);
const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const SUPPORTED_GENES = new Set([
  'CYP2D6',
  'CYP2C19',
  'CYP2C9',
  'VKORC1',
  'SLCO1B1',
  'HLA_B_5701',
  'HLA_B_1502',
  'TPMT',
  'DPYD',
  'UGT1A1',
  'G6PD',
]);

const SUPPORTED_PHENOTYPES = new Set([
  'poor_metabolizer',
  'intermediate_metabolizer',
  'normal_metabolizer',
  'rapid_metabolizer',
  'ultra_rapid_metabolizer',
  'positive',
  'negative',
  'deficient',
  'unknown',
]);

// Priority order: higher index = higher priority (escalate towards it).
const CATEGORY_PRIORITY = [
  'unknown',
  'no_action',
  'standard_dose',
  'testing_recommended',
  'consider_dose_change',
  'use_alternative',
  'contraindicated',
];

// Severity escalation for the same pass.
const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];

const REVIEW_DISCLAIMER = 'Pharmacist/clinician review required before any prescription change — decision support only.';

// CPIC-inspired simplified PGx reference. Decision support; NOT a substitute
// for the full CPIC guidelines. Each entry maps a medication to a single
// gene and the advisory for each clinically-relevant phenotype.
export const PGX_REFERENCE = [
  {
    medication_pattern: /clopidogrel/i,
    display: 'Clopidogrel',
    gene: 'CYP2C19',
    phenotype_advisories: {
      poor_metabolizer: {
        category: 'use_alternative',
        severity: 'high',
        summary: 'CYP2C19 poor metabolizers have reduced clopidogrel activation and increased cardiovascular risk. Consider alternative antiplatelet (ticagrelor or prasugrel).',
        actions: [
          'Consider switching to ticagrelor or prasugrel if not contraindicated.',
          'Discuss bleeding risk and alternative agent choice with the prescribing cardiologist.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'moderate',
        summary: 'CYP2C19 intermediate metabolizers have partially reduced clopidogrel activation; consider alternative antiplatelet or higher surveillance.',
        actions: [
          'Weigh alternative antiplatelet therapy, particularly for acute coronary syndrome or PCI.',
          'If clopidogrel is continued, counsel on signs of thrombotic failure.',
        ],
      },
      ultra_rapid_metabolizer: {
        category: 'standard_dose',
        severity: 'low',
        summary: 'CYP2C19 ultra-rapid metabolizers have normal-to-enhanced clopidogrel activation.',
        actions: ['No adjustment required for PGx reasons.'],
      },
    },
  },
  {
    medication_pattern: /warfarin/i,
    display: 'Warfarin',
    gene: 'CYP2C9',
    phenotype_advisories: {
      poor_metabolizer: {
        category: 'consider_dose_change',
        severity: 'high',
        summary: 'CYP2C9 poor metabolizers require genotype-guided warfarin dosing (typically 30-50% reduction from standard starting dose). Check VKORC1 as well.',
        actions: [
          'Use CYP2C9 + VKORC1 genotype-guided starting dose (CPIC algorithm).',
          'Schedule more frequent INR monitoring during initiation.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'moderate',
        summary: 'CYP2C9 intermediate metabolizers require modest warfarin dose reduction and closer INR monitoring.',
        actions: [
          'Apply genotype-guided dose reduction per CPIC algorithm.',
          'Increase INR check frequency during the first two weeks.',
        ],
      },
    },
  },
  {
    medication_pattern: /warfarin/i,
    display: 'Warfarin (VKORC1)',
    gene: 'VKORC1',
    phenotype_advisories: {
      poor_metabolizer: {
        category: 'consider_dose_change',
        severity: 'high',
        summary: 'VKORC1 variant reduces warfarin dose requirement; use genotype-guided dosing alongside CYP2C9.',
        actions: [
          'Apply CPIC genotype-guided dosing combining VKORC1 + CYP2C9.',
          'Counsel patient on closer INR monitoring.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'moderate',
        summary: 'VKORC1 variant affects warfarin sensitivity; use genotype-guided dosing.',
        actions: [
          'Apply CPIC genotype-guided dosing combining VKORC1 + CYP2C9.',
        ],
      },
    },
  },
  {
    medication_pattern: /codeine/i,
    display: 'Codeine',
    gene: 'CYP2D6',
    phenotype_advisories: {
      ultra_rapid_metabolizer: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'CYP2D6 ultra-rapid metabolizers convert codeine to morphine excessively, risking life-threatening opioid toxicity. Codeine is contraindicated.',
        actions: [
          'Avoid codeine; select a non-CYP2D6-dependent analgesic (e.g., morphine, hydromorphone).',
          'Do not substitute tramadol — same CYP2D6 pathway.',
        ],
      },
      poor_metabolizer: {
        category: 'use_alternative',
        severity: 'high',
        summary: 'CYP2D6 poor metabolizers derive little analgesia from codeine because they cannot activate it to morphine.',
        actions: [
          'Select a non-CYP2D6-dependent analgesic (e.g., morphine, hydromorphone, or a non-opioid option).',
          'Do not escalate codeine dose to compensate — toxicity risk.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'moderate',
        summary: 'CYP2D6 intermediate metabolizers may experience reduced analgesia; monitor response and consider alternative.',
        actions: [
          'Monitor analgesic response; if inadequate, switch to non-CYP2D6-dependent agent.',
        ],
      },
    },
  },
  {
    medication_pattern: /tramadol/i,
    display: 'Tramadol',
    gene: 'CYP2D6',
    phenotype_advisories: {
      ultra_rapid_metabolizer: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'CYP2D6 ultra-rapid metabolizers over-activate tramadol to its opioid metabolite, risking severe toxicity.',
        actions: [
          'Avoid tramadol; use a non-CYP2D6-dependent analgesic.',
        ],
      },
      poor_metabolizer: {
        category: 'use_alternative',
        severity: 'high',
        summary: 'CYP2D6 poor metabolizers get minimal analgesia from tramadol.',
        actions: [
          'Select a non-CYP2D6-dependent analgesic (e.g., morphine or a non-opioid).',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'moderate',
        summary: 'CYP2D6 intermediate metabolizers may experience reduced tramadol analgesia.',
        actions: [
          'Monitor analgesic response; consider alternative if inadequate.',
        ],
      },
    },
  },
  {
    medication_pattern: /simvastatin/i,
    display: 'Simvastatin',
    gene: 'SLCO1B1',
    phenotype_advisories: {
      poor_metabolizer: {
        category: 'consider_dose_change',
        severity: 'high',
        summary: 'SLCO1B1 decreased function raises simvastatin exposure and myopathy risk. Reduce dose or switch to an alternative statin (pravastatin, rosuvastatin).',
        actions: [
          'Avoid simvastatin 80 mg; consider 20 mg ceiling or switch to pravastatin/rosuvastatin.',
          'Counsel patient on muscle pain/weakness and consider CK monitoring.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'moderate',
        summary: 'SLCO1B1 intermediate function modestly increases simvastatin myopathy risk. Prefer a lower dose or an alternative statin.',
        actions: [
          'Prefer lower simvastatin dose (20-40 mg) or consider rosuvastatin/pravastatin.',
        ],
      },
    },
  },
  {
    medication_pattern: /azathioprine/i,
    display: 'Azathioprine',
    gene: 'TPMT',
    phenotype_advisories: {
      deficient: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'TPMT deficiency causes life-threatening myelosuppression on standard-dose azathioprine. Avoid or use drastic dose reduction with specialist oversight.',
        actions: [
          'Avoid azathioprine; if no alternative, reduce to ~10% of standard dose with weekly CBC monitoring.',
          'Specialist (haematology / rheumatology) oversight mandatory.',
        ],
      },
      poor_metabolizer: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'TPMT poor metabolizers have severely reduced thiopurine inactivation and extreme myelosuppression risk.',
        actions: [
          'Avoid azathioprine; if unavoidable, drastic dose reduction (~10%) with close haematology monitoring.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'high',
        summary: 'TPMT intermediate metabolizers require 30-70% dose reduction and closer CBC monitoring.',
        actions: [
          'Start at 30-70% of standard dose.',
          'Monitor CBC weekly during the first 4-8 weeks.',
        ],
      },
    },
  },
  {
    medication_pattern: /6[-\s]?mercaptopurine|mercaptopurine/i,
    display: '6-Mercaptopurine',
    gene: 'TPMT',
    phenotype_advisories: {
      deficient: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'TPMT deficiency causes severe myelosuppression on 6-MP. Avoid or use 10% dose with specialist oversight.',
        actions: [
          'Avoid 6-MP; if unavoidable, ~10% of standard dose with weekly CBC monitoring.',
          'Specialist oversight mandatory.',
        ],
      },
      poor_metabolizer: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'TPMT poor metabolizers cannot safely receive standard 6-MP dosing.',
        actions: [
          'Avoid 6-MP or reduce to ~10% with close haematology monitoring.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'high',
        summary: 'TPMT intermediate metabolizers require 30-70% dose reduction on 6-MP.',
        actions: [
          'Start at 30-70% of standard dose.',
          'Monitor CBC weekly during induction.',
        ],
      },
    },
  },
  {
    medication_pattern: /fluorouracil|5[-\s]?fu|capecitabine/i,
    display: 'Fluorouracil / Capecitabine',
    gene: 'DPYD',
    phenotype_advisories: {
      deficient: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'DPYD deficiency causes life-threatening fluoropyrimidine toxicity (mucositis, neutropenia, death). Avoid 5-FU and capecitabine.',
        actions: [
          'Avoid fluoropyrimidines; select an alternative regimen with oncology.',
          'If no alternative exists, drastic dose reduction with specialist oversight and toxicity monitoring.',
        ],
      },
      poor_metabolizer: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'DPYD poor metabolizers cannot safely receive standard fluoropyrimidine dosing.',
        actions: [
          'Avoid 5-FU/capecitabine or use drastic dose reduction (~50% or lower) under oncology oversight.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'high',
        summary: 'DPYD intermediate metabolizers require ~50% fluoropyrimidine dose reduction with tight toxicity monitoring.',
        actions: [
          'Reduce starting dose by ~50% per CPIC guidance.',
          'Monitor for early myelosuppression and mucositis.',
        ],
      },
    },
  },
  {
    medication_pattern: /irinotecan/i,
    display: 'Irinotecan',
    gene: 'UGT1A1',
    phenotype_advisories: {
      poor_metabolizer: {
        category: 'consider_dose_change',
        severity: 'high',
        summary: 'UGT1A1 poor metabolizers (e.g., *28/*28) have increased irinotecan toxicity — severe neutropenia and diarrhoea.',
        actions: [
          'Reduce starting dose per oncology protocol (commonly 25-30% reduction).',
          'Monitor CBC and for delayed diarrhoea.',
        ],
      },
      intermediate_metabolizer: {
        category: 'consider_dose_change',
        severity: 'moderate',
        summary: 'UGT1A1 intermediate metabolizers have modestly elevated irinotecan toxicity risk; consider dose caution at higher regimens.',
        actions: [
          'Consider dose reduction at higher irinotecan regimens.',
          'Counsel on diarrhoea management.',
        ],
      },
    },
  },
  {
    medication_pattern: /abacavir/i,
    display: 'Abacavir',
    gene: 'HLA_B_5701',
    phenotype_advisories: {
      positive: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'HLA-B*57:01 positive patients have high risk of severe hypersensitivity reaction to abacavir. Contraindicated.',
        actions: [
          'Do not prescribe abacavir.',
          'Select an alternative antiretroviral backbone (e.g., tenofovir-based).',
        ],
      },
    },
  },
  {
    medication_pattern: /carbamazepine/i,
    display: 'Carbamazepine',
    gene: 'HLA_B_1502',
    phenotype_advisories: {
      positive: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'HLA-B*15:02 positive patients (most common in Han Chinese, Thai, Malay, Indian populations) have very high risk of Stevens-Johnson syndrome / TEN on carbamazepine. Contraindicated.',
        actions: [
          'Do not prescribe carbamazepine; check for HLA-B*15:02 cross-risk with oxcarbazepine and phenytoin.',
          'Select an alternative anticonvulsant (e.g., levetiracetam, valproate).',
        ],
      },
    },
  },
  {
    medication_pattern: /primaquine|rasburicase|dapsone/i,
    display: 'Primaquine / Rasburicase / Dapsone',
    gene: 'G6PD',
    phenotype_advisories: {
      deficient: {
        category: 'contraindicated',
        severity: 'critical',
        summary: 'G6PD deficiency increases risk of acute haemolytic anaemia with oxidative drugs. Primaquine, rasburicase, and dapsone are contraindicated.',
        actions: [
          'Avoid the medication; select a non-oxidative alternative.',
          'Counsel patient on other G6PD trigger drugs and foods (fava beans).',
        ],
      },
    },
  },
  {
    medication_pattern: /omeprazole|esomeprazole|lansoprazole|pantoprazole/i,
    display: 'Proton Pump Inhibitors (CYP2C19)',
    gene: 'CYP2C19',
    phenotype_advisories: {
      poor_metabolizer: {
        category: 'standard_dose',
        severity: 'low',
        summary: 'CYP2C19 poor metabolizers have increased PPI exposure and potentially greater acid suppression; standard dosing usually acceptable but monitor for over-suppression on long-term therapy.',
        actions: [
          'Standard dose acceptable. Consider step-down on long-term therapy.',
        ],
      },
      ultra_rapid_metabolizer: {
        category: 'consider_dose_change',
        severity: 'moderate',
        summary: 'CYP2C19 ultra-rapid metabolizers have reduced PPI exposure; therapeutic failure is common at standard doses.',
        actions: [
          'Consider a higher or more frequent PPI dose, or switch to a CYP2C19-independent agent (e.g., rabeprazole has less CYP2C19 dependence).',
          'Reassess symptom control at 2-4 weeks.',
        ],
      },
    },
  },
];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
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

function toNullableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
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

function normalizeGene(value) {
  const s = cleanText(value).toUpperCase().replace(/[\s*:-]+/g, '_');
  // Collapse accidental double underscores (e.g. HLA-B*57:01 → HLA_B_57_01 → HLA_B_5701)
  const collapsed = s.replace(/_0+/g, '_').replace(/__+/g, '_');
  // Map HLA_B_57_01 → HLA_B_5701
  if (/^HLA_B_57_?0?1$/i.test(collapsed)) return 'HLA_B_5701';
  if (/^HLA_B_15_?0?2$/i.test(collapsed)) return 'HLA_B_1502';
  return collapsed;
}

function normalizePhenotype(value) {
  return cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Returns every reference entry whose medication_pattern matches the
 * supplied medication name. Multiple entries may be returned for drugs
 * with more than one relevant gene (e.g. warfarin covers CYP2C9 + VKORC1).
 */
export function lookupPgxReference(medicationName) {
  const name = cleanText(medicationName);
  if (!name) return [];
  return PGX_REFERENCE.filter((entry) => entry.medication_pattern.test(name));
}

/**
 * Given an array of category strings, returns the highest-priority one per
 * CATEGORY_PRIORITY. Unknown categories are treated as the lowest ('unknown').
 */
export function escalateAdvisoryCategory(categories) {
  const list = asArray(categories);
  if (!list.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = CATEGORY_PRIORITY.indexOf('unknown');
  for (const cat of list) {
    const normalized = ADVISORY_CATEGORIES.has(cat) ? cat : 'unknown';
    const idx = CATEGORY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

function escalateSeverity(severities) {
  const list = asArray(severities);
  if (!list.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = SEVERITY_PRIORITY.indexOf('unknown');
  for (const sev of list) {
    const normalized = SEVERITIES.has(sev) ? sev : 'unknown';
    const idx = SEVERITY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

function appendDisclaimer(actions) {
  const list = asArray(actions).map((a) => cleanText(a)).filter(Boolean);
  if (!list.some((line) => line.toLowerCase().includes('decision support only'))) {
    list.push(REVIEW_DISCLAIMER);
  }
  return list;
}

/**
 * Evaluate a medication against a patient's genotype list.
 *
 * genotypes: Array<{ gene, phenotype, verified?, tested_at?, genotype_detail? }>
 *
 * Returns { advisory_category, severity, summary, matched_genes, recommended_actions }.
 */
export function evaluatePgxAdvisory({ medicationName, genotypes = [] } = {}) {
  const name = cleanText(medicationName);
  const references = lookupPgxReference(name);

  if (!references.length) {
    return {
      advisory_category: 'no_action',
      severity: 'low',
      summary: `No PGx consideration on file for ${name || 'this medication'}.`,
      matched_genes: [],
      recommended_actions: appendDisclaimer(['No PGx adjustment required for this medication.']),
    };
  }

  // Index the patient's genotypes by normalized gene key for fast lookup.
  const genotypeByGene = new Map();
  for (const g of asArray(genotypes)) {
    if (!g) continue;
    const gene = normalizeGene(g.gene);
    if (!gene) continue;
    // Keep the first verified entry if any; else fall back to whichever we saw first.
    const existing = genotypeByGene.get(gene);
    if (!existing) {
      genotypeByGene.set(gene, g);
      continue;
    }
    if (!existing.verified && g.verified) {
      genotypeByGene.set(gene, g);
    }
  }

  const matched = [];
  const categories = [];
  const severities = [];
  const summaries = [];
  const actions = [];
  const missingGenes = [];

  for (const ref of references) {
    const geneKey = normalizeGene(ref.gene);
    const gt = genotypeByGene.get(geneKey);
    if (!gt) {
      missingGenes.push({ gene: geneKey, medication: ref.display });
      continue;
    }
    const phenotype = normalizePhenotype(gt.phenotype);
    const advisory = ref.phenotype_advisories?.[phenotype];
    if (!advisory) {
      // Known gene, but phenotype has no specific advisory in the reference
      // (e.g. normal_metabolizer for a drug that only flags extremes).
      matched.push({
        gene: geneKey,
        phenotype,
        genotype_detail: gt.genotype_detail || null,
        verified: Boolean(gt.verified),
        tested_at: gt.tested_at || null,
        medication_display: ref.display,
        category: 'standard_dose',
        severity: 'low',
        summary: `${ref.display}: ${geneKey} ${phenotype} — standard dosing per reference.`,
      });
      categories.push('standard_dose');
      severities.push('low');
      summaries.push(`${ref.display}: ${geneKey} ${phenotype} — standard dosing.`);
      continue;
    }
    matched.push({
      gene: geneKey,
      phenotype,
      genotype_detail: gt.genotype_detail || null,
      verified: Boolean(gt.verified),
      tested_at: gt.tested_at || null,
      medication_display: ref.display,
      category: advisory.category,
      severity: advisory.severity,
      summary: advisory.summary,
    });
    categories.push(advisory.category);
    severities.push(advisory.severity);
    summaries.push(`${ref.display} (${geneKey} ${phenotype}): ${advisory.summary}`);
    for (const line of asArray(advisory.actions)) actions.push(line);
  }

  if (!matched.length) {
    // Reference exists for this medication, but no relevant genotype on file.
    return {
      advisory_category: 'testing_recommended',
      severity: 'low',
      summary: `${name}: PGx testing may inform dosing (relevant gene${missingGenes.length === 1 ? '' : 's'}: ${missingGenes.map((m) => m.gene).join(', ')}).`,
      matched_genes: [],
      recommended_actions: appendDisclaimer([
        `Consider pharmacogenomic testing for ${missingGenes.map((m) => m.gene).join(', ')} before starting or continuing ${name}.`,
        'Until results are available, use standard dosing with clinical monitoring.',
      ]),
    };
  }

  const finalCategory = escalateAdvisoryCategory(categories);
  const finalSeverity = escalateSeverity(severities);

  // Build a headline summary focused on the dominant match.
  const dominant = matched.find((m) => m.category === finalCategory) || matched[0];
  const summary = dominant
    ? `${name}: ${finalCategory.replace(/_/g, ' ')} — ${dominant.summary}`
    : `${name}: ${finalCategory.replace(/_/g, ' ')}.`;

  return {
    advisory_category: finalCategory,
    severity: finalSeverity,
    summary,
    matched_genes: matched,
    recommended_actions: appendDisclaimer(actions.length ? actions : ['Review genotype-guided recommendation with pharmacist.']),
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

export async function upsertPatientGenotype({
  tenantId = null,
  patientUid,
  gene,
  phenotype,
  genotypeDetail = null,
  source = null,
  sourceReportId = null,
  testedAt = null,
  verified = false,
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!patientUid || !cleanText(patientUid)) {
    throw AppError.badRequest('patient_uid is required');
  }
  const geneKey = normalizeGene(gene);
  if (!geneKey || !SUPPORTED_GENES.has(geneKey)) {
    throw AppError.badRequest(`gene must be one of: ${Array.from(SUPPORTED_GENES).join(', ')}`);
  }
  const phenotypeKey = normalizePhenotype(phenotype);
  if (!phenotypeKey || !SUPPORTED_PHENOTYPES.has(phenotypeKey)) {
    throw AppError.badRequest(`phenotype must be one of: ${Array.from(SUPPORTED_PHENOTYPES).join(', ')}`);
  }
  const testedDate = toNullableDate(testedAt);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_patient_genotypes
         (tenant_id, patient_uid, gene, phenotype, genotype_detail, source,
          source_report_id, tested_at, verified, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::date, $9, $10::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, patient_uid, gene)
       DO UPDATE SET
         phenotype = EXCLUDED.phenotype,
         genotype_detail = EXCLUDED.genotype_detail,
         source = EXCLUDED.source,
         source_report_id = EXCLUDED.source_report_id,
         tested_at = EXCLUDED.tested_at,
         verified = EXCLUDED.verified,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, patient_uid, gene, phenotype, genotype_detail,
                 source, source_report_id, tested_at, verified, metadata,
                 created_at, updated_at`,
      tid,
      patientUid,
      geneKey,
      phenotypeKey,
      genotypeDetail ? cleanText(genotypeDetail) : null,
      source ? cleanText(source) : null,
      sourceReportId ? cleanText(sourceReportId) : null,
      testedDate,
      Boolean(verified),
      JSON.stringify(metadata || {})
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listPatientGenotypes({
  tenantId = null,
  patientUid,
  gene = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!patientUid || !cleanText(patientUid)) {
    throw AppError.badRequest('patient_uid is required');
  }
  const geneKey = gene ? normalizeGene(gene) : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, gene, phenotype, genotype_detail,
              source, source_report_id, tested_at, verified, metadata,
              created_at, updated_at
       FROM clinical_ai_patient_genotypes
       WHERE tenant_id = $1::uuid
         AND patient_uid = $2::uuid
         AND ($3::text IS NULL OR gene = $3)
       ORDER BY gene ASC, created_at DESC`,
      tid,
      patientUid,
      geneKey
    );
    return { genotypes: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { genotypes: [], count: 0 };
    throw err;
  }
}

async function loadPatientGenotypesRaw(tenantId, patientUid) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, gene, phenotype, genotype_detail, source, source_report_id,
              tested_at, verified
       FROM clinical_ai_patient_genotypes
       WHERE tenant_id = $1::uuid
         AND patient_uid = $2::uuid`,
      tenantId,
      patientUid
    );
    return rows;
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    logger.warn('PGx: patient genotype load failed', { error: err.message });
    return [];
  }
}

async function insertGeneration({
  tenantId,
  patientUid,
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
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, NULL, $3, $3, $4, $5, $6, $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::uuid, $14, $15, $16,
               $17, $18, $19, $20, $21::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
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
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('PGx: generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, NULL, 'pending', $5::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['DOCTOR', 'PHARMACIST', 'PHARMACY_STAFF', 'ADMIN'],
        source: 'pharmacogenomics_support',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('PGx: review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function buildSafetyFlags({ evaluation, citations }) {
  const flags = [];
  switch (evaluation.advisory_category) {
    case 'contraindicated':
      flags.push({
        severity: 'critical',
        code: 'PGX_CONTRAINDICATED',
        message: 'Patient genotype contraindicates this medication; pharmacist/clinician review required before administration.',
      });
      break;
    case 'use_alternative':
      flags.push({
        severity: 'high',
        code: 'PGX_USE_ALTERNATIVE',
        message: 'Patient genotype suggests an alternative medication is more appropriate.',
      });
      break;
    case 'consider_dose_change':
      flags.push({
        severity: 'medium',
        code: 'PGX_CONSIDER_DOSE_CHANGE',
        message: 'Patient genotype suggests a dose adjustment may be appropriate.',
      });
      break;
    case 'testing_recommended':
      flags.push({
        severity: 'low',
        code: 'PGX_TESTING_RECOMMENDED',
        message: 'PGx testing may inform dosing for this medication.',
      });
      break;
    default:
      break;
  }
  if (!citations || !citations.length) {
    flags.push({
      severity: 'medium',
      code: 'PGX_NO_CITATIONS',
      message: 'PGx advisory has no source citations.',
    });
  }
  return flags;
}

function buildNarrativePrompt({ prompt, draft }) {
  return `${prompt.user_prompt_template}\n\n${JSON.stringify({
    rules_authoritative: true,
    decision_support_only: true,
    medication_name: draft.medication_name,
    patient_uid: draft.patient_uid,
    advisory_category: draft.advisory_category,
    severity: draft.severity,
    matched_genes: draft.matched_genes,
    rule_based_summary: draft.summary,
    rule_based_actions: draft.recommended_actions,
  })}`;
}

function normalizeAiDraft(parsed, fallbackDraft) {
  if (!parsed || typeof parsed !== 'object') return fallbackDraft;
  return {
    ...fallbackDraft,
    // Narrative is decorative; never let AI override advisory_category, severity, or matched_genes.
    summary: cleanText(parsed.summary) || fallbackDraft.summary,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed.source_citations),
    ]),
  };
}

export async function generatePgxAdvisory({
  req = null,
  patientUid,
  medicationName,
  prescriptionId = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  if (!patientUid || !cleanText(patientUid)) {
    throw AppError.badRequest('patient_uid is required');
  }
  const cleanedMedication = cleanText(medicationName);
  if (!cleanedMedication) {
    throw AppError.badRequest('medication_name is required');
  }
  const safePrescriptionId = prescriptionId ? optionalInt(prescriptionId, 'prescription_id') : null;

  const genotypes = await loadPatientGenotypesRaw(tenantId, patientUid);
  const evaluation = evaluatePgxAdvisory({
    medicationName: cleanedMedication,
    genotypes,
  });

  const citations = [
    {
      source_type: 'patient',
      source_id: String(patientUid),
      label: 'Patient record',
      timestamp: null,
    },
    ...asArray(evaluation.matched_genes).map((m) => ({
      source_type: 'patient_genotype',
      source_id: `${m.gene}:${m.phenotype}`,
      label: `Genotype — ${m.gene} ${m.phenotype}${m.genotype_detail ? ` (${m.genotype_detail})` : ''}`,
      timestamp: m.tested_at || null,
    })),
    {
      source_type: 'pgx_reference',
      source_id: MODULE_KEY,
      label: `PGx reference — ${cleanedMedication}`,
      timestamp: null,
    },
  ];
  const uniqueCits = uniqueCitations(citations);

  const safetyFlags = buildSafetyFlags({ evaluation, citations: uniqueCits });

  const safeCategory = ADVISORY_CATEGORIES.has(evaluation.advisory_category)
    ? evaluation.advisory_category
    : 'unknown';
  const safeSeverity = SEVERITIES.has(evaluation.severity) ? evaluation.severity : 'unknown';

  const fallbackDraft = {
    module_key: MODULE_KEY,
    patient_uid: patientUid,
    prescription_id: safePrescriptionId,
    medication_name: cleanedMedication,
    advisory_category: safeCategory,
    severity: safeSeverity,
    summary: evaluation.summary,
    matched_genes: evaluation.matched_genes,
    recommended_actions: evaluation.recommended_actions,
    source_citations: uniqueCits,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = { usedAi: false, provider: 'template', model: null, text: '', usage: {} };
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: buildNarrativePrompt({ prompt, draft: fallbackDraft }),
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
  } catch (err) {
    logger.warn('PGx: AI narrative failed (non-fatal)', { error: err.message });
  }
  const parsed = safeJsonParse(aiResult?.text, {});
  const draft = normalizeAiDraft(parsed, fallbackDraft);

  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        patient: { uid: patientUid },
        medication: { name: cleanedMedication, prescription_id: safePrescriptionId },
      },
      citations: uniqueCits,
    }),
  ];
  draft.safety_flags = combinedFlags;

  const generation = await insertGeneration({
    tenantId,
    patientUid,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      patient_uid: patientUid,
      medication: normalizedText(cleanedMedication),
      prescription_id: safePrescriptionId,
      genotypes: genotypes.map((g) => ({
        gene: normalizeGene(g.gene),
        phenotype: normalizePhenotype(g.phenotype),
      })),
    }),
    draft,
    citations: uniqueCits,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      prescription_id: safePrescriptionId,
      tenant_region: req?.tenant?.region || null,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  let advisoryRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_pgx_advisories
         (tenant_id, patient_uid, prescription_id, generation_id, medication_name,
          matched_genes, advisory_category, severity, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb, 'pending', $13::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, prescription_id, generation_id,
                 medication_name, matched_genes, advisory_category, severity,
                 summary, recommended_actions, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      patientUid,
      safePrescriptionId,
      generation?.id || null,
      cleanedMedication,
      JSON.stringify(evaluation.matched_genes),
      safeCategory,
      safeSeverity,
      draft.summary,
      JSON.stringify(draft.recommended_actions),
      JSON.stringify(uniqueCits),
      JSON.stringify(combinedFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    advisoryRow = rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      advisory_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: uniqueCits,
      safety_flags: combinedFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_pgx_advisories_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    patientUid,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.pgx_advisory_generated',
    aggregateType: 'clinical_ai_pgx_advisory',
    aggregateId: advisoryRow?.id || generation?.id || null,
    patientUid,
    payload: {
      tenant_id: tenantId,
      advisory_id: advisoryRow?.id || null,
      generation_id: generation?.id || null,
      prescription_id: safePrescriptionId,
      medication_name: cleanedMedication,
      advisory_category: safeCategory,
      severity: safeSeverity,
      matched_gene_count: asArray(evaluation.matched_genes).length,
    },
  });

  return {
    advisory_id: advisoryRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    advisory: advisoryRow,
    source_citations: uniqueCits,
    safety_flags: combinedFlags,
    advisory_category: safeCategory,
    severity: safeSeverity,
    matched_genes: evaluation.matched_genes,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || advisoryRow?.reviewer_decision || 'pending',
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

export async function listPgxAdvisories({
  tenantId = null,
  patientUid = null,
  advisoryCategory = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedCategory = advisoryCategory && ADVISORY_CATEGORIES.has(cleanText(advisoryCategory).toLowerCase())
    ? cleanText(advisoryCategory).toLowerCase()
    : null;
  const normalizedSeverity = severity && SEVERITIES.has(cleanText(severity).toLowerCase())
    ? cleanText(severity).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.patient_uid, u.name AS patient_name,
              a.prescription_id, a.generation_id, a.medication_name,
              a.matched_genes, a.advisory_category, a.severity, a.summary,
              a.recommended_actions, a.source_citations, a.safety_flags,
              a.reviewer_decision, a.reviewed_by, a.reviewed_at, a.reviewer_note,
              a.metadata, a.created_at, a.updated_at
       FROM clinical_ai_pgx_advisories a
       LEFT JOIN users u ON u.uid = a.patient_uid
       WHERE a.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR a.patient_uid = $2::uuid)
         AND ($3::text IS NULL OR a.advisory_category = $3)
         AND ($4::text IS NULL OR a.severity = $4)
         AND ($5::text IS NULL OR a.reviewer_decision = $5)
       ORDER BY
         CASE a.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         a.created_at DESC
       LIMIT $6`,
      tid,
      patientUid || null,
      normalizedCategory,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    return { advisories: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { advisories: [], count: 0 };
    throw err;
  }
}

export async function decidePgxAdvisory({
  tenantId = null,
  advisoryId,
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
    `UPDATE clinical_ai_pgx_advisories
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, patient_uid, prescription_id, generation_id, medication_name,
               matched_genes, advisory_category, severity, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(advisoryId, 'advisory_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('PGx advisory not found');
  // toNumber retained for interface parity if callers coerce numeric fields.
  const row = rows[0];
  return {
    ...row,
    prescription_id: row.prescription_id !== null && row.prescription_id !== undefined
      ? toNumber(row.prescription_id, null)
      : null,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

export default {
  PGX_REFERENCE,
  lookupPgxReference,
  evaluatePgxAdvisory,
  escalateAdvisoryCategory,
  upsertPatientGenotype,
  listPatientGenotypes,
  generatePgxAdvisory,
  listPgxAdvisories,
  decidePgxAdvisory,
};
