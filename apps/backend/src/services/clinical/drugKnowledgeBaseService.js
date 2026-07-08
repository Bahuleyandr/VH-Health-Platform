// src/services/clinical/drugKnowledgeBaseService.js
//
// Roadmap B2 — drug knowledge base evaluation engine.
//
// Reads the drug_kb_* tables (migration 277) and screens a medication list
// for: drug–drug interactions, allergy cross-sensitivity (group-based),
// drug–disease cautions (against the B7 problem list), dose-range ceilings
// (adult flat / paediatric mg-kg / renal), and IV Y-site compatibility.
//
// Design rules:
//   * NEVER throws schema errors out — validatePrescriptionSafety fails
//     CLOSED on any exception, and a missing KB table must not brick
//     prescribing on an environment that has not migrated yet. Engine
//     returns { kbAvailable:false, findings:[] } instead.
//   * Matching follows the platform's free-text reality: monograph keys +
//     alias lists (Indian brand names) are matched case-insensitive
//     substring against the prescription text, same approach as the
//     antithrombotic / paediatric tables in prescriptionSafetyCheck.js.
//   * The KB is loaded once and TTL-cached (5 min) — per-prescription
//     evaluation is pure in-memory work after that.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const KB_CACHE_TTL_MS = 5 * 60 * 1000;
let kbCache = { loadedAt: 0, kb: null };

/** Test hook — drop the cache so a fresh load sees newly seeded rows. */
export function __resetDrugKbCache() {
  kbCache = { loadedAt: 0, kb: null };
}

function isSchemaMissing(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === '42P01'
    || code === '42703'
    || /relation .* does not exist|column .* does not exist/i.test(String(err?.message || ''));
}

/** Canonical (a<b) interaction pair key — exported for unit tests. */
export function canonicalPair(a, b) {
  const x = String(a || '').toLowerCase().trim();
  const y = String(b || '').toLowerCase().trim();
  return x < y ? [x, y] : [y, x];
}

function comparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FREQUENCY_PER_DAY = Object.freeze({
  od: 1, qd: 1, 'once daily': 1, daily: 1, om: 1, on: 1, hs: 1, nocte: 1, stat: 1, 'once': 1,
  bd: 2, bid: 2, 'twice daily': 2, 'q12h': 2,
  tds: 3, tid: 3, 'thrice daily': 3, 'three times': 3, 'q8h': 3,
  qid: 4, qds: 4, 'four times': 4, 'q6h': 4,
  'q4h': 6,
});

/**
 * Parse a frequency token ('BD', '1-0-1', 'q8h', 'TDS') to doses/day.
 * Returns null when unparseable or PRN/SOS (daily totals unbounded by
 * schedule are skipped rather than guessed). Exported for unit tests.
 */
export function frequencyPerDay(text) {
  const raw = String(text || '').toLowerCase().trim();
  if (!raw) return null;
  if (/\b(prn|sos|as needed|when required)\b/.test(raw)) return null;
  // 1-0-1 style notation
  const pattern = raw.match(/^([0-9]+(?:\.[05])?)\s*-\s*([0-9]+(?:\.[05])?)\s*-\s*([0-9]+(?:\.[05])?)(?:\s*-\s*([0-9]+(?:\.[05])?))?$/);
  if (pattern) {
    const total = pattern.slice(1).filter(Boolean).reduce((sum, n) => sum + Number.parseFloat(n), 0);
    return total > 0 ? total : null;
  }
  // Exact token first ('qds' must not substring-match 'qd'), then longest
  // substring token wins ('four times' before 'om').
  if (FREQUENCY_PER_DAY[raw] != null) return FREQUENCY_PER_DAY[raw];
  const tokensByLength = Object.entries(FREQUENCY_PER_DAY).sort((a, b) => b[0].length - a[0].length);
  for (const [token, perDay] of tokensByLength) {
    if (token.length >= 2 && raw.includes(token)) return perDay;
  }
  const everyH = raw.match(/every\s+(\d+)\s*h|q(\d+)h/);
  if (everyH) {
    const hours = Number.parseInt(everyH[1] || everyH[2], 10);
    if (Number.isInteger(hours) && hours >= 1 && hours <= 24) return Math.floor(24 / hours);
  }
  return null;
}

