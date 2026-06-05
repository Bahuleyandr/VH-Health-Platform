// src/app/(with-auth)/dashboard/doctors/components/DoctorsTable.tsx
"use client";

import { Doctor } from "@/lib/types";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ClientSavedViews } from "@/components/table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  X,
} from "lucide-react";

interface DoctorsTableProps {
  doctors: Doctor[];
  onDoctorDeleted?: () => void;
  isLoading?: boolean;
  error?: string | null;
}

// Doctors created admin-side have user_id=null, so the doctor row's identity
// has to come from doctors.id (the table PK). user_id is the legacy lookup
// for doctors that ARE paired with a user account.
function doctorKey(d: Doctor): number | string | undefined {
  const id = (d as unknown as { id?: number | string }).id;
  if (id !== undefined && id !== null) return id;
  return d.user_id;
}

type SortKey =
  | "name"
  | "department"
  | "specialization"
  | "consultation_fee"
  | "schedule"
  | "status";
type SortDirection = "asc" | "desc";

const PAGE_SIZE_OPTIONS = [10, 50, 100] as const;
const DOCTOR_SORT_KEYS: SortKey[] = [
  "name",
  "department",
  "specialization",
  "consultation_fee",
  "schedule",
  "status",
];
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function fieldValue(doctor: Doctor, sortKey: SortKey): string | number {
  switch (sortKey) {
    case "consultation_fee":
      return doctor.consultation_fee ?? -1;
    case "schedule":
      return (
        ((doctor as Record<string, unknown>).available_days as
          | string[]
          | undefined) ?? []
      ).join(" ");
    case "status":
      return doctor.is_available ? "Available" : "Unavailable";
    default:
      return String(doctor[sortKey] ?? "");
  }
}

function compareDoctors(
  a: Doctor,
  b: Doctor,
  sortKey: SortKey,
  sortDirection: SortDirection,
) {
  const aValue = fieldValue(a, sortKey);
  const bValue = fieldValue(b, sortKey);
  const result =
    typeof aValue === "number" && typeof bValue === "number"
      ? aValue - bValue
      : collator.compare(String(aValue), String(bValue));

  return sortDirection === "asc" ? result : -result;
}

function getDoctorSearchText(doctor: Doctor) {
  return [
    doctor.name,
    doctor.email,
    doctor.phone,
    doctor.department,
    doctor.specialization,
  ]
    .join(" ")
    .toLocaleLowerCase();
}

function getRowKey(doctor: Doctor, index: number) {
  const key = doctorKey(doctor);
  if (key !== undefined) return key;
  return `${doctor.name}-${doctor.department}-${index}`;
}

function SortIcon({
  column,
  sortKey,
  sortDirection,
}: {
  column: SortKey;
  sortKey: SortKey;
  sortDirection: SortDirection;
}) {
  if (sortKey !== column) {
    return <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" />;
  }

  return sortDirection === "asc" ? (
    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
  ) : (
    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
  );
}

function SortableHeader({
  column,
  sortKey,
  sortDirection,
  onSort,
  children,
}: {
  column: SortKey;
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (column: SortKey) => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      aria-label={`Sort by ${children}`}
    >
      <span>{children}</span>
      <SortIcon
        column={column}
        sortKey={sortKey}
        sortDirection={sortDirection}
      />
    </button>
  );
}

