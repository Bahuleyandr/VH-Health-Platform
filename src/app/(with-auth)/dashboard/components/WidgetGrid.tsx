'use client';

import { useRouter } from 'next/navigation';
import styles from '../Dashboard.module.css';
import type { DashboardData } from './types';

export function WidgetGrid({ dashboardData }: { dashboardData: DashboardData }) {
  const router = useRouter();

  return (
    <div className={styles.widgetGrid}>
      {/* Department Utilization Widget */}
      <div className={styles.widget}>
        <h3 className={styles.widgetTitle}>🏥 Department Utilization</h3>
        <div className={styles.bedMap}>
          {dashboardData.charts.departmentUtilization.map(dept => (
            <div key={dept.label} className={styles.bedFloor}>
              <span className={styles.floorLabel}>{dept.label}</span>
              <div className={styles.bedRow} style={{ display: 'flex', alignItems: 'center' }}>
                <div 
                  style={{
                    width: `${dept.value}%`,
                    background: dept.value > 80 ? '#ef4444' : dept.value > 60 ? '#f59e0b' : '#10b981',
                    height: '20px',
                    borderRadius: '4px',
                    transition: 'all 0.3s'
                  }}
                />
                <span style={{ marginLeft: '8px', fontSize: '12px', color: '#64748b' }}>{dept.value}%</span>
              </div>
            </div>
          ))}
        </div>
        <button 
          className={styles.scheduleBtn}
          onClick={() => router.push('/dashboard/departments')}
        >
          Manage Departments →
        </button>
      </div>

      {/* Staff Roster Widget */}
      <div className={styles.widget}>
        <h3 className={styles.widgetTitle}>👥 Staff Overview</h3>
        <div className={styles.staffList}>
          <div className={styles.staffCategory}>
            <span className={styles.staffRole}>Total Staff</span>
            <span className={styles.staffCount}>{dashboardData.overview.totalStaff}</span>
          </div>
          <div className={styles.staffCategory}>
            <span className={styles.staffRole}>Present</span>
            <span className={styles.staffCount}>{dashboardData.overview.presentStaff}</span>
          </div>
          <div className={styles.staffCategory}>
            <span className={styles.staffRole}>On Leave</span>
            <span className={styles.staffCount}>{dashboardData.overview.onLeaveStaff}</span>
          </div>
          <div className={styles.staffCategory}>
            <span className={styles.staffRole}>Available Doctors</span>
            <span className={styles.staffCount}>{dashboardData.overview.availableDoctors}</span>
          </div>
        </div>
        <button 
          className={styles.scheduleBtn}
          onClick={() => router.push('/dashboard/attendance')}
        >
          View Schedule →
        </button>
      </div>

      {/* Emergency Status Widget */}
      <div className={styles.widget}>
        <h3 className={styles.widgetTitle}>🚨 Quick Stats</h3>
        <div className={styles.erStatus}>
          <div className={styles.erMetric}>
            <span className={styles.erLabel}>Emergency Alerts</span>
            <span className={styles.erValue}>{dashboardData.overview.emergencyAlerts}</span>
          </div>
          <div className={styles.erMetric}>
            <span className={styles.erLabel}>Pending HR</span>
            <span className={styles.erValue}>{dashboardData.overview.pendingHRActions}</span>
          </div>
          <div className={styles.erMetric}>
            <span className={styles.erLabel}>Completion Rate</span>
            <span className={styles.erValue}>{dashboardData.overview.appointmentCompletionRate}%</span>
          </div>
        </div>
        <div className={styles.erTriage}>
          <button 
            className={styles.triageLevel1}
            onClick={() => router.push('/dashboard/sos')}
          >
            SOS
          </button>
          <button 
            className={styles.triageLevel2}
            onClick={() => router.push('/dashboard/notifications')}
          >
            Alerts
          </button>
          <button 
            className={styles.triageLevel3}
            onClick={() => router.push('/dashboard/pharmacy')}
          >
            Pharmacy
          </button>
        </div>
      </div>
    </div>
  );
}
