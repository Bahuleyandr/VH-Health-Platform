'use client';

// src/app/dashboard/pharmacy/page.tsx
import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { PharmacyAnalytics, PharmacyOrder } from "@/lib/types";
import { PharmacyStats } from "./components/PharmacyStats";
import { OrdersTable } from "./components/OrdersTable";
import { PharmacyFilters } from "./components/PharmacyFilters";
import { useSearchParams, useRouter } from "next/navigation";

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

  const fetchPharmacyData = async (page: number, filters?: any) => {
    try {
      setLoading(true);
      setError(null);
      
      // Build query params for orders
      const queryParams = new URLSearchParams();
      queryParams.set('page', page.toString());
      queryParams.set('limit', itemsPerPage.toString());
      
      // Add filters to query params
      if (filters?.status) queryParams.set('status', filters.status);
      if (filters?.dateRange) queryParams.set('dateRange', filters.dateRange);
      if (filters?.search) queryParams.set('search', filters.search);
      
      // Fetch both analytics and orders data in parallel
      const [analyticsResponse, ordersResponse] = await Promise.all([
        fetchAdminAPI('/pharmacy/analytics'),
        fetchAdminAPI(`/pharmacy/orders?${queryParams.toString()}`)
      ]);

      setAnalytics(analyticsResponse.analytics || analyticsResponse);
      setOrders(ordersResponse.orders || []);
      
      // Set pagination info if available
      if (ordersResponse.pagination) {
        setTotalPages(ordersResponse.pagination.totalPages || 1);
        setCurrentPage(ordersResponse.pagination.currentPage || page);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch pharmacy data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const page = searchParams.get('page');
    const pageNumber = page ? parseInt(page) : 1;
    
    // Get filters from URL params
    const filters = {
      status: searchParams.get('status') || '',
      dateRange: searchParams.get('dateRange') || '',
      search: searchParams.get('search') || ''
    };
    
    fetchPharmacyData(pageNumber, filters);
  }, [searchParams]);

  const handleFilterChange = (filters: any) => {
    const url = new URL(window.location.href);
    
    // Reset to page 1 when filters change
    url.searchParams.set('page', '1');
    
    // Set filter params
    if (filters.status) {
      url.searchParams.set('status', filters.status);
    } else {
      url.searchParams.delete('status');
    }
    
    if (filters.dateRange) {
      url.searchParams.set('dateRange', filters.dateRange);
    } else {
      url.searchParams.delete('dateRange');
    }
    
    if (filters.search) {
      url.searchParams.set('search', filters.search);
    } else {
      url.searchParams.delete('search');
    }
    
    router.push(url.pathname + url.search);
  };

  const handleRefresh = () => {
    // Get current filters from URL params
    const filters = {
      status: searchParams.get('status') || '',
      dateRange: searchParams.get('dateRange') || '',
      search: searchParams.get('search') || ''
    };
    fetchPharmacyData(currentPage, filters);
  };

  // This function was missing in your code
  const handlePageChange = (newPage: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set('page', newPage.toString());
    router.push(url.pathname + url.search);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
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
        
        <PharmacyFilters onFilterChange={handleFilterChange} />
        
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
                  
                  {/* Page numbers */}
                  <div className="flex gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum;
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