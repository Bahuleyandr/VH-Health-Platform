"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MessageSquare,
  Star,
  Search,
  RefreshCw,
  Eye,
  TrendingUp,
  BarChart3,
  Filter,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FeedbackItem {
  id?: number;
  patient_id?: string;
  patient_name?: string;
  doctor_id?: string;
  doctor_name?: string;
  department?: string;
  rating: number;
  comment?: string;
  category?: string;
  status?: string;
  response?: string;
  responded_by?: string;
  responded_at?: string;
  created_at?: string;
}

interface FeedbackStats {
  total_feedback?: number;
  average_rating?: number;
  response_rate?: number;
  by_rating?: Record<string, number>;
  by_department?: Array<{ department: string; avg_rating: number; count: number }>;
  by_doctor?: Array<{ doctor_name: string; avg_rating: number; count: number }>;
  trends?: Array<{ month: string; avg_rating: number; count: number }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

function fmtDate(d?: string | null) {
  if (!d) return "\u2014";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function StarRating({ rating, size = "sm" }: { rating: number; size?: "sm" | "lg" }) {
  const cls = size === "lg" ? "h-5 w-5" : "h-4 w-4";
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`${cls} ${i <= rating ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}`}
        />
      ))}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function FeedbackPage() {
  const [activeTab, setActiveTab] = useState<"list" | "stats">("list");
  const [search, setSearch] = useState("");
  const [ratingFilter, setRatingFilter] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [selectedFeedback, setSelectedFeedback] = useState<FeedbackItem | null>(null);

  // Fetch feedback list
  const {
    data: feedbackList,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<FeedbackItem[]>({
    queryKey: ["feedback-list"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/feedback");
      const data = unwrap<{ feedback?: FeedbackItem[] } | FeedbackItem[]>(res);
      return Array.isArray(data) ? data : data.feedback ?? [];
    },
  });

  // Fetch feedback stats
  const { data: stats, isLoading: statsLoading } = useQuery<FeedbackStats>({
    queryKey: ["feedback-stats"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/feedback/stats");
      const data = unwrap<any>(res);
      const overall = data?.overallStats ?? data ?? {};
      return {
        total_feedback: Number(overall.total_feedback ?? 0),
        average_rating: Number(overall.average_rating ?? 0),
        response_rate:
          Number(overall.total_feedback ?? 0) > 0
            ? Math.round((Number(overall.responded_count ?? 0) / Number(overall.total_feedback ?? 1)) * 100)
            : 0,
      };
    },
  });

  const departments = [
    "all",
    ...new Set((feedbackList ?? []).map((f) => f.department).filter(Boolean) as string[]),
  ];

  const filtered = (feedbackList ?? []).filter((f) => {
    const matchesSearch =
      !search ||
      (f.patient_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (f.doctor_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (f.comment ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (f.department ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesRating =
      ratingFilter === "all" || f.rating === parseInt(ratingFilter);
    const matchesDept =
      departmentFilter === "all" || f.department === departmentFilter;
    return matchesSearch && matchesRating && matchesDept;
  });

  const overviewStats = {
    total: feedbackList?.length ?? stats?.total_feedback ?? 0,
    avgRating: stats?.average_rating ?? (feedbackList && feedbackList.length > 0
      ? (feedbackList.reduce((s, f) => s + f.rating, 0) / feedbackList.length).toFixed(1)
      : "0"),
    responseRate: stats?.response_rate ?? 0,
  };

  const tabs = [
    { key: "list" as const, label: "Feedback", icon: MessageSquare },
    { key: "stats" as const, label: "Statistics", icon: BarChart3 },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <MessageSquare className="h-6 w-6" />
            Feedback Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Patient feedback, ratings, and satisfaction tracking
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="border border-border rounded-lg bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" /> Total Feedback
          </div>
          <p className="text-2xl font-bold mt-1">{overviewStats.total}</p>
        </div>
        <div className="border border-yellow-200 rounded-lg bg-yellow-50 p-4">
          <div className="flex items-center gap-2 text-sm text-yellow-600">
            <Star className="h-4 w-4" /> Average Rating
          </div>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-2xl font-bold text-yellow-700">{overviewStats.avgRating}</p>
            <StarRating rating={Math.round(Number(overviewStats.avgRating))} size="lg" />
          </div>
        </div>
        <div className="border border-blue-200 rounded-lg bg-blue-50 p-4">
          <div className="flex items-center gap-2 text-sm text-blue-600">
            <TrendingUp className="h-4 w-4" /> Response Rate
          </div>
          <p className="text-2xl font-bold mt-1 text-blue-700">{overviewStats.responseRate}%</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* List Tab */}
      {activeTab === "list" && (
        <>
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search feedback..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-md border border-border bg-card pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <select
              value={ratingFilter}
              onChange={(e) => setRatingFilter(e.target.value)}
              className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="all">All Ratings</option>
              {[5, 4, 3, 2, 1].map((r) => (
                <option key={r} value={r}>{r} Star{r !== 1 ? "s" : ""}</option>
              ))}
            </select>
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {departments.map((d) => (
                <option key={d} value={d}>{d === "all" ? "All Departments" : d}</option>
              ))}
            </select>
          </div>

          {isLoading && (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full rounded-lg" />
              ))}
            </div>
          )}

          {isError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
              {error instanceof Error ? error.message : "Failed to load feedback"}
            </div>
          )}

          {!isLoading && !isError && filtered.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-40" />
              <p className="text-lg font-medium">No feedback found</p>
              <p className="text-sm mt-1">Try adjusting your filters</p>
            </div>
          )}

          {/* Detail Panel */}
          {selectedFeedback && (
            <div className="border border-border rounded-lg bg-card p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Feedback Details</h3>
                <button onClick={() => setSelectedFeedback(null)} className="text-muted-foreground hover:text-foreground text-sm">
                  Close
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Patient:</span>
                  <p className="font-medium">{selectedFeedback.patient_name ?? "\u2014"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Doctor:</span>
                  <p className="font-medium">{selectedFeedback.doctor_name ?? "\u2014"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Department:</span>
                  <p className="font-medium">{selectedFeedback.department ?? "\u2014"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Rating:</span>
                  <StarRating rating={selectedFeedback.rating} />
                </div>
                <div>
                  <span className="text-muted-foreground">Date:</span>
                  <p>{fmtDate(selectedFeedback.created_at)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Category:</span>
                  <p className="font-medium">{selectedFeedback.category ?? "\u2014"}</p>
                </div>
              </div>
              {selectedFeedback.comment && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Comment:</span>
                  <p className="mt-1 bg-muted/50 rounded-md p-3">{selectedFeedback.comment}</p>
                </div>
              )}
              {selectedFeedback.response && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Response:</span>
                  <p className="mt-1 bg-blue-50 rounded-md p-3 text-blue-800">{selectedFeedback.response}</p>
                  {selectedFeedback.responded_by && (
                    <p className="text-xs text-muted-foreground mt-1">
                      By {selectedFeedback.responded_by} on {fmtDate(selectedFeedback.responded_at)}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Table */}
          {!isLoading && filtered.length > 0 && (
            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Patient</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Doctor</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Department</th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">Rating</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Comment</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((item, idx) => (
                    <tr key={item.id ?? idx} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium">{item.patient_name ?? "\u2014"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{item.doctor_name ?? "\u2014"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{item.department ?? "\u2014"}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-center">
                          <StarRating rating={item.rating} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">
                        {item.comment ?? "\u2014"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(item.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelectedFeedback(item)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                        >
                          <Eye className="h-3.5 w-3.5" /> View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Stats Tab */}
      {activeTab === "stats" && (
        <div className="space-y-6">
          {statsLoading && (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-32 w-full rounded-lg" />
              ))}
            </div>
          )}

          {stats && (
            <>
              {/* Rating Distribution */}
              {stats.by_rating && (
                <div className="border border-border rounded-lg bg-card p-6">
                  <h3 className="text-lg font-semibold mb-4">Rating Distribution</h3>
                  <div className="space-y-3">
                    {[5, 4, 3, 2, 1].map((r) => {
                      const count = stats.by_rating?.[String(r)] ?? 0;
                      const total = Object.values(stats.by_rating ?? {}).reduce((s, v) => s + v, 0);
                      const pct = total > 0 ? (count / total) * 100 : 0;
                      return (
                        <div key={r} className="flex items-center gap-3">
                          <span className="text-sm w-16 flex items-center gap-1">
                            {r} <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                          </span>
                          <div className="flex-1 h-4 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-yellow-400 rounded-full transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-sm text-muted-foreground w-12 text-right">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* By Department */}
              {stats.by_department && stats.by_department.length > 0 && (
                <div className="border border-border rounded-lg bg-card p-6">
                  <h3 className="text-lg font-semibold mb-4">By Department</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 font-medium text-muted-foreground">Department</th>
                          <th className="text-center py-2 font-medium text-muted-foreground">Avg Rating</th>
                          <th className="text-right py-2 font-medium text-muted-foreground">Count</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {stats.by_department.map((d) => (
                          <tr key={d.department}>
                            <td className="py-2 font-medium">{d.department}</td>
                            <td className="py-2 text-center">
                              <div className="flex items-center justify-center gap-1">
                                {d.avg_rating.toFixed(1)}
                                <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                              </div>
                            </td>
                            <td className="py-2 text-right text-muted-foreground">{d.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* By Doctor */}
              {stats.by_doctor && stats.by_doctor.length > 0 && (
                <div className="border border-border rounded-lg bg-card p-6">
                  <h3 className="text-lg font-semibold mb-4">By Doctor</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 font-medium text-muted-foreground">Doctor</th>
                          <th className="text-center py-2 font-medium text-muted-foreground">Avg Rating</th>
                          <th className="text-right py-2 font-medium text-muted-foreground">Count</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {stats.by_doctor.map((d) => (
                          <tr key={d.doctor_name}>
                            <td className="py-2 font-medium">{d.doctor_name}</td>
                            <td className="py-2 text-center">
                              <div className="flex items-center justify-center gap-1">
                                {d.avg_rating.toFixed(1)}
                                <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                              </div>
                            </td>
                            <td className="py-2 text-right text-muted-foreground">{d.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
