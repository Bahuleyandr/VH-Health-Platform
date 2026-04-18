# Adherence-risk ML pipeline

## What this is

A standalone offline script that trains the medication-adherence risk model
used by `src/services/gamification/adherenceModelServing.js` and exports it
to ONNX. The serving layer loads `models/adherence-risk.onnx` lazily; if the
file is missing (the default in this repo), it falls back to a hand-tuned
heuristic — see `adherenceRiskService.js#computeHeuristicScore`.

## What this is **not**

- **Not run in CI.** Training is a one-shot offline process on labelled data.
- **Not a data pipeline.** Producing the labelled CSV is a separate
  data-engineering job — see ROADMAP 3D for the SQL queries that would
  extract the features + label from `medication_administrations`,
  `prescription_safety_overrides`, `e_prescriptions`, and `patient_vitals`.
- **Not committed with a model file.** The repository ships heuristic-only;
  a trained `.onnx` is added by ops on the production host, not the source
  tree.

## Why ship the script if it's never run in CI

So the heuristic-only state is auditable and the path to a real model is
documented in code, not just in someone's head. The Python here is the exact
training recipe the wrapper expects to load.

## Usage

```bash
# One-time setup
python -m venv .venv
source .venv/bin/activate
pip install -r scripts/ml/requirements.txt

# Train + export
python scripts/ml/train_adherence_model.py \
    --csv path/to/labelled_adherence.csv \
    --out models/adherence-risk.onnx

# Then on the backend host:
#   - drop the .onnx file in <backend>/models/
#   - restart the Node process
# adherenceModelServing.js will pick it up at first use.
```

## CSV schema

```
missed_30,overrides_30,late_refills_90,days_silent,defaulted_within_30
3,0,1,12,0
8,2,3,45,1
```

`defaulted_within_30` is the binary label (1 if the patient stopped picking
up refills or stopped recording vitals within 30 days of the snapshot, 0
otherwise). Reasonable training-set size: ≥ 5,000 rows with at least 500
positive examples for the model to be better than the heuristic.

## Validating a trained model

The script prints AUC + Brier score + recall@precision=0.7. Targets:

- AUC > 0.75 — the heuristic is roughly 0.65, so anything below 0.75 isn't
  worth replacing it.
- Brier < 0.20 — calibrated probabilities, so the band thresholds (40/70
  in `bandFor`) correspond to actual risk percentages.

Below these thresholds, leave the heuristic in place.

## Why ONNX, not native scikit-learn

The serving layer is Node.js. ONNX gives us a portable artefact that
`onnxruntime-node` can load without bringing scikit-learn into the
production runtime. The model is small (logistic regression, 4 features),
so cold-start cost is negligible.