const DOSE_MG_RX = /(-?\d+(?:\.\d+)?)\s*(mg|g|mcg|µg)\b/i;
const MG_PER_KG_TOKEN_RX = /\d+(?:\.\d+)?\s*mg\s*\/\s*kg/i;
const STRENGTH_TOKEN_RX = /\d+(?:\.\d+)?\s*mg\s*\/\s*\d*\s*ml/i;

/** Conservative flat-dose parse (mg). Skips mg/kg and syrup-strength text. */
export function parseFlatDoseMg(text) {
  const raw = String(text || '');
  if (!raw || MG_PER_KG_TOKEN_RX.test(raw) || STRENGTH_TOKEN_RX.test(raw)) return null;
  const m = raw.match(DOSE_MG_RX);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === 'mg') return value;
  if (unit === 'g') return value * 1000;
  return value / 1000; // mcg / µg
}

function medicationText(med) {
  return [med?.name, med?.medication_name, med?.drug_name, med?.generic_name, med?.strength]
    .filter(Boolean).join(' ').toLowerCase();
}

function medicationDisplay(med) {
  return String(med?.name || med?.medication_name || med?.drug_name || '').trim();
}

/**
 * Resolve which KB drugs a free-text medication matches. Pure — exported
 * for unit tests. `monographs` = [{ drug_key, aliases: [...] }].
 */
export function matchMonographKeys(monographs, medText) {
  const text = String(medText || '').toLowerCase();
  if (!text) return [];
  const hits = new Set();
  for (const mono of monographs) {
    if (text.includes(mono.drug_key)) { hits.add(mono.drug_key); continue; }
    if ((mono.aliases || []).some((alias) => alias && text.includes(String(alias).toLowerCase()))) {
      hits.add(mono.drug_key);
    }
  }
  return [...hits];
}

function priorityOf(row) {
  const priority = Number(row?.source_priority ?? row?.priority ?? 100);
  return Number.isFinite(priority) ? priority : 100;
}

