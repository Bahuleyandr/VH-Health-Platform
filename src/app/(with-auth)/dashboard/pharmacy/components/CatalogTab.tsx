"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI, postJSON } from "@/lib/api";
import type { CatalogItem } from "./types";
import { CatalogForm } from "./CatalogForm";

export function CatalogTab() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<CatalogItem | null>(null);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchAdminAPI<{ data: CatalogItem[] }>("/pharmacy-orders/catalog");
      const data = (r as Record<string, unknown>).data ?? r;
      setCatalog(Array.isArray(data) ? data : []);
    } catch {
      /* empty */
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

  // Group by category
  const grouped = catalog.reduce(
    (acc, item) => {
      const cat = item.category || "other";
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(item);
      return acc;
    },
    {} as Record<string, CatalogItem[]>,
  );

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

      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} className="border border-border rounded-lg overflow-hidden">
          <div className="bg-muted px-4 py-2 font-medium capitalize">{category}</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Name</th>
                <th className="py-2 px-3">Generic Name</th>
                <th className="py-2 px-3">Price</th>
                <th className="py-2 px-3">Pack Size</th>
                <th className="py-2 px-3">Rx</th>
                <th className="py-2 px-3">Stock</th>
                <th className="py-2 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-border hover:bg-muted/30">
                  <td className="py-2 px-3 font-medium">{item.name}</td>
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
      ))}

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
