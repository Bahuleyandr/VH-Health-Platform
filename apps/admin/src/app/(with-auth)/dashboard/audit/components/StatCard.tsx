// src/app/(with-auth)/dashboard/audit/components/StatCard.tsx

"use client";

import React from "react";

interface Props {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  alert?: boolean;
}

export function StatCard({ icon, label, value, sub, alert }: Props) {
  return (
    <div
      className={`bg-white border rounded-xl p-4 ${
        alert ? "border-red-300" : "border-gray-200"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-gray-500 font-medium">{label}</span>
      </div>
      <p className={`text-3xl font-bold ${alert ? "text-red-600" : "text-gray-900"}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
