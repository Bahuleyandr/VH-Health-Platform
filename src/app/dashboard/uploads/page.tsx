// src/app/dashboard/uploads/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@/services/admin.service';

// Generic JSON type to avoid `any`
type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

function unwrapJson(x: unknown): Json {
  if (x && typeof x === 'object' && 'data' in x) {
    const v = (x as { data: unknown }).data;
    return (v as Json) ?? null;
  }
  return (x as Json) ?? null;
}

export default function UploadsPage() {
  const [summary, setSummary] = useState<Json>(null);
  const [quarantine, setQuarantine] = useState<Json>(null);
  const [hipaa, setHipaa] = useState<Json>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [s, q, h] = await Promise.all([
          adminService.getUploadSummary(),
          adminService.listQuarantinedFiles({ limit: 20, offset: 0 }),
          adminService.getHipaaAuditReport({ limit: 20, offset: 0 }),
        ]);
        setSummary(unwrapJson(s));
        setQuarantine(unwrapJson(q));
        setHipaa(unwrapJson(h));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Uploads / File Management</h1>
      {loading ? (
        <div>Loading…</div>
      ) : (
        <>
          <Section title="Summary" data={summary} />
          <Section title="Quarantined Files" data={quarantine} />
          <Section title="HIPAA Audit" data={hipaa} />
        </>
      )}
      <div className="flex gap-3">
        <button
          className="px-4 py-2 rounded bg-black text-white"
          onClick={() => adminService.cleanupExpiredFiles(true)}
        >
          Cleanup (dry run)
        </button>
        <button
          className="px-4 py-2 rounded bg-black text-white"
          onClick={() => adminService.purgeQuarantinedFiles(true)}
        >
          Purge quarantine (dry run)
        </button>
      </div>
    </div>
  );
}

function Section({ title, data }: { title: string; data: Json }) {
  return (
    <section>
      <h2 className="text-xl font-medium mb-2">{title}</h2>
      <pre className="bg-gray-50 p-3 rounded overflow-auto text-sm">
        {JSON.stringify(data, null, 2)}
      </pre>
    </section>
  );
}
