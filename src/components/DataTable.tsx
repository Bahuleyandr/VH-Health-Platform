// src/components/DataTable.tsx
interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  onSelectionChange?: (selected: T[]) => void;
}

export function DataTable<T extends { id: string }>({
  data,
  columns,
  onRowClick,
  selectable,
  onSelectionChange,
}: DataTableProps<T>) {
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  
  // Reusable table logic here
}