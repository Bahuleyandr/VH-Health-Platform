// src/app/(with-auth)/dashboard/appointments/page.tsx
"use client";

import { Suspense, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { AllAppointmentsTab } from "./components/AllAppointmentsTab";
import { AuditTrailTab } from "./components/AuditTrailTab";
import { DocumentsTab } from "./components/DocumentsTab";
import { DoctorQueueTab } from "./components/DoctorQueueTab";
import { PrescriptionsTab } from "./components/PrescriptionsTab";
import { SlaOverviewTab } from "./components/SlaOverviewTab";
import { BookAppointmentDialog } from "./components/BookAppointmentDialog";
import { WalkInDialog } from "./components/WalkInDialog";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";

const APPOINTMENTS_CHANNEL = "staff:appointments";

const TABS = [
  { id: "overview", label: "Overview & SLA" },
  { id: "appointments", label: "All Appointments" },
  { id: "queue", label: "Doctor Queue" },
  { id: "documents", label: "Documents" },
  { id: "prescriptions", label: "Prescriptions" },
  { id: "audit", label: "Audit Trail" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function AppointmentsPageContent() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [showWalkIn, setShowWalkIn] = useState(false);
  const [showBookAppointment, setShowBookAppointment] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(APPOINTMENTS_CHANNEL, [["appointments"], ["queue"]]);
  const liveLabel = subscribed ? "● Live" : connected ? "○ Connecting" : "○ Offline";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:appointments — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:appointments"
    : connected ? "Connecting…" : "Offline — refresh manually (real-time unavailable)";

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-bold">Appointment Management</h2>
          <span data-testid="appointments-realtime-indicator" role="status"
            aria-label={subscribed ? "Live — real-time appointment updates active" : "Offline — real-time updates unavailable"}
            title={liveTitle}
            className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}>
            {liveLabel}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowBookAppointment(true)}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-lg hover:bg-primary/90 flex items-center gap-2"
          >
            <span>+</span> Book Appointment
          </button>
          <button
            onClick={() => setShowWalkIn(true)}
            className="bg-teal-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-teal-700 flex items-center gap-2"
          >
            <span>+</span> Register Walk-in
          </button>
        </div>
      </div>

      {showBookAppointment && (
        <BookAppointmentDialog
          onClose={() => setShowBookAppointment(false)}
          onSuccess={() => {
            setRefreshKey((value) => value + 1);
            setActiveTab("appointments");
          }}
        />
      )}

      {showWalkIn && (
        <WalkInDialog
          onClose={() => setShowWalkIn(false)}
          onSuccess={() => {
            setRefreshKey((value) => value + 1);
            setActiveTab("appointments");
          }}
        />
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <SlaOverviewTab />}
      {activeTab === "appointments" && (
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <AllAppointmentsTab refreshKey={refreshKey} />
        </Suspense>
      )}
      {activeTab === "queue" && <DoctorQueueTab />}
      {activeTab === "documents" && <DocumentsTab />}
      {activeTab === "prescriptions" && <PrescriptionsTab />}
      {activeTab === "audit" && <AuditTrailTab />}
    </div>
  );
}

export default function AppointmentsPage() {
  return (
    <Suspense fallback={<div className="p-6"><Skeleton className="h-96 w-full" /></div>}>
      <AppointmentsPageContent />
    </Suspense>
  );
}
