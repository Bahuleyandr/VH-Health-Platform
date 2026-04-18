// src/services/gamification/adherenceModelServing.js
//
// ONNX serving wrapper for the adherence-risk model. Loads `models/
// adherence-risk.onnx` at first use; if the file is missing or fails to load,
// falls back to the heuristic scorer so the endpoint keeps working during
// rollout.
//
// Training pipeline (separate one-shot script, run offline):
//
//   1. Export labelled rows from `medication_administrations` +
//      `prescription_safety_overrides` + `patient_vitals` + refill events to
//      a CSV (features: missed_30, overrides_30, late_refills_90,
//      days_since_last_vital; label: patient_defaulted_within_next_30_days).
//   2. Fit a scikit-learn LogisticRegression and export to ONNX via skl2onnx:
//        from skl2onnx import convert_sklearn
//        from skl2onnx.common.data_types import FloatTensorType
//        onnx_model = convert_sklearn(model,
//          initial_types=[('features', FloatTensorType([None, 4]))])
//        with open('adherence-risk.onnx', 'wb') as f:
//          f.write(onnx_model.SerializeToString())
//   3. Drop the file in `<backend>/models/adherence-risk.onnx` and restart.
//
// Expected ONNX input: float32 [N, 4] — [missed, overrides, late_refills, days_silent]
// Expected ONNX output: float32 [N, 2] probabilities (rather than label), we
// take column 1 (positive class = will default) × 100.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import logger from '../../logging/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.resolve(__dirname, '../../../models/adherence-risk.onnx');

let _session = null;
let _sessionPromise = null;
let _loadAttempted = false;

async function _loadSession() {
  if (_session) return _session;
  if (_sessionPromise) return _sessionPromise;
  if (_loadAttempted) return null;
  _loadAttempted = true;

  if (!fs.existsSync(MODEL_PATH)) {
    logger.info(`Adherence ONNX model not present at ${MODEL_PATH} — using heuristic fallback`);
    return null;
  }

  _sessionPromise = (async () => {
    try {
      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(MODEL_PATH);
      logger.info('Adherence ONNX model loaded');
      _session = session;
      return session;
    } catch (err) {
      logger.warn(`Failed to load adherence ONNX model — falling back to heuristic: ${err.message}`);
      return null;
    } finally {
      _sessionPromise = null;
    }
  })();
  return _sessionPromise;
}

/**
 * Score via the ONNX model if available. Returns the probability (0–100) of
 * the patient defaulting in the next 30 days, or `null` when no model is
 * loaded (caller should fall back to the heuristic).
 *
 * @param {{ missed: number, overrides: number, lateRefills: number, daysSilent: number }} features
 * @returns {Promise<number|null>}
 */
export async function scoreViaModel(features) {
  const session = await _loadSession();
  if (!session) return null;

  try {
    const ort = await import('onnxruntime-node');
    const input = Float32Array.from([
      features.missed,
      features.overrides,
      features.lateRefills,
      features.daysSilent,
    ]);
    const tensor = new ort.Tensor('float32', input, [1, 4]);
    const inputName = session.inputNames[0];
    const outputs = await session.run({ [inputName]: tensor });
    const firstOutput = outputs[session.outputNames[0]];

    // Output is a [1, 2] probability vector for [not-defaulted, defaulted].
    // If it's a [1, 1] regression output we use it directly.
    const data = firstOutput.data;
    let p;
    if (data.length >= 2) p = data[1];
    else p = data[0];
    return Math.max(0, Math.min(100, Math.round(p * 100)));
  } catch (err) {
    logger.warn(`ONNX inference failed, falling back to heuristic: ${err.message}`);
    return null;
  }
}

/** True when a model file is present AND loaded without errors. */
export async function isModelLoaded() {
  return Boolean(await _loadSession());
}

export default { scoreViaModel, isModelLoaded };
