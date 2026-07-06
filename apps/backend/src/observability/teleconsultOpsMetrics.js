// src/observability/teleconsultOpsMetrics.js
//
// Prometheus gauges derived from the non-PHI teleconsult ops snapshot.

import logger from '../logging/logger.js';
import { Gauge } from './metricPrimitives.js';
import { getTeleconsultOpsAggregateSnapshot } from '../services/dashboards/teleconsultOpsService.js';

const teleconsultActive = new Gauge('teleconsult_ops_active_count', 'Teleconsultations currently in progress');
const teleconsultWaiting = new Gauge('teleconsult_ops_waiting_count', 'Teleconsultations currently waiting');
const teleconsultScheduled = new Gauge('teleconsult_ops_scheduled_count', 'Teleconsultations scheduled in the metrics window');
const teleconsultJoinFailures = new Gauge('teleconsult_ops_join_failure_count', 'Failed teleconsult or video-session joins in the metrics window');
const teleconsultTurnSessions = new Gauge('teleconsult_ops_turn_session_count', 'Teleconsult video sessions using TURN/relay metadata in the metrics window');
const teleconsultTurnRate = new Gauge('teleconsult_ops_turn_usage_rate_pct', 'Percent of teleconsult video sessions using TURN/relay metadata');
const teleconsultConsentRate = new Gauge('teleconsult_ops_consent_recorded_rate_pct', 'Percent of teleconsultations with recorded remote consent');
const teleconsultFinalModality = new Gauge('teleconsult_ops_final_modality_count', 'Terminal teleconsultations by final modality', ['modality']);

const MODALITIES = ['video', 'audio', 'chat', 'hybrid', 'unknown'];

function setInitialZeros() {
  teleconsultActive.set({}, 0);
  teleconsultWaiting.set({}, 0);
  teleconsultScheduled.set({}, 0);
  teleconsultJoinFailures.set({}, 0);
  teleconsultTurnSessions.set({}, 0);
  teleconsultTurnRate.set({}, 0);
  teleconsultConsentRate.set({}, 0);
  for (const modality of MODALITIES) {
    teleconsultFinalModality.set({ modality }, 0);
  }
}

setInitialZeros();

export async function collectTeleconsultOpsMetrics() {
  try {
    const snapshot = await getTeleconsultOpsAggregateSnapshot({ windowHours: 24 });
    teleconsultActive.set({}, Number(snapshot.active_count || 0));
    teleconsultWaiting.set({}, Number(snapshot.waiting_count || 0));
    teleconsultScheduled.set({}, Number(snapshot.scheduled_count || 0));
    teleconsultJoinFailures.set({}, Number(snapshot.join_failure_count || 0));
    teleconsultTurnSessions.set({}, Number(snapshot.turn_session_count || 0));
    teleconsultTurnRate.set({}, Number(snapshot.turn_usage_rate_pct || 0));
    teleconsultConsentRate.set({}, Number(snapshot.consent_recorded_rate_pct || 0));
    for (const modality of MODALITIES) {
      teleconsultFinalModality.set({
        modality,
      }, Number(snapshot.final_modality_distribution?.[modality] || 0));
    }
  } catch (err) {
    logger.warn(`collectTeleconsultOpsMetrics: refresh skipped - ${err?.message || err}`);
  }
}

export function serializeTeleconsultOpsMetrics() {
  const metrics = [
    teleconsultActive,
    teleconsultWaiting,
    teleconsultScheduled,
    teleconsultJoinFailures,
    teleconsultTurnSessions,
    teleconsultTurnRate,
    teleconsultConsentRate,
    teleconsultFinalModality,
  ];
  return metrics.map((metric) => metric.serialize()).filter(Boolean).join('\n\n') + '\n';
}

export default {
  collectTeleconsultOpsMetrics,
  serializeTeleconsultOpsMetrics,
};
