// src/app/dashboard/attendance/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@/services/admin.service';

export default function AttendancePage() {
  const [analytics, setAnalytics] = useState<any>(null);
  const [anomalies, setAnomalies] = useState<any>(null);
  const [absent, setAbsent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const today = new Date().toISOString().slice(0,10);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [a, an, ab] = await Promise.all([
          adminService.attendanceAnalytics({ group_by: 'day' }),
          adminService.attendanceAnomalies(),
          adminService.absentReport({ date: today }),
        ]);
        setAnalytics(a?.data ?? a);
        setAnomalies(an?.data ?? an);
        setAbsent(ab?.data ?? ab);
      } finally {
        setLoading(false);
      }
    })();
  }, [today]);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Staff Attendance</h1>
      {loading ? <div>Loading…</div> : (
        <>
          <Section title="Analytics" data={analytics} />
          <Section title="Anomalies (30d)" data={anomalies} />
          <Section title="Absent Today" data={absent} />
        </>
      )}
    </div>
  );
}

function Section({ title, data }: { title: string; data: unknown }) {
  return (
    <section>
      <h2 className="text-xl font-medium mb-2">{title}</h2>
      <pre className="bg-gray-50 p-3 rounded overflow-auto text-sm">{JSON.stringify(data, null, 2)}</pre>
    </section>
  );
}
