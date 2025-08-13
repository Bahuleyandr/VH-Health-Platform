// src/app/dashboard/uploads/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@/services/admin.service';

export default function UploadsPage() {
  const [summary, setSummary] = useState<any>(null);
  const [quarantine, setQuarantine] = useState<any>(null);
  const [hipaa, setHipaa] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [s, q, h] = await Promise.all([
          adminService.uploadSummary(),
          adminService.quarantineList({ limit: 20, offset: 0 }),
          adminService.hipaaAudit({ limit: 20, offset: 0 }),
        ]);
        setSummary(s?.data ?? s);
        setQuarantine(q?.data ?? q);
        setHipaa(h?.data ?? h);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Uploads / File Management</h1>
      {loading ? <div>Loading…</div> : (
        <>
          <Section title="Summary" data={summary} />
          <Section title="Quarantined Files" data={quarantine} />
          <Section title="HIPAA Audit" data={hipaa} />
        </>
      )}
      <div className="flex gap-3">
        <button className="px-4 py-2 rounded bg-black text-white" onClick={() => adminService.uploadCleanup(true)}>Cleanup (dry run)</button>
        <button className="px-4 py-2 rounded bg-black text-white" onClick={() => adminService.purgeQuarantine(true)}>Purge quarantine (dry run)</button>
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
