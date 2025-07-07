// src/app/dashboard/doctors/page.tsx

import { getDoctors } from "@/lib/api";
import { Doctor } from "@/lib/types";
import { DoctorsTable } from "./components/DoctorsTable";
import { Suspense } from "react";
import Link from "next/link";

export default async function DoctorsPage() {
  // Fetching from the GET /doctors/manage endpoint
  const response = await getDoctors();
  // Assuming the API returns an object with a 'doctors' array
  const doctors: Doctor[] = response.doctors || []; 

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Doctor Management</h2>
        <Link href="/dashboard/doctors/create" className="bg-blue-500 text-white px-4 py-2 rounded-md">
          Add New Doctor
        </Link>
      </div>
      
      <Suspense fallback={<div>Loading doctors...</div>}>
        <DoctorsTable doctors={doctors} />
      </Suspense>
    </div>
  );
}