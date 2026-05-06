"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAdminAPI, postJSON } from "@/lib/api";
import {
  ClientTablePagination,
  ManagedTableToolbar,
  SortableTableHeader,
  compareTableValues,
  paginateRows,
  type SortDirection,
} from "@/components/table";
import type { CatalogItem } from "./types";
import { CatalogForm } from "./CatalogForm";

type CatalogSortKey = "name" | "category" | "generic_name" | "unit_price" | "stock_quantity";
const CATALOG_SORT_KEYS: CatalogSortKey[] = ["name", "category", "generic_name", "unit_price", "stock_quantity"];
const PAGE_SIZE_OPTIONS = [10, 50, 100];

export function CatalogTab() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sortKey, setSortKey] = useState<CatalogSortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<CatalogItem | null>(null);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: CatalogItem[] }>("/pharmacy-orders/catalog");
      const data = (r as Record<string, unknown>).data ?? r;
      setCatalog(Array.isArray(data) ? data : []);
    } catch (err) {
      setCatalog([]);
      setError(err instanceof Error ? err.message : "Failed to load medicine catalog");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  const handleSave = async (item: Record<string, unknown>) => {
    try {
      await postJSON("/api/v1/pharmacy-orders/catalog", item);
      setShowForm(false);
      setEditItem(null);
      fetchCatalog();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Save failed");
    }
  };

  useEffect(() => {
    setPage(1);
  }, [categoryFilter, pageSize, search]);

  const categories = useMemo(
    () => [...new Set(catalog.map((item) => item.category || "other"))].sort((a, b) => a.localeCompare(b)),
    [catalog],
  );

  const visibleCatalog = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = catalog.filter((item) => {
      const matchesCategory = !categoryFilter || (item.category || "other") === categoryFilter;
      const matchesSearch = !term || [item.name, item.generic_name, item.category, item.manufacturer, item.pack_size]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
      return matchesCategory && matchesSearch;
    });
    return [...filtered].sort((a, b) => {
      const direction = sortDirection === "asc" ? 1 : -1;
      return compareTableValues(a[sortKey], b[sortKey]) * direction;
    });
  }, [catalog, categoryFilter, search, sortDirection, sortKey]);

  const pagedCatalog = paginateRows(visibleCatalog, page, pageSize);

  const handleSort = (key: CatalogSortKey) => {
    setSortDirection((current) => (sortKey === key && current === "asc" ? "desc" : "asc"));
    setSortKey(key);
  };

  if (loading) return <div className="text-center py-8">Loading catalog...</div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Medicine Catalog ({catalog.length})</h3>
        <button
          onClick={() => {
            setEditItem(null);
            setShowForm(true);
          }}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90"
        >
          + Add Medicine
        </button>
      </div>

      <ManagedTableToolbar
        search={search}
        onSearchChange={setSearch}
        placeholder="Search medicine, generic, category, manufacturer"
        countLabel={`${visibleCatalog.length} of ${catalog.length} medicines`}
        savedViewScope="pharmacy-catalog"
        savedViewState={{ search, categoryFilter, sortKey, sortDirection, pageSize }}
        onApplySavedView={(view) => {
          setSearch(String(view.search ?? ""));
          setCategoryFilter(String(view.categoryFilter ?? ""));
          if (CATALOG_SORT_KEYS.includes(view.sortKey as CatalogSortKey)) {
            setSortKey(view.sortKey as CatalogSortKey);
          }
          setSortDirection(view.sortDirection === "desc" ? "desc" : "asc");
          const nextPageSize = Number(view.pageSize);
          if (PAGE_SIZE_OPTIONS.includes(nextPageSize)) setPageSize(nextPageSize);
          setPage(1);
        }}
      >
        <select
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
          className="rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
        >
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </ManagedTableToolbar>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      ) : visibleCatalog.length === 0 ? (
        <div className="rounded-lg border border-border py-10 text-center text-sm text-muted-foreground">
          No medicines match the current filters
        </div>
      ) : (
        <>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-[900px] w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <SortableTableHeader label="Name" sortKey="name" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                <SortableTableHeader label="Category" sortKey="category" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                <SortableTableHeader label="Generic Name" sortKey="generic_name" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                <SortableTableHeader label="Price" sortKey="unit_price" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                <th className="py-2 px-3">Pack Size</th>
                <th className="py-2 px-3">Rx</th>
                <SortableTableHeader label="Stock" sortKey="stock_quantity" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                <th className="py-2 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pagedCatalog.rows.map((item) => (
                <tr key={item.id} className="border-b border-border hover:bg-muted/30">
                  <td className="py-2 px-3 font-medium">{item.name}</td>
                  <td className="py-2 px-3 capitalize">{item.category || "other"}</td>
                  <td className="py-2 px-3 text-muted-foreground">{item.generic_name || "—"}</td>
                  <td className="py-2 px-3">{item.unit_price ? `₹${item.unit_price}` : "—"}</td>
                  <td className="py-2 px-3">{item.pack_size || "—"}</td>
                  <td className="py-2 px-3">
                    {item.requires_prescription ? (
                      <span className="text-red-600 text-xs font-medium">Rx</span>
                    ) : (
                      <span className="text-green-600 text-xs">OTC</span>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={
                        item.stock_quantity <= item.reorder_level
                          ? "text-red-600 font-medium"
                          : ""
                      }
                    >
                      {item.stock_quantity}
                    </span>
                    {item.stock_quantity <= item.reorder_level && (
                      <span className="text-red-500 text-xs ml-1">⚠ Low</span>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() => {
                        setEditItem(item);
                        setShowForm(true);
                      }}
                      className="text-primary text-xs hover:underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ClientTablePagination
          page={pagedCatalog.page}
          pageSize={pageSize}
          total={visibleCatalog.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          itemLabel="medicines"
        />
        </>
      )}

      {showForm && (
        <CatalogForm
          item={editItem}
          onSave={handleSave}
          onCancel={() => {
            setShowForm(false);
            setEditItem(null);
          }}
        />
      )}
    </div>
  );
}
