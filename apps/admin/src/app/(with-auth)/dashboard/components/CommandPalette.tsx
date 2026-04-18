'use client';

import { useRouter } from 'next/navigation';
import styles from '../Dashboard.module.css';

interface CommandPaletteProps {
  onClose: () => void;
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const router = useRouter();

  const executeCommand = (command: string) => {
    const commands: { [key: string]: () => void } = {
      'users': () => router.push('/dashboard/users'),
      'doctors': () => router.push('/dashboard/doctors'),
      'departments': () => router.push('/dashboard/departments'),
      'appointments': () => router.push('/dashboard/appointments'),
      'pharmacy': () => router.push('/dashboard/pharmacy'),
      'reports': () => router.push('/dashboard/reporting'),
      'notifications': () => router.push('/dashboard/notifications'),
      'attendance': () => router.push('/dashboard/attendance'),
      'emergency': () => router.push('/dashboard/sos'),
      'system logs': () => router.push('/dashboard/system-logs'),
      'settings': () => router.push('/dashboard/settings'),
    };

    const cmd = command.toLowerCase();
    if (commands[cmd]) {
      commands[cmd]();
      onClose();
    }
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.commandPalette} onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          placeholder="Type a command or page name..."
          className={styles.commandInput}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.currentTarget.value) {
              executeCommand(e.currentTarget.value);
            }
          }}
        />
        <div className={styles.commandList}>
          <button className={styles.commandItem} onClick={() => executeCommand('users')}>
            <span>👥</span> User Management
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('doctors')}>
            <span>🩺</span> Doctor Management
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('departments')}>
            <span>🏥</span> Department Management
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('appointments')}>
            <span>📅</span> Appointments
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('pharmacy')}>
            <span>💊</span> Pharmacy Orders
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('reports')}>
            <span>📊</span> Reports & Analytics
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('notifications')}>
            <span>🔔</span> Notifications
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('attendance')}>
            <span>✅</span> Staff Attendance
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('emergency')}>
            <span>🚨</span> Emergency/SOS
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('system logs')}>
            <span>📜</span> System Logs
          </button>
          <button className={styles.commandItem} onClick={() => executeCommand('settings')}>
            <span>⚙️</span> System Settings
          </button>
        </div>
      </div>
    </div>
  );
}
