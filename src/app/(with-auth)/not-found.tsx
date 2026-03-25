import Link from 'next/link';
import { StethoscopeIcon } from '@/components/icons';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center px-4">
      <StethoscopeIcon className="w-16 h-16 text-primary opacity-40" />
      <div>
        <h1 className="text-4xl font-bold text-foreground">404</h1>
        <h2 className="text-xl font-medium text-muted-foreground mt-2">Page not found</h2>
        <p className="text-muted-foreground mt-4 max-w-md">
          The page you&apos;re looking for doesn&apos;t exist or you don&apos;t have permission to view it.
        </p>
      </div>
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
