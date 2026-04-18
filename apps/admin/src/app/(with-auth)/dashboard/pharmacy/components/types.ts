// Shared types for the pharmacy admin feature.

export interface PharmacyOrderLifecycle {
  id: number;
  order_number: string;
  patient_id: number;
  patient_name: string;
  phone: string;
  order_note: string | null;
  prescription_photo_key: string | null;
  prescription_photo_url: string | null;
  delivery_type: "delivery" | "pickup";
  delivery_address: string | null;
  delivery_phone: string | null;
  status: string;
  total_cost: number | null;
  items_list: Array<{ name: string; qty: number; price: number }> | null;
  confirmed_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  delivery_person: string | null;
  delivery_person_phone: string | null;
  sla_breached: boolean;
  mins_since_placed: number;
  created_at: string;
  estimated_delivery_mins: number | null;
  delivery_distance_km: number | null;
  delivery_tracking_active: boolean;
}

export interface SLAData {
  summary: {
    total: string;
    placed: string;
    confirmed: string;
    preparing: string;
    dispatched: string;
    delivered: string;
    cancelled: string;
    total_revenue: string;
  };
  avg_times: {
    avg_confirm_mins: string | null;
    avg_dispatch_mins: string | null;
    avg_delivery_mins: string | null;
  };
  sla_breaches: number;
  date_range: { from: string; to: string };
}

export interface CatalogItem {
  id: number;
  name: string;
  generic_name: string | null;
  category: string;
  manufacturer: string | null;
  unit_price: number | null;
  pack_size: string | null;
  requires_prescription: boolean;
  in_stock: boolean;
  stock_quantity: number;
  reorder_level: number;
  is_active: boolean;
}