function preferredRows(rows, keyFor) {
  const byKey = new Map();
  for (const row of rows || []) {
    const key = keyFor(row);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current || priorityOf(row) > priorityOf(current)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

async function loadKb() {
  if (kbCache.kb && Date.now() - kbCache.loadedAt < KB_CACHE_TTL_MS) return kbCache.kb;
  try {
    const [monographRows, interactionRows, groupRows, xreactRows, cautionRows, doseRows, ivPairRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT m.drug_key, m.display_name, m.drug_class, m.aliases, m.source_key,
                s.priority AS source_priority, s.is_starter
           FROM drug_kb_monographs m
           JOIN drug_kb_sources s ON s.source_key = m.source_key AND s.is_active
          ORDER BY s.priority DESC, s.is_starter ASC, s.source_key ASC`,
      ),
      prisma.$queryRawUnsafe(
        `SELECT i.drug_a_key, i.drug_b_key, i.severity, i.mechanism, i.effect, i.management, i.source_key,
                s.priority AS source_priority, s.is_starter
           FROM drug_kb_interactions i
           JOIN drug_kb_sources s ON s.source_key = i.source_key AND s.is_active
          ORDER BY s.priority DESC, s.is_starter ASC, s.source_key ASC`,
      ),
      prisma.$queryRawUnsafe(
        `SELECT g.group_key, g.member_key, g.source_key, s.priority AS source_priority, s.is_starter
           FROM drug_kb_allergy_groups g
           JOIN drug_kb_sources s ON s.source_key = g.source_key AND s.is_active
          ORDER BY s.priority DESC, s.is_starter ASC, s.source_key ASC`,
      ),
      prisma.$queryRawUnsafe(
        `SELECT x.group_key, x.reacts_with_group_key, x.risk, x.note, x.source_key,
                s.priority AS source_priority, s.is_starter
           FROM drug_kb_allergy_cross_reactivity x
           JOIN drug_kb_sources s ON s.source_key = x.source_key AND s.is_active
          ORDER BY s.priority DESC, s.is_starter ASC, s.source_key ASC`,
      ),
      prisma.$queryRawUnsafe(
        `SELECT c.drug_key, c.icd10_prefix, c.condition_label, c.risk, c.note, c.source_key,
                s.priority AS source_priority, s.is_starter
           FROM drug_kb_condition_cautions c
           JOIN drug_kb_sources s ON s.source_key = c.source_key AND s.is_active
          ORDER BY s.priority DESC, s.is_starter ASC, s.source_key ASC`,
      ),
      prisma.$queryRawUnsafe(
        `SELECT d.drug_key, d.route, d.population, d.max_single_dose_mg, d.max_daily_dose_mg,
                d.max_daily_mg_per_kg, d.min_egfr, d.egfr_max_daily_mg, d.note, d.source_key,
                s.priority AS source_priority, s.is_starter
           FROM drug_kb_dose_ranges d
           JOIN drug_kb_sources s ON s.source_key = d.source_key AND s.is_active
          ORDER BY s.priority DESC, s.is_starter ASC, s.source_key ASC`,
      ),
      prisma.$queryRawUnsafe(
        `SELECT v.drug_a_key, v.drug_b_key, v.compatibility, v.diluent, v.note, v.source_key,
                s.priority AS source_priority, s.is_starter
           FROM drug_kb_iv_compatibility v
           JOIN drug_kb_sources s ON s.source_key = v.source_key AND s.is_active
          ORDER BY s.priority DESC, s.is_starter ASC, s.source_key ASC`,
      ),
    ]);

    const monographs = preferredRows(monographRows, (row) => String(row.drug_key || '').toLowerCase());
    const interactions = preferredRows(interactionRows, (row) => {
      const [a, b] = canonicalPair(row.drug_a_key, row.drug_b_key);
      return `${a}|${b}`;
    });
    const groups = preferredRows(groupRows, (row) => (
      `${String(row.group_key || '').toLowerCase()}|${String(row.member_key || '').toLowerCase()}`
    ));
    const xreact = preferredRows(xreactRows, (row) => (
      `${String(row.group_key || '').toLowerCase()}|${String(row.reacts_with_group_key || '').toLowerCase()}`
    ));
    const cautions = preferredRows(cautionRows, (row) => (
      `${String(row.drug_key || '').toLowerCase()}|${String(row.icd10_prefix || '').toUpperCase()}`
    ));
    const doses = preferredRows(doseRows, (row) => (
      `${String(row.drug_key || '').toLowerCase()}|${String(row.route || 'any').toLowerCase()}|${String(row.population || '').toLowerCase()}`
    ));
    const ivPairs = preferredRows(ivPairRows, (row) => {
      const [a, b] = canonicalPair(row.drug_a_key, row.drug_b_key);
      return `${a}|${b}`;
    });

    const interactionIndex = new Map();
    for (const row of interactions) {
      const [a, b] = canonicalPair(row.drug_a_key, row.drug_b_key);
      interactionIndex.set(`${a}|${b}`, { ...row, drug_a_key: a, drug_b_key: b });
    }
    const groupsByMember = new Map();
    const membersByGroup = new Map();
    for (const row of groups) {
      const member = row.member_key.toLowerCase();
      if (!groupsByMember.has(member)) groupsByMember.set(member, new Set());
      groupsByMember.get(member).add(row.group_key);
      if (!membersByGroup.has(row.group_key)) membersByGroup.set(row.group_key, new Set());
      membersByGroup.get(row.group_key).add(member);
    }
    const xreactByGroup = new Map();
    for (const row of xreact) {
      if (!xreactByGroup.has(row.group_key)) xreactByGroup.set(row.group_key, []);
      xreactByGroup.get(row.group_key).push(row);
    }
    const cautionsByDrug = new Map();
    for (const row of cautions) {
      if (!cautionsByDrug.has(row.drug_key)) cautionsByDrug.set(row.drug_key, []);
      cautionsByDrug.get(row.drug_key).push(row);
    }
    const dosesByDrug = new Map();
    for (const row of doses) {
      if (!dosesByDrug.has(row.drug_key)) dosesByDrug.set(row.drug_key, []);
      dosesByDrug.get(row.drug_key).push(row);
    }
    const ivIndex = new Map();
    for (const row of ivPairs) {
      const [a, b] = canonicalPair(row.drug_a_key, row.drug_b_key);
      ivIndex.set(`${a}|${b}`, { ...row, drug_a_key: a, drug_b_key: b });
    }

    const kb = {
      monographs: monographs.map((m) => ({
        ...m,
        drug_key: m.drug_key.toLowerCase(),
        aliases: (m.aliases || []).map((a) => String(a).toLowerCase()),
      })),
      interactionIndex,
      groupsByMember,
      membersByGroup,
      xreactByGroup,
      cautionsByDrug,
      dosesByDrug,
      ivIndex,
      counts: {
        monographs: monographs.length,
        interactions: interactions.length,
        allergy_group_members: groups.length,
        cross_reactivity_edges: xreact.length,
        condition_cautions: cautions.length,
        dose_ranges: doses.length,
        iv_compatibility_pairs: ivPairs.length,
      },
    };
    kbCache = { loadedAt: Date.now(), kb };
    return kb;
  } catch (err) {
    if (isSchemaMissing(err)) {
      logger.warn('Drug KB tables unavailable — KB checks skipped (migrate 277 to enable)', {
        error: err?.message,
      });
      return null;
    }
    throw err;
  }
}

export async function drugKbStatus() {
  try {
    const sources = await prisma.$queryRawUnsafe(
      `SELECT source_key, name, vendor, version, license_note, is_starter, is_active,
              priority, source_family, edition_status, license_status, imported_at,
              accepted_at, activated_at, deactivated_at, metadata
         FROM drug_kb_sources
        ORDER BY is_active DESC, priority DESC, is_starter ASC, source_key`,
    );
    __resetDrugKbCache();
    const kb = await loadKb();
    return {
      kb_available: !!kb,
      sources,
      counts: kb?.counts || null,
      starter_only: sources.every((s) => !s.is_active || s.is_starter),
    };
  } catch (err) {
    if (isSchemaMissing(err)) return { kb_available: false, sources: [], counts: null, starter_only: null };
    throw err;
  }
}

function allergenGroups(kb, allergenText) {
  const text = comparableText(allergenText);
  const groups = new Set();
  if (!text) return groups;
  // Direct member-name hit ("amoxicillin"), group-name hit ("penicillins" /
  // "penicillin", "sulfa" → sulfonamides), substring either direction.
  for (const [member, memberGroups] of kb.groupsByMember.entries()) {
    const label = comparableText(member);
    if (text.includes(label) || label.includes(text)) {
      for (const g of memberGroups) groups.add(g);
    }
  }
  for (const groupKey of kb.membersByGroup.keys()) {
    const label = comparableText(groupKey);
    if (text.includes(label) || label.startsWith(text) || (text.length >= 4 && label.includes(text))) {
      groups.add(groupKey);
    }
  }
  if (/\bsulfa\b|sulpha/.test(text)) groups.add('sulfonamides');
  return groups;
}

/**
 * Evaluate the KB against a prescription. All context is passed explicitly
 * so the engine stays pure relative to the DB (besides the cached KB load):
 *
 *   evaluateDrugKb({
 *     medications: [{ name, dose, frequency, route, days }],
 *     allergies:   [{ allergen, severity }],
 *     problems:    [{ icd10_code, title }],          // B7 active problems
 *     patient:     { ageYears, weightKg, egfr },
 *   })
 *
 * Returns { kbAvailable, findings: [{ check, severity, drug_keys,
 * medications, message, management, source_key }] }.
 */
export async function evaluateDrugKb({ medications = [], allergies = [], problems = [], patient = {} } = {}) {
  const kb = await loadKb();
  if (!kb) return { kbAvailable: false, findings: [] };
  const findings = [];

  // Resolve each medication to KB drug keys once.
  const meds = (medications || []).map((med) => ({
    med,
    display: medicationDisplay(med),
    text: medicationText(med),
    keys: matchMonographKeys(kb.monographs, medicationText(med)),
  })).filter((m) => m.display);

  // 1. Drug–drug interactions (pairwise on resolved keys).
  const seenPairs = new Set();
  for (let i = 0; i < meds.length; i += 1) {
    for (let j = i + 1; j < meds.length; j += 1) {
      for (const keyA of meds[i].keys) {
        for (const keyB of meds[j].keys) {
          if (keyA === keyB) continue;
          const [a, b] = canonicalPair(keyA, keyB);
          const pairId = `${a}|${b}`;
          if (seenPairs.has(pairId)) continue;
          const hit = kb.interactionIndex.get(pairId);
          if (!hit) continue;
          seenPairs.add(pairId);
          findings.push({
            check: 'interaction',
            severity: hit.severity,
            drug_keys: [a, b],
            medications: [meds[i].display, meds[j].display],
            message: `${meds[i].display} + ${meds[j].display}: ${hit.effect || hit.mechanism || 'documented interaction'} (${hit.severity}).`,
            management: hit.management || null,
            mechanism: hit.mechanism || null,
            source_key: hit.source_key,
          });
        }
      }
    }
  }

  // 2. Allergy cross-sensitivity (group membership + cross-reactivity edges).
  for (const allergy of allergies || []) {
    const allergen = allergy?.allergen ?? allergy;
    const groups = allergenGroups(kb, allergen);
    if (groups.size === 0) continue;
    for (const entry of meds) {
      for (const drugKey of entry.keys) {
        const drugGroups = kb.groupsByMember.get(drugKey) || new Set();
        // Same-group: prescribing within the allergen's class.
        const shared = [...drugGroups].find((g) => groups.has(g));
        if (shared) {
          findings.push({
            check: 'allergy_cross_sensitivity',
            severity: 'high',
            drug_keys: [drugKey],
            medications: [entry.display],
            allergen: String(allergen),
            group: shared,
            message: `${entry.display} belongs to the ${shared} group — patient has a recorded ${allergen} allergy in the same class.`,
            management: 'Verify reaction history; choose an agent outside the class or override with reason.',
            source_key: 'kb',
          });
          continue;
        }
        // Cross-group edges (e.g. penicillins → cephalosporins).
        for (const allergenGroup of groups) {
          for (const edge of kb.xreactByGroup.get(allergenGroup) || []) {
            if (drugGroups.has(edge.reacts_with_group_key)) {
              findings.push({
                check: 'allergy_cross_sensitivity',
                severity: edge.risk === 'high' ? 'high' : 'moderate',
                drug_keys: [drugKey],
                medications: [entry.display],
                allergen: String(allergen),
                group: edge.reacts_with_group_key,
                message: `${entry.display} (${edge.reacts_with_group_key}) may cross-react with the patient's ${allergen} allergy (${allergenGroup} → ${edge.reacts_with_group_key}, ${edge.risk} risk).`,
                management: edge.note || 'Confirm reaction type and severity before proceeding.',
                source_key: edge.source_key,
              });
            }
          }
        }
      }
    }
  }

  // 3. Drug–disease cautions against the active problem list (ICD-10 prefix).
  const problemCodes = (problems || [])
    .map((p) => ({ code: String(p?.icd10_code || '').toUpperCase().trim(), title: p?.title || null }))
    .filter((p) => p.code);
  if (problemCodes.length > 0) {
    for (const entry of meds) {
      for (const drugKey of entry.keys) {
        for (const caution of kb.cautionsByDrug.get(drugKey) || []) {
          const prefix = caution.icd10_prefix.toUpperCase();
          const matched = problemCodes.find((p) => p.code.startsWith(prefix));
          if (!matched) continue;
          findings.push({
            check: 'condition_caution',
            severity: caution.risk === 'contraindicated' ? 'contraindicated' : 'moderate',
            drug_keys: [drugKey],
            medications: [entry.display],
            condition: caution.condition_label,
            problem_code: matched.code,
            problem_title: matched.title,
            message: `${entry.display} is ${caution.risk} in ${caution.condition_label} (active problem ${matched.code}${matched.title ? ` — ${matched.title}` : ''}).`,
            management: caution.note || null,
            source_key: caution.source_key,
          });
        }
      }
    }
  }

  // 4. Dose-range ceilings.
  const ageYears = Number(patient?.ageYears);
  const weightKg = Number(patient?.weightKg);
  const egfr = Number(patient?.egfr);
  const population = Number.isFinite(ageYears) && ageYears < 12 ? 'pediatric' : 'adult';
  for (const entry of meds) {
    const doseMg = parseFlatDoseMg(entry.med?.dose || entry.med?.dosage || '');
    const perDay = frequencyPerDay(entry.med?.frequency || entry.med?.freq || entry.med?.timing || '');
    const dailyMg = doseMg != null && perDay != null ? doseMg * perDay : null;
    for (const drugKey of entry.keys) {
      for (const range of kb.dosesByDrug.get(drugKey) || []) {
        if (range.population !== population) continue;
        if (range.route && entry.med?.route
          && String(entry.med.route).toLowerCase() !== String(range.route).toLowerCase()) continue;
        if (population === 'pediatric') {
          const maxPerKg = Number(range.max_daily_mg_per_kg);
          if (dailyMg != null && Number.isFinite(maxPerKg) && Number.isFinite(weightKg) && weightKg > 0
            && dailyMg > maxPerKg * weightKg) {
            findings.push({
              check: 'dose_range',
              severity: dailyMg > maxPerKg * weightKg * 1.2 ? 'major' : 'moderate',
              drug_keys: [drugKey],
              medications: [entry.display],
              message: `${entry.display}: computed ${dailyMg}mg/day exceeds the ${maxPerKg}mg/kg/day ceiling for a ${weightKg}kg child (${(maxPerKg * weightKg).toFixed(0)}mg/day).`,
              management: range.note || 'Recalculate weight-based dose.',
              source_key: range.source_key,
            });
          }
          continue;
        }
        const maxSingle = Number(range.max_single_dose_mg);
        if (doseMg != null && Number.isFinite(maxSingle) && doseMg > maxSingle) {
          findings.push({
            check: 'dose_range',
            severity: doseMg > maxSingle * 1.2 ? 'major' : 'moderate',
            drug_keys: [drugKey],
            medications: [entry.display],
            message: `${entry.display}: single dose ${doseMg}mg exceeds the ${maxSingle}mg adult single-dose ceiling.`,
            management: range.note || null,
            source_key: range.source_key,
          });
        }
        const maxDaily = Number(range.max_daily_dose_mg);
        if (dailyMg != null && Number.isFinite(maxDaily) && dailyMg > maxDaily) {
          findings.push({
            check: 'dose_range',
            severity: dailyMg > maxDaily * 1.2 ? 'major' : 'moderate',
            drug_keys: [drugKey],
            medications: [entry.display],
            message: `${entry.display}: computed ${dailyMg}mg/day exceeds the ${maxDaily}mg/day adult ceiling.`,
            management: range.note || null,
            source_key: range.source_key,
          });
        }
        const minEgfr = Number(range.min_egfr);
        const egfrMaxDaily = Number(range.egfr_max_daily_mg);
        if (Number.isFinite(egfr) && Number.isFinite(minEgfr) && egfr < minEgfr
          && dailyMg != null && Number.isFinite(egfrMaxDaily) && dailyMg > egfrMaxDaily) {
          findings.push({
            check: 'dose_range',
            severity: 'major',
            drug_keys: [drugKey],
            medications: [entry.display],
            message: `${entry.display}: ${dailyMg}mg/day exceeds the renal-adjusted ceiling ${egfrMaxDaily}mg/day for eGFR ${egfr} (<${minEgfr}).`,
            management: range.note || 'Renal dose adjustment required.',
            source_key: range.source_key,
          });
        }
      }
    }
  }

  // 5. IV Y-site compatibility — only among medications that look IV.
  const ivMeds = meds.filter((m) => {
    const route = String(m.med?.route || '').toLowerCase();
    return route === 'iv' || route.includes('intraven') || /\binj\b|injection|infusion/.test(m.text);
  });
  const seenIv = new Set();
  for (let i = 0; i < ivMeds.length; i += 1) {
    for (let j = i + 1; j < ivMeds.length; j += 1) {
      for (const keyA of ivMeds[i].keys) {
        for (const keyB of ivMeds[j].keys) {
          if (keyA === keyB) continue;
          const [a, b] = canonicalPair(keyA, keyB);
          const pairId = `${a}|${b}`;
          if (seenIv.has(pairId)) continue;
          const hit = kb.ivIndex.get(pairId);
          if (!hit || hit.compatibility === 'compatible') continue;
          seenIv.add(pairId);
          findings.push({
            check: 'iv_compatibility',
            severity: hit.compatibility === 'incompatible' ? 'major' : 'moderate',
            drug_keys: [a, b],
            medications: [ivMeds[i].display, ivMeds[j].display],
            message: `${ivMeds[i].display} and ${ivMeds[j].display} are ${hit.compatibility} for same-line IV administration.`,
            management: hit.note || 'Use separate lines or flush between drugs.',
            source_key: hit.source_key,
          });
        }
      }
    }
  }

  return { kbAvailable: true, findings };
}

export default {
  evaluateDrugKb,
  drugKbStatus,
  canonicalPair,
  frequencyPerDay,
  parseFlatDoseMg,
  matchMonographKeys,
  __resetDrugKbCache,
};
