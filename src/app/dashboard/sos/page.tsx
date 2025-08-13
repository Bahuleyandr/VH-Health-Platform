// src/app/dashboard/sos/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@/services/admin.service';

export default function SosPage() {
  const [analytics, setAnalytics] = useState<any>(null);
  const [perf, setPerf] = useState<any>(null);
  const [services, setServices] = useState<any>(null);
  const [alerts, setAlerts] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [a, p, s, al] = await Promise.all([
          adminService.sosAnalytics(),
          adminService.sosPerformanceReport(),
          adminService.sosServices(),
          adminService.sosAlerts({ limit: 20, offset: 0 }),
        ]);
        setAnalytics(a?.data ?? a);
        setPerf(p?.data ?? p);
        setServices(s?.data ?? s);
        setAlerts(al?.data ?? al);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">SOS / Emergency</h1>
      {loading ? <div>Loading…</div> : (
        <>
          <Section title="Analytics" data={analytics} />
          <Section title="Performance" data={perf} />
          <Section title="Services" data={services} />
          <Section title="Recent Alerts" data={alerts} />
        </>
      )}

      <div className="flex gap-2">
        <input className="border px-3 py-2 rounded w-full" placeholder="Broadcast message…" value={msg} onChange={e=>setMsg(e.target.value)} />
        <button className="px-4 py-2 rounded bg-black text-white" onClick={async () => {
          await adminService.sosBroadcast({ message: msg });
          setMsg('');
        }}>
          Broadcast
        </button>
      </div>
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
