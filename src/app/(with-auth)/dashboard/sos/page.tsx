// src/app/(with-auth)/dashboard/sos/page.tsx
"use client";

import { adminService } from "@/services/admin.service";
import { useEffect, useState } from "react";

// Generic JSON type (avoids `any`)
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function unwrapJson(x: unknown): Json {
  if (x && typeof x === "object" && "data" in x) {
    const v = (x as { data: unknown }).data;
    return (v as Json) ?? null;
  }
  return (x as Json) ?? null;
}

export default function SosPage() {
  const [analytics, setAnalytics] = useState<Json>(null);
  const [perf, setPerf] = useState<Json>(null);
  const [services, setServices] = useState<Json>(null);
  const [alerts, setAlerts] = useState<Json>(null);
  const [msg, setMsg] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [a, p, s, al] = await Promise.all([
          adminService.getSosAnalytics(),
          adminService.getSosPerformanceReport(),
          adminService.getEmergencyServices(),
          adminService.listSosAlerts({ limit: 20, offset: 0 }),
        ]);
        setAnalytics(unwrapJson(a));
        setPerf(unwrapJson(p));
        setServices(unwrapJson(s));
        setAlerts(unwrapJson(al));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">SOS / Emergency</h1>
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-blue-600" />
            <p className="mt-3 text-sm text-gray-500">Loading…</p>
          </div>
        </div>
      ) : (
        <>
          <Section title="Analytics" data={analytics} />
          <Section title="Performance" data={perf} />
          <Section title="Services" data={services} />
          <Section title="Recent Alerts" data={alerts} />
        </>
      )}

      <div className="flex gap-2">
        <input
          className="border px-3 py-2 rounded w-full"
          placeholder="Broadcast message…"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
        />
        <button
          className="px-4 py-2 rounded bg-black text-white"
          onClick={async () => {
            if (!msg.trim()) return;
            await adminService.broadcastSosAlert({ message: msg.trim() });
            setMsg("");
          }}
        >
          Broadcast
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
