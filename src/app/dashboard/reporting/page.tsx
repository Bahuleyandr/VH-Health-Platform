// src/app/dashboard/reporting/page.tsx

import { getDoctors, getUsers } from "@/lib/api";
import { Doctor, User } from "@/lib/types";
import { ReportGenerator } from "./components/ReportGenerator";
import { Suspense } from "react";

export default async function ReportingPage() {
  // Fetch all users and doctors to populate filter dropdowns
  const [usersResponse, doctorsResponse] = await Promise.all([
    getUsers(new URLSearchParams()), // Fetch all users
    getDoctors()
  ]);

  const users: User[] = usersResponse.users || [];
  const doctors: Doctor[] = doctorsResponse.doctors || [];

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Data Export & Reporting</h2>
      <p className="mb-6 text-gray-600">
        Select filters to generate a report of medical records. The report will be downloaded to your device.
      </p>

      <Suspense fallback={<div>Loading report generator...</div>}>
        <ReportGenerator users={users} doctors={doctors} />
      </Suspense>
    </div>
  );
}