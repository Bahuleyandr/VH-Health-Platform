'use client';

import styles from '../Dashboard.module.css';

const DEPARTMENTS = ['all', 'emergency', 'icu', 'surgery', 'pediatrics', 'radiology'];

export function DepartmentTabs({
  selectedDepartment,
  onSelectDepartment,
}: {
  selectedDepartment: string;
  onSelectDepartment: (department: string) => void;
}) {
  return (
    <div className={styles.departmentTabs}>
      {DEPARTMENTS.map((department) => (
        <button
          key={department}
          className={`${styles.deptTab} ${selectedDepartment === department ? styles.deptTabActive : ''}`}
          onClick={() => onSelectDepartment(department)}
        >
          {department.charAt(0).toUpperCase() + department.slice(1)}
        </button>
      ))}
    </div>
  );
}
