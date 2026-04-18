'use client';

import styles from '../Dashboard.module.css';
import type { Notification } from './types';
import { formatTimeAgo } from './utils';

interface NotificationsDropdownProps {
  notifications: Notification[];
  onMarkAsRead: (id: string) => void;
  onClearAll: () => void;
}

export function NotificationsDropdown({ notifications, onMarkAsRead, onClearAll }: NotificationsDropdownProps) {
  return (
    <div className={styles.notificationsDropdown}>
      <div className={styles.notificationsHeader}>
        <h3>Notifications</h3>
        <button onClick={onClearAll}>Clear All</button>
      </div>
      <div className={styles.notificationsList}>
        {notifications.map(notif => (
          <div 
            key={notif.id} 
            className={`${styles.notificationItem} ${notif.read ? styles.notifRead : ''}`}
            onClick={() => onMarkAsRead(notif.id)}
          >
            <div className={styles.notifIcon}>
              {notif.type === 'critical' ? '🔴' : 
               notif.type === 'warning' ? '🟡' : 
               notif.type === 'success' ? '🟢' : '🔵'}
            </div>
            <div className={styles.notifContent}>
              <h4>{notif.title}</h4>
              <p>{notif.message}</p>
              <span className={styles.notifTime}>{formatTimeAgo(notif.time)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
