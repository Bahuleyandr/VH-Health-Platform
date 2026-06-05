// Modal for editing one admin's permissions. Includes role-template
// shortcuts and per-category toggle groups.
"use client";

import { useCallback, useState } from "react";
import { toast } from "react-hot-toast";
import { putJSON } from "@/lib/api";
import type { AdminUser } from "@/lib/types";
import {
  PERMISSION_CATEGORIES,
  PERMISSION_DISPLAY,
  ROLE_TEMPLATES,
} from "./permissionsConfig";

interface PermissionEditModalProps {
  admin: AdminUser;
  onClose: () => void;
  onSaved?: () => void;
}

export function PermissionEditModal({
  admin,
  onClose,
  onSaved,
}: PermissionEditModalProps) {
  const [editPerms, setEditPerms] = useState<string[]>(
    Array.isArray(admin.permissions) ? [...admin.permissions] : [],
  );
  const [saving, setSaving] = useState(false);

  const togglePerm = useCallback((perm: string) => {
    setEditPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  }, []);

  const selectAllCategory = useCallback((perms: string[]) => {
    setEditPerms((prev) => {
      const set = new Set(prev);
      perms.forEach((p) => set.add(p));
      return Array.from(set);
    });
  }, []);

  const clearCategory = useCallback((perms: string[]) => {
    setEditPerms((prev) => prev.filter((p) => !perms.includes(p)));
  }, []);

  const applyTemplate = useCallback((templateKey: string) => {
    const tmpl = ROLE_TEMPLATES[templateKey];
    if (tmpl) setEditPerms([...tmpl.permissions]);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await putJSON("/api/v1/auth/admin/update-permissions", {
        adminId: admin.uid,
        permissions: editPerms,
      });
      toast.success(`Permissions updated for ${admin.name}`);
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save permissions",
      );
    } finally {
      setSaving(false);
    }
  }, [admin, editPerms, onSaved, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 m-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-semibold">
            Edit Permissions — {admin.name}
          </h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-muted-foreground text-xl"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="mb-5">
          <p className="text-sm font-medium text-foreground mb-2">
            Apply Role Template:
          </p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(ROLE_TEMPLATES).map(([key, tmpl]) => (
              <button
                key={key}
                onClick={() => applyTemplate(key)}
                className="px-3 py-1.5 text-sm rounded-full border border-input hover:border-primary hover:text-primary bg-card transition-colors"
              >
                {tmpl.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {Object.entries(PERMISSION_CATEGORIES).map(([catKey, cat]) => (
            <div key={catKey} className="border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-medium text-foreground">{cat.label}</h4>
                <div className="flex gap-2">
                  <button
                    onClick={() => selectAllCategory(cat.permissions)}
                    className="text-xs text-success hover:text-success"
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => clearCategory(cat.permissions)}
                    className="text-xs text-destructive hover:text-destructive"
                  >
                    Clear All
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {cat.permissions.map((perm) => {
                  const enabled = editPerms.includes(perm);
                  return (
                    <div
                      key={perm}
                      className="flex items-center justify-between"
                    >
                      <span className="text-sm text-foreground">
                        {PERMISSION_DISPLAY[perm] ?? perm}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        onClick={() => togglePerm(perm)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          enabled ? "bg-primary" : "bg-muted"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${
                            enabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground border border-input rounded-md"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm text-white bg-primary hover:bg-primary/90 rounded-md disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Permissions"}
          </button>
        </div>
      </div>
    </div>
  );
}
