#!/usr/bin/env python3
"""
Train the medication-adherence risk model and export to ONNX.

Loads labelled rows from the production database (or a CSV export), fits a
scikit-learn LogisticRegression, calibrates the probabilities, and emits
`models/adherence-risk.onnx` for the Node.js serving layer to load.

The Node serving wrapper at `src/services/gamification/adherenceModelServing.js`
expects:
    input  shape: float32 [N, 4]   features = [missed_30, overrides_30, late_refills_90, days_silent]
    output shape: float32 [N, 2]   probabilities; column 1 (positive class) × 100 → score 0–100

Run (offline, on a machine with Python 3.10+ and a copy of production data):

    node scripts/ml/export_adherence_training_csv.mjs \\
        --out data/labelled_adherence.csv
    pip install -r scripts/ml/requirements.txt
    python scripts/ml/train_adherence_model.py \\
        --csv data/labelled_adherence.csv \\
        --out models/adherence-risk.onnx

CSV schema:
    missed_30,overrides_30,late_refills_90,days_silent,defaulted_within_30
    3,0,1,12,0
    8,2,3,45,1
    ...

NOTE: this script is committed but not run in CI. Use the Node exporter above
against a production-data copy; review cohort balance and labels before
promoting a model into `models/adherence-risk.onnx`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--csv', type=Path, required=True, help='Labelled CSV path')
    p.add_argument('--out', type=Path, required=True, help='Output .onnx path')
    p.add_argument('--test-frac', type=float, default=0.2, help='Holdout fraction')
    p.add_argument('--random-state', type=int, default=42)
    p.add_argument('--no-calibration', action='store_true',
                   help='Skip Platt scaling (use raw model probabilities)')
    return p.parse_args()


def main() -> int:
    args = parse_args()

    # Imports kept lazy so `python -h` works without the heavy deps.
    try:
        import numpy as np
        import pandas as pd
        from sklearn.linear_model import LogisticRegression
        from sklearn.model_selection import train_test_split
        from sklearn.metrics import roc_auc_score, precision_recall_curve, brier_score_loss
        from sklearn.calibration import CalibratedClassifierCV
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType
    except ImportError as exc:
        print(f'Missing dependency: {exc.name}', file=sys.stderr)
        print('Install via: pip install -r scripts/ml/requirements.txt', file=sys.stderr)
        return 1

    if not args.csv.exists():
        print(f'CSV not found: {args.csv}', file=sys.stderr)
        return 1

    df = pd.read_csv(args.csv)
    required = ['missed_30', 'overrides_30', 'late_refills_90', 'days_silent', 'defaulted_within_30']
    missing = [c for c in required if c not in df.columns]
    if missing:
        print(f'CSV missing columns: {missing}', file=sys.stderr)
        return 1

    X = df[['missed_30', 'overrides_30', 'late_refills_90', 'days_silent']].values.astype(np.float32)
    y = df['defaulted_within_30'].values.astype(np.int32)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=args.test_frac, random_state=args.random_state, stratify=y,
    )

    base = LogisticRegression(max_iter=1000, class_weight='balanced')
    if args.no_calibration:
        model = base
    else:
        # Platt scaling — gives well-calibrated probabilities so the score-band
        # thresholds (40/70) actually correspond to risk percentages.
        model = CalibratedClassifierCV(base, method='sigmoid', cv=5)

    model.fit(X_train, y_train)

    # Eval
    proba = model.predict_proba(X_test)[:, 1]
    auc = roc_auc_score(y_test, proba)
    brier = brier_score_loss(y_test, proba)
    precision, recall, _ = precision_recall_curve(y_test, proba)
    print(f'AUC: {auc:.3f}')
    print(f'Brier score: {brier:.3f}')
    print(f'Recall@P=0.7: {recall[(precision >= 0.7).argmax()]:.3f}')

    # Export to ONNX
    onnx_model = convert_sklearn(
        model,
        initial_types=[('features', FloatTensorType([None, 4]))],
        options={id(model): {'zipmap': False}},  # raw float32 [N, 2] output
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(onnx_model.SerializeToString())
    print(f'Wrote {args.out} ({args.out.stat().st_size} bytes)')

    # Sanity-check the export — load via onnxruntime and confirm shapes match.
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(str(args.out), providers=['CPUExecutionProvider'])
        sample = np.array([[3, 0, 1, 12]], dtype=np.float32)
        out = sess.run(None, {'features': sample})
        print(f'Round-trip check: input shape {sample.shape}, output {out[0].shape}')
    except ImportError:
        print('onnxruntime not installed — skipping round-trip check')

    return 0


if __name__ == '__main__':
    sys.exit(main())
