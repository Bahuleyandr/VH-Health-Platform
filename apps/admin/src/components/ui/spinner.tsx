// src/components/ui/spinner.tsx
export function Spinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "h-4 w-4 border-2",
    md: "h-8 w-8 border-2",
    lg: "h-12 w-12 border-3",
  };

  return (
    <div
      className={`animate-spin rounded-full border-input border-t-blue-600 ${sizeClasses[size]}`}
      aria-label="Loading"
    />
  );
}

export function LoadingSpinner({
  message = "Loading...",
}: {
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center space-y-3">
      <Spinner size="lg" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

export function FullPageSpinner() {
  return (
    <div className="fixed inset-0 bg-card/80 backdrop-blur-sm flex items-center justify-center z-50">
      <LoadingSpinner />
    </div>
  );
}
