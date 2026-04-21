'use client';

import styles from '../Dashboard.module.css';
import type { ChartData, DashboardData } from '../dashboardTypes';
import { ActivityFeed } from './ActivityFeed';
import { SimpleChart } from './SimpleChart';
import { WidgetGrid } from './WidgetGrid';

export function DashboardMainGrid({
  chartData,
  dashboardData,
  onExport,
}: {
  chartData: ChartData;
  dashboardData: DashboardData;
  onExport: () => void;
}) {
  return (
    <div className={styles.mainGrid}>
      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <h2 className={styles.chartTitle}>📊 Analytics Overview</h2>
          <div className={styles.chartActions}>
            <select className={styles.chartPeriod}>
              <option>Last 7 days</option>
              <option>Last 30 days</option>
              <option>Last 3 months</option>
            </select>
            <button className={styles.chartExport} onClick={onExport}>
              📥 Export
            </button>
          </div>
        </div>
        <div className={styles.chartContainer}>
          <SimpleChart data={chartData} />
        </div>
      </div>

      <ActivityFeed activities={dashboardData.recentActivity} />
      <WidgetGrid dashboardData={dashboardData} />
    </div>
  );
}
