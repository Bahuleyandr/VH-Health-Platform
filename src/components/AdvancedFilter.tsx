// src/components/AdvancedFilter.tsx
'use client';

import { useState, useCallback, useEffect } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { SearchIcon, FilterIcon, CalendarIcon, CloseIcon } from '@/components/icons';
import { cn } from '@/lib/utils';

/* ─── Types ─── */

export interface FilterValues {
  search: string;
  dateFrom: string;
  dateTo: string;
  status: string;
  role: string;
}

export interface AdvancedFilterProps {
  /** Called whenever any filter value changes */
  onFilterChange: (filters: FilterValues) => void;
  /** Options for the status dropdown */
  statusOptions?: string[];
  /** Options for the role/department dropdown */
  roleOptions?: string[];
  /** Label for the role/department dropdown (default: "Role") */
  roleLabel?: string;
  /** Show the date range pickers */
  showDateRange?: boolean;
  /** Show the status dropdown */
  showStatusFilter?: boolean;
  /** Show the role/department dropdown */
  showRoleFilter?: boolean;
  /** Placeholder for the search input */
  searchPlaceholder?: string;
  /** Debounce delay in ms (default: 300) */
  debounceMs?: number;
  /** Additional className for the wrapper */
  className?: string;
}

const EMPTY_FILTERS: FilterValues = {
  search: '',
  dateFrom: '',
  dateTo: '',
  status: '',
  role: '',
};

/* ─── Component ─── */

export function AdvancedFilter({
  onFilterChange,
  statusOptions = [],
  roleOptions = [],
  roleLabel = 'Role',
  showDateRange = false,
  showStatusFilter = false,
  showRoleFilter = false,
  searchPlaceholder = 'Search...',
  debounceMs = 300,
  className,
}: AdvancedFilterProps) {
  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);

  // Debounced callback that fires the parent onChange
  const debouncedNotify = useDebouncedCallback((next: FilterValues) => {
    onFilterChange(next);
  }, debounceMs);

  // For non-search fields we notify immediately
  const notifyImmediate = useCallback(
    (next: FilterValues) => {
      onFilterChange(next);
    },
    [onFilterChange],
  );

  // Update a single filter key
  const updateFilter = useCallback(
    (key: keyof FilterValues, value: string) => {
      setFilters((prev) => {
        const next = { ...prev, [key]: value };
        if (key === 'search') {
          debouncedNotify(next);
        } else {
          notifyImmediate(next);
        }
        return next;
      });
    },
    [debouncedNotify, notifyImmediate],
  );

  const clearAll = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    onFilterChange(EMPTY_FILTERS);
  }, [onFilterChange]);

  const hasActiveFilters =
    filters.search !== '' ||
    filters.dateFrom !== '' ||
    filters.dateTo !== '' ||
    filters.status !== '' ||
    filters.role !== '';

  // Common input classes matching the project style
  const inputCls =
    'w-full px-3 py-2 border border-input rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary bg-white';
  const labelCls = 'block text-sm font-medium text-foreground mb-1';

  return (
    <div
      className={cn(
        'bg-white rounded-lg border shadow-sm p-4 space-y-4',
        className,
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <FilterIcon className="h-4 w-4" />
          <span>Filters</span>
        </div>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <CloseIcon className="h-3 w-3" />
            Clear All
          </button>
        )}
      </div>

      {/* Filter controls — responsive grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Search input — always shown */}
        <div className="sm:col-span-2 lg:col-span-1">
          <label htmlFor="af-search" className={labelCls}>
            Search
          </label>
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              id="af-search"
              type="text"
              placeholder={searchPlaceholder}
              value={filters.search}
              onChange={(e) => updateFilter('search', e.target.value)}
              className={cn(inputCls, 'pl-9')}
            />
          </div>
        </div>

        {/* Date range: from */}
        {showDateRange && (
          <div>
            <label htmlFor="af-date-from" className={labelCls}>
              From Date
            </label>
            <div className="relative">
              <CalendarIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <input
                id="af-date-from"
                type="date"
                value={filters.dateFrom}
                onChange={(e) => updateFilter('dateFrom', e.target.value)}
                className={cn(inputCls, 'pl-9')}
              />
            </div>
          </div>
        )}

        {/* Date range: to */}
        {showDateRange && (
          <div>
            <label htmlFor="af-date-to" className={labelCls}>
              To Date
            </label>
            <div className="relative">
              <CalendarIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <input
                id="af-date-to"
                type="date"
                value={filters.dateTo}
                onChange={(e) => updateFilter('dateTo', e.target.value)}
                className={cn(inputCls, 'pl-9')}
              />
            </div>
          </div>
        )}

        {/* Status dropdown */}
        {showStatusFilter && statusOptions.length > 0 && (
          <div>
            <label htmlFor="af-status" className={labelCls}>
              Status
            </label>
            <select
              id="af-status"
              value={filters.status}
              onChange={(e) => updateFilter('status', e.target.value)}
              className={inputCls}
            >
              <option value="">All Statuses</option>
              {statusOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt.charAt(0) + opt.slice(1).toLowerCase().replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Role / Department dropdown */}
        {showRoleFilter && roleOptions.length > 0 && (
          <div>
            <label htmlFor="af-role" className={labelCls}>
              {roleLabel}
            </label>
            <select
              id="af-role"
              value={filters.role}
              onChange={(e) => updateFilter('role', e.target.value)}
              className={inputCls}
            >
              <option value="">All {roleLabel}s</option>
              {roleOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt.charAt(0) + opt.slice(1).toLowerCase().replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Active filters summary chips */}
      {hasActiveFilters && (
        <div className="flex flex-wrap gap-2 pt-1">
          {filters.search && (
            <FilterChip
              label={`Search: "${filters.search}"`}
              onRemove={() => updateFilter('search', '')}
            />
          )}
          {filters.dateFrom && (
            <FilterChip
              label={`From: ${filters.dateFrom}`}
              onRemove={() => updateFilter('dateFrom', '')}
            />
          )}
          {filters.dateTo && (
            <FilterChip
              label={`To: ${filters.dateTo}`}
              onRemove={() => updateFilter('dateTo', '')}
            />
          )}
          {filters.status && (
            <FilterChip
              label={`Status: ${filters.status}`}
              onRemove={() => updateFilter('status', '')}
            />
          )}
          {filters.role && (
            <FilterChip
              label={`${roleLabel}: ${filters.role}`}
              onRemove={() => updateFilter('role', '')}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Filter chip sub-component ─── */

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="hover:text-destructive transition-colors"
        aria-label={`Remove filter: ${label}`}
      >
        <CloseIcon className="h-3 w-3" />
      </button>
    </span>
  );
}