export function DoctorsTable({
  doctors,
  onDoctorDeleted,
  isLoading,
  error,
}: DoctorsTableProps) {
  const [deleting, setDeleting] = useState<number | string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDoctor, setPendingDoctor] = useState<Doctor | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [pageSize, setPageSize] =
    useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [page, setPage] = useState(1);

  const filteredDoctors = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
    const visibleDoctors = normalizedSearch
      ? doctors.filter((doctor) =>
          getDoctorSearchText(doctor).includes(normalizedSearch),
        )
      : doctors;

    return [...visibleDoctors].sort((a, b) =>
      compareDoctors(a, b, sortKey, sortDirection),
    );
  }, [doctors, searchTerm, sortDirection, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filteredDoctors.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const pageStart =
    filteredDoctors.length === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const pageEnd = Math.min(clampedPage * pageSize, filteredDoctors.length);
  const paginatedDoctors = filteredDoctors.slice(
    (clampedPage - 1) * pageSize,
    clampedPage * pageSize,
  );

  useEffect(() => {
    setPage(1);
  }, [pageSize, searchTerm]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Loading doctors...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-destructive">
        {error}{" "}
        <button onClick={() => onDoctorDeleted?.()} className="ml-2 underline">
          Retry
        </button>
      </div>
    );
  }

  const handleDeleteClick = (doctor: Doctor) => {
    setPendingDoctor(doctor);
    setConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDoctor) return;
    const key = doctorKey(pendingDoctor);
    if (key === undefined) {
      alert("Doctor row missing id — cannot delete.");
      return;
    }

    setDeleting(key);
    try {
      await fetchAdminAPI(`/doctors/${key}`, {
        method: "DELETE",
      });

      if (onDoctorDeleted) {
        onDoctorDeleted();
      }
    } catch (error) {
      console.error("Deletion failed:", error);
      alert("Failed to delete doctor. Please try again.");
    } finally {
      setDeleting(null);
      setPendingDoctor(null);
    }
  };

  const handleSort = (nextSortKey: SortKey) => {
    setPage(1);
    setSortKey((currentSortKey) => {
      if (currentSortKey !== nextSortKey) {
        setSortDirection("asc");
        return nextSortKey;
      }

      setSortDirection((currentDirection) =>
        currentDirection === "asc" ? "desc" : "asc",
      );
      return currentSortKey;
    });
  };

  return (
    <>
      <div className="bg-card shadow rounded-lg overflow-hidden">
        <div className="border-b border-border bg-card px-4 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative max-w-md flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search doctors by name, department, speciality..."
                className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-10 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              {searchTerm ? (
                <button
                  type="button"
                  onClick={() => setSearchTerm("")}
                  className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Clear doctor search"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <ClientSavedViews
                scope="doctors"
                state={{ searchTerm, sortKey, sortDirection, pageSize }}
                onApply={(view) => {
                  setSearchTerm(String(view.searchTerm ?? ""));
                  if (DOCTOR_SORT_KEYS.includes(view.sortKey as SortKey)) {
                    setSortKey(view.sortKey as SortKey);
                  }
                  setSortDirection(
                    view.sortDirection === "desc" ? "desc" : "asc",
                  );
                  const nextPageSize = Number(view.pageSize);
                  if (
                    PAGE_SIZE_OPTIONS.includes(
                      nextPageSize as (typeof PAGE_SIZE_OPTIONS)[number],
                    )
                  ) {
                    setPageSize(
                      nextPageSize as (typeof PAGE_SIZE_OPTIONS)[number],
                    );
                  }
                  setPage(1);
                }}
              />
              <span>
                {filteredDoctors.length} of {doctors.length} doctors
              </span>
              <label className="flex items-center gap-2">
                <span>Rows</span>
                <select
                  value={pageSize}
                  onChange={(event) =>
                    setPageSize(Number(event.target.value) as typeof pageSize)
                  }
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  aria-sort={
                    sortKey === "name"
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <SortableHeader
                    column="name"
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  >
                    Doctor
                  </SortableHeader>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  aria-sort={
                    sortKey === "department"
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <SortableHeader
                    column="department"
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  >
                    Department
                  </SortableHeader>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  aria-sort={
                    sortKey === "specialization"
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <SortableHeader
                    column="specialization"
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  >
                    Specialization
                  </SortableHeader>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  aria-sort={
                    sortKey === "consultation_fee"
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <SortableHeader
                    column="consultation_fee"
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  >
                    Consultation Fee
                  </SortableHeader>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  aria-sort={
                    sortKey === "schedule"
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <SortableHeader
                    column="schedule"
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  >
                    Schedule
                  </SortableHeader>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  aria-sort={
                    sortKey === "status"
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <SortableHeader
                    column="status"
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  >
                    Status
                  </SortableHeader>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-card divide-y divide-border">
              {paginatedDoctors.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-6 py-10 text-center text-sm text-muted-foreground"
                  >
                    No doctors match your search.
                  </td>
                </tr>
              ) : (
                paginatedDoctors.map((doctor, index) => {
                  const key = doctorKey(doctor);
                  const isDeleting = key !== undefined && deleting === key;
                  return (
                    <tr
                      key={getRowKey(doctor, index)}
                      className="hover:bg-muted"
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            {doctor.name}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {doctor.email}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {doctor.phone}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-foreground">
                          {doctor.department}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-foreground">
                          {doctor.specialization}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-foreground">
                          {doctor.consultation_fee != null ? (
                            `₹${doctor.consultation_fee}`
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1">
                          {(
                            (doctor as Record<string, unknown>)
                              .available_days as string[] | undefined
                          )?.map((day: string) => (
                            <span
                              key={day}
                              className="inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary/10 text-primary"
                            >
                              {day.slice(0, 3)}
                            </span>
                          )) ?? (
                            <span className="text-xs text-muted-foreground">
                              Not set
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                            doctor.is_available
                              ? "bg-success/10 text-success"
                              : "bg-destructive/10 text-destructive"
                          }`}
                        >
                          {doctor.is_available ? "Available" : "Unavailable"}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                        <div className="flex items-center gap-3">
                          <Link
                            href={`/dashboard/doctors/edit/${key ?? ""}`}
                            className={`transition-colors ${key === undefined ? "pointer-events-none text-muted-foreground" : "text-primary hover:text-primary"}`}
                          >
                            Edit
                          </Link>
                          <button
                            onClick={() => handleDeleteClick(doctor)}
                            disabled={isDeleting || key === undefined}
                            className={`${
                              isDeleting || key === undefined
                                ? "text-muted-foreground cursor-not-allowed"
                                : "text-destructive hover:text-destructive transition-colors"
                            }`}
                          >
                            {isDeleting ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-border bg-card px-4 py-3 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
          <div>
            Showing {pageStart}-{pageEnd} of {filteredDoctors.length}
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-2">
              Page {clampedPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage(1)}
              disabled={clampedPage === 1}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="First page"
            >
              <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                setPage((currentPage) => Math.max(1, currentPage - 1))
              }
              disabled={clampedPage === 1}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                setPage((currentPage) => Math.min(totalPages, currentPage + 1))
              }
              disabled={clampedPage === totalPages}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setPage(totalPages)}
              disabled={clampedPage === totalPages}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Last page"
            >
              <ChevronsRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        setOpen={setConfirmOpen}
        title="Remove Doctor"
        message={
          pendingDoctor
            ? `This will remove Dr. ${pendingDoctor.name}'s account. Their records will be preserved.`
            : "This will remove the doctor's account. Their records will be preserved."
        }
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
