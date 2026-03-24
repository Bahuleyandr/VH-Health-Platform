'use client';

import styles from '../Dashboard.module.css';
import type { StatCard } from './types';
import { AnimatedCounter } from './AnimatedCounter';

export function StatsGrid({ stats }: { stats: StatCard[] }) {
  return (
    <div className={styles.statsGrid}>
      {stats.map((stat) => (
        <div key={stat.id} className={`${styles.statCard} ${styles[`statCard${stat.color.charAt(0).toUpperCase() + stat.color.slice(1)}`]}`}>
          <div className={styles.statHeader}>
            <span className={styles.statIcon}>{stat.icon}</span>
            <span className={`${styles.statChange} ${stat.change > 0 ? styles.changePositive : styles.changeNegative}`}>
              {stat.change > 0 ? '↑' : '↓'} {Math.abs(stat.change)}%
            </span>
          </div>
          <div className={styles.statContent}>
            <h3 className={styles.statTitle}>{stat.title}</h3>
            <AnimatedCounter value={stat.value} suffix={stat.suffix} />
          </div>
          <div className={styles.statSparkline}>
            <svg className={styles.sparklineSvg}>
              <polyline
                points="0,20 20,15 40,18 60,10 80,12 100,8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
          </div>
        </div>
      ))}
    </div>
  );
}
