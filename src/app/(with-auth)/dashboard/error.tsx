// src/app/(with-auth)/dashboard/error.tsx

'use client';
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Couldn’t load the dashboard</h2>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <button onClick={reset} className="inline-flex items-center px-3 py-1.5 rounded bg-primary text-white">
        Try again
      </button>
    </div>
  );
}
