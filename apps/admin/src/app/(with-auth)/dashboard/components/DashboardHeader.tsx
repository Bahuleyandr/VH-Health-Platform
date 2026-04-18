'use client';

import { RefObject } from 'react';
import styles from '../Dashboard.module.css';
import type { DashboardData } from './types';

interface DashboardHeaderProps {
  greeting: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  dashboardData: DashboardData;
  onShowCommandPalette: () => void;
  showNotifications: boolean;
  onToggleNotifications: () => void;
  unreadNotifications: number;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  refreshing: boolean;
  onRefresh: () => void;
}

export function DashboardHeader({
  greeting,
  searchInputRef,
  searchQuery,
  onSearchChange,
  dashboardData,
  onShowCommandPalette,
  onToggleNotifications,
  unreadNotifications,
  isDarkMode,
  onToggleTheme,
  refreshing,
  onRefresh,
}: DashboardHeaderProps) {
  return (
    <header className={styles.dashboardHeader}>
      <div className={styles.headerLeft}>
        <h1 className={styles.greeting}>{greeting}</h1>
        <p className={styles.dateTime}>{new Date().toLocaleDateString('en-US', { 
          weekday: 'long', 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })}</p>
      </div>

      <div className={styles.headerCenter}>
        <div className={styles.searchContainer}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search patients, staff, records..."
            className={styles.searchInput}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          <kbd className={styles.searchKbd}>⌘K</kbd>
        </div>
      </div>

      <div className={styles.headerRight}>
        <div className={styles.systemStatus}>
          <span className={`${styles.statusDot} ${dashboardData.systemHealth.status === 'healthy' ? styles.statusGreen : styles.statusRed}`}></span>
          <span className={styles.statusText}>
            {dashboardData.systemHealth.status === 'healthy' ? 'All Systems Operational' : 'System Issues Detected'}
          </span>
        </div>

        <button className={styles.quickActionBtn} onClick={onShowCommandPalette}>
          <span>⚡</span> Quick Actions
        </button>

        <button 
          className={styles.notificationBtn}
          onClick={onToggleNotifications}
        >
          <span>🔔</span>
          {unreadNotifications > 0 && (
            <span className={styles.notificationBadge}>{unreadNotifications}</span>
          )}
        </button>

        <button className={styles.themeToggle} onClick={onToggleTheme}>
          {isDarkMode ? '☀️' : '🌙'}
        </button>

        <button 
          className={styles.refreshBtn}
          onClick={onRefresh}
          disabled={refreshing}
        >
          <span className={refreshing ? styles.spinning : ''}>🔄</span>
        </button>
      </div>
    </header>
  );
}
