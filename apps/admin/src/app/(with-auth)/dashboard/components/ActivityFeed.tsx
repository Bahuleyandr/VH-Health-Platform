'use client';

import { useRouter } from 'next/navigation';
import styles from '../Dashboard.module.css';
import type { Activity } from './types';
import { formatTimeAgo } from './utils';

export function ActivityFeed({ activities }: { activities: Activity[] }) {
  const router = useRouter();

  return (
    <div className={styles.activityCard}>
      <div className={styles.activityHeader}>
        <h2 className={styles.activityTitle}>📋 Recent Activity</h2>
        <button 
          className={styles.viewAllBtn}
          onClick={() => router.push('/dashboard/system-logs')}
        >
          View All →
        </button>
      </div>
      <div className={styles.activityList}>
        {activities.map(activity => (
          <div key={activity.id} className={styles.activityItem}>
            <div className={styles.activityIcon}>
              {activity.department === 'ICU' ? '🏥' : 
               activity.department === 'Emergency' ? '🚨' : '👤'}
            </div>
            <div className={styles.activityContent}>
              <p className={styles.activityText}>
                <strong>{activity.user}</strong> {activity.action} <em>{activity.target}</em>
              </p>
              <div className={styles.activityMeta}>
                <span className={styles.activityDept}>{activity.department}</span>
                <span className={styles.activityTime}>
                  {formatTimeAgo(activity.time)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
