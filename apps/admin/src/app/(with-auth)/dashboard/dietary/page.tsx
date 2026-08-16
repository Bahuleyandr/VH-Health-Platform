// src/app/(with-auth)/dashboard/dietary/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";

type DietaryOrder = {
  id: number;
  patient_uid: string;
  diet_type: string;
  status: string;
  notes?: string;
  ordered_at: string;
  updated_at?: string;
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  PREPARING: "bg-blue-100 text-blue-800",
  DELIVERED: "bg-green-100 text-green-800",
  CANCELLED: "bg-gray-100 text-gray-600",
  ON_HOLD: "bg-orange-100 text-orange-800",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status?.toUpperCase()] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
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

function WorklistTab() {
  const [orders, setOrders] = useState<DietaryOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    id: number;
    status: string;
    notes: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: DietaryOrder[] }>(
        "/dietary/worklist",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load worklist");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await putJSON(`/api/v1/dietary/${editing.id}`, {
        status: editing.status,
        notes: editing.notes,
      });
      setEditing(null);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Dietary Worklist</h2>
        <button onClick={load} className="text-sm text-primary hover:underline">
          ↻ Refresh
        </button>
      </div>
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}
      {!loading && orders.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No dietary orders
        </div>
      )}
      {orders.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">ID</th>
                <th className="py-2 px-3">Diet Type</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Notes</th>
                <th className="py-2 px-3">Ordered</th>
                <th className="py-2 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="py-2 px-3 font-mono text-xs">{o.id}</td>
                  <td className="py-2 px-3 font-medium">{o.diet_type}</td>
                  <td className="py-2 px-3">
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground max-w-xs truncate">
                    {o.notes ?? "—"}
                  </td>
                  <td className="py-2 px-3">{fmtDate(o.ordered_at)}</td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() =>
                        setEditing({
                          id: o.id,
                          status: o.status,
                          notes: o.notes ?? "",
                        })
                      }
                      className="text-xs text-primary hover:underline"
                    >
                      Update
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl max-w-md w-full p-6 space-y-3">
            <div className="flex justify-between">
              <h3 className="font-bold">Update Order #{editing.id}</h3>
              <button
                onClick={() => setEditing(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <select
              value={editing.status}
              onChange={(e) =>
                setEditing({ ...editing, status: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {[
                "PENDING",
                "PREPARING",
                "DELIVERED",
                "CANCELLED",
                "ON_HOLD",
              ].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <textarea
              rows={2}
              placeholder="Notes (optional)"
              value={editing.notes}
              onChange={(e) =>
                setEditing({ ...editing, notes: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setEditing(null)}
                className="flex-1 py-2 border rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewOrderTab() {
  const [form, setForm] = useState({
    patient_uid: "",
    diet_type: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const submit = async () => {
    if (!form.patient_uid || !form.diet_type) {
      alert("Patient UID and diet type are required");
      return;
    }
    setSaving(true);
    setSuccess(false);
    try {
      await postJSON("/api/v1/dietary/orders", form);
      setSuccess(true);
      setForm({ patient_uid: "", diet_type: "", notes: "" });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create order");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-md space-y-3">
      <h2 className="text-lg font-semibold">New Dietary Order</h2>
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">
          Order created.
        </div>
      )}
      <input
        placeholder="Patient UID *"
        value={form.patient_uid}
        onChange={(e) => setForm({ ...form, patient_uid: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <input
        placeholder="Diet type (e.g. DIABETIC, LOW_SODIUM, NPO) *"
        value={form.diet_type}
        onChange={(e) => setForm({ ...form, diet_type: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <textarea
        rows={2}
        placeholder="Notes (optional)"
        value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
      />
      <button
        onClick={submit}
        disabled={saving}
        className="w-full py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50"
      >
        {saving ? "Creating..." : "Create Order"}
      </button>
    </div>
  );
}

type MenuItem = {
  id: string;
  name: string;
  meal_type: string;
  diet_types: string[];
  is_veg: boolean;
  allergen_tags: string[];
  active: boolean;
  notes?: string | null;
};

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];
const MENU_DIET_TYPES = [
  "regular",
  "diabetic",
  "cardiac",
  "renal",
  "soft",
  "liquid",
  "enteral",
];

const emptyMenuForm = {
  name: "",
  meal_type: "breakfast",
  diet_types: [] as string[],
  is_veg: true,
  allergen_tags: "",
  notes: "",
};

// Kitchen menu master (migration 685). Menu management deliberately lives on
// the admin portal: the backend gates mutations to SUPER_ADMIN/ADMIN/DIETITIAN
// and this is where those managers work; kitchen staff consume the menu from
// the staff-app kitchen board.
function MenuTab() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyMenuForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data?: { items?: MenuItem[] } }>(
        "/dietary/menu-items",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      const list = (data as { items?: MenuItem[] })?.items;
      setItems(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load menu");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleDiet = (diet: string) => {
    setForm((f) => ({
      ...f,
      diet_types: f.diet_types.includes(diet)
        ? f.diet_types.filter((d) => d !== diet)
        : [...f.diet_types, diet],
    }));
  };

  const create = async () => {
    if (!form.name.trim()) {
      alert("Item name is required");
      return;
    }
    setSaving(true);
    try {
      await postJSON("/api/v1/dietary/menu-items", {
        name: form.name.trim(),
        meal_type: form.meal_type,
        diet_types: form.diet_types,
        is_veg: form.is_veg,
        allergen_tags: form.allergen_tags
          .split(/[,;\n]/)
          .map((t) => t.trim())
          .filter(Boolean),
        notes: form.notes.trim() || undefined,
      });
      setForm(emptyMenuForm);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create menu item");
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (item: MenuItem, active: boolean) => {
    try {
      await putJSON(`/api/v1/dietary/menu-items/${item.id}`, { active });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update menu item");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Kitchen Menu Master</h2>
        <button onClick={load} className="text-sm text-primary hover:underline">
          ↻ Refresh
        </button>
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3 max-w-2xl">
        <h3 className="font-medium text-sm">Add menu item</h3>
        <div className="flex gap-2">
          <input
            aria-label="Item name"
            placeholder="Item name *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="flex-1 border border-border rounded-lg px-3 py-2 text-sm"
          />
          <select
            value={form.meal_type}
            onChange={(e) => setForm({ ...form, meal_type: e.target.value })}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            {MEAL_TYPES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input
              aria-label="Vegetarian item"
              type="checkbox"
              checked={form.is_veg}
              onChange={(e) => setForm({ ...form, is_veg: e.target.checked })}
            />
            Veg
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {MENU_DIET_TYPES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDiet(d)}
              className={`px-2 py-1 rounded-full text-xs border ${form.diet_types.includes(d) ? "bg-primary text-white border-primary" : "border-border text-muted-foreground"}`}
            >
              {d}
            </button>
          ))}
        </div>
        <input
          aria-label="Allergen tags"
          placeholder="Allergen tags (comma-separated, e.g. peanut, milk)"
          value={form.allergen_tags}
          onChange={(e) => setForm({ ...form, allergen_tags: e.target.value })}
          className="w-full border border-border rounded-lg px-3 py-2 text-sm"
        />
        <button
          onClick={create}
          disabled={saving}
          className="py-2 px-4 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? "Adding..." : "Add item"}
        </button>
      </div>

      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No menu items yet — add the kitchen&apos;s dishes above
        </div>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Name</th>
                <th className="py-2 px-3">Meal</th>
                <th className="py-2 px-3">Suits diets</th>
                <th className="py-2 px-3">Veg</th>
                <th className="py-2 px-3">Allergens</th>
                <th className="py-2 px-3">Active</th>
                <th className="py-2 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr
                  key={it.id}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="py-2 px-3 font-medium">{it.name}</td>
                  <td className="py-2 px-3">{it.meal_type}</td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {it.diet_types?.join(", ") || "—"}
                  </td>
                  <td className="py-2 px-3">{it.is_veg ? "Veg" : "Non-veg"}</td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {it.allergen_tags?.join(", ") || "—"}
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${it.active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}
                    >
                      {it.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() => setActive(it, !it.active)}
                      className="text-xs text-primary hover:underline"
                    >
                      {it.active ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DietaryContent() {
  const [tab, setTab] = useState<"worklist" | "new" | "menu">("worklist");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Dietary</h1>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[
          { key: "worklist" as const, label: "🥗 Worklist" },
          { key: "new" as const, label: "+ New Order" },
          { key: "menu" as const, label: "🍽️ Menu" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "worklist" && <WorklistTab />}
      {tab === "new" && <NewOrderTab />}
      {tab === "menu" && <MenuTab />}
    </div>
  );
}

export default function DietaryPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading dietary...</div>}>
      <DietaryContent />
    </Suspense>
  );
}
