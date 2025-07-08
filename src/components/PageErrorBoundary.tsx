// src/components/PageErrorBoundary.tsx
import { ErrorBoundary } from 'react-error-boundary';

function ErrorFallback({ error, resetErrorBoundary }) {
  return (
    <div className="min-h-[400px] flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-red-600 mb-4">
          Oops! Something went wrong
        </h2>
        <p className="text-gray-600 mb-4">{error.message}</p>
        <button
          onClick={resetErrorBoundary}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export function PageErrorBoundary({ children }) {
  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error) => {
        // Log to Sentry
        Sentry.captureException(error);
      }}
    >
      {children}
    </ErrorBoundary>
  );
}