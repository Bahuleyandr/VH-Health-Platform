"use client";

import Image from "next/image";
import { X } from "lucide-react";
import type { HousekeepingRequest } from "@/lib/api/housekeeping";
import {
  Badge,
  fmtDate,
  InfoRow,
  STATUS_STYLES,
  URGENCY_STYLES,
} from "./helpers";

export function DetailPanel({
  req,
  onClose,
}: {
  req: HousekeepingRequest;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-end md:items-center justify-center md:justify-end z-50">
      <div className="bg-card w-full md:w-[420px] md:h-full h-[85vh] overflow-y-auto shadow-xl">
        <div className="flex justify-between items-center p-5 border-b sticky top-0 bg-card">
          <div>
            <h3 className="font-bold text-gray-800">{req.request_number}</h3>
            <div className="flex gap-2 mt-1">
              <Badge value={req.urgency} styleMap={URGENCY_STYLES} />
              <Badge value={req.status} styleMap={STATUS_STYLES} />
            </div>
          </div>
          <button onClick={onClose}>
            <X size={18} className="text-gray-400" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <InfoRow
            label="Location"
            value={req.zone_name ?? req.location_text}
          />
          <InfoRow label="Type" value={req.request_type.replace(/_/g, " ")} />
          <InfoRow
            label="Raised by"
            value={`${req.requester_name ?? "—"} (${req.requester_dept ?? ""})`}
          />
          <InfoRow label="Raised at" value={fmtDate(req.created_at)} />
          <InfoRow label="Assigned to" value={req.assigned_to_name ?? "—"} />
          {req.assigned_at && (
            <InfoRow label="Assigned at" value={fmtDate(req.assigned_at)} />
          )}
          {req.description && (
            <InfoRow label="Description" value={req.description} />
          )}
          {req.sla_due_at && (
            <InfoRow label="SLA Due" value={fmtDate(req.sla_due_at)} />
          )}

          {req.photo_url && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1">
                Problem Photo
              </div>
              <a
                href={req.photo_url}
                target="_blank"
                rel="noreferrer"
                className="relative block w-full h-48"
              >
                <Image
                  src={req.photo_url}
                  alt="Problem"
                  fill
                  sizes="(max-width: 768px) 100vw, 50vw"
                  className="rounded border object-cover"
                  unoptimized
                />
              </a>
            </div>
          )}

          {req.completed_at && (
            <div className="pt-2 border-t space-y-2">
              <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                Completion
              </div>
              <InfoRow label="Completed at" value={fmtDate(req.completed_at)} />
              {req.completion_notes && (
                <InfoRow label="Notes" value={req.completion_notes} />
              )}
              {req.completion_photo_url && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-1">
                    Completion Photo
                  </div>
                  <a
                    href={req.completion_photo_url}
                    target="_blank"
                    rel="noreferrer"
                    className="relative block w-full h-48"
                  >
                    <Image
                      src={req.completion_photo_url}
                      alt="Completion"
                      fill
                      sizes="(max-width: 768px) 100vw, 50vw"
                      className="rounded border object-cover"
                      unoptimized
                    />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
