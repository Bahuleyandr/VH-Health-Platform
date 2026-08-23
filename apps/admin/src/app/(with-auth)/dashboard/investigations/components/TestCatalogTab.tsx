"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "react-hot-toast";
import {
  getTestCatalog,
  upsertTestCatalog,
  type TestCatalogItem,
} from "@/lib/api/investigations";

export function TestCatalogTab() {
  const [catalog, setCatalog] = useState<TestCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<Partial<TestCatalogItem> | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTestCatalog();
      setCatalog(Array.isArray(res) ? res : []);
    } catch {
      toast.error("Failed to load test catalog");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(item: Partial<TestCatalogItem>) {
    try {
      await upsertTestCatalog(item);
      toast.success(item.id ? "Test updated" : "Test added");
      setShowForm(false);
      setEditItem(null);
      load();
    } catch {
      toast.error("Failed to save");
    }
  }

  // Group by category
  const grouped = catalog.reduce<Record<string, TestCatalogItem[]>>(
    (acc, item) => {
      const cat = item.category || "other";
      (acc[cat] = acc[cat] || []).push(item);
      return acc;
    },
    {},
  );

  const categoryLabels: Record<string, string> = {
    blood: "🩸 Blood",
    urine: "🧪 Urine",
    radiology: "📷 Radiology",
    microbiology: "🦠 Microbiology",
    cardiac: "❤️ Cardiac",
    pathology: "🔬 Pathology",
  };

  if (loading)
    return (
      <div className="py-12 text-center text-muted-foreground">
        Loading catalog…
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          Test Catalog ({catalog.length} tests)
        </h3>
        <button
          onClick={() => {
            setEditItem({});
            setShowForm(true);
          }}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
        >
          + Add Test
        </button>
      </div>

      {/* Modal form */}
      {showForm && (
        <CatalogForm
          initial={editItem ?? {}}
          onSave={handleSave}
          onCancel={() => {
            setShowForm(false);
            setEditItem(null);
          }}
        />
      )}

      {/* Grouped display */}
      {Object.entries(grouped).map(([cat, items]) => (
        <section key={cat}>
          <h4 className="mb-2 text-base font-semibold capitalize">
            {categoryLabels[cat] ?? cat}
          </h4>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Cost (₹)</th>
                  <th className="px-3 py-2">TAT (hrs)</th>
                  <th className="px-3 py-2">Fasting</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-3 py-2">{item.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {item.code ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {item.default_cost != null
                        ? `₹${item.default_cost}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2">{item.turnaround_hours}h</td>
                    <td className="px-3 py-2">
                      {item.requires_fasting && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          Fasting
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => {
                          setEditItem(item);
                          setShowForm(true);
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function CatalogForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Partial<TestCatalogItem>;
  onSave: (item: Partial<TestCatalogItem>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Partial<TestCatalogItem>>({
    name: "",
    code: "",
    category: "blood",
    default_cost: undefined,
    turnaround_hours: 24,
    requires_fasting: false,
    normal_range: "",
    unit: "",
    patient_instructions: "",
    description: "",
    ...initial,
  });

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <h4 className="mb-3 font-semibold">
        {initial.id ? "Edit Test" : "Add New Test"}
      </h4>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <input
          placeholder="Test Name *"
          value={form.name ?? ""}
          onChange={(e) => set("name", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm"
        />
        <input
          placeholder="Code"
          value={form.code ?? ""}
          onChange={(e) => set("code", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm"
        />
        <select
          value={form.category ?? "blood"}
          onChange={(e) => set("category", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm"
        >
          {[
            "blood",
            "urine",
            "radiology",
            "microbiology",
            "cardiac",
            "pathology",
          ].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          type="number"
          placeholder="Cost (₹)"
          value={form.default_cost ?? ""}
          onChange={(e) =>
            set(
              "default_cost",
              e.target.value ? Number(e.target.value) : undefined,
            )
          }
          className="rounded border px-3 py-1.5 text-sm"
        />
        <input
          type="number"
          placeholder="TAT (hours)"
          value={form.turnaround_hours ?? 24}
          onChange={(e) => set("turnaround_hours", Number(e.target.value))}
          className="rounded border px-3 py-1.5 text-sm"
        />
        <input
          placeholder="Normal Range"
          value={form.normal_range ?? ""}
          onChange={(e) => set("normal_range", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm"
        />
        <input
          placeholder="Unit"
          value={form.unit ?? ""}
          onChange={(e) => set("unit", e.target.value)}
          className="rounded border px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.requires_fasting ?? false}
            onChange={(e) => set("requires_fasting", e.target.checked)}
          />
          Requires Fasting
        </label>
        <input
          placeholder="Patient Instructions"
          value={form.patient_instructions ?? ""}
          onChange={(e) => set("patient_instructions", e.target.value)}
          className="col-span-full rounded border px-3 py-1.5 text-sm"
        />
        <input
          placeholder="Description"
          value={form.description ?? ""}
          onChange={(e) => set("description", e.target.value)}
          className="col-span-full rounded border px-3 py-1.5 text-sm"
        />
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onSave(form)}
          className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground"
        >
          {initial.id ? "Update" : "Add"}
        </button>
        <button
          onClick={onCancel}
          className="rounded border px-4 py-1.5 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
