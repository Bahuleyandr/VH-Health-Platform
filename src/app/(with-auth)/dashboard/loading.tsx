// src/app/(with-auth)/dashboard/loading.tsx

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-6 w-40 bg-gray-200 rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 bg-gray-200 rounded animate-pulse" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-5 h-44 bg-gray-200 rounded animate-pulse" />
        <div className="lg:col-span-7 h-56 bg-gray-200 rounded animate-pulse" />
      </div>
    </div>
  );
}
