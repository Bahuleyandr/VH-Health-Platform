export function MetricCard({
  label, value, delta, help,
}: { label: string; value: string | number; delta?: number; help?: string; }) {
  const positive = (delta ?? 0) >= 0;
  return (
    <div className="bg-white rounded-lg border shadow-sm p-4">
      <div className="flex items-start justify-between">
        <p className="text-sm text-muted-foreground">{label}</p>
        {help && <span className="text-xs text-gray-400">{help}</span>}
      </div>
      <div className="mt-2 flex items-end justify-between">
        <p className="text-2xl font-semibold">{value}</p>
        {delta != null && (
          <span className={`text-sm ${positive ? "text-emerald-600" : "text-red-600"}`}>
            {positive ? "▲" : "▼"} {Math.abs(delta)}%
          </span>
        )}
      </div>
      {/* optional mini sparkline area if you wire it up later */}
    </div>
  );
}
