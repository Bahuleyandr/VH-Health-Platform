"use client";

import { useState } from "react";
import type { CatalogItem } from "./types";

const CATEGORIES = [
  "analgesics",
  "antibiotics",
  "antacids",
  "vitamins",
  "cardiac",
  "diabetes",
  "hormones",
  "antihistamines",
  "respiratory",
  "general",
  "other",
];

export function CatalogForm({
  item,
  onSave,
  onCancel,
}: {
  item: CatalogItem | null;
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    id: item?.id || undefined,
    name: item?.name || "",
    generic_name: item?.generic_name || "",
    category: item?.category || "other",
    manufacturer: item?.manufacturer || "",
    unit_price: item?.unit_price?.toString() || "",
    pack_size: item?.pack_size || "",
    requires_prescription: item?.requires_prescription ?? true,
    in_stock: item?.in_stock ?? true,
    stock_quantity: item?.stock_quantity?.toString() || "0",
    reorder_level: item?.reorder_level?.toString() || "10",
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl max-w-md w-full p-6 max-h-[80vh] overflow-y-auto">
        <h3 className="text-lg font-bold mb-4">
          {item ? "Edit Medicine" : "Add Medicine"}
        </h3>

        <div className="space-y-3">
          <input
            placeholder="Medicine Name *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
          <input
            placeholder="Generic Name"
            value={form.generic_name}
            onChange={(e) => setForm({ ...form, generic_name: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            placeholder="Manufacturer"
            value={form.manufacturer}
            onChange={(e) => setForm({ ...form, manufacturer: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Unit Price"
              type="number"
              value={form.unit_price}
              onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Pack Size"
              value={form.pack_size}
              onChange={(e) => setForm({ ...form, pack_size: e.target.value })}
              className="border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Stock Qty"
              type="number"
              value={form.stock_quantity}
              onChange={(e) =>
                setForm({ ...form, stock_quantity: e.target.value })
              }
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Reorder Level"
              type="number"
              value={form.reorder_level}
              onChange={(e) =>
                setForm({ ...form, reorder_level: e.target.value })
              }
              className="border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.requires_prescription}
                onChange={(e) =>
                  setForm({ ...form, requires_prescription: e.target.checked })
                }
              />
              Prescription Required
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.in_stock}
                onChange={(e) =>
                  setForm({ ...form, in_stock: e.target.checked })
                }
              />
              In Stock
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 border rounded-lg text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              onSave({
                ...form,
                unit_price: form.unit_price ? Number(form.unit_price) : null,
                stock_quantity: Number(form.stock_quantity) || 0,
                reorder_level: Number(form.reorder_level) || 10,
              })
            }
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90"
          >
            {item ? "Update" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
