// src/app/(with-auth)/dashboard/attendance/page.tsx
"use client";

import { useEffect, useState } from "react";
import { adminService } from "@/services/admin.service";

// Generic JSON type (avoids `any`)
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function unwrapJson(x: unknown): Json {
  if (x && typeof x === "object" && "data" in x) {
    const v = (x as { data?: unknown }).data;
    return (v as Json) ?? null;
  }
  return (x as Json) ?? null;
}

export default function AttendancePage() {
  const [analytics, setAnalytics] = useState<Json>(null);
  const [anomalies, setAnomalies] = useState<Json>(null);
  const [absent, setAbsent] = useState<Json>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [a, an, ab] = await Promise.all([
          adminService.getAttendanceAnalytics({ group_by: "day" }),
          adminService.getAttendanceAnomalies(),
          adminService.getAbsentReport({ date: today }),
        ]);
        setAnalytics(unwrapJson(a)); // no `any`
        setAnomalies(unwrapJson(an)); // no `any`
        setAbsent(unwrapJson(ab)); // no `any`
      } finally {
        setLoading(false);
      }
    })();
  }, [today]);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Staff Attendance</h1>
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
      ) : (
        <>
          <Section title="Analytics" data={analytics} />
          <Section title="Anomalies (30d)" data={anomalies} />
          <Section title="Absent Today" data={absent} />
        </>
      )}
    </div>
  );
}

function Section({ title, data }: { title: string; data: Json }) {
  return (
    <section>
      <h2 className="text-xl font-medium mb-2">{title}</h2>
      <pre className="bg-muted p-3 rounded overflow-auto text-sm">
        {JSON.stringify(data, null, 2)}
      </pre>
    </section>
  );
}
