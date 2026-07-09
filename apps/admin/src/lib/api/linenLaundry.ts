import { fetchAdminAPI } from "@/lib/api";

export type LinenParLevel = {
  id: number;
  ward_id: number;
  ward_name: string;
  item_type_id: number;
  item_code: string;
  display_name: string;
  category: string;
  unit: string;
  par_quantity: number;
  actual_quantity: number;
  reorder_threshold: number;
  par_delta: number;
  below_par: boolean;
  last_counted_at?: string | null;
  updated_at?: string;
};

export type LinenCycle = {
  id: number;
  cycle_code: string;
  ward_id: number;
  ward_name: string;
  status: string;
  discrepancy_flag: boolean;
  item_count: number;
  soiled_collected_quantity: number;
  clean_returned_quantity: number;
  updated_at?: string;
};

export type LinenBoard = {
  summary: {
    par_level_count: number;
    below_par_count: number;
    open_cycle_count: number;
    discrepancy_cycle_count: number;
    shortage_quantity: number;
  };
  par_levels: LinenParLevel[];
  cycles: LinenCycle[];
};

export function getLinenBoard(params?: { wardId?: number; limit?: number }) {
  const query = new URLSearchParams();
  if (params?.wardId) query.set("ward_id", String(params.wardId));
  if (params?.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return fetchAdminAPI<LinenBoard>(`/linen-laundry/board${suffix}`);
}
