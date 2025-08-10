// src/app/dashboard/pharmacy/page.tsx
'use client';

// src/app/dashboard/pharmacy/page.tsx
import { useEffect, useState, useCallback } from 'react';
import { fetchAdminAPI } from '@/lib/api';
import type { PharmacyAnalytics, PharmacyOrder } from '@/lib/types';
import { PharmacyStats } from './components/PharmacyStats';
import { OrdersTable } from './components/OrdersTable';
import { PharmacyFilters as PharmacyFiltersComponent } from './components/PharmacyFilters';
import { useSearchParams, useRouter } from 'next/navigation';

// Avoid name clash with the component
interface PharmacyFilterParams {
  status?: string;
  dateRange?: string;
  search?: string;
}

type OrdersRespShape =
  | {
      orders?: PharmacyOrder[];
      data?: PharmacyOrder[];
      pagination?: { totalPages?: number; currentPage?: number };
    }
  | PharmacyOrder[];

type AnalyticsRespShape = { analytics?: PharmacyAnalytics } | PharmacyAnalytics;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function normalizeAnalytics(resp: AnalyticsRespShape): PharmacyAnalytics | null {
  if (isObj(resp) && 'analytics' in resp) {
    const a = (resp as { analytics?: PharmacyAnalytics }).analytics;
    return a ?? null;
  }
  // Otherwise it's already a PharmacyAnalytics
  return resp as PharmacyAnalytics;
}

function normalizeOrders(
  resp: OrdersRespShape
): {
  orders: PharmacyOrder[];
  pagination?: { totalPages?: number; currentPage?: number };
} {
  if (Array.isArray(resp)) {
    return { orders: resp as PharmacyOrder[] };
  }

  if (isObj(resp)) {
    const r = resp as {
      orders?: unknown;
      data?: unknown;
      pagination?: { totalPages?: number; currentPage?: number };
    };

    const orders: PharmacyOrder[] =
      (Array.isArray(r.orders) ? (r.orders as PharmacyOrder[]) : undefined) ??
      (Array.isArray(r.data) ? (r.data as PharmacyOrder[]) : []) ??
      [];

    const pagination = r.pagination;
    return { orders, pagination };
  }

  return { orders: [] };
}

export default function PharmacyPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [analytics, setAnalytics] = useState<PharmacyAnalytics | null>(null);
  const [orders, setOrders] = useState<PharmacyOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const itemsPerPage = 10;

  const fetchPharmacyData = useCallback(
    async (page: number, filters?: PharmacyFilterParams) => {
      try {
        setLoading(true);
        setError(null);

        // Build query params for orders
        const queryParams = new URLSearchParams();
        queryParams.set('page', page.toString());
        queryParams.set('limit', itemsPerPage.toString());

        if (filters?.status) queryParams.set('status', filters.status);
        if (filters?.dateRange) queryParams.set('dateRange', filters.dateRange);
        if (filters?.search) queryParams.set('search', filters.search);

        // Fetch both analytics and orders in parallel with proper typing
        const [analyticsResponse, ordersResponse] = await Promise.all([
          fetchAdminAPI<AnalyticsRespShape>('/pharmacy/analytics'),
          fetchAdminAPI<OrdersRespShape>(`/pharmacy/orders?${queryParams.toString()}`),
        ]);

        const normalizedAnalytics = normalizeAnalytics(analyticsResponse);
        if (normalizedAnalytics) setAnalytics(normalizedAnalytics);

        const { orders: list, pagination } = normalizeOrders(ordersResponse);
        setOrders(list);

        // Pagination
        if (pagination) {
          setTotalPages(pagination.totalPages ?? 1);
          setCurrentPage(pagination.currentPage ?? page);
        } else {
          // Fallback if backend doesn't return pagination
          setTotalPages(1);
          setCurrentPage(page);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch pharmacy data');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const pageParam = searchParams.get('page');
    const pageNumber = pageParam ? parseInt(pageParam, 10) : 1;

    const filters: PharmacyFilterParams = {
      status: searchParams.get('status') || undefined,
      dateRange: searchParams.get('dateRange') || undefined,
      search: searchParams.get('search') || undefined,
    };

    void fetchPharmacyData(pageNumber, filters);
  }, [searchParams, fetchPharmacyData]);

  const handleFilterChange = (filters: PharmacyFilterParams) => {
    const url = new URL(window.location.href);
    url.searchParams.set('page', '1');

    if (filters.status) url.searchParams.set('status', filters.status);
    else url.searchParams.delete('status');

    if (filters.dateRange) url.searchParams.set('dateRange', filters.dateRange);
    else url.searchParams.delete('dateRange');

    if (filters.search) url.searchParams.set('search', filters.search);
    else url.searchParams.delete('search');

    router.push(url.pathname + url.search);
  };

  const handleRefresh = () => {
    const filters: PharmacyFilterParams = {
      status: searchParams.get('status') || undefined,
      dateRange: searchParams.get('dateRange') || undefined,
      search: searchParams.get('search') || undefined,
    };
    void fetchPharmacyData(currentPage, filters);
  };

  const handlePageChange = (newPage: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set('page', String(newPage));
    router.push(url.pathname + url.search);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Pharmacy Management</h1>

      {analytics && <PharmacyStats analytics={analytics} />}

      <div className="mt-8">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">Pharmacy Orders</h2>

        <PharmacyFiltersComponent onFilterChange={handleFilterChange} />

        {orders.length === 0 ? (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No pharmacy orders found.</p>
          </div>
        ) : (
          <>
            <OrdersTable orders={orders} onOrderUpdated={handleRefresh} />

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <div className="text-sm text-gray-700">
                  Showing page {currentPage} of {totalPages}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage === 1}
                    className={`px-4 py-2 rounded-md font-medium transition-colors ${
                      currentPage === 1
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : 'bg-blue-600 text-white hover:bg-blue-700'
                    }`}
                  >
                    Previous
                  </button>

                  {/* Page numbers (windowed) */}
                  <div className="flex gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }

                      return (
                        <button
                          key={pageNum}
                          onClick={() => handlePageChange(pageNum)}
                          className={`px-3 py-1 rounded-md transition-colors ${
                            currentPage === pageNum
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage === totalPages}
                    className={`px-4 py-2 rounded-md font-medium transition-colors ${
                      currentPage === totalPages
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : 'bg-blue-600 text-white hover:bg-blue-700'
                    }`}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
