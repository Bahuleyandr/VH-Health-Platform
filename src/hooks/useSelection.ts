import { useState, useCallback } from 'react';

export function useSelection<T extends { id: string | number }>(items: T[] = []) {
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set());

  const toggleSelection = useCallback((id: string | number) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === items.length) {
        return new Set();
      } else {
        return new Set(items.map(item => item.id));
      }
    });
  }, [items]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback((id: string | number) => {
    return selectedIds.has(id);
  }, [selectedIds]);

  const isAllSelected = items.length > 0 && selectedIds.size === items.length;
  const isPartiallySelected = selectedIds.size > 0 && selectedIds.size < items.length;

  return {
    selectedIds: Array.from(selectedIds),
    selectedCount: selectedIds.size,
    toggleSelection,
    toggleAll,
    clearSelection,
    isSelected,
    isAllSelected,
    isPartiallySelected,
  };
}