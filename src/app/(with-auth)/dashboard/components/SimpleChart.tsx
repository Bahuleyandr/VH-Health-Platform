'use client';

import styles from '../Dashboard.module.css';
import type { ChartData } from './types';

export function SimpleChart({ data }: { data: ChartData }) {
  const maxValue = Math.max(...data.datasets.flatMap(d => d.data));
  
  return (
    <div className={styles.simpleChart}>
      <div className={styles.chartBars}>
        {data.labels.map((label, i) => (
          <div key={label} className={styles.chartBarGroup}>
            {data.datasets.map((dataset, j) => (
              <div
                key={dataset.label}
                className={styles.chartBar}
                style={{
                  height: `${(dataset.data[i] / maxValue) * 100}%`,
                  backgroundColor: dataset.color,
                  opacity: j === 0 ? 1 : 0.7
                }}
                title={`${dataset.label}: ${dataset.data[i]}`}
              />
            ))}
            <span className={styles.chartLabel}>{label}</span>
          </div>
        ))}
      </div>
      <div className={styles.chartLegend}>
        {data.datasets.map(dataset => (
          <span key={dataset.label} className={styles.legendItem}>
            <span 
              className={styles.legendColor} 
              style={{ backgroundColor: dataset.color }}
            />
            {dataset.label}
          </span>
        ))}
      </div>
    </div>
  );
}
