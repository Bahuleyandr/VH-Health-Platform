// src/app/dashboard/system-logs/components/LogLevelIndicator.tsx
"use client";

import { SystemLog } from "@/lib/types";

interface LogLevelIndicatorProps {
  logs: SystemLog[];
}

export function LogLevelIndicator({ logs }: LogLevelIndicatorProps) {
  const levelCounts = logs.reduce(
    (acc, log) => {
      acc[log.level] = (acc[log.level] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const total = logs.length;
  if (total === 0) return null;

  const levels = [
    { name: "ERROR", color: "bg-red-500", count: levelCounts.ERROR || 0 },
    { name: "WARN", color: "bg-yellow-500", count: levelCounts.WARN || 0 },
    { name: "INFO", color: "bg-blue-500", count: levelCounts.INFO || 0 },
    { name: "DEBUG", color: "bg-gray-500", count: levelCounts.DEBUG || 0 },
  ];

  return (
    <div className="mb-4">
      <div className="flex h-2 bg-gray-200 rounded-full overflow-hidden">
        {levels.map((level) => {
          const percentage = (level.count / total) * 100;
          if (percentage === 0) return null;

          return (
            <div
              key={level.name}
              className={`${level.color} transition-all duration-300`}
              style={{ width: `${percentage}%` }}
              title={`${level.name}: ${level.count} (${percentage.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <div className="flex justify-between mt-2 text-xs text-gray-600">
        {levels.map((level) => {
          const percentage = (level.count / total) * 100;
          if (percentage === 0) return null;

          return (
            <div key={level.name} className="flex items-center gap-1">
              <div className={`w-3 h-3 rounded-full ${level.color}`} />
              <span>
                {level.name}: {percentage.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
