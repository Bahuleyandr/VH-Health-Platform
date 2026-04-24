"use client";

import React from "react";
import { Skeleton } from "@/components/ui";
import { TrailPanel } from "./TrailPanel";
import type { TrailTarget } from "./types";

interface Props {
  target: TrailTarget;
  data: Record<string, unknown> | null | undefined;
  isLoading: boolean;
  onClose: () => void;
}

export function AuditTrailDialog({ target, data, isLoading, onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h2 className="font-semibold text-lg">{target.number} — Audit Trail</h2>
            <p className="text-xs text-gray-500 capitalize">
              {target.type} report · complete action history
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <Skeleton className="h-48" />
          ) : (
            <TrailPanel data={data as Record<string, unknown> | null} />
          )}
        </div>
      </div>
    </div>
  );
}
